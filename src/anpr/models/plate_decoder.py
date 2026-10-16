"""Format-constrained CTC decoding: the CRNN may only "say" valid Moroccan plates.

Greedy (best-path) decoding takes the most likely class at each time step independently, so it
can output strings no plate has: two letters, six digits, a region of 0 or 95, a missing
separator. This decoder runs a CTC prefix beam search and only extends a prefix when the result
can still become a valid plate:

    number   1-5 digits, no leading zero
    "|"
    letter   one of configs/plate_format.yaml letters
    "|"
    region   1-2 digits, no leading zero, inside the configured region range

At the end it returns the most probable COMPLETE valid plate, or None when no valid plate fits
the image at all (then the caller decides: show the raw greedy text, or report nothing).
When greedy already reads a valid plate, the beam search almost always returns the same plate;
it only changes reads where the best path breaks the format and a valid plate is nearly as likely.

Torch-free (numpy log-probabilities in, string out) so it is cheap to test.
"""

import math
from dataclasses import dataclass, field

import numpy as np

from anpr.models.ocr_labels import BLANK, SEPARATOR, Charset
from anpr.utils.config import PlateFormat

NEG_INF = -math.inf


def _logsumexp(a: float, b: float) -> float:
    if a == NEG_INF:
        return b
    if b == NEG_INF:
        return a
    m = max(a, b)
    return m + math.log1p(math.exp(-abs(a - b)))


@dataclass
class PlateGrammar:
    letters: frozenset[str]
    region_min: int
    region_max: int

    @classmethod
    def from_format(cls, fmt: PlateFormat) -> "PlateGrammar":
        return cls(frozenset(fmt.letters), fmt.region_min, fmt.region_max)

    def _number_ok(self, part: str, complete: bool) -> bool:
        if not part:
            return not complete
        return part.isascii() and part.isdigit() and len(part) <= 5 and part[0] != "0"

    def _region_ok(self, part: str, complete: bool) -> bool:
        if not part:
            return not complete
        if not (part.isascii() and part.isdigit()) or len(part) > 2 or part[0] == "0":
            return False
        value = int(part)
        if complete or len(part) == 2:
            return self.region_min <= value <= self.region_max
        return value <= self.region_max  # one digit so far: a second digit may still come

    def is_prefix(self, text: str) -> bool:
        """Can `text` still grow into a valid plate (or already is one)?"""
        parts = text.split(SEPARATOR)
        if len(parts) > 3:
            return False
        if not self._number_ok(parts[0], complete=len(parts) > 1):
            return False
        if len(parts) >= 2:
            letter = parts[1]
            if len(letter) > 1 or (letter and letter not in self.letters) or (len(parts) == 3 and not letter):
                return False
        if len(parts) == 3:
            return self._region_ok(parts[2], complete=False)
        return True

    def is_complete(self, text: str) -> bool:
        parts = text.split(SEPARATOR)
        return (len(parts) == 3 and self._number_ok(parts[0], True) and len(parts[1]) == 1
                and parts[1] in self.letters and self._region_ok(parts[2], True))


@dataclass
class _Beam:
    p_blank: float = NEG_INF      # log P(prefix, last frame was blank)
    p_char: float = NEG_INF       # log P(prefix, last frame was the prefix's last character)
    confs: list[float] = field(default_factory=list)  # per character: best probability seen for it

    @property
    def total(self) -> float:
        return _logsumexp(self.p_blank, self.p_char)


def _beam(beams: dict[str, _Beam], prefix: str, confs: list[float]) -> _Beam:
    """The beam for `prefix` in this time step, created (with a copy of confs) on first use."""
    if prefix not in beams:
        beams[prefix] = _Beam(confs=list(confs))
    return beams[prefix]


def decode_plate(log_probs: np.ndarray, charset: Charset, grammar: PlateGrammar,
                 beam_width: int = 16) -> tuple[str, list[float], float] | None:
    """log_probs: (T, C) log-probabilities for ONE image (class 0 = CTC blank).

    Returns (plate, per-character probabilities including separators, log P(plate)) for the most
    probable valid plate, or None if none survives.
    """
    probs = np.exp(log_probs)
    beams: dict[str, _Beam] = {"": _Beam(p_blank=0.0)}
    for t in range(log_probs.shape[0]):
        lp, pr = log_probs[t], probs[t]
        nxt: dict[str, _Beam] = {}
        for prefix, beam in beams.items():
            # stay on the same prefix: emit a blank, or repeat the last character (CTC merges repeats)
            same = _beam(nxt, prefix, beam.confs)
            same.p_blank = _logsumexp(same.p_blank, beam.total + lp[BLANK])
            if prefix:
                last_id = charset.index[prefix[-1]]
                same.p_char = _logsumexp(same.p_char, beam.p_char + lp[last_id])
                same.confs[-1] = max(same.confs[-1], float(pr[last_id]))
            # extend the prefix by one character, if the result can still be a plate
            for c, cid in charset.index.items():
                ext = prefix + c
                if not grammar.is_prefix(ext):
                    continue
                # the same character twice in a row needs a blank in between (else CTC merges them)
                source = beam.p_blank if prefix and prefix[-1] == c else beam.total
                if source == NEG_INF:
                    continue
                new = _beam(nxt, ext, beam.confs + [float(pr[cid])])
                new.p_char = _logsumexp(new.p_char, source + lp[cid])
                new.confs[-1] = max(new.confs[-1], float(pr[cid]))
        beams = dict(sorted(nxt.items(), key=lambda kv: kv[1].total, reverse=True)[:beam_width])

    complete = [(p, b) for p, b in beams.items() if grammar.is_complete(p)]
    if not complete:
        return None
    plate, beam = max(complete, key=lambda kv: kv[1].total)
    return plate, beam.confs, beam.total


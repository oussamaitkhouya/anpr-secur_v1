"""Text side of the OCR model: character set, CTC decoding, accuracy metrics.

Kept free of torch so it can be tested and reused without the model.

The model reads plates left to right and predicts the canonical label directly,
including the "|" separators (they are drawn on the plate as vertical bars).
"""

from collections.abc import Iterable, Sequence

from rapidfuzz.distance import Levenshtein

BLANK = 0          # CTC "no character here" class, always index 0
DIGITS = "0123456789"
SEPARATOR = "|"


class Charset:
    """Maps characters to class ids 1..N (0 is the CTC blank)."""

    def __init__(self, letters: Iterable[str]):
        self.chars: list[str] = list(DIGITS) + [SEPARATOR] + sorted(set(letters))
        self.index = {c: i + 1 for i, c in enumerate(self.chars)}

    @classmethod
    def from_config(cls, fmt) -> "Charset":
        return cls(fmt.letters)

    @property
    def num_classes(self) -> int:
        return len(self.chars) + 1  # + blank

    def encode(self, text: str) -> list[int]:
        try:
            return [self.index[c] for c in text]
        except KeyError as e:
            raise ValueError(f"character {e.args[0]!r} in {text!r} is not in the charset") from None

    def decode_greedy(self, ids: Sequence[int]) -> str:
        """CTC best-path decoding: merge repeated ids, then drop blanks.

        "1 1 - 1 2" -> "1 1 2"  (a blank between two 1s keeps them separate).
        """
        out, prev = [], BLANK
        for i in ids:
            if i != prev and i != BLANK:
                out.append(self.chars[i - 1])
            prev = i
        return "".join(out)


def char_accuracy(preds: Sequence[str], targets: Sequence[str]) -> float:
    """1 - (total edit distance / total target length), floored at 0 per plate.

    Edit distance counts substituted, missing and extra characters, so a
    prediction with one wrong digit out of 9 characters scores 8/9.
    """
    total = sum(len(t) for t in targets)
    if total == 0:
        return 0.0
    correct = sum(max(0, len(t) - Levenshtein.distance(p, t)) for p, t in zip(preds, targets, strict=True))
    return correct / total


def plate_accuracy(preds: Sequence[str], targets: Sequence[str]) -> float:
    """Share of plates read exactly right, every character."""
    if not targets:
        return 0.0
    return sum(p == t for p, t in zip(preds, targets, strict=True)) / len(targets)

"""Format-constrained CTC decoding on hand-built probability tables (one row per time step)."""

import numpy as np
import pytest

from anpr.models.ocr_labels import BLANK, Charset
from anpr.models.plate_decoder import PlateGrammar, decode_plate
from anpr.utils.config import default_plate_format

FMT = default_plate_format()
CHARSET = Charset.from_config(FMT)
GRAMMAR = PlateGrammar.from_format(FMT)
A, B = "أ", "ب"


def table(*frames: dict[str, float]) -> np.ndarray:
    """Each frame: {char: prob}; "_" is the blank. Unlisted classes share what is left."""
    out = np.full((len(frames), CHARSET.num_classes), 1e-6)
    for t, frame in enumerate(frames):
        for c, p in frame.items():
            out[t, BLANK if c == "_" else CHARSET.index[c]] = p
        out[t] /= out[t].sum()
    return np.log(out)


def spell(text: str) -> list[dict[str, float]]:
    """Confident frames for text, a blank after every character."""
    return [f for c in text for f in ({c: 0.95}, {"_": 0.95})]


def test_grammar():
    assert GRAMMAR.is_complete(f"12345|{A}|40") and GRAMMAR.is_complete(f"7|{B}|1")
    for bad in (f"123456|{A}|4", f"012|{A}|4", f"12|{A}|0", f"12|{A}|05", "12|X|4", "12||4", f"12|{A}{B}|4",
                f"12|{A}|{FMT.region_max + 1}", f"12|{A}", "12"):
        assert not GRAMMAR.is_complete(bad), bad
    assert GRAMMAR.is_prefix("") and GRAMMAR.is_prefix("123|") and GRAMMAR.is_prefix(f"1|{A}|8")
    assert not GRAMMAR.is_prefix("0") and not GRAMMAR.is_prefix("123456") and not GRAMMAR.is_prefix(f"1|{A}|0")


def test_a_clear_valid_plate_is_read_unchanged():
    plate, confs, logp = decode_plate(table(*spell(f"12345|{A}|40")), CHARSET, GRAMMAR)
    assert plate == f"12345|{A}|40"
    assert len(confs) == len(plate) and all(c > 0.9 for c in confs) and logp < 0


def test_digit_in_the_letter_slot_is_replaced_by_the_runner_up_letter():
    # best path says "12|1|6" (a digit where the letter goes); ب is a close second
    frames = spell("12|") + [{"1": 0.55, B: 0.4}, {"_": 0.95}] + spell("|6")
    assert decode_plate(table(*frames), CHARSET, GRAMMAR)[0] == f"12|{B}|6"


def test_region_out_of_range_is_replaced():
    assert FMT.region_max < 95
    frames = spell(f"345|{A}|") + [{"9": 0.6, "4": 0.38}, {"_": 0.95}, {"5": 0.95}, {"_": 0.95}]
    assert decode_plate(table(*frames), CHARSET, GRAMMAR)[0] == f"345|{A}|45"


def test_repeated_digits_need_a_blank_between_them():
    double = [{"1": 0.95}, {"_": 0.95}, {"1": 0.95}, {"_": 0.95}] + spell(f"|{A}|3")
    merged = [{"1": 0.95}, {"1": 0.95}, {"_": 0.95}] + spell(f"|{A}|3")
    assert decode_plate(table(*double), CHARSET, GRAMMAR)[0] == f"11|{A}|3"
    assert decode_plate(table(*merged), CHARSET, GRAMMAR)[0] == f"1|{A}|3"


@pytest.mark.parametrize("frames", [[{"_": 0.99}] * 10, spell("12345")])
def test_no_valid_plate_returns_none(frames):
    assert decode_plate(table(*frames), CHARSET, GRAMMAR) is None

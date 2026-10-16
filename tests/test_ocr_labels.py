import pytest

from anpr.models.ocr_labels import BLANK, Charset, char_accuracy, plate_accuracy
from anpr.utils.config import default_plate_format


@pytest.fixture
def charset():
    return Charset.from_config(default_plate_format())


def test_charset_covers_labels(charset):
    fmt = default_plate_format()
    assert charset.num_classes == 10 + 1 + len(fmt.letters) + 1
    assert BLANK not in charset.encode("12345|ب|6")


def test_encode_decode_roundtrip(charset):
    label = "12345|ب|6"
    assert charset.decode_greedy(charset.encode(label)) == label


def test_encode_unknown_char(charset):
    with pytest.raises(ValueError, match="not in the charset"):
        charset.encode("12|X|6")


def test_ctc_greedy_collapse(charset):
    one, two = charset.encode("12")
    # repeats merge; a blank separates genuine double letters
    assert charset.decode_greedy([BLANK, one, one, BLANK, one, two, two, BLANK]) == "112"
    assert charset.decode_greedy([BLANK, BLANK]) == ""


def test_metrics():
    targets = ["123|ب|6", "45|ج|12"]
    assert plate_accuracy(targets, targets) == 1.0
    assert char_accuracy(targets, targets) == 1.0
    preds = ["123|ب|5", "45|ج|12"]           # one wrong char out of 14
    assert plate_accuracy(preds, targets) == 0.5
    assert char_accuracy(preds, targets) == pytest.approx(13 / 14)
    assert char_accuracy(["", "45|ج|12"], targets) == pytest.approx(7 / 14)
    assert char_accuracy([], []) == 0.0 and plate_accuracy([], []) == 0.0

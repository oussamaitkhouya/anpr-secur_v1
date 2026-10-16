import pytest

from anpr.pipeline.validator import parse_plate


def test_valid_plate():
    p = parse_plate("12345|ب|6")
    assert p and p.canonical() == "12345|ب|6"


def test_spaces_and_arabic_digits():
    assert parse_plate("١٢٣ هـ ٢٦").canonical() == "123|ه|26"


@pytest.mark.parametrize("bad", ["", "123456|ب|6", "0|ب|6", "123|ب|0", "123|ب|99", "123|X|6", "abc"])
def test_invalid(bad):
    assert parse_plate(bad) is None
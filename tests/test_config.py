import pytest

from anpr.pipeline.validator import parse_plate
from anpr.utils.config import load_plate_format

EXPECTED_TYPES = {"private", "taxi", "temporary", "police", "government", "diplomatic"}


def test_default_config_loads():
    fmt = load_plate_format()
    assert "ب" in fmt.letters
    assert fmt.region_min <= fmt.region_max
    assert set(fmt.plate_types) == EXPECTED_TYPES


def _write(tmp_path, letters="[ب]", rmin=1, rmax=5):
    p = tmp_path / "plate_format.yaml"
    p.write_text(
        f"letters: {{values: {letters}}}\n"
        f"region: {{min: {rmin}, max: {rmax}}}\n"
        "plate_types: {private: {description: x}}\n",
        encoding="utf-8",
    )
    return p


def test_custom_config_drives_validator(tmp_path):
    fmt = load_plate_format(_write(tmp_path))
    assert parse_plate("1|ب|5", fmt)
    assert parse_plate("1|ب|6", fmt) is None   # outside custom region range
    assert parse_plate("1|ج|5", fmt) is None   # letter not in custom set


@pytest.mark.parametrize("kwargs", [{"letters": "[]"}, {"letters": "[ab]"}, {"rmin": 5, "rmax": 1}])
def test_invalid_config_rejected(tmp_path, kwargs):
    with pytest.raises(ValueError):
        load_plate_format(_write(tmp_path, **kwargs))


def test_missing_section_rejected(tmp_path):
    p = tmp_path / "bad.yaml"
    p.write_text("letters: {values: [ب]}\n", encoding="utf-8")
    with pytest.raises(ValueError):
        load_plate_format(p)

import csv
import importlib.util

import pytest
from PIL import Image

from anpr.data.plate_generator import (
    DIGIT_FONT,
    LETTER_FONT,
    GeneratedPlate,
    PlateGenerator,
    shape_arabic,
)
from anpr.pipeline.validator import Plate, parse_plate
from anpr.utils.config import REPO_ROOT, default_plate_format

# data/ is gitignored, so fonts may be missing on a fresh clone
pytestmark = pytest.mark.skipif(
    not (DIGIT_FONT.exists() and LETTER_FONT.exists()),
    reason=f"fonts not found in {DIGIT_FONT.parent}",
)

PLATE_TYPES = sorted(default_plate_format().plate_types)


@pytest.mark.parametrize("plate_type", PLATE_TYPES)
def test_labels_pass_validator(plate_type):
    gen = PlateGenerator(seed=1)
    for _ in range(50):
        result = gen.generate(plate_type)
        parsed = parse_plate(result.label)
        assert parsed is not None, result.label
        assert parsed.canonical() == result.label
        assert result.plate_type == plate_type


def test_random_plates_cover_config():
    gen = PlateGenerator(seed=2, augment=False)
    fmt = gen.fmt
    plates = [gen.random_plate() for _ in range(2000)]
    assert {p.letter for p in plates} == set(fmt.letters)
    assert all(fmt.region_min <= p.region <= fmt.region_max for p in plates)
    assert {len(str(p.number)) for p in plates} == {1, 2, 3, 4, 5}


def test_render_produces_image():
    gen = PlateGenerator(seed=3, augment=False)
    img = gen.render(Plate(12345, "ب", 6))
    assert img.mode == "RGB" and img.size == (520, 112)
    assert img.getextrema() != ((255, 255), (255, 255), (255, 255))  # something was drawn


def test_augmented_image_is_rgb():
    img = PlateGenerator(seed=4).generate("private").image
    assert img.mode == "RGB" and img.width > 520


def test_same_seed_same_output():
    a = PlateGenerator(seed=5).generate()
    b = PlateGenerator(seed=5).generate()
    assert a.label == b.label and a.plate_type == b.plate_type
    assert a.image.tobytes() == b.image.tobytes()


def test_unknown_plate_type_rejected():
    with pytest.raises(ValueError, match="unknown plate type"):
        PlateGenerator(seed=6).generate("spaceship")


def test_shape_arabic_returns_presentation_form():
    # reshaper maps base letters to their isolated presentation forms
    assert shape_arabic("ب") != "ب"


def _load_generate_dataset():
    spec = importlib.util.spec_from_file_location("generate_dataset", REPO_ROOT / "scripts" / "generate_dataset.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_rows(csv_path):
    with open(csv_path, encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        return reader.fieldnames, list(reader)


def test_generate_dataset_script(tmp_path):
    csv_path = _load_generate_dataset().main(["--n", "12", "--out", str(tmp_path), "--seed", "0"])

    assert csv_path == tmp_path / "labels.csv"
    fieldnames, rows = _read_rows(csv_path)
    assert fieldnames == ["filename", "label", "plate_type"]
    assert len(rows) == 12
    assert {r["plate_type"] for r in rows} == set(PLATE_TYPES)
    for r in rows:
        assert parse_plate(r["label"]) is not None, r["label"]
        assert r["filename"].startswith("images/")
        assert (tmp_path / r["filename"]).is_file()


def test_generate_dataset_writes_disjoint_splits(tmp_path):
    _load_generate_dataset().main(["--n", "60", "--out", str(tmp_path), "--seed", "1", "--no-augment"])

    _, all_rows = _read_rows(tmp_path / "labels.csv")
    splits = {}
    for name in ("train", "val", "test"):
        fieldnames, splits[name] = _read_rows(tmp_path / f"{name}.csv")
        assert fieldnames == ["filename", "label", "plate_type"]
        assert splits[name], name
    # together the splits are exactly labels.csv
    assert sorted(r["filename"] for rows in splits.values() for r in rows) == sorted(r["filename"] for r in all_rows)
    # no plate label in more than one split
    labels = {name: {r["label"] for r in rows} for name, rows in splits.items()}
    assert not labels["train"] & labels["val"]
    assert not labels["train"] & labels["test"]
    assert not labels["val"] & labels["test"]


def test_generate_dataset_same_seed_same_dataset(tmp_path):
    module = _load_generate_dataset()
    a = module.main(["--n", "6", "--out", str(tmp_path / "a"), "--seed", "3"])
    b = module.main(["--n", "6", "--out", str(tmp_path / "b"), "--seed", "3"])

    for name in ("labels.csv", "train.csv", "val.csv", "test.csv"):
        assert (a.parent / name).read_bytes() == (b.parent / name).read_bytes(), name
    _, rows_a = _read_rows(a)
    for r in rows_a:
        assert (a.parent / r["filename"]).read_bytes() == (b.parent / r["filename"]).read_bytes()


def test_generate_dataset_rejects_invalid_label(tmp_path, monkeypatch):
    module = _load_generate_dataset()
    bad = GeneratedPlate(Image.new("RGB", (520, 112)), "12|?|999", "private")
    monkeypatch.setattr(module.PlateGenerator, "generate", lambda self, plate_type=None: bad)

    with pytest.raises(ValueError, match="validator rejects"):
        module.main(["--n", "1", "--out", str(tmp_path), "--seed", "0"])


def test_variety_mode_renders_valid_varied_plates():
    gen = PlateGenerator(seed=5, variety=True)
    assert len(gen.digit_fonts) > 1 and len(gen.letter_fonts) > 1
    for _ in range(10):
        result = gen.generate("private")
        assert parse_plate(result.label) is not None
        assert result.image.mode == "RGB" and result.image.width >= 520


def test_variety_mode_is_reproducible_and_differs_from_default():
    a = PlateGenerator(seed=9, variety=True, augment=False).generate("private")
    b = PlateGenerator(seed=9, variety=True, augment=False).generate("private")
    plain = PlateGenerator(seed=9, augment=False).generate("private")
    assert a.label == b.label and a.image.tobytes() == b.image.tobytes()
    assert a.image.tobytes() != plain.image.tobytes()

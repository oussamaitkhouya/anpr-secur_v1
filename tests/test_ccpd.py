from pathlib import Path

import pytest
from PIL import Image

from anpr.data.ccpd import image_size, list_subset, parse_filename, scan

# Two real names (README example, ccpd_base line from split/train.txt) and one malformed name
README_NAME = "025-95_113-154&383_386&473-386&473_177&454_154&383_363&402-0_0_22_27_27_33_16-37-15.jpg"
BASE_NAME = ("0092816091954-94_82-181&490_358&548-363&554_189&540_190&484_364&498"
             "-0_0_28_29_16_29_32-133-13.jpg")
MALFORMED_NAME = "025-95_113-154&383-0_0_22_27_27_33_16-37-15.jpg"  # bbox has one corner, vertices missing


def test_parse_readme_example():
    ann = parse_filename(README_NAME)
    assert ann.area == "025"
    assert ann.tilt == (95, 113)
    assert ann.bbox == (154, 383, 386, 473)
    assert ann.vertices == ((386, 473), (177, 454), (154, 383), (363, 402))
    assert ann.chars == (0, 0, 22, 27, 27, 33, 16)
    assert (ann.brightness, ann.blur) == (37, 15)


def test_parse_with_directory_prefix():
    ann = parse_filename(f"ccpd_base/{BASE_NAME}")
    assert ann.bbox == (181, 490, 358, 548)
    assert ann.vertices[0] == (363, 554)


@pytest.mark.parametrize("name", [
    MALFORMED_NAME,
    "1.jpg",                                                     # ccpd_np style: no annotation
    README_NAME.replace("154&383_386&473", "386&473_154&383"),   # corners swapped: x1 > x2
    README_NAME.replace("-37-", "-bright-"),                     # non-integer field
    README_NAME.replace("_363&402-", "-"),                       # only 3 vertices
])
def test_malformed_names_raise(name):
    with pytest.raises(ValueError):
        parse_filename(name)


def test_scan_skips_and_counts_malformed(tmp_path):
    for name in (README_NAME, BASE_NAME, MALFORMED_NAME, "notes.txt"):
        (tmp_path / name).write_bytes(b"")
    result = scan(list_subset(tmp_path.parent, tmp_path.name))

    assert sorted(s.path.name for s in result.samples) == sorted([README_NAME, BASE_NAME])
    assert result.skipped == {"malformed filename": 1, "not an image": 1}
    assert result.skipped_examples["malformed filename"] == MALFORMED_NAME


def test_image_size_read_from_file(tmp_path):
    path = tmp_path / README_NAME
    Image.new("RGB", (720, 1160)).save(path)
    assert image_size(path) == (720, 1160)


def test_missing_subset_folder(tmp_path):
    with pytest.raises(FileNotFoundError, match="ccpd_night"):
        list_subset(tmp_path, "ccpd_night")


def test_list_subset_is_sorted(tmp_path):
    for name in ("b.jpg", "a.jpg", "c.jpg"):
        (tmp_path / name).write_bytes(b"")
    assert [p.name for p in list_subset(tmp_path.parent, tmp_path.name)] == ["a.jpg", "b.jpg", "c.jpg"]
    assert all(isinstance(p, Path) for p in list_subset(tmp_path.parent, tmp_path.name))

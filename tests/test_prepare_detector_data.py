import importlib.util
import os

import numpy as np
import pytest
import yaml
from PIL import Image

from anpr.utils.config import REPO_ROOT

IMG_SIZE = (200, 100)  # width, height of the fake CCPD photos


def _load_script():
    spec = importlib.util.spec_from_file_location("prepare_detector_data",
                                                  REPO_ROOT / "scripts" / "prepare_detector_data.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def ccpd_name(i: int, x1: int, y1: int, x2: int, y2: int) -> str:
    vertices = f"{x2}&{y2}_{x1}&{y2}_{x1}&{y1}_{x2}&{y1}"  # CCPD starts from the bottom-right corner
    return f"{i:03d}-90_90-{x1}&{y1}_{x2}&{y2}-{vertices}-0_0_1_2_3_4_5-100-10.jpg"


@pytest.fixture
def fake_ccpd(tmp_path):
    """data/external/CCPD2019 look-alike: 20 + 4 valid images and 3 that must be skipped."""
    src = tmp_path / "CCPD2019"
    for subset, count in (("ccpd_base", 20), ("ccpd_weather", 4)):
        (src / subset).mkdir(parents=True)
        for i in range(count):
            x1, y1 = 10 + 3 * i, 20 + i
            Image.new("RGB", IMG_SIZE, (128, 128, 128)).save(src / subset / ccpd_name(i, x1, y1, x1 + 60, y1 + 25))
    base = src / "ccpd_base"
    (base / "025-95_113-154&383-0_0_22-37-15.jpg").write_bytes(b"")              # malformed name
    (base / ccpd_name(900, 10, 10, 50, 30)).write_bytes(b"not a jpeg")          # unreadable image
    Image.new("RGB", IMG_SIZE).save(base / ccpd_name(901, 250, 10, 300, 50))    # box right of the image
    return src


def _snapshot(folder):
    return {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(folder.rglob("*")) if p.is_file()}


def _run(src, out, *extra):
    return _load_script().main(["--src", str(src), "--out", str(out), "--seed", "0", *extra])


def test_yolo_line_normalises_and_clips():
    yolo_line = _load_script().yolo_line
    assert yolo_line((50, 20, 150, 60), 200, 100) == "0 0.500000 0.400000 0.500000 0.400000"
    assert yolo_line((-10, 0, 100, 100), 200, 100) == "0 0.250000 0.500000 0.500000 1.000000"
    assert yolo_line((250, 10, 300, 50), 200, 100) is None


def test_conversion_writes_yolo_dataset(fake_ccpd, tmp_path):
    out = tmp_path / "detector"
    summary = _run(fake_ccpd, out)

    assert summary["found"] == 22  # names that parse: 20 good + unreadable + box outside
    assert summary["splits"] == {"train": 16, "val": 2, "test": 2}
    assert summary["skipped"] == {"malformed filename": 1, "unreadable image": 1, "box outside image": 1}

    script = _load_script()
    from anpr.data.ccpd import parse_filename

    for split in ("train", "val", "test"):
        images = sorted((out / "images" / split).iterdir())
        labels = sorted((out / "labels" / split).iterdir())
        assert [p.stem for p in images] == [p.stem for p in labels]
        for img, label in zip(images, labels, strict=True):
            assert img.name.startswith("ccpd_base__")  # default --subsets is ccpd_base only
            ccpd = parse_filename(img.name.split("__", 1)[1])
            assert label.read_text(encoding="utf-8") == script.yolo_line(ccpd.bbox, *IMG_SIZE) + "\n"

    with open(out / "plates.yaml", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    assert cfg == {"path": str(out.resolve()), "train": "images/train", "val": "images/val",
                   "test": "images/test", "names": {0: "plate"}}


def test_originals_never_modified(fake_ccpd, tmp_path):
    before = _snapshot(fake_ccpd)
    _run(fake_ccpd, tmp_path / "out")
    _run(fake_ccpd, tmp_path / "out", "--overwrite", "--preview")  # deleting old hard links too
    _run(fake_ccpd, tmp_path / "copy", "--mode", "copy")
    assert _snapshot(fake_ccpd) == before


@pytest.mark.parametrize("mode", ["hardlink", "copy"])
def test_link_or_copy(fake_ccpd, tmp_path, mode):
    out = tmp_path / "out"
    summary = _run(fake_ccpd, out, "--mode", mode)
    dst = next((out / "images" / "train").iterdir())
    original = fake_ccpd / "ccpd_base" / dst.name.split("__", 1)[1]
    assert dst.read_bytes() == original.read_bytes()
    if mode == "copy":
        assert summary["methods"] == {"copy": 20}
        assert not os.path.samefile(dst, original)
    elif summary["methods"] == {"hardlink": 20}:  # tmp volumes without hard-link support fall back to copy
        assert os.path.samefile(dst, original)


def test_split_is_seeded_and_disjoint(fake_ccpd, tmp_path):
    def split_names(out):
        return {s: sorted(p.name for p in (out / "images" / s).iterdir()) for s in ("train", "val", "test")}

    _run(fake_ccpd, tmp_path / "a")
    _run(fake_ccpd, tmp_path / "b")
    a, b = split_names(tmp_path / "a"), split_names(tmp_path / "b")
    assert a == b
    assert not set(a["train"]) & set(a["val"]) and not set(a["train"]) & set(a["test"])
    assert not set(a["val"]) & set(a["test"])

    _load_script().main(["--src", str(fake_ccpd), "--out", str(tmp_path / "c"), "--seed", "7"])
    assert split_names(tmp_path / "c") != a


def test_subsets_and_max_images(fake_ccpd, tmp_path):
    summary = _run(fake_ccpd, tmp_path / "out", "--subsets", "ccpd_base", "ccpd_weather", "--max-images", "10")
    assert summary["sampled"] == 10
    total = sum(summary["splits"].values()) + summary["skipped"].get("unreadable image", 0) \
        + summary["skipped"].get("box outside image", 0)
    assert total == 10


def test_preview_draws_boxes_from_labels(fake_ccpd, tmp_path):
    out = tmp_path / "out"
    summary = _run(fake_ccpd, out, "--preview")
    previews = summary["previews"]
    assert len(previews) == 12
    assert sorted(p.name for p in (out / "preview").iterdir()) == sorted(p.name for p in previews)

    for path in previews:
        split, image_stem = path.stem.split("__", 1)
        assert (out / "images" / split / f"{image_stem}.jpg").is_file()  # traceable to its source


def _is_red(px) -> bool:
    r, g, b = (int(v) for v in px)
    return r > 200 and g < 90 and b < 90


def test_preview_box_matches_ccpd_box(fake_ccpd, tmp_path):
    """The drawn box must sit exactly where the CCPD filename says (photos are plain grey)."""
    from anpr.data.ccpd import parse_filename

    out = tmp_path / "out"
    for path in _run(fake_ccpd, out, "--preview")["previews"]:
        ccpd_name = path.stem.split("__", 2)[2] + ".jpg"  # <split>__<subset>__<ccpd name>
        x1, y1, x2, y2 = parse_filename(ccpd_name).bbox
        with Image.open(path) as img:
            px = np.asarray(img.convert("RGB"))
        assert img.size == IMG_SIZE
        mid_x, mid_y = (x1 + x2) // 2, (y1 + y2) // 2
        assert _is_red(px[y1, mid_x]) and _is_red(px[y2 - 1, mid_x]), path.name  # top and bottom edges
        assert _is_red(px[mid_y, x1]) and _is_red(px[mid_y, x2 - 1]), path.name  # left and right edges
        assert not _is_red(px[mid_y, mid_x]), path.name                          # inside stays grey
        assert not _is_red(px[max(0, y1 - 4), mid_x]), path.name                 # just outside too


def test_preview_with_fewer_than_12_images(fake_ccpd, tmp_path):
    summary = _run(fake_ccpd, tmp_path / "out", "--preview", "--max-images", "5")
    assert len(summary["previews"]) == sum(summary["splits"].values()) <= 5


def test_refuses_unsafe_or_existing_output(fake_ccpd, tmp_path):
    with pytest.raises(SystemExit, match="must not be inside"):
        _run(fake_ccpd, fake_ccpd / "detector")
    with pytest.raises(SystemExit, match="must not be inside"):
        _run(fake_ccpd / "ccpd_base", fake_ccpd)  # --out containing --src
    with pytest.raises(SystemExit, match="ccpd_night"):
        _run(fake_ccpd, tmp_path / "out", "--subsets", "ccpd_night")

    _run(fake_ccpd, tmp_path / "out")
    with pytest.raises(SystemExit, match="--overwrite"):
        _run(fake_ccpd, tmp_path / "out")
    assert _run(fake_ccpd, tmp_path / "out", "--overwrite")["splits"]["train"] == 16

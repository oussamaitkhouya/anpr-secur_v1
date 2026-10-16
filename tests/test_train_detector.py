import hashlib
import json
import random
from pathlib import Path

import pytest
import yaml
from PIL import Image, ImageDraw

from anpr.training import train_detector as td


def make_dataset(root: Path, sizes: dict[str, int], seed: int = 0) -> Path:
    """Tiny YOLO dataset: grey images with one bright rectangle ("plate") each."""
    rng = random.Random(seed)
    for split, n in sizes.items():
        (root / "images" / split).mkdir(parents=True)
        (root / "labels" / split).mkdir(parents=True)
        for i in range(n):
            img = Image.new("RGB", (96, 96), (60, 60, 60))
            x1, y1 = rng.randint(5, 40), rng.randint(5, 60)
            x2, y2 = x1 + rng.randint(30, 45), y1 + rng.randint(10, 20)
            ImageDraw.Draw(img).rectangle((x1, y1, x2, y2), fill=(240, 240, 240))
            img.save(root / "images" / split / f"{i:03d}.jpg")
            xc, yc, w, h = (x1 + x2) / 192, (y1 + y2) / 192, (x2 - x1) / 96, (y2 - y1) / 96
            (root / "labels" / split / f"{i:03d}.txt").write_text(f"0 {xc} {yc} {w} {h}\n")
    path = root / "plates.yaml"
    data = {"path": str(root), **{s: f"images/{s}" for s in sizes}, "names": {0: "plate"}}
    path.write_text(yaml.safe_dump(data, sort_keys=False))
    return path


def test_load_data_yaml_resolves_relative_root(tmp_path):
    (tmp_path / "plates.yaml").write_text(yaml.safe_dump({"path": ".", "train": "images/train", "names": {0: "plate"}}))
    data = td.load_data_yaml(tmp_path / "plates.yaml")
    assert Path(data["train"]) == tmp_path / "." / "images" / "train"


def test_load_data_yaml_missing(tmp_path):
    with pytest.raises(SystemExit, match="prepare_detector_data"):
        td.load_data_yaml(tmp_path / "nope.yaml")


def test_subset_samples_and_keeps_full_splits(tmp_path):
    data = td.load_data_yaml(make_dataset(tmp_path / "ds", {"train": 12, "val": 4}))
    path = td.subset_data_yaml(data, tmp_path / "run", {"train": 5, "val": None, "test": 3}, seed=0)
    subset = yaml.safe_load(path.read_text())
    train = Path(subset["train"]).read_text().splitlines()
    val = Path(subset["val"]).read_text().splitlines()
    assert len(train) == 5 and len(set(train)) == 5
    assert len(val) == 4
    assert "test" not in subset  # absent splits stay absent
    # Ultralytics finds labels by swapping /images/ for /labels/
    for line in train:
        image = Path(line)
        assert image.parent == (tmp_path / "ds" / "images" / "train").resolve()
        assert (tmp_path / "ds" / "labels" / "train" / f"{image.stem}.txt").is_file()


def test_subset_is_seeded(tmp_path):
    data = td.load_data_yaml(make_dataset(tmp_path / "ds", {"train": 20}))
    a = Path(yaml.safe_load(td.subset_data_yaml(data, tmp_path / "a", {"train": 5}, 1).read_text())["train"])
    b = Path(yaml.safe_load(td.subset_data_yaml(data, tmp_path / "b", {"train": 5}, 1).read_text())["train"])
    assert a.read_text() == b.read_text()


def test_subset_empty_split_rejected(tmp_path):
    root = tmp_path / "ds"
    (root / "images" / "train").mkdir(parents=True)
    data = {"path": str(root), "train": str(root / "images" / "train")}
    with pytest.raises(SystemExit, match="no images"):
        td.subset_data_yaml(data, tmp_path / "run", {"train": 5}, 0)


def test_sha256(tmp_path):
    f = tmp_path / "w.pt"
    f.write_bytes(b"weights")
    assert td.sha256(f) == hashlib.sha256(b"weights").hexdigest()


def test_bad_epochs_rejected():
    with pytest.raises(SystemExit):
        td.parse_args(["--epochs", "0"])


def test_full_mode_needs_cuda(monkeypatch):
    torch = pytest.importorskip("torch")
    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    with pytest.raises(SystemExit):
        td.parse_args(["--mode", "full"])


def test_smoke_run_end_to_end(tmp_path):
    """1 CPU epoch on a tiny dataset with an untrained architecture (no weight download)."""
    pytest.importorskip("ultralytics")
    data = make_dataset(tmp_path / "ds", {"train": 8, "val": 4, "test": 4})
    models = tmp_path / "models"
    results = td.main(["--mode", "smoke", "--data", str(data), "--model", "yolo11n.yaml", "--imgsz", "64",
                       "--batch", "4", "--project", str(tmp_path / "runs"), "--models-dir", str(models)])
    weights = models / "plate_detector_smoke.pt"
    assert weights.is_file()
    assert results["sha256"] == td.sha256(weights)
    saved = json.loads(weights.with_suffix(".json").read_text())
    for split in ("val", "test"):
        assert set(saved["metrics"][split]) == {"precision", "recall", "map50", "map50_95"}
        assert all(0.0 <= v <= 1.0 for v in saved["metrics"][split].values())

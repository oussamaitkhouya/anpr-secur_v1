"""scripts/export_real_crops.py: crops plates from YOLO-labelled photos, wherever --src is."""

import csv
import importlib.util
from pathlib import Path

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("export_real_crops", REPO / "scripts" / "export_real_crops.py")
export_real_crops = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(export_real_crops)


def _photo(folder: Path) -> None:
    folder.mkdir(parents=True)
    cv2.imwrite(str(folder / "car.jpg"), np.full((200, 400, 3), 127, np.uint8))
    (folder / "car.txt").write_text("0 0.5 0.5 0.5 0.2\n")


def test_relative_src_outside_the_repo_works(tmp_path, monkeypatch):
    _photo(tmp_path / "photos")
    monkeypatch.chdir(tmp_path)
    assert export_real_crops.main(["--src", "photos", "--out", "crops"]) == 0
    with open(tmp_path / "crops" / "labels.csv", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    assert [r["filename"] for r in rows] == ["images/car_0.png"]
    assert Path(rows[0]["source"]) == (tmp_path / "photos" / "car.jpg")
    assert (tmp_path / "crops" / "images" / "car_0.png").is_file()


def test_source_inside_the_repo_is_stored_relative():
    assert export_real_crops._source(REPO / "data" / "x" / "a.jpg") == "data/x/a.jpg"

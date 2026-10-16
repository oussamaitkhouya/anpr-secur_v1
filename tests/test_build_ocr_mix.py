"""scripts/build_ocr_mix.py: synthetic + labelled real crops, split by plate text, real oversampled."""

import csv
import importlib.util
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("build_ocr_mix", REPO / "scripts" / "build_ocr_mix.py")
build_ocr_mix = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(build_ocr_mix)

HEADER = ["filename", "label", "plate_type"]


def _csv(path: Path, rows: list[dict], fields=HEADER) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fields)
        w.writeheader()
        w.writerows(rows)


def _read(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def _setup(tmp_path: Path) -> tuple[Path, Path]:
    syn, real = tmp_path / "synthetic", tmp_path / "real"
    for i, s in enumerate(("train", "val", "test")):
        rows = [{"filename": f"images/{s}{j}.png", "label": f"{100 * (i + 1) + j}|ب|6", "plate_type": "private"} for j in range(4)]
        _csv(syn / f"{s}.csv", rows)
    labelled = [{"filename": f"images/r{j}.png", "label": f"{5000 + j}|د|{1 + j % 9}", "source": "x"} for j in range(20)]
    labelled += [
        {"filename": "images/dup.png", "label": "5000|د|1", "source": "x"},  # same car again
        {"filename": "images/blur.png", "label": "-", "source": "x"},  # unreadable
        {"filename": "images/todo.png", "label": "", "source": "x"},  # not labelled
        {"filename": "images/bad.png", "label": "ABC", "source": "x"},  # not a plate
        {"filename": "images/clash.png", "label": "100|ب|6", "source": "x"},  # same text as a synthetic train plate
    ]
    _csv(real / "labels.csv", labelled, ["filename", "label", "source"])
    return syn, real


def test_mix_splits_by_plate_text_and_oversamples_real(tmp_path, capsys):
    syn, real = _setup(tmp_path)
    out = tmp_path / "mix"
    assert build_ocr_mix.main(["--synthetic", str(syn), "--real", str(real), "--out", str(out), "--real-repeat", "3"]) == 0
    train, val, test = (_read(out / f"{s}.csv") for s in ("train", "val", "test"))

    # no plate text in two splits (train_ocr.load_splits would refuse it)
    labels = [{r["label"] for r in rows} for rows in (train, val, test)]
    assert not (labels[0] & labels[1]) and not (labels[0] & labels[2]) and not (labels[1] & labels[2])
    # both crops of the same car stay together
    dup_splits = {s for s, rows in (("train", train), ("val", val), ("test", test)) for r in rows if r["label"] == "5000|د|1"}
    assert len(dup_splits) == 1
    # val is real only; real train rows are repeated
    assert val and all(r["plate_type"] == "real" for r in val)
    real_train = [r for r in train if r["plate_type"] == "real"]
    assert len(real_train) == 3 * len({r["filename"] for r in real_train})
    # skipped rows never reach the files
    names = {Path(r["filename"]).name for rows in (train, val, test) for r in rows}
    assert not names & {"blur.png", "todo.png", "bad.png"}
    # every filename resolves from the out folder to the original image location
    assert {(out / r["filename"]).resolve().parent for r in train} <= {(syn / "images").resolve(), (real / "images").resolve()}
    # real_test.csv points into the crops folder, as eval_ocr_real.py expects
    real_test = _read(out / "real_test.csv")
    assert real_test and all(r["filename"].startswith("images/") for r in real_test)
    assert {r["label"] for r in real_test} == {r["label"] for r in test if r["plate_type"] == "real"}
    assert "skipped" in capsys.readouterr().out


def test_mix_refuses_without_labelled_real_crops(tmp_path):
    syn, real = _setup(tmp_path)
    _csv(real / "labels.csv", [{"filename": "images/a.png", "label": "", "source": "x"}], ["filename", "label", "source"])
    assert build_ocr_mix.main(["--synthetic", str(syn), "--real", str(real), "--out", str(tmp_path / "mix")]) == 1

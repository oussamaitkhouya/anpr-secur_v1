"""Train the YOLO plate detector on the dataset built by scripts/prepare_detector_data.py.

Two modes:
    smoke  1 epoch on 200 training images (and up to 50 validation / 50 test images), on CPU.
           Checks the whole pipeline in a few minutes; the metrics mean nothing.
    full   the whole dataset on CUDA (fails if CUDA is unavailable).

After training, the best checkpoint (chosen by Ultralytics on the validation split) is evaluated
once on the test split, then copied to models/plate_detector_<mode>.pt (git-ignored), next to a
JSON file with its precision, recall, mAP50, mAP50-95 and SHA-256.
Ultralytics' own run (curves, last.pt, ...) stays under runs/detector/<mode>.

Usage (from the repo root, PowerShell):
    python scripts/prepare_detector_data.py --seed 0
    $env:PYTHONPATH = "src"
    python -m anpr.training.train_detector --mode smoke
    python -m anpr.training.train_detector --mode full --epochs 100
"""

import argparse
import hashlib
import json
import logging
import random
import shutil
from pathlib import Path

import yaml

from anpr.utils.config import REPO_ROOT

log = logging.getLogger("train_detector")

IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png", ".bmp"}
MODES = {
    # small images and batch keep a CPU epoch short; plots=False avoids a font download
    "smoke": {"epochs": 1, "train_images": 200, "val_images": 50, "test_images": 50,
              "device": "cpu", "imgsz": 320, "batch": 8, "workers": 0, "plots": False},
    "full": {"epochs": 100, "train_images": None, "val_images": None, "test_images": None,
             "device": 0, "imgsz": 640, "batch": 16, "workers": 4, "plots": True},
}
import torch
if not torch.cuda.is_available():
    MODES["full"]["device"] = "cpu"


def load_data_yaml(path: Path) -> dict:
    """Read an Ultralytics dataset file and resolve its split entries to absolute paths."""
    if not path.is_file():
        raise SystemExit(f"{path} not found; build it with scripts/prepare_detector_data.py")
    with open(path, encoding="utf-8") as f:
        data = yaml.safe_load(f)
    root = Path(data.get("path") or path.parent)
    if not root.is_absolute():
        root = path.parent / root
    for split in ("train", "val", "test"):
        if split in data:
            data[split] = str(root / data[split])
    data["path"] = str(root)
    return data


def list_images(split_dir: Path) -> list[Path]:
    return sorted(p for p in split_dir.iterdir() if p.suffix.lower() in IMAGE_SUFFIXES)


def subset_data_yaml(data: dict, out_dir: Path, limits: dict[str, int | None], seed: int) -> Path:
    """Write a dataset file whose splits are seeded random samples of at most limits[split] images.

    Ultralytics accepts a .txt file of image paths as a split; it finds each label by replacing
    /images/ with /labels/ in the path, so the original label files are used unchanged.
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    subset = dict(data)
    for split, limit in limits.items():
        if split not in data:
            continue
        images = list_images(Path(data[split]))
        if not images:
            raise SystemExit(f"no images in {data[split]}")
        if limit is not None and len(images) > limit:
            images = sorted(random.Random(seed).sample(images, limit))
        list_file = out_dir / f"{split}.txt"
        list_file.write_text("".join(f"{p.resolve()}\n" for p in images), encoding="utf-8")
        subset[split] = str(list_file)
    path = out_dir / "plates_subset.yaml"
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(subset, f, sort_keys=False)
    return path


def box_metrics(results) -> dict[str, float]:
    """Pull the headline detection metrics out of an Ultralytics DetMetrics object."""
    box = results.box
    return {"precision": float(box.mp), "recall": float(box.mr), "map50": float(box.map50),
            "map50_95": float(box.map)}


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mode", choices=list(MODES), default="smoke")
    p.add_argument("--data", type=Path, default=REPO_ROOT / "data" / "detector" / "plates.yaml")
    p.add_argument("--model", default="yolo11n.pt",
                   help="pretrained weights (downloaded into --models-dir) or an architecture .yaml (from scratch)")
    p.add_argument("--epochs", type=int, default=None, help="override the mode's epoch count")
    p.add_argument("--imgsz", type=int, default=None, help="override the mode's image size")
    p.add_argument("--batch", type=int, default=None, help="override the mode's batch size")
    p.add_argument("--project", type=Path, default=REPO_ROOT / "runs" / "detector")
    p.add_argument("--models-dir", type=Path, default=REPO_ROOT / "models")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args(argv)
    if args.epochs is not None and args.epochs < 1:
        p.error("--epochs must be at least 1")
    if args.mode == "full":
        import torch

        if not torch.cuda.is_available():
            log.warning("CUDA is not available; running full training on CPU. This will be very slow.")
    return args


def main(argv: list[str] | None = None) -> dict:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    from ultralytics import YOLO  # slow import; keep --help fast

    cfg = dict(MODES[args.mode])
    for key in ("epochs", "imgsz", "batch"):
        if getattr(args, key) is not None:
            cfg[key] = getattr(args, key)

    data = load_data_yaml(args.data)
    run_dir = args.project / args.mode
    limits = {split: cfg.pop(f"{split}_images") for split in ("train", "val", "test")}
    data_file = subset_data_yaml(data, run_dir / "data", limits, args.seed)

    args.models_dir.mkdir(parents=True, exist_ok=True)
    model_src = args.model
    if model_src.endswith(".pt") and not Path(model_src).parent.parts:
        # bare name such as yolo11n.pt: Ultralytics downloads it to this path, keeping weights in models/
        model_src = str(args.models_dir / model_src)
    model = YOLO(model_src)
    log.info("mode=%s model=%s data=%s %s", args.mode, model_src, data_file, cfg)

    model.train(data=str(data_file), project=str(args.project), name=args.mode, exist_ok=True,
                seed=args.seed, deterministic=True, verbose=False, **cfg)
    best_run = Path(model.trainer.best)
    if not best_run.is_file():
        raise SystemExit(f"training produced no best checkpoint at {best_run}")

    # Model selection used validation only; test is evaluated once, on the chosen checkpoint.
    best = YOLO(str(best_run))
    eval_kw = {"data": str(data_file), "imgsz": cfg["imgsz"], "batch": cfg["batch"], "device": cfg["device"],
               "plots": False, "verbose": False, "project": str(args.project), "exist_ok": True}
    metrics = {"val": box_metrics(best.val(split="val", name=f"{args.mode}_val", **eval_kw))}
    if "test" in data:
        metrics["test"] = box_metrics(best.val(split="test", name=f"{args.mode}_test", **eval_kw))
    for split, m in metrics.items():
        log.info("%-4s precision=%.3f recall=%.3f mAP50=%.3f mAP50-95=%.3f",
                 split, m["precision"], m["recall"], m["map50"], m["map50_95"])

    weights = args.models_dir / f"plate_detector_{args.mode}.pt"
    shutil.copy2(best_run, weights)
    results = {
        "mode": args.mode,
        "weights": str(weights),
        "sha256": sha256(weights),  # lets later steps verify they load exactly this file
        "base_model": args.model,
        "data": str(args.data),
        "train_cfg": cfg,
        "metrics": metrics,
        "run_dir": str(run_dir),
    }
    with open(weights.with_suffix(".json"), "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2)
    log.info("best weights %s (sha256 %s...)", weights, results["sha256"][:12])
    return results


if __name__ == "__main__":
    main()

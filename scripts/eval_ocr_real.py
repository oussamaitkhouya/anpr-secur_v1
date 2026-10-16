"""Score an OCR checkpoint on REAL plate crops (data/real_crops, from export_real_crops.py).

    .venv\\Scripts\\python scripts\\eval_ocr_real.py --weights runs/ocr/best.pt
    .venv\\Scripts\\python scripts\\eval_ocr_real.py --weights runs/ocr_overfit/best.pt
    .venv\\Scripts\\python scripts\\eval_ocr_real.py --weights runs/ocr_real/best.pt --labels data/ocr_mix/real_test.csv

After fine-tuning on real crops (scripts/build_ocr_mix.py), score ONLY the held-out real test
plates with --labels: the other crops were seen in training and would inflate the score.

Synthetic test accuracy says little about real plates. This reads every crop with the given
checkpoint and writes predictions.csv next to the labels (useful when labelling: correct the
prediction instead of typing from scratch). For the crops whose `label` you filled in, it
reports full-plate accuracy, character accuracy and the share of reads that are valid plates.
"""

import argparse
import csv
import os
import sys
from pathlib import Path

import cv2

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from anpr.pipeline.live import FrameDetector
from anpr.pipeline.matcher import canonical_or_none


def char_accuracy(pred: str, target: str) -> float:
    """Share of target characters (separators excluded) read correctly at the same position."""
    p, t = pred.replace("|", ""), target.replace("|", "")
    return sum(a == b for a, b in zip(p, t, strict=False)) / max(len(t), 1)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", type=Path, required=True)
    ap.add_argument("--crops", type=Path, default=REPO / "data" / "real_crops")
    ap.add_argument("--labels", type=Path, default=None,
                    help="CSV of crops to score (filename relative to --crops, label); default: <crops>/labels.csv")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args(argv)

    labels_csv = args.labels or args.crops / "labels.csv"
    with open(labels_csv, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))[: args.limit]
    os.environ.setdefault("ANPR_OCR_WEIGHTS", str(args.weights))
    det = FrameDetector(ocr_path=args.weights)

    out, scored = [], []
    for r in rows:
        img = cv2.imread(str(args.crops / r["filename"]))
        if img is None:
            continue
        text, conf, _ = det.read_plate(img)
        text = "" if text in (None, "EMPTY_OCR") else text
        canonical = canonical_or_none(text) if text else None
        out.append({"filename": r["filename"], "prediction": canonical or text, "valid": int(canonical is not None), "confidence": round(conf, 4)})
        label = (r.get("label") or "").strip()
        if label and label != "-":  # "-" = unreadable to a human (scripts/label_crops.py)
            gold = canonical_or_none(label) or label
            scored.append((canonical or text, gold))

    suffix = f"_{args.labels.stem}" if args.labels else ""  # keep the full-set drafts file intact
    pred_path = args.crops / f"predictions_{args.weights.parent.name}{suffix}.csv"
    with open(pred_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["filename", "prediction", "valid", "confidence"])
        w.writeheader()
        w.writerows(out)

    valid = sum(o["valid"] for o in out) / max(len(out), 1)
    print(f"{len(out)} crops read with {args.weights}; {valid:.1%} gave a valid Moroccan plate. Predictions: {pred_path}")
    if scored:
        plate_acc = sum(p == g for p, g in scored) / len(scored)
        char_acc = sum(char_accuracy(p, g) for p, g in scored) / len(scored)
        print(f"On {len(scored)} labelled real plates: plate accuracy {plate_acc:.1%}, character accuracy {char_acc:.1%}")
    else:
        print("No labelled crops yet: fill the label column of labels.csv to measure real accuracy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

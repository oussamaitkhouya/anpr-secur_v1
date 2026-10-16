"""Cut the plates out of the real Moroccan photos (YOLO box labels) for OCR evaluation.

    .venv\\Scripts\\python scripts\\export_real_crops.py
    .venv\\Scripts\\python scripts\\export_real_crops.py --src data/detector/moroccan_split --out data/real_crops

The detector dataset has boxes but no plate text, so it cannot train the OCR. This writes one
PNG per plate (with a small margin, like the detector's crops at run time) and a labels.csv with
an empty `label` column. Fill in the text of as many plates as you can, as number|letter|region
(e.g. 56651|أ|4); leave unreadable ones empty. scripts/eval_ocr_real.py then measures a model on
the labelled rows. Existing labels are kept when the script runs again.
"""

import argparse
import csv
import sys
from pathlib import Path

import cv2

REPO = Path(__file__).resolve().parents[1]
MARGIN = 0.06  # extra box width/height on each side


def _label_for(img_path: Path) -> Path:
    """YOLO layout: .../images/<split>/x.jpg -> .../labels/<split>/x.txt; else x.txt beside the image."""
    parts = list(img_path.parts)
    if "images" in parts:
        i = len(parts) - 1 - parts[::-1].index("images")
        candidate = Path(*parts[:i], "labels", *parts[i + 1:]).with_suffix(".txt")
        if candidate.is_file():
            return candidate
    return img_path.with_suffix(".txt")


def _source(img_path: Path) -> str:
    """Where a crop came from: relative to the repo when inside it, else the absolute path."""
    try:
        return img_path.relative_to(REPO).as_posix()
    except ValueError:
        return str(img_path)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--src", type=Path, default=REPO / "data" / "detector" / "moroccan_split")
    p.add_argument("--out", type=Path, default=REPO / "data" / "real_crops")
    p.add_argument("--min-width", type=int, default=40, help="skip plates narrower than this (pixels)")
    args = p.parse_args(argv)
    # Relative paths are taken from the current folder; the CSV stores sources relative to the repo.
    args.src, args.out = args.src.resolve(), args.out.resolve()

    images = sorted(f for f in args.src.rglob("*") if f.suffix.lower() in {".jpg", ".jpeg", ".png"})
    if not images:
        print(f"No images under {args.src}", file=sys.stderr)
        return 1
    out_img = args.out / "images"
    out_img.mkdir(parents=True, exist_ok=True)
    labels_csv = args.out / "labels.csv"
    existing = {}
    if labels_csv.is_file():
        with open(labels_csv, encoding="utf-8", newline="") as f:
            existing = {r["filename"]: r.get("label", "") for r in csv.DictReader(f)}

    rows, skipped = [], 0
    for img_path in images:
        label_path = _label_for(img_path)
        if not label_path.is_file():
            continue
        img = cv2.imread(str(img_path))
        if img is None:
            continue
        h, w = img.shape[:2]
        for i, line in enumerate(label_path.read_text().split("\n")):
            parts = line.split()
            if len(parts) != 5:
                continue
            _, cx, cy, bw, bh = (float(v) for v in parts)
            mx, my = bw * MARGIN, bh * MARGIN * 2
            x1, y1 = max(0, int((cx - bw / 2 - mx) * w)), max(0, int((cy - bh / 2 - my) * h))
            x2, y2 = min(w, int((cx + bw / 2 + mx) * w)), min(h, int((cy + bh / 2 + my) * h))
            if x2 - x1 < args.min_width or y2 - y1 < 8:
                skipped += 1
                continue
            name = f"images/{img_path.stem}_{i}.png"
            cv2.imwrite(str(args.out / name), img[y1:y2, x1:x2])
            rows.append({"filename": name, "label": existing.get(name, ""), "source": _source(img_path)})

    with open(labels_csv, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=["filename", "label", "source"])
        writer.writeheader()
        writer.writerows(rows)
    labelled = sum(1 for r in rows if r["label"])
    print(f"{len(rows)} plate crops in {args.out} ({skipped} too small skipped); {labelled} already labelled.")
    print(f"Fill the 'label' column of {labels_csv} (number|letter|region), then run scripts/eval_ocr_real.py.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Merge synthetic plate datasets generated in parallel into one OCR training set.

    .venv\\Scripts\\python scripts\\merge_ocr_parts.py --parts data/synthetic_ocr_parts --out data/synthetic_ocr

Each part was written by generate_dataset.py with its own seed. Their own train/val/test files are
ignored: the merged rows are split ONCE, by unique plate text, so a plate never appears in two
splits (separate per-part splits could put the same text in train and test). Images are moved,
renamed <part>_<file>, so nothing is duplicated on disk.
"""

import argparse
import csv
import shutil
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from anpr.data.splits import split_by_label

FIELDS = ["filename", "label", "plate_type"]


def write(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, FIELDS)
        w.writeheader()
        w.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--parts", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args(argv)

    parts = sorted(p for p in args.parts.iterdir() if (p / "labels.csv").is_file())
    if not parts:
        print(f"No finished parts (labels.csv) under {args.parts}", file=sys.stderr)
        return 1
    (args.out / "images").mkdir(parents=True, exist_ok=True)
    rows = []
    for part in parts:
        with open(part / "labels.csv", encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                src = part / r["filename"]
                name = f"images/{part.name}_{Path(r['filename']).name}"
                shutil.move(str(src), str(args.out / name))
                rows.append({"filename": name, "label": r["label"], "plate_type": r["plate_type"]})
    write(args.out / "labels.csv", rows)
    splits = split_by_label(rows, seed=args.seed)
    for name, split_rows in splits.items():
        write(args.out / f"{name}.csv", split_rows)
    print(f"merged {len(parts)} parts, {len(rows)} plates into {args.out}: " + ", ".join(f"{k}={len(v)}" for k, v in splits.items()))
    return 0


if __name__ == "__main__":
    sys.exit(main())

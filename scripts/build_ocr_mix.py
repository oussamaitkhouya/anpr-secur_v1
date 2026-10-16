"""Build an OCR training set that mixes synthetic plates with your labelled REAL crops.

    .venv\\Scripts\\python scripts\\build_ocr_mix.py
    .venv\\Scripts\\python scripts\\build_ocr_mix.py --synthetic data/synthetic_ocr --real data/real_crops --real-repeat 6

Reads the synthetic split (train/val/test.csv from generate_dataset.py or merge_ocr_parts.py) and
data/real_crops/labels.csv (labelled with scripts/label_crops.py), and writes to --out:

- train.csv  synthetic train + real train, each real row repeated --real-repeat times so a
             thousand real plates are not drowned by tens of thousands of synthetic ones
- val.csv    real val only: the best epoch is the one that reads REAL plates best
- test.csv   real test + synthetic test; train_ocr reports them apart (plate_type "real")
- real_test.csv  the real test crops, for scripts/eval_ocr_real.py --labels

Real crops are split by plate text (70/15/15, seeded), so the same plate never appears in two
splits. Synthetic rows whose text falls in another split are dropped for the same reason.
Unreadable ("-"), empty and invalid labels are skipped and counted. Images are not copied:
filenames point back to their folders, relative to --out.
"""

import argparse
import csv
import os
import sys
from collections import Counter
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from anpr.data.splits import split_by_label
from anpr.pipeline.matcher import canonical_or_none

FIELDS = ["filename", "label", "plate_type"]
REAL = "real"


def read(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def write(path: Path, rows: list[dict], fields: list[str] = FIELDS) -> None:
    with open(path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fields, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows)


def rel(target: Path, out: Path) -> str:
    """Path of target as seen from out, with forward slashes (works on Windows and Linux)."""
    return Path(os.path.relpath(target, out)).as_posix()


def real_rows(real_dir: Path) -> tuple[list[dict], Counter]:
    """Labelled real crops with canonical labels; skipped ones counted by reason."""
    rows, skipped = [], Counter()
    for r in read(real_dir / "labels.csv"):
        label = (r.get("label") or "").strip()
        if not label:
            skipped["not labelled"] += 1
        elif label == "-":
            skipped["unreadable"] += 1
        elif (canon := canonical_or_none(label)) is None:
            skipped["not a valid plate"] += 1
        else:
            rows.append({"filename": r["filename"], "label": canon, "plate_type": REAL})
    return rows, skipped


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--synthetic", type=Path, default=REPO / "data" / "synthetic_ocr")
    ap.add_argument("--real", type=Path, default=REPO / "data" / "real_crops")
    ap.add_argument("--out", type=Path, default=REPO / "data" / "ocr_mix")
    ap.add_argument("--real-repeat", type=int, default=5, help="copies of each real train row (oversampling)")
    ap.add_argument("--synthetic-limit", type=int, default=None, help="use at most N synthetic train rows")
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args(argv)
    if args.real_repeat < 1:
        ap.error("--real-repeat must be at least 1")
    syn_dir, real_dir, out = args.synthetic.resolve(), args.real.resolve(), args.out.resolve()

    for f in ("train.csv", "val.csv", "test.csv"):
        if not (syn_dir / f).is_file():
            print(f"{syn_dir} has no {f}: generate synthetic plates first (scripts/generate_dataset.py)", file=sys.stderr)
            return 1
    if not (real_dir / "labels.csv").is_file():
        print(f"{real_dir} has no labels.csv: run scripts/export_real_crops.py and label the crops", file=sys.stderr)
        return 1

    real, skipped = real_rows(real_dir)
    if len({r["label"] for r in real}) < 3:
        print("Fewer than 3 distinct labelled real plates: label more crops first.", file=sys.stderr)
        return 1
    real_split = split_by_label(real, fractions=(0.7, 0.15, 0.15), seed=args.seed)
    owner = {r["label"]: s for s, rows in real_split.items() for r in rows}  # plate text -> its split

    out.mkdir(parents=True, exist_ok=True)
    syn = {s: read(syn_dir / f"{s}.csv") for s in ("train", "val", "test")}
    if args.synthetic_limit is not None:
        syn["train"] = syn["train"][: args.synthetic_limit]
    dropped = 0
    for s, rows in syn.items():
        kept = [r for r in rows if owner.get(r["label"], s) == s]
        dropped += len(rows) - len(kept)
        syn[s] = [{**r, "filename": rel(syn_dir / r["filename"], out)} for r in kept]
    for s, rows in real_split.items():
        real_split[s] = [{**r, "filename": rel(real_dir / r["filename"], out)} for r in rows]

    train = syn["train"] + real_split["train"] * args.real_repeat
    write(out / "train.csv", train)
    write(out / "val.csv", real_split["val"])
    write(out / "test.csv", real_split["test"] + syn["test"])
    # for eval_ocr_real.py: filenames relative to the crops folder, as in labels.csv
    write(out / "real_test.csv", [{**r, "filename": rel(out / r["filename"], real_dir)} for r in real_split["test"]],
          ["filename", "label"])

    n = {s: len(rows) for s, rows in real_split.items()}
    print(f"Real crops: {len(real)} usable ({n['train']} train, {n['val']} val, {n['test']} test)"
          + (f"; skipped {dict(skipped)}" if skipped else ""))
    print(f"Synthetic: {len(syn['train'])} train, {len(syn['test'])} test"
          + (f"; {dropped} dropped because their text is a real plate in another split" if dropped else ""))
    print(f"Wrote {out}: train {len(train)} rows (real x{args.real_repeat}), val {n['val']} (real only), "
          f"test {n['test'] + len(syn['test'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

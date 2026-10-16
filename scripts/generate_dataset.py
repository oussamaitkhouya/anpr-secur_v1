"""Generate N synthetic Moroccan plates into data/synthetic/ with a labels CSV.

Writes images/<index>.png and labels.csv (filename,label,plate_type), plus an 80/10/10
train.csv / val.csv / test.csv split with the same columns. The split is by unique
label: a plate text never appears in two splits. Every label is checked with the plate
validator before it is written; the run stops on the first invalid one. --seed makes
the output reproducible (labels, pixels and split).

Usage:
    python scripts/generate_dataset.py --n 1000
    python scripts/generate_dataset.py --n 200 --types private taxi --seed 7 --no-augment
"""

import argparse
import csv
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))  # allow running without installing the package

from anpr.data.augment import apply, build_light_augment
from anpr.data.plate_generator import PlateGenerator
from anpr.data.splits import split_by_label
from anpr.pipeline.validator import parse_plate
from anpr.utils.config import default_plate_format

FIELDS = ["filename", "label", "plate_type"]


def main(argv: list[str] | None = None) -> Path:
    fmt = default_plate_format()
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--n", type=int, required=True, help="number of plates to generate")
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "data" / "synthetic")
    parser.add_argument("--types", nargs="+", choices=sorted(fmt.plate_types), help="default: all types")
    parser.add_argument("--seed", type=int, default=None, help="same seed -> identical dataset")
    parser.add_argument("--no-augment", action="store_true", help="render clean plates only")
    parser.add_argument("--variety", action="store_true",
                        help="vary fonts, weights and condensing (closer to real plates; for OCR training)")
    args = parser.parse_args(argv)
    if args.n < 1:
        parser.error("--n must be at least 1")

    images_dir = args.out / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    gen = PlateGenerator(fmt, seed=args.seed, augment=not args.no_augment, variety=args.variety)
    augment = None if args.no_augment else build_light_augment(seed=args.seed)
    types = args.types or sorted(fmt.plate_types)

    width = max(6, len(str(args.n)))
    rows = []
    for i in range(args.n):
        result = gen.generate(types[i % len(types)])
        plate = parse_plate(result.label, fmt)
        if plate is None or plate.canonical() != result.label:
            raise ValueError(f"generator produced a label the validator rejects: {result.label!r}")
        image = apply(augment, result.image) if augment is not None else result.image
        name = f"{i:0{width}d}.png"
        image.save(images_dir / name)
        rows.append({"filename": f"images/{name}", "label": result.label, "plate_type": result.plate_type})

    csv_path = args.out / "labels.csv"
    write_csv(csv_path, rows)
    # 80/10/10 by unique label, so no plate text is shared between train, val and test
    splits = split_by_label(rows, seed=args.seed)
    for name, split_rows in splits.items():
        write_csv(args.out / f"{name}.csv", split_rows)

    counts = ", ".join(f"{name}={len(r)}" for name, r in splits.items())
    print(f"wrote {args.n} plates to {args.out} (labels.csv; {counts})")
    return csv_path


def write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, FIELDS)
        writer.writeheader()
        writer.writerows(rows)


if __name__ == "__main__":
    main()

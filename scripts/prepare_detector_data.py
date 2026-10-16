"""Convert CCPD images into a YOLO detection dataset (one class: plate) for detector pre-training.

Output under --out:
    images/{train,val,test}/<subset>__<ccpd name>.jpg   hard link (default) or copy of the original
    labels/{train,val,test}/<same stem>.txt             "0 x_center y_center width height", normalised 0-1
    plates.yaml                                         dataset file for Ultralytics
    preview/<split>__<image stem>.jpg                   with --preview: 12 images with their boxes drawn

The CCPD originals are only read, never modified. Note that a hard link IS the original file
under a second name: do not edit images in --out in place (use --mode copy if a tool might).
Malformed CCPD names and unreadable images are skipped and counted in the summary.

Usage:
    python scripts/prepare_detector_data.py --seed 0
    python scripts/prepare_detector_data.py --subsets ccpd_base ccpd_weather --max-images 5000 --preview
"""

import argparse
import os
import random
import shutil
import sys
from collections import Counter
from pathlib import Path

import yaml
from PIL import Image, ImageDraw, UnidentifiedImageError

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))  # allow running without installing the package

from anpr.data.ccpd import image_size, list_subset, scan
from anpr.data.splits import SPLITS, split_by_label

PLATE_CLASS = 0
PREVIEW_COUNT = 12
OUTPUT_ITEMS = ("images", "labels", "preview", "plates.yaml")  # the only things this script creates or deletes


def yolo_line(bbox: tuple[int, int, int, int], width: int, height: int) -> str | None:
    """Pixel box (x1, y1, x2, y2) -> YOLO "class xc yc w h" normalised by image size.

    The box is clipped to the image first; returns None if nothing is left.
    """
    x1, y1, x2, y2 = bbox
    x1, x2 = max(0, min(x1, width)), max(0, min(x2, width))
    y1, y2 = max(0, min(y1, height)), max(0, min(y2, height))
    if x2 <= x1 or y2 <= y1:
        return None
    xc, yc = (x1 + x2) / 2 / width, (y1 + y2) / 2 / height
    w, h = (x2 - x1) / width, (y2 - y1) / height
    return f"{PLATE_CLASS} {xc:.6f} {yc:.6f} {w:.6f} {h:.6f}"


def place(src: Path, dst: Path, mode: str) -> str:
    """Hard-link or copy src to dst; returns the method actually used.

    Hard links need src and dst on the same NTFS/ext4/... volume; otherwise fall back to a copy.
    """
    if mode == "hardlink":
        try:
            os.link(src, dst)
            return "hardlink"
        except OSError:
            pass
    shutil.copy2(src, dst)
    return "copy"


def check_paths(src: Path, out: Path) -> None:
    src, out = src.resolve(), out.resolve()
    if out == src or out.is_relative_to(src) or src.is_relative_to(out):
        raise SystemExit(f"--out ({out}) must not be inside --src ({src}) or contain it")
    if not src.is_dir():
        raise SystemExit(f"--src not found: {src}")


def prepare_output(out: Path, overwrite: bool) -> None:
    existing = [out / name for name in OUTPUT_ITEMS if (out / name).exists()]
    if existing and not overwrite:
        names = ", ".join(p.name for p in existing)
        raise SystemExit(f"{out} already has {names}; pass --overwrite to replace them")
    for p in existing:
        # removing a hard link only removes that name; the CCPD original is untouched
        shutil.rmtree(p) if p.is_dir() else p.unlink()
    for kind in ("images", "labels"):
        for split in SPLITS:
            (out / kind / split).mkdir(parents=True, exist_ok=True)


def write_yaml(out: Path) -> Path:
    path = out / "plates.yaml"
    data = {
        "path": str(out.resolve()),
        **{split: f"images/{split}" for split in SPLITS},
        "names": {PLATE_CLASS: "plate"},
    }
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False)
    return path


def write_preview(out: Path, seed: int, count: int = PREVIEW_COUNT) -> list[Path]:
    """Draw the boxes read back from the YOLO label files, so the preview checks the conversion itself."""
    images = sorted((out / "images").glob("*/*"))
    chosen = random.Random(seed).sample(images, min(count, len(images)))
    preview_dir = out / "preview"
    preview_dir.mkdir(exist_ok=True)
    written = []
    for img_path in sorted(chosen):
        split = img_path.parent.name
        label_path = out / "labels" / split / f"{img_path.stem}.txt"
        with Image.open(img_path) as src_img:
            img = src_img.convert("RGB")
        draw = ImageDraw.Draw(img)
        w, h = img.size
        for line in label_path.read_text(encoding="utf-8").splitlines():
            _, xc, yc, bw, bh = (float(v) for v in line.split())
            box = ((xc - bw / 2) * w, (yc - bh / 2) * h, (xc + bw / 2) * w, (yc + bh / 2) * h)
            draw.rectangle(box, outline=(255, 0, 0), width=max(2, w // 200))
        # named after the source, so a wrong box can be traced back to its CCPD file
        dst = preview_dir / f"{split}__{img_path.stem}.jpg"
        img.save(dst, quality=95, subsampling=0)  # no chroma subsampling: thin red lines stay red
        written.append(dst)
    return written


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--src", type=Path, default=REPO_ROOT / "data" / "external" / "CCPD2019")
    p.add_argument("--out", type=Path, default=REPO_ROOT / "data" / "detector")
    p.add_argument("--subsets", nargs="+", default=["ccpd_base"], help="CCPD subset folders to read")
    p.add_argument("--max-images", type=int, default=20000, help="random sample size (seeded)")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--mode", choices=["hardlink", "copy"], default="hardlink",
                   help="how images reach --out; hardlink falls back to copy across drives")
    p.add_argument("--overwrite", action="store_true", help="replace a previous conversion in --out")
    p.add_argument("--preview", action="store_true", help=f"save {PREVIEW_COUNT} images with boxes to --out/preview")
    args = p.parse_args(argv)
    if args.max_images < 1:
        p.error("--max-images must be at least 1")
    return args


def main(argv: list[str] | None = None) -> dict:
    args = parse_args(argv)
    check_paths(args.src, args.out)

    samples, skipped, examples = [], Counter(), {}
    for subset in args.subsets:
        try:
            result = scan(list_subset(args.src, subset))
        except FileNotFoundError as e:
            raise SystemExit(str(e)) from None
        samples += [(subset, s) for s in result.samples]
        skipped.update(result.skipped)
        for reason, name in result.skipped_examples.items():
            examples.setdefault(reason, f"{subset}/{name}")
    found = len(samples)

    rng = random.Random(args.seed)
    if len(samples) > args.max_images:
        samples = rng.sample(samples, args.max_images)

    rows = []
    for subset, sample in samples:
        try:
            width, height = image_size(sample.path)
        except (OSError, UnidentifiedImageError):
            skipped["unreadable image"] += 1
            examples.setdefault("unreadable image", f"{subset}/{sample.path.name}")
            continue
        line = yolo_line(sample.annotation.bbox, width, height)
        if line is None:
            skipped["box outside image"] += 1
            examples.setdefault("box outside image", f"{subset}/{sample.path.name}")
            continue
        rows.append({"key": f"{subset}__{sample.path.name}", "path": sample.path, "line": line})
    rows.sort(key=lambda r: r["key"])  # order independent of sampling, before the seeded split

    prepare_output(args.out, args.overwrite)
    splits = split_by_label(rows, seed=args.seed, key="key")  # keys are unique, so this is a plain 80/10/10
    methods = Counter()
    for split, split_rows in splits.items():
        for row in split_rows:
            dst = args.out / "images" / split / row["key"]
            methods[place(row["path"], dst, args.mode)] += 1
            (args.out / "labels" / split / f"{dst.stem}.txt").write_text(row["line"] + "\n", encoding="utf-8")
    yaml_path = write_yaml(args.out)
    previews = write_preview(args.out, args.seed) if args.preview else []

    summary = {
        "found": found,
        "sampled": len(samples),
        "splits": {s: len(r) for s, r in splits.items()},
        "skipped": dict(skipped),
        "methods": dict(methods),
        "yaml": yaml_path,
        "previews": previews,
    }
    print(f"CCPD subsets {', '.join(args.subsets)}: {found} annotated images found, {len(samples)} sampled")
    print("images per split: " + ", ".join(f"{s}={n}" for s, n in summary["splits"].items()))
    print(f"skipped: {sum(skipped.values())}")
    for reason, n in sorted(skipped.items()):
        print(f"  {reason}: {n} (e.g. {examples[reason]})")
    print("placed by: " + ", ".join(f"{m}={n}" for m, n in sorted(methods.items())))
    print(f"wrote {yaml_path}")
    if previews:
        print(f"preview: {len(previews)} images in {previews[0].parent}")
    return summary


if __name__ == "__main__":
    main()

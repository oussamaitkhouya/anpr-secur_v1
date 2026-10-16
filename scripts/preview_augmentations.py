"""Save preview grids of synthetic plates and augmentations for visual inspection.

Writes two images to --out:
  augment_grid.png  one row per augmentation (same base plates in each column)
  scenes_grid.png   augmented plates pasted onto backgrounds, plate box in green

Backgrounds are read from --backgrounds (jpg/png). If that folder is empty, a plain
synthetic backdrop is used instead; add real car photos there for a true preview.

Usage:
    python scripts/preview_augmentations.py
    python scripts/preview_augmentations.py --cols 6 --seed 3 --backgrounds path/to/cars
"""

import argparse
import random
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))  # allow running without installing the package

import numpy as np
from PIL import Image, ImageDraw

from anpr.data.augment import apply, build_plate_augment, paste_plate, single_transforms
from anpr.data.plate_generator import PlateGenerator

CELL = (260, 72)      # plate cell size in augment grid
SCENE = (320, 240)    # scene cell size in scenes grid
LABEL_W = 110
BG_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def fit(img: Image.Image, size: tuple[int, int]) -> Image.Image:
    """Letterbox img into size on a grey cell."""
    cell = Image.new("RGB", size, (60, 60, 60))
    img = img.copy()
    img.thumbnail(size, Image.LANCZOS)
    cell.paste(img, ((size[0] - img.width) // 2, (size[1] - img.height) // 2))
    return cell


def grid(rows: list[tuple[str, list[Image.Image]]], cell: tuple[int, int]) -> Image.Image:
    cols = max(len(r[1]) for r in rows)
    pad = 4
    out = Image.new("RGB", (LABEL_W + cols * (cell[0] + pad), len(rows) * (cell[1] + pad)), (30, 30, 30))
    draw = ImageDraw.Draw(out)
    for r, (name, images) in enumerate(rows):
        y = r * (cell[1] + pad)
        draw.text((6, y + cell[1] // 2), name, fill="white", anchor="lm")
        for c, img in enumerate(images):
            out.paste(fit(img, cell), (LABEL_W + c * (cell[0] + pad), y))
    return out


def synthetic_background(size: tuple[int, int], rng: random.Random) -> Image.Image:
    """Vertical grey gradient with noise: a stand-in when no car photos are available."""
    w, h = size
    top, bottom = rng.randint(90, 200), rng.randint(20, 90)
    col = np.linspace(top, bottom, h, dtype=np.float32)[:, None, None]
    arr = np.repeat(np.repeat(col, w, axis=1), 3, axis=2)
    arr += np.random.default_rng(rng.getrandbits(32)).normal(0, 6, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def load_backgrounds(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in BG_EXTS)


def main(argv: list[str] | None = None) -> tuple[Path, Path]:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "data" / "previews")
    parser.add_argument("--backgrounds", type=Path, default=REPO_ROOT / "data" / "backgrounds")
    parser.add_argument("--cols", type=int, default=5)
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args(argv)
    rng = random.Random(args.seed)
    args.out.mkdir(parents=True, exist_ok=True)

    # Clean plates (generator's own light augmentation off) so each row shows one effect.
    gen = PlateGenerator(seed=args.seed, augment=False)
    types = sorted(gen.fmt.plate_types)
    plates = [gen.generate(types[i % len(types)]).image for i in range(args.cols)]

    rows = [("original", plates)]
    for name, t in single_transforms().items():
        t.set_random_seed(args.seed)
        rows.append((name, [apply(t, p) for p in plates]))
    pipeline = build_plate_augment(seed=args.seed)
    for i in range(2):
        rows.append((f"pipeline #{i + 1}", [apply(pipeline, p) for p in plates]))
    augment_path = args.out / "augment_grid.png"
    grid(rows, CELL).save(augment_path)

    bg_paths = load_backgrounds(args.backgrounds)
    scene_rows = []
    for r in range(2):
        scenes = []
        for c in range(args.cols):
            if bg_paths:
                bg = Image.open(rng.choice(bg_paths)).convert("RGB")
            else:
                bg = synthetic_background((640, 480), rng)
            scene, box = paste_plate(apply(pipeline, plates[c]), bg, rng)
            ImageDraw.Draw(scene).rectangle(box, outline=(0, 255, 0), width=max(2, scene.width // 200))
            scenes.append(scene)
        scene_rows.append((f"scenes #{r + 1}", scenes))
    scenes_path = args.out / "scenes_grid.png"
    grid(scene_rows, SCENE).save(scenes_path)

    source = f"{len(bg_paths)} backgrounds from {args.backgrounds}" if bg_paths else "synthetic backgrounds"
    print(f"wrote {augment_path} and {scenes_path} ({source})")
    return augment_path, scenes_path


if __name__ == "__main__":
    main()

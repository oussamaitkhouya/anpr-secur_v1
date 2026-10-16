"""Train the plate CRNN on the synthetic dataset split (data/synthetic/{train,val,test}.csv),
optionally mixed with hand-labelled real crops and fine-tuned from an earlier checkpoint.

Trains on train.csv, keeps the checkpoint with the best validation full-plate accuracy,
then reloads it and evaluates once on test.csv, overall and per plate type.
Logs per epoch: train loss, validation loss, character accuracy, full-plate accuracy.
Writes metrics.csv, best.pt and results.json to --out.

--overfit is a sanity check instead: it trains and evaluates on every row of labels.csv.

--real data/real_crops mixes in the real crops (anpr.data.real_plates: split by plate, invalid
labels skipped and listed). Real plates then decide everything that matters: the best epoch is
picked on REAL validation plates, and the reported test score is on held-out REAL plates. Each
epoch trains on every real train crop --real-repeat times (each copy augmented differently) plus
a fresh random sample of synthetic plates (--synthetic-ratio per real image), so the model keeps
seeing rare letters and regions the real photos lack. Synthetic plates whose label is a real
val/test plate are left out. The synthetic test split is still scored, to catch forgetting.

--init runs/ocr/best.pt starts from that checkpoint (same charset and image size required)
instead of random weights; the default learning rate then drops to 3e-4 so the fine-tune does
not wipe out what it already knows.

--augment takes 'plate' (the default when the flag is bare) or 'camera' (webcam/phone
conditions) for synthetic rows; real rows always use build_real_augment. An alternative to
--real is a prebuilt mixed dataset from scripts/build_ocr_mix.py, passed as --data.

Usage (from the repo root, PowerShell):
    python scripts/generate_dataset.py --n 2000 --seed 0
    $env:PYTHONPATH = "src"
    python -m anpr.training.train_ocr --epochs 2 --limit 256        # CPU smoke test
    python -m anpr.training.train_ocr --epochs 30 --augment --gpu   # full run on CUDA
    python -m anpr.training.train_ocr --data data/synthetic_ocr --real data/real_crops `
        --init runs/ocr/best.pt --augment --epochs 25 --gpu --out runs/ocr_real   # real fine-tune
"""

import argparse
import csv
import json
import logging
import random
import time
from collections import defaultdict
from pathlib import Path

import torch
from PIL import Image
from torch import nn
from torch.utils.data import DataLoader, Dataset

from anpr.data.augment import (
    apply,
    build_camera_augment,
    build_plate_augment,
    build_real_augment,
)
from anpr.data.real_plates import load_real_labels, split_real
from anpr.models.ocr_crnn import CRNN, IMG_HEIGHT, IMG_WIDTH, greedy_decode, preprocess
from anpr.models.ocr_labels import BLANK, Charset, char_accuracy, plate_accuracy
from anpr.utils.config import REPO_ROOT, default_plate_format

log = logging.getLogger("train_ocr")

SPLIT_FILES = {"train": "train.csv", "val": "val.csv", "test": "test.csv"}
AUGMENTS = {"plate": build_plate_augment, "camera": build_camera_augment}


class PlateDataset(Dataset):
    """augment: one transform for every row, or {kind: transform} by row["kind"] ("synthetic", "real").
    A row may carry its own "root" (mixed real + synthetic sets); otherwise `root` is used."""

    def __init__(self, root: Path, rows: list[dict], charset: Charset, augment=None):
        self.root, self.rows, self.charset, self.augment = root, rows, charset, augment

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, i):
        row = self.rows[i]
        img = Image.open(Path(row.get("root") or self.root) / row["filename"]).convert("RGB")
        augment = self.augment.get(row.get("kind", "synthetic")) if isinstance(self.augment, dict) else self.augment
        if augment is not None:
            img = apply(augment, img)
        target = torch.tensor(self.charset.encode(row["label"]), dtype=torch.long)
        return preprocess(img), target, row["label"], row.get("plate_type", "")


def collate(batch):
    """Stack images; concatenate variable-length targets as CTCLoss expects."""
    images, targets, labels, plate_types = zip(*batch, strict=True)
    lengths = torch.tensor([len(t) for t in targets], dtype=torch.long)
    return torch.stack(images), torch.cat(targets), lengths, list(labels), list(plate_types)


def read_csv(path: Path) -> list[dict]:
    with open(path, encoding="utf-8", newline="") as f:
        return list(csv.DictReader(f))


def load_splits(data_dir: Path, limit: int | None = None) -> dict[str, list[dict]]:
    """Read train/val/test CSVs and refuse splits that share a plate label (it would inflate test accuracy)."""
    missing = [name for name in SPLIT_FILES.values() if not (data_dir / name).is_file()]
    if missing:
        raise SystemExit(f"{data_dir} has no {', '.join(missing)}; regenerate it with scripts/generate_dataset.py")
    splits = {s: read_csv(data_dir / name)[:limit] for s, name in SPLIT_FILES.items()}
    for s, rows in splits.items():
        if not rows:
            raise SystemExit(f"{SPLIT_FILES[s]} is empty; generate more plates")
    names = list(splits)
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            shared = {r["label"] for r in splits[a]} & {r["label"] for r in splits[b]}
            if shared:
                raise SystemExit(f"{len(shared)} label(s) appear in both {a} and {b}, e.g. {min(shared)!a}")
    return splits


def load_real(real_dir: Path, limit: int | None = None) -> tuple[dict[str, list[dict]], list[dict]]:
    rows, rejected = load_real_labels(real_dir)
    extra = {"root": str(real_dir), "kind": "real", "plate_type": "real"}
    splits = {s: [r | extra for r in rows][:limit] for s, rows in split_real(rows).items()}
    for s, rows in splits.items():
        if not rows:
            raise SystemExit(f"no labelled real plates fell in the {s} split; label more crops in {real_dir}")
    return splits, rejected


def mixed_train_rows(real_train: list[dict], synthetic: list[dict], repeat: int, ratio: float,
                     rng: random.Random) -> list[dict]:
    """One epoch: every real crop `repeat` times, plus a fresh random synthetic sample."""
    n_syn = min(len(synthetic), round(len(real_train) * repeat * ratio))
    return real_train * repeat + rng.sample(synthetic, n_syn)


def load_init(model: nn.Module, path: Path, charset: Charset, device) -> None:
    """Load a checkpoint to fine-tune from. Refuses one trained with another charset or image size,
    since its output classes or time steps would not line up with this model."""
    ckpt = torch.load(path, map_location=device, weights_only=False)
    if list(ckpt.get("charset", [])) != list(charset.chars):
        raise SystemExit(f"{path} was trained with a different charset; it cannot be fine-tuned here")
    if tuple(ckpt.get("img_size", ())) != (IMG_HEIGHT, IMG_WIDTH):
        raise SystemExit(f"{path} expects images of {ckpt.get('img_size')}, this model uses {(IMG_HEIGHT, IMG_WIDTH)}")
    model.load_state_dict(ckpt["model"])
    log.info("initialised from %s (epoch %s)", path, ckpt.get("epoch"))


def score(preds: list[str], targets: list[str]) -> dict:
    return {"n": len(targets), "char_acc": char_accuracy(preds, targets), "plate_acc": plate_accuracy(preds, targets)}


def run_epoch(model, loader, ctc, device, charset, optimizer=None):
    """One pass over loader. Trains if optimizer is given, otherwise evaluates."""
    training = optimizer is not None
    model.train(training)
    total_loss, n, preds, targets, types = 0.0, 0, [], [], []
    with torch.set_grad_enabled(training):
        for images, flat_targets, target_lengths, labels, plate_types in loader:
            images = images.to(device)
            log_probs = model(images)  # (T, N, C)
            # every image yields the same number of time steps (T)
            input_lengths = torch.full((images.size(0),), log_probs.size(0), dtype=torch.long)
            loss = ctc(log_probs, flat_targets.to(device), input_lengths, target_lengths)
            if training:
                optimizer.zero_grad()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 5.0)  # LSTMs can have exploding gradients
                optimizer.step()
            total_loss += loss.item() * images.size(0)
            n += images.size(0)
            if not training:
                preds += greedy_decode(log_probs, charset)
                targets += labels
                types += plate_types
    metrics = {"loss": total_loss / max(n, 1)}
    if not training:
        metrics |= score(preds, targets)
        metrics |= {"preds": preds, "targets": targets, "types": types}
    return metrics


def by_plate_type(result: dict) -> dict[str, dict]:
    groups = defaultdict(lambda: ([], []))
    for p, t, plate_type in zip(result["preds"], result["targets"], result["types"], strict=True):
        groups[plate_type][0].append(p)
        groups[plate_type][1].append(t)
    return {k: score(*groups[k]) for k in sorted(groups)}


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--data", type=Path, default=REPO_ROOT / "data" / "synthetic")
    p.add_argument("--out", type=Path, default=REPO_ROOT / "runs" / "ocr")
    p.add_argument("--epochs", type=int, default=10)
    p.add_argument("--batch-size", type=int, default=64)
    p.add_argument("--lr", type=float, default=None, help="default 1e-3, or 3e-4 with --init")
    p.add_argument("--real", type=Path, default=None, help="labelled real crops to mix in (e.g. data/real_crops)")
    p.add_argument("--real-repeat", type=int, default=3, help="times each real train crop is seen per epoch")
    p.add_argument("--synthetic-ratio", type=float, default=1.0,
                   help="synthetic plates per real image per epoch (with --real)")
    p.add_argument("--init", type=Path, default=None, help="checkpoint to fine-tune from (e.g. runs/ocr/best.pt)")
    p.add_argument("--limit", type=int, default=None, help="use only the first N rows of each split (smoke tests)")
    p.add_argument("--augment", nargs="?", const="plate", choices=sorted(AUGMENTS), default=None,
                   help="augment on the fly: 'plate' (default when the flag is bare) or 'camera' (real webcam/phone)")
    p.add_argument("--overfit", action="store_true",
                   help="sanity check: train and evaluate on all of labels.csv (no split, no augmentation)")
    p.add_argument("--log-every", type=int, default=1, help="log metrics every N epochs (and the last)")
    p.add_argument("--gpu", action="store_true", help="train on CUDA (fails if CUDA is unavailable)")
    p.add_argument("--workers", type=int, default=0, help="DataLoader worker processes")
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args(argv)
    if args.epochs < 1:
        p.error("--epochs must be at least 1")
    if args.overfit and args.augment:
        p.error("--overfit and --augment are mutually exclusive")
    if args.overfit and args.real:
        p.error("--overfit and --real are mutually exclusive")
    if args.real_repeat < 1 or args.synthetic_ratio < 0:
        p.error("--real-repeat must be at least 1 and --synthetic-ratio at least 0")
    if args.init is not None and not args.init.is_file():
        p.error(f"--init {args.init} does not exist")
    if args.lr is None:
        args.lr = 3e-4 if args.init else 1e-3
    if args.log_every < 1:
        p.error("--log-every must be at least 1")
    if args.gpu and not torch.cuda.is_available():
        p.error("--gpu given but torch.cuda.is_available() is False (CPU-only torch build or no GPU)")
    return args


def main(argv: list[str] | None = None) -> dict:
    args = parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    random.seed(args.seed)
    torch.manual_seed(args.seed)
    device = torch.device("cuda" if args.gpu else "cpu")

    charset = Charset.from_config(default_plate_format())
    if args.overfit:
        # memorisation test: a working model + loss + decoder must reach ~100% on its own training set
        rows = read_csv(args.data / "labels.csv")[: args.limit]
        splits = {"train": rows, "val": rows, "test": rows}
    else:
        splits = load_splits(args.data, args.limit)

    real, rejected, synthetic = None, [], None
    if args.real:
        real, rejected = load_real(args.real, args.limit)
        held_out = {r["label"] for s in ("val", "test") for r in real[s]}
        synthetic = {s: [r for r in rows if r["label"] not in held_out] for s, rows in splits.items()}
        splits = {"train": real["train"], "val": real["val"], "test": real["test"]}
        for r in rejected:
            log.warning("skipping real crop %s: %s (label %s)", r["filename"], r["reason"], ascii(r["label"]))
    rng = random.Random(args.seed)

    augment = None
    if args.augment:
        augment = {"synthetic": AUGMENTS[args.augment](seed=args.seed), "real": build_real_augment(seed=args.seed)}
    loader_kw = {"batch_size": args.batch_size, "collate_fn": collate, "num_workers": args.workers,
                 "pin_memory": args.gpu}

    def train_loader():
        rows = splits["train"]
        if real is not None:
            rows = mixed_train_rows(real["train"], synthetic["train"], args.real_repeat, args.synthetic_ratio, rng)
        return DataLoader(PlateDataset(args.data, rows, charset, augment), shuffle=True, **loader_kw)

    val_loader = DataLoader(PlateDataset(args.data, splits["val"], charset), shuffle=False, **loader_kw)
    test_loader = DataLoader(PlateDataset(args.data, splits["test"], charset), shuffle=False, **loader_kw)

    model = CRNN(charset.num_classes).to(device)
    if args.init is not None:
        load_init(model, args.init, charset, device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.lr)
    # zero_infinity: ignore impossible alignments (target longer than the sequence) instead of NaN.
    ctc = nn.CTCLoss(blank=BLANK, zero_infinity=True)
    n_params = sum(p.numel() for p in model.parameters())
    log.info("device=%s train=%d val=%d test=%d params=%.2fM classes=%d", device, len(splits["train"]),
             len(splits["val"]), len(splits["test"]), n_params / 1e6, charset.num_classes)

    args.out.mkdir(parents=True, exist_ok=True)
    ckpt_path = args.out / "best.pt"
    history, best = [], None
    with open(args.out / "metrics.csv", "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, ["epoch", "train_loss", "val_loss", "char_acc", "plate_acc", "seconds"])
        writer.writeheader()
        for epoch in range(1, args.epochs + 1):
            start = time.perf_counter()
            train = run_epoch(model, train_loader(), ctc, device, charset, optimizer)
            val = run_epoch(model, val_loader, ctc, device, charset)
            row = {
                "epoch": epoch,
                "train_loss": round(train["loss"], 4),
                "val_loss": round(val["loss"], 4),
                "char_acc": round(val["char_acc"], 4),
                "plate_acc": round(val["plate_acc"], 4),
                "seconds": round(time.perf_counter() - start, 1),
            }
            writer.writerow(row)
            f.flush()
            history.append(row)
            if epoch % args.log_every == 0 or epoch == args.epochs:
                log.info("epoch %d/%d train_loss=%.4f val_loss=%.4f char_acc=%.2f%% plate_acc=%.2f%% (%.1fs)",
                         epoch, args.epochs, row["train_loss"], row["val_loss"],
                         100 * row["char_acc"], 100 * row["plate_acc"], row["seconds"])
                # ascii() escapes Arabic letters so logging works on consoles without UTF-8 (cp1252)
                examples = list(zip(val["preds"][:3], val["targets"][:3], strict=True))
                log.info("  examples (pred, target): %s", ascii(examples))

            # model selection uses validation only; test is touched once, after training
            if best is None or val["plate_acc"] > best["plate_acc"]:
                best = row
                torch.save({
                    "model": model.state_dict(),
                    "charset": charset.chars,
                    "img_size": (IMG_HEIGHT, IMG_WIDTH),
                    "epoch": epoch,
                    "metrics": row,
                }, ckpt_path)

    model.load_state_dict(torch.load(ckpt_path, map_location=device)["model"])
    test = run_epoch(model, test_loader, ctc, device, charset)
    per_type = by_plate_type(test)
    log.info("test (best epoch %d): char_acc=%.2f%% plate_acc=%.2f%% n=%d",
             best["epoch"], 100 * test["char_acc"], 100 * test["plate_acc"], test["n"])
    for plate_type, m in per_type.items():
        log.info("  %-12s char_acc=%.2f%% plate_acc=%.2f%% n=%d",
                 plate_type, 100 * m["char_acc"], 100 * m["plate_acc"], m["n"])

    synthetic_test = None
    if synthetic is not None:
        syn_loader = DataLoader(PlateDataset(args.data, synthetic["test"], charset), shuffle=False, **loader_kw)
        s = run_epoch(model, syn_loader, ctc, device, charset)
        synthetic_test = {"n": s["n"], "char_acc": s["char_acc"], "plate_acc": s["plate_acc"]}
        log.info("  synthetic test (forgetting check): char_acc=%.2f%% plate_acc=%.2f%% n=%d",
                 100 * s["char_acc"], 100 * s["plate_acc"], s["n"])

    results = {
        "data": str(args.data),
        "real": None if real is None else {
            "dir": str(args.real), "sizes": {s: len(r) for s, r in real.items()},
            "plates": {s: len({x["label"] for x in r}) for s, r in real.items()},
            "rejected": rejected, "synthetic_test": synthetic_test},
        "init": None if args.init is None else str(args.init),
        "overfit": args.overfit,
        "sizes": {s: len(r) for s, r in splits.items()},
        "best_epoch": best["epoch"],
        "best_val": best,
        "test": {"loss": test["loss"], "n": test["n"], "char_acc": test["char_acc"],
                 "plate_acc": test["plate_acc"], "by_plate_type": per_type},
        "history": history,
        "args": {k: str(v) if isinstance(v, Path) else v for k, v in vars(args).items()},
    }
    with open(args.out / "results.json", "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    log.info("done; best val plate_acc=%.2f%% at epoch %d; results %s",
             100 * best["plate_acc"], best["epoch"], args.out / "results.json")
    return results


if __name__ == "__main__":
    main()

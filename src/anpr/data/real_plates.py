"""Hand-labelled real plate crops (data/real_crops/labels.csv, from scripts/label_crops.py).

Each row is a crop and its label. Rows that cannot train the OCR are left out and reported:
"-" (a human could not read it) and labels the plate validator rejects (typos such as a
Latin "A" for "أ"). Labels are stored in canonical form.

The split is by plate, not by photo: the same car is often photographed several times, and
if one photo were in train and another in test, the test score would partly measure
memorisation. Each label goes to a split by a hash of the label, so the split
  - never puts one plate in two splits,
  - does not change when more crops are labelled later (an old test plate stays in test),
  - needs no seed and no split file to keep in sync.
"""

import csv
import hashlib
from pathlib import Path

from anpr.pipeline.validator import parse_plate
from anpr.utils.config import PlateFormat

UNREADABLE = "-"
DEFAULT_FRACTIONS = (0.7, 0.15, 0.15)  # train, val, test: more held out than synthetic, real data is scarce


def load_real_labels(crops_dir: Path, fmt: PlateFormat | None = None) -> tuple[list[dict], list[dict]]:
    """Return (usable rows, rejected rows). Usable rows: filename, label (canonical), source."""
    with open(crops_dir / "labels.csv", encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    usable, rejected = [], []
    for row in rows:
        raw = (row.get("label") or "").strip()
        if not raw:
            continue  # not labelled yet
        plate = None if raw == UNREADABLE else parse_plate(raw, fmt)
        if plate is None:
            rejected.append({"filename": row["filename"], "label": raw,
                             "reason": "unreadable" if raw == UNREADABLE else "not a valid plate"})
            continue
        usable.append({"filename": row["filename"], "label": plate.canonical(), "source": row.get("source", "")})
    return usable, rejected


def split_of(label: str, fractions: tuple[float, float, float] = DEFAULT_FRACTIONS) -> str:
    """'train', 'val' or 'test' for this plate, from the first 8 bytes of SHA-256(label)."""
    bucket = int.from_bytes(hashlib.sha256(label.encode("utf-8")).digest()[:8], "big") / 2**64
    if bucket < fractions[0]:
        return "train"
    return "val" if bucket < fractions[0] + fractions[1] else "test"


def split_real(rows: list[dict], fractions: tuple[float, float, float] = DEFAULT_FRACTIONS) -> dict[str, list[dict]]:
    out: dict[str, list[dict]] = {"train": [], "val": [], "test": []}
    for row in rows:
        out[split_of(row["label"], fractions)].append(row)
    return out

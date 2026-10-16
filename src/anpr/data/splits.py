"""Seeded train/val/test split that never puts the same plate label in two splits.

Short plates (e.g. "7|ب|1") are generated more than once in a large dataset. If one copy
landed in train and another in test, the test score would partly measure memorisation,
so rows are grouped by label and whole groups are assigned to a split.
"""

import random
from collections import defaultdict
from collections.abc import Sequence

SPLITS = ("train", "val", "test")
DEFAULT_FRACTIONS = (0.8, 0.1, 0.1)


def split_by_label(
    rows: Sequence[dict],
    fractions: Sequence[float] = DEFAULT_FRACTIONS,
    seed: int | None = None,
    key: str = "label",
) -> dict[str, list[dict]]:
    """Split rows into {"train", "val", "test"} by unique `key`, with roughly `fractions` of the labels each.

    Fractions apply to unique labels; duplicates are rare, so row counts end up close to them.
    With at least 3 unique labels, val and test each get at least one. Rows keep their
    original order inside each split. Same rows + same seed -> same split.
    """
    if len(fractions) != 3 or any(f < 0 for f in fractions) or abs(sum(fractions) - 1) > 1e-6:
        raise ValueError(f"fractions must be 3 non-negative numbers summing to 1, got {fractions}")

    groups: dict[str, list[int]] = defaultdict(list)
    for i, row in enumerate(rows):
        groups[row[key]].append(i)
    labels = sorted(groups)  # sorted first so the shuffle depends only on the seed, not on row order
    random.Random(seed).shuffle(labels)

    n = len(labels)
    n_val = round(n * fractions[1])
    n_test = round(n * fractions[2])
    if n >= 3:
        n_val, n_test = max(n_val, 1), max(n_test, 1)
    n_train = n - n_val - n_test

    assigned = {}
    for split, chunk in zip(SPLITS, (labels[:n_train], labels[n_train:n_train + n_val], labels[n_train + n_val:])):
        for label in chunk:
            assigned[label] = split

    out: dict[str, list[dict]] = {s: [] for s in SPLITS}
    for row in rows:
        out[assigned[row[key]]].append(row)
    return out

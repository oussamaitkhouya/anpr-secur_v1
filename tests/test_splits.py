import random
from collections import Counter

import pytest

from anpr.data.splits import SPLITS, split_by_label


def _rows(n=500, seed=0):
    """Rows with many repeated labels, like short plates in a big synthetic set."""
    rng = random.Random(seed)
    return [{"filename": f"images/{i}.png", "label": f"{rng.randint(1, 120)}|ب|{rng.randint(1, 3)}",
             "plate_type": "private"} for i in range(n)]


def _labels(rows):
    return {r["label"] for r in rows}


def test_no_label_in_two_splits():
    rows = _rows()
    assert max(Counter(r["label"] for r in rows).values()) > 1  # the data really has duplicates
    splits = split_by_label(rows, seed=0)
    for i, a in enumerate(SPLITS):
        for b in SPLITS[i + 1:]:
            assert not _labels(splits[a]) & _labels(splits[b]), (a, b)


def test_every_row_kept_exactly_once():
    rows = _rows()
    splits = split_by_label(rows, seed=0)
    out = [r["filename"] for s in SPLITS for r in splits[s]]
    assert sorted(out) == sorted(r["filename"] for r in rows)


def test_fractions_roughly_80_10_10():
    rows = _rows(2000)
    n_labels = len(_labels(rows))
    splits = split_by_label(rows, seed=1)
    assert len(_labels(splits["val"])) == round(0.1 * n_labels)
    assert len(_labels(splits["test"])) == round(0.1 * n_labels)
    assert 0.7 < len(splits["train"]) / len(rows) < 0.9


def test_seeded():
    rows = _rows()
    assert split_by_label(rows, seed=3) == split_by_label(rows, seed=3)
    assert split_by_label(rows, seed=3) != split_by_label(rows, seed=4)
    # the split depends on the seed and the set of rows, not on their order
    shuffled = rows[:]
    random.Random(9).shuffle(shuffled)
    assert {s: _labels(r) for s, r in split_by_label(shuffled, seed=3).items()} == \
           {s: _labels(r) for s, r in split_by_label(rows, seed=3).items()}


def test_small_sets_get_val_and_test():
    rows = [{"label": str(i)} for i in range(3)]
    splits = split_by_label(rows, seed=0)
    assert [len(splits[s]) for s in SPLITS] == [1, 1, 1]


@pytest.mark.parametrize("fractions", [(0.8, 0.1), (0.8, 0.3, 0.1), (1.1, -0.05, -0.05)])
def test_bad_fractions_rejected(fractions):
    with pytest.raises(ValueError):
        split_by_label(_rows(10), fractions=fractions)

"""Real crops: invalid labels are skipped and reported, and the split is by plate and stable."""

from anpr.data.real_plates import load_real_labels, split_of, split_real


def write_labels(tmp_path, rows):
    lines = ["filename,label,source"] + [f"images/{i}.png,{label},src/{i}.jpg" for i, label in enumerate(rows)]
    (tmp_path / "labels.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_load_skips_unreadable_and_invalid(tmp_path):
    write_labels(tmp_path, ["12345|أ|40", "-", "64112|A|7", "555346|ب|40", "", "7 ب 6"])
    usable, rejected = load_real_labels(tmp_path)
    assert [r["label"] for r in usable] == ["12345|أ|40", "7|ب|6"]  # stored canonical
    assert [(r["label"], r["reason"]) for r in rejected] == [
        ("-", "unreadable"), ("64112|A|7", "not a valid plate"), ("555346|ب|40", "not a valid plate")]


def test_split_keeps_each_plate_in_one_split():
    rows = [{"label": f"{n}|ب|{n % 80 + 1}"} for n in range(1, 400)] * 3  # every plate photographed 3 times
    splits = split_real(rows)
    seen = [{r["label"] for r in splits[s]} for s in ("train", "val", "test")]
    assert not (seen[0] & seen[1] or seen[0] & seen[2] or seen[1] & seen[2])
    assert sum(len(v) for v in splits.values()) == len(rows)
    assert 0.6 < len(splits["train"]) / len(rows) < 0.8  # roughly the 70/15/15 default


def test_split_is_stable_when_more_plates_are_labelled():
    first = {f"{n}|أ|1": split_of(f"{n}|أ|1") for n in range(1, 200)}
    more = split_real([{"label": f"{n}|أ|1"} for n in range(1, 400)])
    for split, rows in more.items():
        for r in rows:
            if r["label"] in first:
                assert first[r["label"]] == split

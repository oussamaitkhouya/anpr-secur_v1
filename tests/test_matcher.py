"""Watchlist matcher: every branch."""

from datetime import UTC, datetime, timedelta

import pytest

from anpr.pipeline.matcher import (
    Candidate,
    MatcherConfig,
    PlateRead,
    disagreements,
    load_matcher_config,
    match,
)

NOW = datetime(2026, 10, 8, 12, 0, tzinfo=UTC)
CFG = MatcherConfig(max_distance=1, low_char_confidence=0.6, min_plate_confidence=0.85,
                    unknown_values=frozenset({"", "unknown"}),
                    color_synonyms={"gris": "gray", "grey": "gray"},
                    make_synonyms={"vw": "volkswagen", "mercedes": "mercedes benz"})
PLATE = "12345|ب|6"


def entry(plate=PLATE, **kw) -> Candidate:
    return Candidate(entry_id=kw.pop("entry_id", "e1"), plate_canonical=plate, **kw)


def read(raw=PLATE, conf=0.95, chars=(), **kw) -> PlateRead:
    return PlateRead(plate_raw=raw, plate_confidence=conf, char_confidences=tuple(chars), **kw)


def run(r, entries):
    return match(r, entries, CFG, NOW)


def test_exact_full_match():
    [m] = run(read(color="white", make="Dacia", model="Logan"), [entry(color="White", make="dacia", model="logan")])
    assert (m.kind, m.distance) == ("full_match", 0)


def test_exact_match_normalises_the_read():
    [m] = run(read(raw=" ١٢٣٤٥ - ب - ٦ "), [entry()])  # Arabic digits, spaces and dashes
    assert m.kind == "full_match"


def test_unknown_attributes_never_disagree():
    [m] = run(read(color=None, make="unknown", model=""), [entry(color="red", make="Renault", model="Clio")])
    assert m.kind == "full_match"


def test_synonyms_and_spelling_do_not_disagree():
    [m] = run(read(color="gris", make="VW"), [entry(color="grey", make="Volkswagen")])
    assert m.kind == "full_match"
    [m] = run(read(make="Mercedes-Benz"), [entry(make="mercedes")])
    assert m.kind == "full_match"


@pytest.mark.parametrize("attrs, expected", [
    ({"color": "red"}, ("color",)),
    ({"make": "Renault"}, ("make",)),
    ({"model": "Sandero"}, ("model",)),
])
def test_attribute_mismatch_is_possible_clone(attrs, expected):
    [m] = run(read(**attrs), [entry(color="white", make="Dacia", model="Logan")])
    assert m.kind == "plate_only_mismatch_vehicle"
    assert m.disagreements == expected


def test_exact_match_from_low_confidence_read_is_fuzzy():
    [m] = run(read(conf=0.5, color="red"), [entry(color="white")])
    assert m.kind == "fuzzy_match"


def test_fuzzy_match_when_differing_char_was_uncertain():
    # read 12845 instead of 12345; the '8' had low confidence
    r = read(raw="12845|ب|6", conf=0.9, chars=[0.99, 0.99, 0.3, 0.99, 0.99, 0.99, 0.99])
    [m] = run(r, [entry()])
    assert (m.kind, m.distance) == ("fuzzy_match", 1)
    assert 0 < m.score < 0.9


def test_no_fuzzy_match_when_differing_char_was_confident():
    r = read(raw="12845|ب|6", conf=0.9, chars=[0.99] * 7)
    assert run(r, [entry()]) == []


def test_fuzzy_without_char_confidences_uses_plate_confidence():
    assert run(read(raw="12845|ب|6", conf=0.95), [entry()]) == []
    [m] = run(read(raw="12845|ب|6", conf=0.5), [entry()])
    assert m.kind == "fuzzy_match"


def test_missing_character_insertion():
    # OCR dropped the last digit: 1234 vs 12345; neighbour confidence low
    r = read(raw="1234|ب|6", conf=0.9, chars=[0.99, 0.99, 0.99, 0.4, 0.99, 0.99])
    [m] = run(r, [entry()])
    assert m.kind == "fuzzy_match"


def test_invalid_read_can_still_fuzzy_match():
    # letter misread as one outside the allowed set ("x"), so the read is not a valid plate
    r = read(raw="12345|x|6", conf=0.9, chars=[0.99, 0.99, 0.99, 0.99, 0.99, 0.2, 0.99])
    [m] = run(r, [entry()])
    assert m.kind == "fuzzy_match"


def test_distance_beyond_limit_is_ignored():
    assert run(read(raw="99345|ب|6", conf=0.3), [entry()]) == []


def test_removed_and_expired_entries_are_ignored():
    entries = [
        entry(entry_id="removed", removed_at=NOW - timedelta(days=1)),
        entry(entry_id="expired", expires_at=NOW - timedelta(seconds=1)),
    ]
    assert run(read(), entries) == []
    [m] = run(read(), [entry(entry_id="future", expires_at=NOW + timedelta(days=1))])
    assert m.entry_id == "future"


def test_exact_matches_win_over_fuzzy_ones():
    entries = [entry(entry_id="exact"), entry(entry_id="near", plate="12346|ب|6")]
    assert [m.entry_id for m in run(read(conf=0.5), entries)] == ["exact"]


def test_same_plate_on_two_lists_gives_two_matches():
    assert len(run(read(), [entry(entry_id="a"), entry(entry_id="b")])) == 2


def test_no_candidates():
    assert run(read(), []) == []


def test_disagreements_helper():
    assert disagreements(read(color="RED"), entry(color="red"), CFG) == ()


def test_config_file_loads():
    cfg = load_matcher_config()
    assert cfg.max_distance >= 0 and 0 < cfg.min_plate_confidence <= 1
    assert cfg.make_synonyms["mercedes"] == "mercedes benz"

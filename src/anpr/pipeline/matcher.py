"""Match a plate read against watchlist entries.

1. Normalise the read with the plate validator (canonical "number|letter|region").
2. Exact match on the canonical plate.
3. If there is no exact match: fuzzy match with Levenshtein distance <= max_distance, accepted
   only when every differing character was a low-confidence OCR character. A confident read
   that differs from a listed plate is a different car, not a misread.
4. Compare observed colour/make/model with the entry. Unknown values never disagree.

Result kinds:
    full_match                   confident exact plate, attributes agree (or are unknown)
    plate_only_mismatch_vehicle  confident exact plate, but a known attribute clearly differs:
                                 possible cloned plate
    fuzzy_match                  plate uncertain (fuzzy match, or exact match from a low-confidence read)

The matcher only proposes. Every match becomes a pending alert that a human reviews.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime
from functools import lru_cache
from pathlib import Path

import yaml
from rapidfuzz.distance import Levenshtein

from anpr.pipeline.validator import normalize, parse_plate
from anpr.utils.config import CONFIG_DIR

MATCHER_CONFIG_PATH = CONFIG_DIR / "matcher.yaml"


@dataclass(frozen=True)
class MatcherConfig:
    max_distance: int = 1
    low_char_confidence: float = 0.60
    min_plate_confidence: float = 0.85
    unknown_values: frozenset[str] = frozenset({"", "unknown"})
    color_synonyms: dict[str, str] = field(default_factory=dict)
    make_synonyms: dict[str, str] = field(default_factory=dict)


def load_matcher_config(path: Path | str = MATCHER_CONFIG_PATH) -> MatcherConfig:
    with open(path, encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    try:
        cfg = MatcherConfig(
            max_distance=int(raw.get("max_distance", 1)),
            low_char_confidence=float(raw.get("low_char_confidence", 0.60)),
            min_plate_confidence=float(raw.get("min_plate_confidence", 0.85)),
            unknown_values=frozenset(str(v).lower() for v in raw.get("unknown_values", ["", "unknown"])),
            color_synonyms={_words(str(k)): _words(str(v)) for k, v in (raw.get("color_synonyms") or {}).items()},
            make_synonyms={_words(str(k)): _words(str(v)) for k, v in (raw.get("make_synonyms") or {}).items()},
        )
    except (TypeError, ValueError) as e:
        raise ValueError(f"invalid matcher config {path}: {e!r}") from e
    if not 0 <= cfg.max_distance <= 3:
        raise ValueError(f"{path}: max_distance must be between 0 and 3")
    return cfg


@lru_cache(maxsize=1)
def default_matcher_config() -> MatcherConfig:
    return load_matcher_config()


@dataclass(frozen=True)
class PlateRead:
    """One observation from a camera or radar."""
    plate_raw: str
    plate_confidence: float
    char_confidences: tuple[float, ...] = ()  # one per plate character, separators excluded
    color: str | None = None
    make: str | None = None
    model: str | None = None


@dataclass(frozen=True)
class Candidate:
    """A watchlist entry, as the matcher needs it."""
    entry_id: str
    plate_canonical: str
    color: str | None = None
    make: str | None = None
    model: str | None = None
    expires_at: datetime | None = None
    removed_at: datetime | None = None

    def is_active(self, now: datetime) -> bool:
        return self.removed_at is None and (self.expires_at is None or self.expires_at > now)


@dataclass(frozen=True)
class Match:
    entry_id: str
    kind: str
    score: float
    distance: int
    disagreements: tuple[str, ...] = ()


def canonical_or_none(plate_raw: str) -> str | None:
    plate = parse_plate(plate_raw)
    return plate.canonical() if plate else None


def _words(value: str) -> str:
    """"Mercedes-Benz " -> "mercedes benz": case, hyphens and extra spaces do not matter."""
    return " ".join(value.strip().lower().replace("-", " ").split())


def _norm_attr(value: str | None, cfg: MatcherConfig, synonyms: dict[str, str]) -> str | None:
    if value is None or _words(value) in cfg.unknown_values:
        return None
    v = _words(value)
    return synonyms.get(v, v)


def disagreements(read: PlateRead, entry: Candidate, cfg: MatcherConfig) -> tuple[str, ...]:
    """Attributes where both sides are known and differ."""
    out = []
    pairs = (
        ("color", read.color, entry.color, cfg.color_synonyms),
        ("make", read.make, entry.make, cfg.make_synonyms),
        ("model", read.model, entry.model, {}),
    )
    for name, observed, listed, synonyms in pairs:
        a, b = _norm_attr(observed, cfg, synonyms), _norm_attr(listed, cfg, synonyms)
        if a is not None and b is not None and a != b:
            out.append(name)
    return tuple(out)


def _char_confidence_at(read_text: str, pos: int, confidences: tuple[float, ...]) -> float | None:
    """Confidence of the plate character at read_text[pos] (separators are not OCR characters)."""
    if not confidences or pos >= len(read_text) or read_text[pos] == "|":
        return None
    index = sum(1 for c in read_text[:pos] if c != "|")
    return confidences[index] if index < len(confidences) else None


def _edits_explained_by_low_confidence(read_text: str, listed: str, read: PlateRead, cfg: MatcherConfig) -> bool:
    plate_chars = sum(1 for c in read_text if c != "|")
    confidences = read.char_confidences if len(read.char_confidences) == plate_chars else ()
    for op in Levenshtein.editops(read_text, listed):
        if op.tag == "insert":
            # A character the OCR missed: look at its neighbours in the read.
            near = [_char_confidence_at(read_text, p, confidences) for p in (op.src_pos - 1, op.src_pos)]
            near = [c for c in near if c is not None]
            conf = min(near) if near else None
        else:
            conf = _char_confidence_at(read_text, op.src_pos, confidences)
        if conf is None:
            # No per-character information for this edit: fall back to the whole-plate confidence.
            if read.plate_confidence >= cfg.min_plate_confidence:
                return False
        elif conf >= cfg.low_char_confidence:
            return False
    return True


def match(read: PlateRead, candidates: list[Candidate], cfg: MatcherConfig | None = None,
          now: datetime | None = None) -> list[Match]:
    """All watchlist matches for one read, best first. Empty list if nothing matches."""
    cfg = cfg or default_matcher_config()
    now = now or datetime.now(UTC)
    active = [c for c in candidates if c.is_active(now)]
    canonical = canonical_or_none(read.plate_raw)
    read_text = canonical or normalize(read.plate_raw)
    confident = read.plate_confidence >= cfg.min_plate_confidence

    exact = [c for c in active if canonical is not None and c.plate_canonical == canonical]
    if exact:
        results = []
        for c in exact:
            diff = disagreements(read, c, cfg)
            kind = "fuzzy_match" if not confident else ("plate_only_mismatch_vehicle" if diff else "full_match")
            results.append(Match(c.entry_id, kind, round(read.plate_confidence, 4), 0, diff))
        return sorted(results, key=lambda m: -m.score)

    results = []
    if cfg.max_distance == 0 or not read_text:
        return results
    for c in active:
        distance = Levenshtein.distance(read_text, c.plate_canonical, score_cutoff=cfg.max_distance)
        if distance > cfg.max_distance:
            continue
        if not _edits_explained_by_low_confidence(read_text, c.plate_canonical, read, cfg):
            continue
        length = max(len(read_text), len(c.plate_canonical))
        score = read.plate_confidence * (1 - distance / length)
        results.append(Match(c.entry_id, "fuzzy_match", round(score, 4), distance, disagreements(read, c, cfg)))
    return sorted(results, key=lambda m: -m.score)

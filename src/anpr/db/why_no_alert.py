"""Explain why a plate read does (or does not) raise a watchlist alert. Read-only.

    $env:PYTHONPATH = "src"
    python -m anpr.db.why_no_alert "40781|ب|40"
    python -m anpr.db.why_no_alert "40781 ب 40" --confidence 0.99

Lists every watchlist entry within two edits of the plate, with its status and the matcher's
verdict for a read at --confidence (the per-character confidences are taken as equal to it), plus
cameras in maintenance (they record reads but never alert) and the plate's latest reads and alerts.
The same rules as the API apply (anpr.pipeline.matcher, anpr.api.services.ingest).

Prints full plates: run it only in a terminal you trust, as with the other admin CLIs.
"""

import argparse
import sys
from datetime import UTC, datetime

from rapidfuzz.distance import Levenshtein
from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.api.services.ingest import DEDUP_WINDOW
from anpr.db.engine import make_engine
from anpr.db.models import Alert, Camera, DetectionEvent, WatchlistEntry, WatchlistList
from anpr.pipeline import matcher
from anpr.utils.settings import load_env_file, load_settings


def entry_status(e: WatchlistEntry, now: datetime) -> str:
    if e.removed_at is not None:
        return "REMOVED"
    if e.expires_at is not None and e.expires_at <= now:
        return "EXPIRED"
    return "active"


def verdict(read: matcher.PlateRead, e: WatchlistEntry, now: datetime) -> str:
    candidate = matcher.Candidate(entry_id=str(e.id), plate_canonical=e.plate_canonical, color=e.color, make=e.make,
                                  model=e.model, expires_at=e.expires_at, removed_at=e.removed_at)
    found = matcher.match(read, [candidate], now=now)
    if found:
        return f"MATCH -> alert ({found[0].kind}, score {found[0].score:.2f})"
    if not candidate.is_active(now):
        return "no alert: entry not active"
    cfg = matcher.default_matcher_config()
    return (f"no alert: differs by {Levenshtein.distance(matcher.canonical_or_none(read.plate_raw) or read.plate_raw, e.plate_canonical)} "
            f"character(s) and the read is confident; near matches need a character below "
            f"{cfg.low_char_confidence:.0%} confidence")


def explain(db: Session, plate: str, confidence: float, now: datetime) -> list[str]:
    out = []
    canonical = matcher.canonical_or_none(plate)
    if canonical is None:
        out.append(f"'{plate}' is not a valid Moroccan plate (number|letter|region): it is stored but never matched exactly.")
        text = matcher.normalize(plate)
    else:
        text = canonical
        out.append(f"Read: {canonical}  (code points: {' '.join(f'U+{ord(c):04X}' for c in canonical if not c.isdigit() and c != '|')})")
    n = sum(1 for c in text if c != "|")
    read = matcher.PlateRead(plate_raw=text, plate_confidence=confidence, char_confidences=(confidence,) * n)

    rows = db.execute(select(WatchlistEntry, WatchlistList.name).join(WatchlistList)).all()
    near = sorted(((Levenshtein.distance(text, e.plate_canonical), e, name) for e, name in rows), key=lambda r: r[0])
    near = [r for r in near if r[0] <= 2]
    out.append("")
    if not near:
        out.append(f"No watchlist entry within 2 characters of {text}. Add it in Admin > Watchlists.")
    for distance, e, name in near:
        letters = " ".join(f"U+{ord(c):04X}" for c in e.plate_canonical if not c.isdigit() and c != "|")
        out.append(f"Entry {e.plate_canonical}  list '{name}'  reason {e.reason}  [{entry_status(e, now)}]  "
                   f"distance {distance}  letter {letters}")
        out.append(f"    {verdict(read, e, now)}")

    maintenance = db.scalars(select(Camera.name).where(Camera.status == "maintenance")).all()
    out.append("")
    out.append("Cameras in maintenance (record reads, never alert): " + (", ".join(maintenance) if maintenance else "none"))

    if canonical:
        last = db.execute(select(DetectionEvent.observed_at, DetectionEvent.plate_confidence, Camera.name)
                          .join(Camera).where(DetectionEvent.plate_canonical == canonical)
                          .order_by(DetectionEvent.observed_at.desc()).limit(3)).all()
        out.append(f"Latest reads of {canonical}: " + ("; ".join(f"{t:%Y-%m-%d %H:%M:%S} {c:.0%} {cam}" for t, c, cam in last) or "none"))
        pending = db.scalar(select(Alert.created_at).join(DetectionEvent).where(
            DetectionEvent.plate_canonical == canonical, Alert.status == "pending").order_by(Alert.created_at.desc()).limit(1))
        if pending:
            out.append(f"A pending alert for this plate exists (created {pending:%Y-%m-%d %H:%M:%S}). "
                       f"Repeats from the same camera are suppressed for {int(DEDUP_WINDOW.total_seconds())} s after it.")
    return out


def main(argv: list[str] | None = None, url: str | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("plate", help='e.g. "40781|ب|40" or "40781 ب 40"')
    p.add_argument("--confidence", type=float, default=0.99, help="confidence of the read to simulate (0-1)")
    args = p.parse_args(argv)
    if not 0 <= args.confidence <= 1:
        p.error("--confidence must be between 0 and 1")
    if url is None:
        load_env_file()
        url = load_settings().database_url
    engine = make_engine(url)
    try:
        with Session(engine) as db:
            lines = explain(db, args.plate, args.confidence, datetime.now(UTC))
    finally:
        engine.dispose()
    sys.stdout.reconfigure(encoding="utf-8")  # Arabic letters on Windows consoles
    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    sys.exit(main())

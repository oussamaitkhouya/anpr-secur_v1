"""anpr.db.why_no_alert: explains, against the real database, why a read alerts or not."""

from datetime import UTC, datetime, timedelta

import pytest
from pg_support import TEST_URL, add_user, migrate_fresh, requires_pg
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from anpr.db.models import Camera, City, WatchlistEntry, WatchlistList
from anpr.db.why_no_alert import explain, main

pytestmark = requires_pg


@pytest.fixture(scope="module")
def db():
    migrate_fresh()
    engine = create_engine(TEST_URL)
    s = Session(engine)
    city = City(name="Rabat", region="RSK")
    s.add(city)
    s.flush()
    admin = add_user(s, "admin1", "admin")
    s.add(Camera(city_id=city.id, name="bench", kind="anpr_camera", latitude=34, longitude=-6.8, protocol="file", status="maintenance"))
    wl = WatchlistList(name="Stolen", source="test", created_by=admin)
    s.add(wl)
    s.flush()
    now = datetime.now(UTC)
    s.add_all([
        WatchlistEntry(list_id=wl.id, plate_canonical="40781|ب|44", reason="stolen"),
        WatchlistEntry(list_id=wl.id, plate_canonical="12345|أ|6", reason="wanted", expires_at=now - timedelta(days=1)),
    ])
    s.commit()
    yield s
    s.close()
    engine.dispose()


def test_one_confident_character_off_is_explained(db):
    text = "\n".join(explain(db, "40781 ب 40", 0.99, datetime.now(UTC)))
    assert "Entry 40781|ب|44" in text and "distance 1" in text
    assert "no alert: differs by 1 character(s) and the read is confident" in text
    assert "Cameras in maintenance (record reads, never alert): bench" in text


def test_exact_match_and_expired_entry(db):
    now = datetime.now(UTC)
    assert "MATCH -> alert (full_match" in "\n".join(explain(db, "40781|ب|44", 0.99, now))
    text = "\n".join(explain(db, "12345|أ|6", 0.99, now))
    assert "[EXPIRED]" in text and "no alert: entry not active" in text


def test_cli_runs(capsys):
    assert main(["40781|ب|44"], url=TEST_URL) == 0
    assert "MATCH" in capsys.readouterr().out

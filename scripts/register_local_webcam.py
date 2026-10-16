"""Register this PC's webcam as a camera (protocol "file": a local source), directly in the
database, so the Live surveillance page can monitor it and raise alerts.

    .venv\\Scripts\\python scripts\\register_local_webcam.py --city Rabat
    .venv\\Scripts\\python scripts\\register_local_webcam.py --city Rabat --lat 34.0209 --lon -6.8416 --owner <you>

Safe to run again: if a local webcam camera already exists in that city, nothing changes. The
insert is written to the signed audit log in the same transaction (an unaudited insert would
show up as an unexplained change). Uses MIGRATION_DATABASE_URL (the owner role), like
anpr.db.create_admin. Without --lat/--lon the city's centre is used and the camera's notes say
so; correct it later in Cities & Cameras.
"""

import argparse
import os
import sys
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.db.engine import make_engine
from anpr.db.models import Camera, CameraStatusEvent, City
from anpr.security import audit_chain
from anpr.security.keys import EnvKeyProvider
from anpr.security.rbac import Actor
from anpr.utils.settings import load_env_file, load_settings

# City centres (approximate), used only when no exact position is given.
CITY_CENTRES = {"rabat": (34.020882, -6.841650), "casablanca": (33.573110, -7.589843), "sale": (34.034, -6.7985),
                "tanger": (35.759465, -5.833954), "marrakech": (31.629472, -7.981084), "fes": (34.033126, -5.000280)}
NAME = "This PC webcam"


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--city", required=True, help="existing city name, e.g. Rabat")
    p.add_argument("--lat", type=float)
    p.add_argument("--lon", type=float)
    p.add_argument("--owner", default=None, help="who operates it (free text)")
    p.add_argument("--direction", type=int, default=None, help="view direction in degrees, 0 = north")
    args = p.parse_args()

    load_env_file()
    settings = load_settings()
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    engine = make_engine(os.environ.get("MIGRATION_DATABASE_URL") or settings.database_url)
    with Session(engine) as db:
        city = db.scalar(select(City).where(City.name.ilike(args.city)))
        if city is None:
            names = ", ".join(db.scalars(select(City.name))) or "none"
            print(f"No city named {args.city!r}. Existing cities: {names}.", file=sys.stderr)
            return 1
        existing = db.scalar(select(Camera).where(Camera.city_id == city.id, Camera.protocol == "file", Camera.name == NAME))
        if existing:
            print(f"Already registered: {NAME} in {city.name} (id {existing.id}). Nothing changed.")
            return 0
        exact = args.lat is not None and args.lon is not None
        lat, lon = (args.lat, args.lon) if exact else CITY_CENTRES.get(city.name.lower(), (None, None))
        if lat is None or not (-90 <= lat <= 90 and -180 <= lon <= 180):
            print("Give --lat and --lon (no centre known for this city).", file=sys.stderr)
            return 2
        notes = ("Local webcam of the operator PC, monitored from the Live surveillance page. "
                 + ("Exact position." if exact else f"Position is the {city.name} city centre (approximate): set the real one in Cities & Cameras."))
        cam = Camera(city_id=city.id, name=NAME, kind="fixed_cctv", latitude=lat, longitude=lon, view_direction_deg=args.direction,
                     installed_on=datetime.now(UTC).date(), owner=args.owner, protocol="file", status="unknown", notes=notes)
        db.add(cam)
        db.flush()
        db.add(CameraStatusEvent(camera_id=cam.id, status="unknown", reason="created"))
        audit_chain.append(db, keys.audit_signing_key(), Actor(id="cli", role="system", ip="local"), "camera.create", "camera",
                           str(cam.id), "local webcam (register_local_webcam.py)")
        db.commit()
        print(f"Registered {NAME} in {city.name} at {lat:.6f}, {lon:.6f}{'' if exact else ' (city centre)'}. Camera id: {cam.id}")
    engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Register or update an RTSP/RTSPS network camera directly in the database.

    .venv\\Scripts\\python scripts\\register_rtsp_camera.py --city Salé --name Gate --host <camera ip> --username <user>

The password is read from RTSP_PASSWORD or asked at a hidden prompt, never passed on the command line.

Safe to run repeatedly: if the camera already exists, it is updated in place.
Encrypted credentials and audit chain entries are recorded cleanly with each run.
"""

import argparse
import getpass
import json
import os
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.db.engine import make_engine
from anpr.db.models import Camera, CameraStatusEvent, City
from anpr.security import audit_chain, crypto
from anpr.security.keys import EnvKeyProvider
from anpr.security.rbac import Actor
from anpr.utils.settings import load_env_file, load_settings

CITY_CENTRES = {
    "rabat": (34.020882, -6.841650),
    "casablanca": (33.573110, -7.589843),
    "sale": (34.026569, -6.760833),
    "salé": (34.026569, -6.760833),
    "tanger": (35.759465, -5.833954),
    "marrakech": (31.629472, -7.981084),
    "fes": (34.033126, -5.000280),
}


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--city", default="Salé", help="City name (e.g. Salé, Rabat)")
    p.add_argument("--name", default="Sale", help="Camera name")
    p.add_argument("--host", required=True, help="Camera host IP or domain")
    p.add_argument("--port", type=int, default=554, help="RTSP port (default: 554)")
    p.add_argument("--protocol", default="rtsp", choices=["rtsp", "rtsps"], help="Protocol (rtsp or rtsps)")
    p.add_argument("--stream-path", default="/channel=1_stream=0.sdp?real_stream", help="RTSP stream path")
    p.add_argument("--username", default=None, help="RTSP username (password: RTSP_PASSWORD or hidden prompt)")
    p.add_argument("--lat", type=float, default=None, help="Latitude")
    p.add_argument("--lon", type=float, default=None, help="Longitude")
    p.add_argument("--address", default=None, help="Street address")
    p.add_argument("--status", default="online", choices=["online", "offline", "unknown", "degraded", "maintenance"], help="Status")
    args = p.parse_args()
    args.password = None
    if args.username:
        args.password = os.environ.get("RTSP_PASSWORD") or getpass.getpass("RTSP password: ")

    load_env_file()
    settings = load_settings()
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    engine = make_engine(os.environ.get("MIGRATION_DATABASE_URL") or settings.database_url)

    with Session(engine) as db:
        # Find or create the city
        city = db.scalar(select(City).where(City.name.ilike(args.city)))
        if not city:
            city = City(id=uuid.uuid4(), name=args.city, region="Rabat-Salé-Kénitra")
            db.add(city)
            db.flush()
            audit_chain.append(db, keys.audit_signing_key(), Actor(id="cli", role="system", ip="local"),
                               "city.create", "city", str(city.id), args.city)
            print(f"Created city {city.name} (id {city.id})")

        # Position fallback
        lat = args.lat
        lon = args.lon
        if lat is None or lon is None:
            default_lat, default_lon = CITY_CENTRES.get(args.city.lower(), (34.026569, -6.760833))
            lat = lat if lat is not None else default_lat
            lon = lon if lon is not None else default_lon

        cam = db.scalar(select(Camera).where(Camera.name == args.name))
        is_new = False
        if not cam:
            is_new = True
            cam = Camera(
                id=uuid.uuid4(),
                city_id=city.id,
                name=args.name,
                kind="fixed_cctv",
                street_address=args.address,
                latitude=lat,
                longitude=lon,
                host=args.host,
                port=args.port,
                protocol=args.protocol,
                stream_path=args.stream_path,
                status=args.status,
                notes=f"Direct {args.protocol.upper()} network camera stream",
                installed_on=datetime.now(UTC).date(),
            )
            db.add(cam)
            db.flush()
        else:
            cam.city_id = city.id
            cam.host = args.host
            cam.port = args.port
            cam.protocol = args.protocol
            cam.stream_path = args.stream_path
            cam.latitude = lat
            cam.longitude = lon
            cam.street_address = args.address
            cam.status = args.status
            cam.updated_at = datetime.now(UTC)

        # Encrypt credentials if provided
        if args.username and args.password:
            plaintext = json.dumps({"username": args.username, "password": args.password}).encode()
            cam.credentials_encrypted, cam.credentials_key_id = crypto.encrypt(
                keys, plaintext, purpose="camera-credentials", row_id=str(cam.id)
            )

        db.add(CameraStatusEvent(camera_id=cam.id, status=args.status, reason="registered/updated directly"))
        audit_action = "camera.create" if is_new else "camera.update"
        audit_chain.append(db, keys.audit_signing_key(), Actor(id="cli", role="system", ip="local"),
                           audit_action, "camera", str(cam.id), f"Direct {args.protocol.upper()} camera configuration")
        db.commit()

        userinfo = "***@" if args.username else ""
        assembled = f"{args.protocol}://{userinfo}{args.host}:{args.port}{args.stream_path}"
        print(f"Successfully {'created' if is_new else 'updated'} Camera {cam.name} (id {cam.id}) in city {city.name}:")
        print(f"  URL: {assembled}")
        print(f"  Coordinates: {cam.latitude}, {cam.longitude}")
        print(f"  Status: {cam.status}")

    engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(main())

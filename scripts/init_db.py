"""Create the dashboard database (every table, empty) and optionally add real cities and watchlists.

    $env:PYTHONPATH = "src"
    python scripts/init_db.py
    python scripts/init_db.py --city rabat:Rabat --city casablanca:Casablanca --watchlist "Stolen vehicles"

The file is ANPR_DB_PATH, default data/app/anpr.sqlite3 (under data/, which git ignores: it will
hold plate reads). Safe to run again: existing tables and rows are kept, and a city or watchlist
that already exists is skipped. Nothing else is inserted; cameras, entries and accounts are
created from the dashboard (the first super admin with python -m anpr.db.create_super_admin).
"""

import argparse
import sys
import uuid

from anpr.db.database import connect, db_path, now_iso, transaction
from anpr.db.users import CITY_ID
from anpr.security import audit


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--db", default=None, help="database file (default: ANPR_DB_PATH or data/app/anpr.sqlite3)")
    p.add_argument("--city", action="append", default=[], metavar="ID:NAME", help="e.g. rabat:Rabat (repeatable)")
    p.add_argument("--watchlist", action="append", default=[], metavar="NAME", help="e.g. 'Stolen vehicles' (repeatable)")
    args = p.parse_args(argv)

    cities = []
    for spec in args.city:
        city_id, _, name = spec.partition(":")
        if not CITY_ID.match(city_id) or not 1 <= len(name.strip()) <= 80:
            print(f"--city {spec!r}: use id:Name, id = lowercase letters, digits and '-'.", file=sys.stderr)
            return 2
        cities.append((city_id, name.strip()))
    lists = [n.strip() for n in args.watchlist if n.strip()]
    if any(len(n) > 80 for n in lists):
        print("Watchlist names are at most 80 characters.", file=sys.stderr)
        return 2

    conn = connect(args.db)  # creates every table that does not exist yet
    try:
        with transaction(conn):
            for city_id, name in cities:
                if conn.execute("SELECT 1 FROM cities WHERE id = ? OR name = ?", (city_id, name)).fetchone():
                    print(f"city {city_id} exists, skipped")
                    continue
                conn.execute("INSERT INTO cities (id, name, created_at) VALUES (?, ?, ?)", (city_id, name, now_iso()))
                audit.append(conn, actor="cli", role="system", action="city.create", target=city_id, detail=name, ip="local")
                print(f"city {city_id} ({name}) added")
            for name in lists:
                if conn.execute("SELECT 1 FROM watchlist_lists WHERE name = ?", (name,)).fetchone():
                    print(f"watchlist {name!r} exists, skipped")
                    continue
                list_id = f"wl-{uuid.uuid4().hex[:8]}"
                conn.execute("INSERT INTO watchlist_lists (id, name, created_at) VALUES (?, ?, ?)", (list_id, name, now_iso()))
                audit.append(conn, actor="cli", role="system", action="watchlist.create", target=list_id, detail=name, ip="local")
                print(f"watchlist {name!r} added as {list_id}")
    finally:
        conn.close()
    print(f"database ready: {args.db or db_path()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

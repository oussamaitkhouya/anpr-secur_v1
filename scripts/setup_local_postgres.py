"""One-time setup of a native (non-Docker) PostgreSQL for development, mirroring
configs/postgres/init-roles.sh: roles anpr_owner and anpr_app, databases anpr and anpr_test.

Run from the repo root, with the venv active:
    python scripts/setup_local_postgres.py --port 5432

It asks for the `postgres` superuser password at a hidden prompt (never as an argument), reads
POSTGRES_OWNER_PASSWORD and APP_DB_PASSWORD from .env, and then points DATABASE_URL,
MIGRATION_DATABASE_URL and TEST_DATABASE_URL in .env at this server (the old .env is kept as
.env.bak). No secret is printed. Safe to run twice: existing roles get their password reset.
"""

import argparse
import getpass
import shutil
import sys
from pathlib import Path
from urllib.parse import quote

import psycopg
from psycopg import sql

ENV = Path(".env")


def read_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, _, value = line.partition("=")
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def ensure_role(conn, name: str, password: str, extra: str) -> None:
    exists = conn.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (name,)).fetchone()
    verb = "ALTER" if exists else "CREATE"
    conn.execute(sql.SQL(f"{verb} ROLE {{}} LOGIN PASSWORD {{}} {extra}").format(sql.Identifier(name), sql.Literal(password)))


def ensure_db(conn, name: str) -> None:
    if not conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (name,)).fetchone():
        conn.execute(sql.SQL("CREATE DATABASE {} OWNER anpr_owner").format(sql.Identifier(name)))
    conn.execute(sql.SQL("REVOKE ALL ON DATABASE {} FROM PUBLIC").format(sql.Identifier(name)))
    conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO anpr_app").format(sql.Identifier(name)))


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=5432)
    p.add_argument("--superuser", default="postgres")
    args = p.parse_args()

    env = read_env(ENV)
    owner_pw, app_pw = env.get("POSTGRES_OWNER_PASSWORD", ""), env.get("APP_DB_PASSWORD", "")
    if not owner_pw or not app_pw or "change-me" in owner_pw + app_pw:
        print("Set POSTGRES_OWNER_PASSWORD and APP_DB_PASSWORD in .env first (python -m anpr.security.keys).", file=sys.stderr)
        return 2

    su_pw = getpass.getpass(f"Password for PostgreSQL user '{args.superuser}': ")
    try:
        with psycopg.connect(host=args.host, port=args.port, user=args.superuser, password=su_pw,
                             dbname="postgres", autocommit=True, connect_timeout=5) as conn:
            ensure_role(conn, "anpr_owner", owner_pw, "NOSUPERUSER CREATEDB NOCREATEROLE")
            ensure_role(conn, "anpr_app", app_pw, "NOSUPERUSER NOCREATEDB NOCREATEROLE")
            for db in ("anpr", "anpr_test"):
                ensure_db(conn, db)
        # PostgreSQL 14 and older: schema public belongs to the superuser, so the owner role could
        # not run migrations cleanly or reset the test database. (15+ gives it to the db owner.)
        for db in ("anpr", "anpr_test"):
            with psycopg.connect(host=args.host, port=args.port, user=args.superuser, password=su_pw,
                                 dbname=db, autocommit=True, connect_timeout=5) as conn:
                conn.execute("ALTER SCHEMA public OWNER TO anpr_owner")
                conn.execute("REVOKE CREATE ON SCHEMA public FROM PUBLIC")
    except psycopg.OperationalError:
        print("Could not connect as the superuser (wrong password, port or server not running).", file=sys.stderr)
        return 1

    base = f"{args.host}:{args.port}"
    urls = {
        "DATABASE_URL": f"postgresql+psycopg://anpr_app:{quote(app_pw, safe='')}@{base}/anpr",
        "MIGRATION_DATABASE_URL": f"postgresql+psycopg://anpr_owner:{quote(owner_pw, safe='')}@{base}/anpr",
        "TEST_DATABASE_URL": f"postgresql+psycopg://anpr_owner:{quote(owner_pw, safe='')}@{base}/anpr_test",
    }
    backup = ENV.with_suffix(".bak")
    if not backup.exists():  # keep the very first copy: a second run must not overwrite it
        shutil.copyfile(ENV, backup)
    lines, seen = [], set()
    for line in ENV.read_text(encoding="utf-8").splitlines():
        key = line.partition("=")[0].strip()
        if key in urls and not line.lstrip().startswith("#"):
            lines.append(f"{key}={urls[key]}")
            seen.add(key)
        else:
            lines.append(line)
    lines += [f"{k}={v}" for k, v in urls.items() if k not in seen]
    ENV.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"Roles anpr_owner and anpr_app ready; databases anpr and anpr_test on {base}.")
    print("Updated DATABASE_URL, MIGRATION_DATABASE_URL and TEST_DATABASE_URL in .env (original kept in .env.bak).")
    print("Next: alembic upgrade head")
    return 0


if __name__ == "__main__":
    sys.exit(main())

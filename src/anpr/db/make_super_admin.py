"""Promote an existing account to super admin. Run from a terminal you trust:

    $env:PYTHONPATH = "src"
    python -m anpr.db.make_super_admin --username <you>

Works from the CLI only, on the database named by MIGRATION_DATABASE_URL (the owner role), so
the first super admin cannot be created through the API. Later super admins are granted from
the dashboard by a super admin. The change is written to the signed audit chain, and the
account's sessions are revoked so it signs in again with the new role.
"""

import argparse
import os
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.db.engine import make_engine
from anpr.db.models import User, UserCity, utcnow
from anpr.security import audit_chain
from anpr.security.keys import EnvKeyProvider
from anpr.security.rbac import Actor
from anpr.security.tokens import revoke_user
from anpr.utils.settings import load_env_file, load_settings


def main(argv: list[str] | None = None, url: str | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--username", required=True)
    args = p.parse_args(argv)
    username = args.username.strip().lower()

    load_env_file()
    settings = load_settings()
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    engine = make_engine(url or os.environ.get("MIGRATION_DATABASE_URL") or settings.database_url)
    try:
        with Session(engine) as db:
            user = db.scalar(select(User).where(User.username == username))
            if user is None:
                print("No account with that username.", file=sys.stderr)
                return 1
            if not user.is_active:
                print("That account is deactivated.", file=sys.stderr)
                return 1
            if user.role == "super_admin":
                print(f"'{username}' is already a super admin.")
                return 0
            old_role = user.role
            user.role = "super_admin"
            user.updated_at = utcnow()
            db.query(UserCity).filter(UserCity.user_id == user.id).delete()  # super admins see all cities
            revoke_user(db, user.id)
            audit_chain.append(db, keys.audit_signing_key(), Actor(id="cli", role="system", ip="local"),
                               "user.update", "user", str(user.id), f"role={old_role}->super_admin (cli)")
            db.commit()
    finally:
        engine.dispose()
    print(f"'{username}' is now a super admin. Sign in again to use the new role.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

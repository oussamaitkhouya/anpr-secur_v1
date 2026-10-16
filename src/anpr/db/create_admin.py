"""Create the first admin of the PostgreSQL backend. Run once, from a terminal you trust:

    $env:PYTHONPATH = "src"
    python -m anpr.db.create_admin --username <you>

The password is asked twice at a hidden prompt, never taken as an argument or environment
variable, checked against the password policy and stored only as an Argon2id hash. The account
is created in the database named by MIGRATION_DATABASE_URL (the owner role; the API's own role
cannot create the first account). Refuses to run if an admin already exists: further accounts
are created from the dashboard. MFA is set up at the first sign-in.
"""

import argparse
import getpass
import os
import re
import sys

from sqlalchemy import select
from sqlalchemy.orm import Session

from anpr.db.engine import make_engine
from anpr.db.models import User
from anpr.security import audit_chain
from anpr.security.keys import EnvKeyProvider
from anpr.security.passwords import hash_password, policy_problems
from anpr.security.rbac import Actor
from anpr.utils.settings import load_env_file, load_settings

USERNAME = re.compile(r"^[a-z0-9._-]{3,32}$")
USERNAME_HELP = "Username: 3 to 32 characters, lowercase letters, digits, '.', '_' or '-'."


def main(argv: list[str] | None = None, read_password=getpass.getpass, url: str | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--username", required=True)
    args = p.parse_args(argv)
    username = args.username.strip().lower()
    if not USERNAME.match(username):
        print(USERNAME_HELP, file=sys.stderr)
        return 2

    load_env_file()
    settings = load_settings()
    keys = EnvKeyProvider(settings.data_keys, settings.active_data_key_id, settings.audit_signing_key)
    engine = make_engine(url or os.environ.get("MIGRATION_DATABASE_URL") or settings.database_url)
    with Session(engine) as db:
        if db.scalar(select(User.id).where(User.role.in_(("super_admin", "admin"))).limit(1)):
            print("An admin already exists. Create other accounts from the dashboard.", file=sys.stderr)
            return 1
        if db.scalar(select(User.id).where(User.username == username)):
            print("That username is taken.", file=sys.stderr)
            return 1
        password = read_password("Password: ")
        problems = policy_problems(password, username)
        if problems:
            print(" ".join(problems), file=sys.stderr)
            return 2
        if read_password("Repeat password: ") != password:
            print("The passwords do not match.", file=sys.stderr)
            return 2
        user = User(username=username, password_hash=hash_password(password), role="admin",
                    is_active=True, failed_attempts=0)
        db.add(user)
        db.flush()
        audit_chain.append(db, keys.audit_signing_key(), Actor(id="cli", role="system", ip="local"),
                           "user.create", "user", str(user.id), "role=admin (bootstrap)")
        db.commit()
    engine.dispose()
    print(f"Admin '{username}' created. Sign in at the dashboard; you will set up MFA on first sign-in.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

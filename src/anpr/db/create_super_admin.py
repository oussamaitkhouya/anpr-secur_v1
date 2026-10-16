"""Create the first super admin account. Run once, from a terminal you trust:

    $env:PYTHONPATH = "src"
    python -m anpr.db.create_super_admin --username <you> --name "<your name>"

The password is asked twice at a hidden prompt. It is never accepted as an argument or an
environment variable (those end up in shell history and process listings) and is stored only
as an Argon2id hash. Refuses to run if a super admin already exists; further accounts are
created from the dashboard.
"""

import argparse
import getpass
import json
import sys
import uuid

from anpr.db.database import connect, now_iso, transaction
from anpr.db.users import USERNAME
from anpr.security import audit
from anpr.security.passwords import hash_password, policy_problems


def main(argv: list[str] | None = None, read_password=getpass.getpass) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--username", required=True)
    p.add_argument("--name", default=None, help="display name (defaults to the username)")
    p.add_argument("--db", default=None, help="database file (default: ANPR_DB_PATH or data/app/anpr.sqlite3)")
    args = p.parse_args(argv)

    username = args.username.strip().lower()
    if not USERNAME.match(username):
        print("Username: 3 to 32 characters, lowercase letters, digits, '.', '_' or '-'.", file=sys.stderr)
        return 2

    conn = connect(args.db)
    try:
        if conn.execute("SELECT 1 FROM users WHERE role = 'super_admin'").fetchone():
            print("A super admin already exists. Create other accounts from the dashboard.", file=sys.stderr)
            return 1
        if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
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

        now = now_iso()
        with transaction(conn):
            conn.execute(
                "INSERT INTO users (id, username, display_name, role, password_hash, allowed_city_ids, created_at, updated_at, created_by)"
                " VALUES (?, ?, ?, 'super_admin', ?, ?, ?, ?, 'cli')",
                (f"u-{uuid.uuid4().hex[:12]}", username, (args.name or username)[:60], hash_password(password), json.dumps([]), now, now),
            )
            audit.append(conn, actor="cli", role="system", action="user.create", target=username,
                         detail="role=super_admin (bootstrap)", ip="local")
        print(f"Super admin '{username}' created.")
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())

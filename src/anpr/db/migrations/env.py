"""Alembic environment. Connects as the schema owner (MIGRATION_DATABASE_URL), not as the app role.

Tests pass their own URL with: config.set_main_option("sqlalchemy.url", url).
"""

import os

from alembic import context
from sqlalchemy import create_engine, pool

from anpr.db.models import Base
from anpr.utils.settings import load_env_file

load_env_file()  # MIGRATION_DATABASE_URL from .env when it is not already in the environment

config = context.config
target_metadata = Base.metadata


def database_url() -> str:
    # Config lives in pyproject.toml (no alembic.ini), so read the optional override without
    # get_main_option, which raises when there is no ini section.
    url = (config.file_config.get(config.config_ini_section, "sqlalchemy.url", fallback=None)
           or os.environ.get("MIGRATION_DATABASE_URL"))
    if not url:
        raise RuntimeError("set MIGRATION_DATABASE_URL (the owner role) to run migrations")
    return url


def run_migrations_offline() -> None:
    context.configure(url=database_url(), target_metadata=target_metadata, literal_binds=True,
                      dialect_opts={"paramstyle": "named"})
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    engine = create_engine(database_url(), poolclass=pool.NullPool)
    with engine.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()

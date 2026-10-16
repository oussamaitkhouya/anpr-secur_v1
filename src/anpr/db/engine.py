"""SQLAlchemy engine and session factory for PostgreSQL.

create_app() builds one engine from its settings and keeps the session factory on app.state;
anpr.api.deps.get_db hands out one session per request. Routes commit explicitly. The audit
entry for an action is written in the same session, so both commit together or not at all.
"""

from sqlalchemy import Engine, create_engine
from sqlalchemy.orm import Session, sessionmaker


def make_engine(url: str) -> Engine:
    # pool_pre_ping: replace dead connections after a database restart instead of failing a request.
    # The engine connects lazily, so building it does not need the database to be up.
    return create_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=10)


def make_session_factory(engine: Engine) -> sessionmaker[Session]:
    return sessionmaker(bind=engine, expire_on_commit=False)

"""Camera registry: host instead of ip_address, notes, 'unknown' status, status history.

Revision ID: 0002
Revises: 0001
Create Date: 2026-10-09

- cameras.ip_address becomes cameras.host (a hostname or an IP, validated by the API). Existing
  IPs are kept as they are valid hosts.
- cameras.notes (free text, capped at 2000 characters by the API).
- status gains 'unknown', the new default: a camera nobody has tested is not "offline".
- camera_status_events: one row per status change, for the detail drawer's history.
- Composite index (city_id, status) for the city-scoped health queries.
"""

import sqlalchemy as sa
from alembic import op

revision = "0002"
down_revision = "0001"
branch_labels = None
depends_on = None

APP_ROLE = "anpr_app"
STATUSES_OLD = "'online', 'offline', 'degraded', 'maintenance'"
STATUSES_NEW = "'online', 'offline', 'degraded', 'maintenance', 'unknown'"

APP_GRANTS = f"""
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON camera_status_events TO {APP_ROLE}';
    END IF;
END
$$;
"""


def upgrade() -> None:
    op.alter_column("cameras", "ip_address", new_column_name="host", type_=sa.String(length=253),
                    existing_nullable=True)
    op.add_column("cameras", sa.Column("notes", sa.Text(), nullable=True))
    op.drop_constraint("status_allowed", "cameras", type_="check")
    op.create_check_constraint("status_allowed", "cameras", f"status IN ({STATUSES_NEW})")
    op.create_index("ix_cameras_city_status", "cameras", ["city_id", "status"])

    op.create_table(
        "camera_status_events",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("camera_id", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("reason", sa.String(length=120), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(f"status IN ({STATUSES_NEW})", name="status_allowed"),
        sa.ForeignKeyConstraint(["camera_id"], ["cameras.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(op.f("ix_camera_status_events_camera_id"), "camera_status_events", ["camera_id"])
    op.execute(APP_GRANTS)


def downgrade() -> None:
    op.drop_table("camera_status_events")
    op.drop_index("ix_cameras_city_status", table_name="cameras")
    op.execute("UPDATE cameras SET status = 'offline' WHERE status = 'unknown'")
    op.drop_constraint("status_allowed", "cameras", type_="check")
    op.create_check_constraint("status_allowed", "cameras", f"status IN ({STATUSES_OLD})")
    op.drop_column("cameras", "notes")
    op.alter_column("cameras", "host", new_column_name="ip_address", type_=sa.String(length=45),
                    existing_nullable=True, postgresql_using="left(host, 45)")

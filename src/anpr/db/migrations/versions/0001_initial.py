"""Initial schema: accounts, cameras, watchlists, detections, alerts, signed audit chain.

Revision ID: 0001
Revises:
Create Date: 2026-10-08

Besides the tables this migration installs two protections for audit_entries:
1. A trigger that raises on UPDATE, DELETE and TRUNCATE, for every role including the owner.
2. Grants for the application role anpr_app (if it exists): normal read/write on business
   tables, but only SELECT and INSERT on audit_entries. Even with the trigger dropped, the app's
   own credentials cannot rewrite history; that needs the owner role, which the API never uses.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

APP_ROLE = "anpr_app"

AUDIT_GUARD = """
CREATE FUNCTION audit_entries_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'audit_entries is append-only (% blocked)', TG_OP
        USING ERRCODE = 'insufficient_privilege';
END;
$$;
CREATE TRIGGER audit_entries_no_update_delete
    BEFORE UPDATE OR DELETE ON audit_entries
    FOR EACH ROW EXECUTE FUNCTION audit_entries_append_only();
CREATE TRIGGER audit_entries_no_truncate
    BEFORE TRUNCATE ON audit_entries
    FOR EACH STATEMENT EXECUTE FUNCTION audit_entries_append_only();
"""

APP_GRANTS = f"""
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{APP_ROLE}') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO {APP_ROLE}';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {APP_ROLE}';
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON audit_entries FROM {APP_ROLE}';
        EXECUTE 'REVOKE ALL ON alembic_version FROM {APP_ROLE}';
        EXECUTE 'GRANT SELECT ON alembic_version TO {APP_ROLE}';
    END IF;
END
$$;
"""


def upgrade() -> None:
    op.create_table('audit_entries',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('seq', sa.BigInteger(), nullable=False),
    sa.Column('ts', sa.DateTime(timezone=True), nullable=False),
    sa.Column('actor_id', sa.String(length=64), nullable=False),
    sa.Column('actor_role', sa.String(length=16), nullable=False),
    sa.Column('action', sa.String(length=64), nullable=False),
    sa.Column('target_type', sa.String(length=32), nullable=False),
    sa.Column('target_id', sa.String(length=64), nullable=True),
    sa.Column('justification', sa.Text(), nullable=True),
    sa.Column('ip', sa.String(length=45), nullable=False),
    sa.Column('prev_hash', sa.String(length=64), nullable=False),
    sa.Column('hash', sa.String(length=64), nullable=False),
    sa.Column('signature', sa.String(length=100), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('seq')
    )
    op.create_index(op.f('ix_audit_entries_action'), 'audit_entries', ['action'], unique=False)
    op.create_table('cities',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('region', sa.String(length=80), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    op.create_table('users',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('username', sa.String(length=32), nullable=False),
    sa.Column('password_hash', sa.String(length=255), nullable=False),
    sa.Column('role', sa.String(length=16), nullable=False),
    sa.Column('totp_secret_encrypted', sa.LargeBinary(), nullable=True),
    sa.Column('totp_key_id', sa.String(length=32), nullable=True),
    sa.Column('totp_confirmed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('totp_last_step', sa.BigInteger(), nullable=True),
    sa.Column('is_active', sa.Boolean(), nullable=False),
    sa.Column('failed_attempts', sa.Integer(), nullable=False),
    sa.Column('locked_until', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("role IN ('admin', 'analyst', 'auditor')", name='role_allowed'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('username')
    )
    op.create_table('cameras',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('city_id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('kind', sa.String(length=16), nullable=False),
    sa.Column('district', sa.String(length=80), nullable=True),
    sa.Column('street_address', sa.String(length=200), nullable=True),
    sa.Column('latitude', sa.Float(), nullable=False),
    sa.Column('longitude', sa.Float(), nullable=False),
    sa.Column('view_direction_deg', sa.Integer(), nullable=True),
    sa.Column('lane', sa.String(length=20), nullable=True),
    sa.Column('installed_on', sa.Date(), nullable=True),
    sa.Column('owner', sa.String(length=80), nullable=True),
    sa.Column('ip_address', sa.String(length=45), nullable=True),
    sa.Column('port', sa.Integer(), nullable=True),
    sa.Column('protocol', sa.String(length=10), nullable=False),
    sa.Column('stream_path', sa.String(length=200), nullable=True),
    sa.Column('vlan', sa.Integer(), nullable=True),
    sa.Column('firmware_version', sa.String(length=40), nullable=True),
    sa.Column('credentials_encrypted', sa.LargeBinary(), nullable=True),
    sa.Column('credentials_key_id', sa.String(length=32), nullable=True),
    sa.Column('status', sa.String(length=12), nullable=False),
    sa.Column('last_frame_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('tls_not_after', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.CheckConstraint("kind IN ('fixed_cctv', 'ptz', 'anpr_camera', 'radar')", name='kind_allowed'),
    sa.CheckConstraint("protocol IN ('rtsps', 'rtsp', 'onvif', 'file', 'webhook', 'mqtt')", name='protocol_allowed'),
    sa.CheckConstraint("status IN ('online', 'offline', 'degraded', 'maintenance')", name='status_allowed'),
    sa.CheckConstraint('(credentials_encrypted IS NULL) = (credentials_key_id IS NULL)', name='credentials_key_pair'),
    sa.CheckConstraint('latitude BETWEEN -90 AND 90', name='latitude_range'),
    sa.CheckConstraint('longitude BETWEEN -180 AND 180', name='longitude_range'),
    sa.CheckConstraint('port IS NULL OR port BETWEEN 1 AND 65535', name='port_range'),
    sa.CheckConstraint('view_direction_deg IS NULL OR view_direction_deg BETWEEN 0 AND 359', name='view_direction_range'),
    sa.CheckConstraint('vlan IS NULL OR vlan BETWEEN 1 AND 4094', name='vlan_range'),
    sa.ForeignKeyConstraint(['city_id'], ['cities.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('city_id', 'name')
    )
    op.create_index(op.f('ix_cameras_city_id'), 'cameras', ['city_id'], unique=False)
    op.create_index(op.f('ix_cameras_status'), 'cameras', ['status'], unique=False)
    op.create_table('refresh_tokens',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('family_id', sa.Uuid(), nullable=False),
    sa.Column('token_sha256', sa.String(length=64), nullable=False),
    sa.Column('issued_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('used_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token_sha256')
    )
    op.create_index(op.f('ix_refresh_tokens_family_id'), 'refresh_tokens', ['family_id'], unique=False)
    op.create_index(op.f('ix_refresh_tokens_user_id'), 'refresh_tokens', ['user_id'], unique=False)
    op.create_table('user_cities',
    sa.Column('user_id', sa.Uuid(), nullable=False),
    sa.Column('city_id', sa.Uuid(), nullable=False),
    sa.ForeignKeyConstraint(['city_id'], ['cities.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('user_id', 'city_id')
    )
    op.create_table('watchlist_lists',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('name', sa.String(length=80), nullable=False),
    sa.Column('source', sa.String(length=120), nullable=False),
    sa.Column('created_by', sa.Uuid(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('name')
    )
    op.create_table('detection_events',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('camera_id', sa.Uuid(), nullable=False),
    sa.Column('observed_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('source_kind', sa.String(length=8), nullable=False),
    sa.Column('plate_raw', sa.String(length=40), nullable=False),
    sa.Column('plate_canonical', sa.String(length=20), nullable=True),
    sa.Column('char_confidences', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('plate_confidence', sa.Float(), nullable=False),
    sa.Column('observed_color', sa.String(length=30), nullable=True),
    sa.Column('observed_make', sa.String(length=40), nullable=True),
    sa.Column('observed_model', sa.String(length=40), nullable=True),
    sa.Column('evidence_sha256', sa.String(length=64), nullable=True),
    sa.Column('evidence_uri', sa.String(length=300), nullable=True),
    sa.Column('speed_kmh', sa.Float(), nullable=True),
    sa.CheckConstraint("source_kind IN ('video', 'radar')", name='source_kind_allowed'),
    sa.CheckConstraint('plate_confidence BETWEEN 0 AND 1', name='plate_confidence_range'),
    sa.CheckConstraint('speed_kmh IS NULL OR speed_kmh BETWEEN 0 AND 400', name='speed_range'),
    sa.ForeignKeyConstraint(['camera_id'], ['cameras.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_detection_events_camera_id'), 'detection_events', ['camera_id'], unique=False)
    op.create_index(op.f('ix_detection_events_observed_at'), 'detection_events', ['observed_at'], unique=False)
    op.create_index(op.f('ix_detection_events_plate_canonical'), 'detection_events', ['plate_canonical'], unique=False)
    op.create_table('watchlist_imports',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('list_id', sa.Uuid(), nullable=False),
    sa.Column('file_name', sa.String(length=200), nullable=False),
    sa.Column('sha256', sa.String(length=64), nullable=False),
    sa.Column('rows_total', sa.Integer(), nullable=False),
    sa.Column('rows_accepted', sa.Integer(), nullable=False),
    sa.Column('rows_rejected', sa.Integer(), nullable=False),
    sa.Column('rejected_report', postgresql.JSONB(astext_type=sa.Text()), nullable=False),
    sa.Column('imported_by', sa.Uuid(), nullable=False),
    sa.Column('imported_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.ForeignKeyConstraint(['imported_by'], ['users.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['list_id'], ['watchlist_lists.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('list_id', 'version')
    )
    op.create_index(op.f('ix_watchlist_imports_list_id'), 'watchlist_imports', ['list_id'], unique=False)
    op.create_index(op.f('ix_watchlist_imports_sha256'), 'watchlist_imports', ['sha256'], unique=False)
    op.create_table('watchlist_entries',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('list_id', sa.Uuid(), nullable=False),
    sa.Column('import_id', sa.Uuid(), nullable=True),
    sa.Column('plate_canonical', sa.String(length=20), nullable=False),
    sa.Column('reason', sa.String(length=10), nullable=False),
    sa.Column('color', sa.String(length=30), nullable=True),
    sa.Column('make', sa.String(length=40), nullable=True),
    sa.Column('model', sa.String(length=40), nullable=True),
    sa.Column('vehicle_type', sa.String(length=30), nullable=True),
    sa.Column('case_ref', sa.String(length=60), nullable=True),
    sa.Column('source', sa.String(length=120), nullable=True),
    sa.Column('added_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('removed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('removed_by', sa.Uuid(), nullable=True),
    sa.CheckConstraint("reason IN ('stolen', 'wanted', 'other')", name='reason_allowed'),
    sa.ForeignKeyConstraint(['import_id'], ['watchlist_imports.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['list_id'], ['watchlist_lists.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['removed_by'], ['users.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_watchlist_entries_list_id'), 'watchlist_entries', ['list_id'], unique=False)
    op.create_index(op.f('ix_watchlist_entries_plate_canonical'), 'watchlist_entries', ['plate_canonical'], unique=False)
    op.create_index('uq_active_plate_per_list', 'watchlist_entries', ['list_id', 'plate_canonical'], unique=True, postgresql_where=sa.text('removed_at IS NULL'))
    op.create_table('alerts',
    sa.Column('id', sa.Uuid(), nullable=False),
    sa.Column('detection_id', sa.Uuid(), nullable=False),
    sa.Column('entry_id', sa.Uuid(), nullable=False),
    sa.Column('kind', sa.String(length=30), nullable=False),
    sa.Column('score', sa.Float(), nullable=False),
    sa.Column('status', sa.String(length=10), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('reviewed_by', sa.Uuid(), nullable=True),
    sa.Column('reviewed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('justification', sa.Text(), nullable=True),
    sa.CheckConstraint("kind IN ('full_match', 'plate_only_mismatch_vehicle', 'fuzzy_match')", name='kind_allowed'),
    sa.CheckConstraint("status IN ('pending', 'approved', 'rejected', 'escalated')", name='status_allowed'),
    sa.ForeignKeyConstraint(['detection_id'], ['detection_events.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['entry_id'], ['watchlist_entries.id'], ondelete='RESTRICT'),
    sa.ForeignKeyConstraint(['reviewed_by'], ['users.id'], ondelete='RESTRICT'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('detection_id', 'entry_id')
    )
    op.create_index(op.f('ix_alerts_detection_id'), 'alerts', ['detection_id'], unique=False)
    op.create_index(op.f('ix_alerts_status'), 'alerts', ['status'], unique=False)
    op.execute(AUDIT_GUARD)
    op.execute(APP_GRANTS)


def downgrade() -> None:
    op.execute("DROP TRIGGER IF EXISTS audit_entries_no_truncate ON audit_entries")
    op.execute("DROP TRIGGER IF EXISTS audit_entries_no_update_delete ON audit_entries")
    op.execute("DROP FUNCTION IF EXISTS audit_entries_append_only()")
    for table in ("alerts", "detection_events", "watchlist_entries", "watchlist_imports", "watchlist_lists",
                  "cameras", "refresh_tokens", "user_cities", "users", "cities", "audit_entries"):
        op.drop_table(table)

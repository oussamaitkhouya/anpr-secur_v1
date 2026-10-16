"""Super admin role.

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-09

- users.role may be 'super_admin': every permission, and the only role that manages admin and
  super admin accounts (anpr.security.rbac, anpr.api.routes.admin). Granted from the CLI with
  anpr.db.make_super_admin, or by another super admin from the dashboard.
"""

from alembic import op

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("role_allowed", "users", type_="check")
    op.create_check_constraint("role_allowed", "users", "role IN ('super_admin', 'admin', 'analyst', 'auditor')")


def downgrade() -> None:
    # Refuses (check violation) while a super admin exists: demote them first.
    op.drop_constraint("role_allowed", "users", type_="check")
    op.create_check_constraint("role_allowed", "users", "role IN ('admin', 'analyst', 'auditor')")

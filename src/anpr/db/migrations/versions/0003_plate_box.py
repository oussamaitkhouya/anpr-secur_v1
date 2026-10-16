"""Plate box on detections, for the evidence view.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-09

- detection_events.plate_box: where the detector found the plate in the evidence frame, as
  [x, y, w, h] fractions of the frame (0..1). NULL for reads without a frame or from older
  workers. The API validates the values; the frame itself is never modified.
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0003"
down_revision = "0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("detection_events", sa.Column("plate_box", JSONB, nullable=True))


def downgrade() -> None:
    op.drop_column("detection_events", "plate_box")

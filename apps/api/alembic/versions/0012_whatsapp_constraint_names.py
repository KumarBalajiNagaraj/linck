"""name core.whatsapp_messages' keys and indexes the way the models do

0009 created core.whatsapp_messages in raw SQL, so its primary key, foreign
keys and organization index took Postgres's default names
(whatsapp_messages_pkey, ..._fkey, ix_whatsapp_messages_organization_id)
instead of the naming convention in app/models/base.py, and the model did not
declare the pending-inbox index or the imported_by ON DELETE RESTRICT. Alembic
autogenerate therefore proposed dropping and re-creating all of them, so
`alembic check`, the drift gate, could never pass.

Renames only; nothing is rebuilt and no row is touched. The model now
declares what 0009 created.

Revision ID: 0012_whatsapp_names
Revises: 0011_desk_persistence
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0012_whatsapp_names"
down_revision: str | None = "0011_desk_persistence"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# (what 0009 got, what the naming convention calls it)
CONSTRAINTS = (
    ("whatsapp_messages_pkey", "pk_whatsapp_messages"),
    ("whatsapp_messages_organization_id_fkey", "fk_whatsapp_messages_organization_id"),
    ("whatsapp_messages_imported_by_fkey", "fk_whatsapp_messages_imported_by"),
)
INDEX = ("ix_whatsapp_messages_organization_id", "ix_core_whatsapp_messages_organization_id")


def upgrade() -> None:
    for old, new in CONSTRAINTS:
        op.execute(f"ALTER TABLE core.whatsapp_messages RENAME CONSTRAINT {old} TO {new}")
    op.execute(f"ALTER INDEX core.{INDEX[0]} RENAME TO {INDEX[1]}")


def downgrade() -> None:
    op.execute(f"ALTER INDEX core.{INDEX[1]} RENAME TO {INDEX[0]}")
    for old, new in CONSTRAINTS:
        op.execute(f"ALTER TABLE core.whatsapp_messages RENAME CONSTRAINT {new} TO {old}")

"""expense bill upload: fleet and stores desks

LIN-11 let the fleet manager and the store manager upload scanned expense
bills, and gave the store manager an expense register of their own under
Stores. The web app gates the upload action and the Stores register on these
three keys; as with 0006 and 0007, a key missing here could never be granted.

Downgrade refuses (foreign-key violation) while any role still holds one.

Revision ID: 0008_expense_upload
Revises: 0007_fleet_desk
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0008_expense_upload"
down_revision: str | None = "0007_fleet_desk"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KEYS = ("fleet.expense.upload", "stores.expense.read", "stores.expense.upload")


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('fleet.expense.upload',  'fleet',  'Upload scanned fleet expense bills'),
            ('stores.expense.read',   'stores', 'See the stores expense register'),
            ('stores.expense.upload', 'stores', 'Upload scanned stores expense bills')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM core.permissions WHERE key IN ({', '.join(repr(k) for k in KEYS)})")

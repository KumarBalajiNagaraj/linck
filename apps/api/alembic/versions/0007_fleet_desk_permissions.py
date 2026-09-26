"""fleet desk permissions: drivers, breakdown register, expenses

LIN-18 gave the Fleet Manager a command board whose buttons open three new
databases — the driver list, the breakdown register and the expense bills —
and made the fleet manager the first sign-off on an expense bill. The web app
gates them on these four keys; like 0006, a key missing here could never be
granted to a real user.

Downgrade refuses (foreign-key violation) while any role still holds one.

Revision ID: 0007_fleet_desk
Revises: 0006_sales_desk
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007_fleet_desk"
down_revision: str | None = "0006_sales_desk"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KEYS = ("fleet.driver.read", "fleet.breakdown.read", "fleet.expense.read", "fleet.expense.validate")


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('fleet.driver.read',      'fleet', 'See the driver list and attendance'),
            ('fleet.breakdown.read',   'fleet', 'See the breakdown register'),
            ('fleet.expense.read',     'fleet', 'See fleet expense bills'),
            ('fleet.expense.validate', 'fleet', 'Validate fleet expense bills, the first sign-off')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM core.permissions WHERE key IN ({', '.join(repr(k) for k in KEYS)})")

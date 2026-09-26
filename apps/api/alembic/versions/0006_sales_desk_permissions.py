"""sales desk permissions: command board, customers, purchase orders

LIN-17 gave the Sales Coordinator a command board of their own and two new
databases behind it. The web app gates them on four keys, and a key that is
not in core.permissions can never be granted — role_permissions.permission_key
is a foreign key into it — so without this migration the coordinator would be
sent straight back to the fleet board the day the app switches from mock
sessions to GET /me/session.

Downgrade refuses (foreign-key violation) while any role still holds one of
these keys. That is deliberate: silently revoking a grant is not a schema
change.

Revision ID: 0006_sales_desk
Revises: 0005_audit_writer
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0006_sales_desk"
down_revision: str | None = "0005_audit_writer"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KEYS = ("sales.board.read", "sales.customer.read", "sales.order.read", "sales.order.approve")


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('sales.board.read',    'sales', 'See the sales command board'),
            ('sales.customer.read', 'sales', 'See the customer database'),
            ('sales.order.read',    'sales', 'See customer purchase orders'),
            ('sales.order.approve', 'sales', 'Approve or reject customer purchase orders')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM core.permissions WHERE key IN ({', '.join(repr(k) for k in KEYS)})")

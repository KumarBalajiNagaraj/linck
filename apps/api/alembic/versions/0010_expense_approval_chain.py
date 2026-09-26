"""expense approval chain: validate, approve, pass, pay

LIN-14. A bill walks: its desk validates it, the director approves it,
accounts passes it for payment and records the payment. Each step is one
key, checked at the bill's site. Stores bills are validated under their own
key, held by the fleet manager at the workshop, so the store manager who
uploads a bill is never the one who validates it.

Downgrade refuses (foreign-key violation) while any role still holds one.

Revision ID: 0010_expense_approval
Revises: 0009_whatsapp_inbox
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0010_expense_approval"
down_revision: str | None = "0009_whatsapp_inbox"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KEYS = (
    "stores.expense.validate",
    "finance.expense.read",
    "finance.expense.approve",
    "finance.expense.pass",
    "finance.expense.pay",
)


def upgrade() -> None:
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('stores.expense.validate', 'stores',  'Validate stores-desk expense bills'),
            ('finance.expense.read',    'finance', 'See expense bills across desks, for approval and payment'),
            ('finance.expense.approve', 'finance', 'Approve validated expense bills (director)'),
            ('finance.expense.pass',    'finance', 'Pass approved expense bills for payment'),
            ('finance.expense.pay',     'finance', 'Record the payment of passed expense bills')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM core.permissions WHERE key IN ({', '.join(repr(k) for k in KEYS)})")

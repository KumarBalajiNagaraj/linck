"""whatsapp inbox: slip photos drivers send to the fleet's business number

LIN-13. Drivers photograph the bunk slip and send it to the WhatsApp Business
number; Meta posts each message to /webhooks/whatsapp, which keeps it here
until the fleet manager imports it. One row per WhatsApp message id, so a
webhook Meta retries is stored once.

Tenant table like every other: RLS enabled, FORCED, and the same
tenant_isolation policy, so the boot-time posture check covers it.

Revision ID: 0009_whatsapp_inbox
Revises: 0008_expense_upload
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0009_whatsapp_inbox"
down_revision: str | None = "0008_expense_upload"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE core.whatsapp_messages (
            id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
            organization_id uuid NOT NULL REFERENCES core.organizations(id) ON DELETE RESTRICT,
            wamid           text NOT NULL,
            phone_number_id text NOT NULL,
            from_phone      text NOT NULL,
            sender_name     text,
            sent_at         timestamptz NOT NULL,
            kind            text NOT NULL,
            caption         text NOT NULL DEFAULT '',
            media_id        text,
            media_mime      text,
            media_filename  text,
            media_sha256    text,
            media_bytes     integer,
            media_error     text,
            received_at     timestamptz NOT NULL DEFAULT now(),
            imported_at     timestamptz,
            imported_by     uuid REFERENCES core.users(id) ON DELETE RESTRICT,
            CONSTRAINT uq_whatsapp_messages_organization_id_wamid UNIQUE (organization_id, wamid)
        )
        """
    )
    op.execute(
        "CREATE INDEX ix_whatsapp_messages_organization_id ON core.whatsapp_messages (organization_id)"
    )
    op.execute(
        "CREATE INDEX ix_whatsapp_messages_pending ON core.whatsapp_messages (organization_id, sent_at) "
        "WHERE imported_at IS NULL"
    )
    op.execute("ALTER TABLE core.whatsapp_messages ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE core.whatsapp_messages FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY tenant_isolation ON core.whatsapp_messages
            USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
            WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE core.whatsapp_messages")

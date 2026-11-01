"""audit the access tables, and make the permission catalogue read-only for the app

LIN-25, hardening before the API goes live. Two gaps, both in who may do what.

THE ACCESS TABLES HAD NO HISTORY. 0002 attached the generic audit trigger to
five core tables, role assignments among them, but not to the tables that say
what a role grants or which Google account signs in as whom. A role quietly
given finance.expense.pay, or someone else's Google account pinned to a user,
left no trace; the invariant lint listed these tables as known gaps. They get
the same trigger now, as do the two other core tables still without it:

    core.roles               what a role is
    core.role_permissions    which keys it grants
    core.invitations         who was invited, and when they accepted
    core.user_identities     which Google account signs in as which person
    core.gst_registrations   a legal entity's GSTINs
    core.whatsapp_messages   the slips drivers send, and who imported them

Two core tables stay unaudited, on purpose:

    core.audit_logs   the log itself; a trigger there would audit its own writes
    core.sessions     every refresh revokes one row and writes another, each
                      with the hash its refresh token is looked up by. Sign-ins
                      are in the log already, as the users.last_seen_at and
                      user_identities.last_login_at they stamp.

The trigger needs no tenant context, which most writes to these tables lack
outside a request: a fixture, a data fix in psql, a backfill. Since 0005 it
runs as linck_audit, which may append to the log under any GUC, and takes the
row's own organization_id, so such a write is still attributed to its tenant
and shows in that tenant's audit view. Sign-in itself writes under the tenant
it resolved (auth.establish_session), so it is attributed to the person too.

THE CATALOGUE WAS WRITABLE BY THE APP. init-roles.sql's default privileges give
linck_app SELECT, INSERT, UPDATE and DELETE on every table the migrator makes
in core, core.permissions included, and the catalogue has no organization_id,
so no row level security either. One bad statement from any request, a bug or
an injection, would have changed it for every tenant at once. The app needs
only to read it; the keys are added by migrations, which run as its owner.
TRUNCATE is revoked too, though the app role never held it. The downgrade
gives back only what the default privileges gave.

Revision ID: 0021_harden_access
Revises: 0020_industry_news
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0021_harden_access"
down_revision: str | None = "0020_industry_news"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

AUDITED = (
    "roles",
    "role_permissions",
    "invitations",
    "user_identities",
    "gst_registrations",
    "whatsapp_messages",
)


def _if_app_role(statements: str) -> None:
    """Grants to linck_app, skipped where the role does not exist, as 0002 and 0011 do."""
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_app') THEN
                {statements}
            END IF;
        END
        $$
        """
    )


def upgrade() -> None:
    for table in AUDITED:
        op.execute(
            f"""
            CREATE TRIGGER audit_{table}
            AFTER INSERT OR UPDATE OR DELETE ON core.{table}
            FOR EACH ROW EXECUTE FUNCTION core.write_audit_log()
            """
        )

    # Named table by table, never through default privileges, which are
    # schema-wide (see init-roles.sql). SELECT stays.
    op.execute("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON core.permissions FROM PUBLIC")
    _if_app_role("REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON core.permissions FROM linck_app;")


def downgrade() -> None:
    _if_app_role("GRANT INSERT, UPDATE, DELETE ON core.permissions TO linck_app;")
    for table in reversed(AUDITED):
        op.execute(f"DROP TRIGGER IF EXISTS audit_{table} ON core.{table}")

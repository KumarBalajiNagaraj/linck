"""give the identity resolvers a role that can actually read during sign-in

THE BUG THIS FIXES, because it is subtle and it would have reached production:

core.resolve_identity and core.resolve_pending_user are SECURITY DEFINER, which
means they execute as their OWNER rather than the caller. The intent was that
this lets sign-in read core.users before any tenant context exists — the
chicken-and-egg at the heart of multi-tenant authentication.

But SECURITY DEFINER only escapes the CALLER's privileges. It does not escape
row level security, because we set FORCE ROW LEVEL SECURITY, and FORCE applies
to the table owner as well. So the function ran as linck_migrator, RLS still
applied, `app.current_org_id` was empty, the policy matched no rows, and the
lookup returned nothing. Every sign-in would have been rejected with "this
account is not registered" — including correctly registered ones.

It appeared to work in development only because the functions happened to be
owned by a superuser account, and superusers are exempt from RLS entirely. The
moment ownership moved to a normal role — which is exactly what a correct
deployment does — authentication broke.

THE FIX, and why it is this one:

A dedicated role, `linck_identity`, owns the two resolvers. It is NOLOGIN, so
nothing can connect as it; it is reachable only by calling these two functions.
It is granted read access through EXPLICIT ROLE-TARGETED POLICIES rather than
BYPASSRLS.

That distinction matters. BYPASSRLS would have been one word and would have made
this role able to read every row in every table in the database forever, with
nothing in the schema recording that fact. A `TO linck_identity` policy is
visible in pg_policy, is scoped to the three tables sign-in actually needs, and
shows up in the same posture query that checks everything else. The blast radius
is written down.

The functions' result shape is the second half of the containment: they return
(user_id, organization_id, status) and nothing else, so even full read access to
core.users cannot leak a name, a phone number or an email through them.

Revision ID: 0004_identity_role
Revises: 0003_resolve_ambiguity
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0004_identity_role"
down_revision: str | None = "0003_resolve_ambiguity"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Only what the two resolvers actually read.
READ_TABLES = ["users", "organizations", "user_identities"]


def upgrade() -> None:
    # Role creation needs superuser, so scripts/init-roles.sql owns it and this
    # guard keeps the migration runnable on a database where an operator has
    # not created it yet. The posture check reports the gap loudly rather than
    # the migration failing halfway.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_identity') THEN
                RAISE WARNING 'role linck_identity is missing — run apps/api/scripts/init-roles.sql, then re-run this migration. Sign-in will not work until you do.';
                RETURN;
            END IF;

            -- Read access, narrowly. GRANT alone is not enough under RLS: the
            -- policy below is what actually admits the rows.
            EXECUTE 'GRANT USAGE ON SCHEMA core TO linck_identity';
            EXECUTE 'GRANT SELECT ON core.users, core.organizations, core.user_identities TO linck_identity';

            -- Postgres requires a function's new owner to hold CREATE on the
            -- containing schema, so this is forced rather than chosen. It is
            -- inert in practice: linck_identity is NOLOGIN, so nothing can
            -- connect as it to exercise the privilege, and it owns exactly two
            -- functions. Revoking it after the ALTER would break the next
            -- CREATE OR REPLACE of these functions in a later migration, so it
            -- stays.
            EXECUTE 'GRANT CREATE ON SCHEMA core TO linck_identity';

            EXECUTE 'ALTER FUNCTION core.resolve_identity(text, text) OWNER TO linck_identity';
            EXECUTE 'ALTER FUNCTION core.resolve_pending_user(text, text) OWNER TO linck_identity';
        END
        $$
        """
    )

    for table in READ_TABLES:
        op.execute(
            f"""
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_identity') THEN
                    EXECUTE 'CREATE POLICY identity_lookup ON core.{table} FOR SELECT TO linck_identity USING (true)';
                END IF;
            END
            $$
            """
        )


def downgrade() -> None:
    for table in READ_TABLES:
        op.execute(f"DROP POLICY IF EXISTS identity_lookup ON core.{table}")
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_migrator') THEN
                EXECUTE 'ALTER FUNCTION core.resolve_identity(text, text) OWNER TO linck_migrator';
                EXECUTE 'ALTER FUNCTION core.resolve_pending_user(text, text) OWNER TO linck_migrator';
            END IF;
        END
        $$
        """
    )

"""row level security, the audit trigger, and seeded reference data

Everything in this revision is invisible to Alembic autogenerate. RLS,
policies, triggers, grants and idempotent seed data all have to be written by
hand, with matching drops in downgrade().

CI enforces the important half of that: a revision that creates a table in a
business schema without enabling AND forcing RLS on it fails the invariant lint.

Revision ID: 0002_rls_audit_seed
Revises: f749f78afd61
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0002_rls_audit_seed"
down_revision: str | None = "f749f78afd61"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# Every core table except `organizations` (whose own id IS the tenant key) and
# `permissions` (global reference data, identical for every tenant).
TENANT_TABLES = [
    "organization_modules",
    "legal_entities",
    "gst_registrations",
    "sites",
    "users",
    "user_identities",
    "sessions",
    "roles",
    "role_permissions",
    "role_assignments",
    "invitations",
    "audit_logs",
]


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Row level security
    # ------------------------------------------------------------------
    # FORCE is the part that matters. A table's OWNER bypasses RLS by default,
    # so without FORCE every policy below silently stops applying the moment
    # the app connects as the owning role — and nothing fails, the queries just
    # quietly return every tenant's rows.
    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE core.{table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE core.{table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"""
            CREATE POLICY tenant_isolation ON core.{table}
                USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
                WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
            """
        )

    # `organizations` is visible only as the row the current GUC names. Without
    # this, a tenant could enumerate every other tenant on the platform.
    op.execute("ALTER TABLE core.organizations ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE core.organizations FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY tenant_isolation ON core.organizations
            USING (id = nullif(current_setting('app.current_org_id', true), '')::uuid)
            WITH CHECK (id = nullif(current_setting('app.current_org_id', true), '')::uuid)
        """
    )

    # The sign-in path has to find a Google identity BEFORE it knows which
    # tenant the person belongs to, which is precisely the lookup RLS forbids.
    # Rather than punching a hole in the policy, that one query runs through a
    # SECURITY DEFINER function with a fixed, minimal result: it returns the
    # ids needed to establish tenant context and nothing else.
    op.execute(
        """
        CREATE FUNCTION core.resolve_identity(p_provider text, p_subject text)
        RETURNS TABLE (user_id uuid, organization_id uuid, status text)
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = core, pg_temp
        AS $$
            SELECT u.id, u.organization_id, u.status
            FROM core.user_identities i
            JOIN core.users u ON u.id = i.user_id
            WHERE i.provider = p_provider AND i.subject = p_subject
            LIMIT 1
        $$
        """
    )

    # First sign-in has the same problem: the verified email must be matched to
    # a pre-registered user before any tenant context exists. Deliberately
    # matches on EMAIL ONLY and never on display name — two drivers called
    # "Murugan S" is an ordinary Tuesday, and matching on a name would hand one
    # person the other's grants.
    op.execute(
        """
        CREATE FUNCTION core.resolve_pending_user(p_email text, p_hosted_domain text)
        RETURNS TABLE (user_id uuid, organization_id uuid, status text)
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = core, pg_temp
        AS $$
            SELECT u.id, u.organization_id, u.status
            FROM core.users u
            JOIN core.organizations o ON o.id = u.organization_id
            WHERE lower(u.email) = lower(p_email)
              AND u.status IN ('invited', 'active')
              AND o.status = 'active'
              AND (
                    cardinality(o.google_hosted_domains) = 0
                    OR p_hosted_domain = ANY (o.google_hosted_domains)
                  )
            LIMIT 1
        $$
        """
    )

    # ------------------------------------------------------------------
    # Audit
    # ------------------------------------------------------------------
    # One generic trigger rather than application-level writes, so a background
    # job, a data-fix script and a stray psql session are all captured. The
    # actor comes from a GUC the request sets alongside the tenant id.
    op.execute(
        """
        CREATE FUNCTION core.write_audit_log() RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = core, pg_temp
        AS $$
        DECLARE
            v_actor uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
            v_org   uuid := nullif(current_setting('app.current_org_id', true), '')::uuid;
            v_before jsonb;
            v_after  jsonb;
            v_id uuid;
        BEGIN
            IF TG_OP = 'DELETE' THEN
                v_before := to_jsonb(OLD);
                v_id := OLD.id;
            ELSIF TG_OP = 'UPDATE' THEN
                v_before := to_jsonb(OLD);
                v_after := to_jsonb(NEW);
                v_id := NEW.id;
                -- An UPDATE that changed nothing is noise, not history.
                IF v_before = v_after THEN
                    RETURN NEW;
                END IF;
            ELSE
                v_after := to_jsonb(NEW);
                v_id := NEW.id;
            END IF;

            INSERT INTO core.audit_logs (organization_id, actor_user_id, action, entity_table, entity_id, before, after)
            VALUES (v_org, v_actor, lower(TG_OP), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME, v_id, v_before, v_after);

            RETURN COALESCE(NEW, OLD);
        END;
        $$
        """
    )

    for table in ["legal_entities", "sites", "users", "role_assignments", "organization_modules"]:
        op.execute(
            f"""
            CREATE TRIGGER audit_{table}
            AFTER INSERT OR UPDATE OR DELETE ON core.{table}
            FOR EACH ROW EXECUTE FUNCTION core.write_audit_log()
            """
        )

    # The audit log is append-only. A revoked grant is the only version of this
    # that survives someone with a psql prompt and a motive — an application
    # rule does not.
    #
    # Targeted at the one table by name. This deliberately does NOT go in
    # ALTER DEFAULT PRIVILEGES, which is schema-wide and would strip UPDATE and
    # DELETE from every table in core.
    #
    # Guarded on role existence because local development against a Homebrew
    # Postgres runs as the developer's own superuser role with no linck_app.
    op.execute("REVOKE UPDATE, DELETE ON core.audit_logs FROM PUBLIC")
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_app') THEN
                REVOKE UPDATE, DELETE ON core.audit_logs FROM linck_app;
            END IF;
        END
        $$
        """
    )

    # ------------------------------------------------------------------
    # Seeded permissions — migration-managed, applied idempotently by key so
    # they can never diverge per environment the way a seed script does.
    # ------------------------------------------------------------------
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('executive.dashboard.read', 'finance',    'See the executive dashboard and cross-site P&L'),
            ('fleet.board.read',         'fleet',      'See the fleet command board'),
            ('fleet.vehicle.read',       'fleet',      'See vehicle detail'),
            ('fleet.vehicle.write',      'fleet',      'Add and edit vehicles'),
            ('fleet.fuel.create',        'fleet',      'Record diesel and DEF entries'),
            ('fleet.fuel.read',          'fleet',      'See fuel entries and mileage'),
            ('production.run.create',    'production', 'Record a shift production run'),
            ('production.run.read',      'production', 'See production runs'),
            ('production.stock.read',    'production', 'See the live stock position'),
            ('sales.dispatch.read',      'sales',      'See the dispatch board'),
            ('sales.dispatch.write',     'sales',      'Book loads and allot vehicles'),
            ('sales.trip.read',          'sales',      'See trip detail and cost sheets'),
            ('sales.invoice.read',       'sales',      'See invoices'),
            ('sales.invoice.write',      'sales',      'Raise and issue invoices'),
            ('stores.indent.create',     'stores',     'Raise a stores indent'),
            ('stores.indent.read',       'stores',     'See the indent queue'),
            ('stores.indent.approve',    'stores',     'Approve or reject indents'),
            ('finance.receipt.read',     'finance',    'See payment receipts'),
            ('finance.receipt.verify',   'finance',    'Cross-verify a payment receipt'),
            ('compliance.document.read', 'compliance', 'See the document and expiry register'),
            ('compliance.document.write','compliance', 'Record document renewals'),
            ('compliance.ewb.read',      'compliance', 'See the e-way bill console'),
            ('compliance.ewb.write',     'compliance', 'Generate, update and cancel e-way bills'),
            ('ai.extraction.review',     'ai',         'Review and confirm extracted documents'),
            ('field.trip.read',          'fleet',      'Driver view of assigned trips'),
            ('admin.member.manage',      'core',       'Register members and assign roles'),
            ('admin.org.manage',         'core',       'Manage legal entities, sites and modules')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    for table in ["legal_entities", "sites", "users", "role_assignments", "organization_modules"]:
        op.execute(f"DROP TRIGGER IF EXISTS audit_{table} ON core.{table}")
    op.execute("DROP FUNCTION IF EXISTS core.write_audit_log()")
    op.execute("DROP FUNCTION IF EXISTS core.resolve_pending_user(text, text)")
    op.execute("DROP FUNCTION IF EXISTS core.resolve_identity(text, text)")

    op.execute("DROP POLICY IF EXISTS tenant_isolation ON core.organizations")
    op.execute("ALTER TABLE core.organizations NO FORCE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE core.organizations DISABLE ROW LEVEL SECURITY")

    for table in TENANT_TABLES:
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON core.{table}")
        op.execute(f"ALTER TABLE core.{table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE core.{table} DISABLE ROW LEVEL SECURITY")

    op.execute("DELETE FROM core.permissions")

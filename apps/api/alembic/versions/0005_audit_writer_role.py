"""let the audit trigger write under RLS, and attribute rows from the data

SECOND INSTANCE OF THE SAME BUG CLASS as migration 0004, found by the test
suite rather than by reading:

core.write_audit_log() is SECURITY DEFINER, so it runs as its owner. Under
FORCE ROW LEVEL SECURITY the owner is not exempt, so the trigger's INSERT into
core.audit_logs is checked against audit_logs' own tenant_isolation policy. That
policy requires organization_id to equal `app.current_org_id`. Any write that
happens without a tenant GUC set — an operator running a data fix, a migration
backfill, a background job, the test suite planting a fixture — therefore fails
with "new row violates row-level security policy", and takes the original write
down with it.

It looked fine only while the function was owned by a superuser.

The consequence is worth stating plainly: the audit log is the one table that
must never refuse a write. A design where auditing fails closed and blocks the
underlying operation converts every missing GUC into an outage; a design where
it fails open loses history. Neither is acceptable, so the trigger is given a
role that is allowed to insert unconditionally.

TWO CHANGES:

1. `linck_audit` owns the trigger function and holds an INSERT-only policy on
   core.audit_logs. READS stay tenant-scoped — a tenant still sees only its own
   audit rows, because the existing tenant_isolation policy is untouched and
   this new one grants nothing but INSERT. As in 0004 the grant is an explicit
   role-targeted policy rather than BYPASSRLS, so its reach is one table and one
   command, visible in pg_policy.

2. The trigger now derives organization_id from the ROW BEING AUDITED, falling
   back to the GUC only when the row has no such column. Previously it used the
   GUC alone, which meant a write made without tenant context recorded
   organization_id = NULL — an audit row that survives but belongs to nobody and
   is invisible to every tenant's own audit view. Reading it off the row is both
   more accurate and available in exactly the cases the GUC is not.

Revision ID: 0005_audit_writer
Revises: 0004_identity_role
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0005_audit_writer"
down_revision: str | None = "0004_identity_role"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION core.write_audit_log() RETURNS trigger
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = core, pg_temp
        AS $$
        DECLARE
            v_actor uuid := nullif(current_setting('app.current_user_id', true), '')::uuid;
            v_org   uuid;
            v_before jsonb;
            v_after  jsonb;
            v_row    jsonb;
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

            -- Attribute from the data first. The row always knows which tenant
            -- it belongs to; the session GUC only knows when a request set it.
            v_row := coalesce(v_after, v_before);
            v_org := nullif(v_row ->> 'organization_id', '')::uuid;
            IF v_org IS NULL THEN
                v_org := nullif(current_setting('app.current_org_id', true), '')::uuid;
            END IF;

            INSERT INTO core.audit_logs
                (organization_id, actor_user_id, action, entity_table, entity_id, before, after)
            VALUES
                (v_org, v_actor, lower(TG_OP), TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
                 v_id, v_before, v_after);

            RETURN COALESCE(NEW, OLD);
        END;
        $$
        """
    )

    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_audit') THEN
                RAISE WARNING 'role linck_audit is missing — run apps/api/scripts/init-roles.sql and re-run this migration, or audited writes will fail whenever no tenant context is set.';
                RETURN;
            END IF;

            EXECUTE 'GRANT USAGE, CREATE ON SCHEMA core TO linck_audit';
            EXECUTE 'GRANT INSERT ON core.audit_logs TO linck_audit';
            EXECUTE 'ALTER FUNCTION core.write_audit_log() OWNER TO linck_audit';
        END
        $$
        """
    )

    # INSERT only, and deliberately no USING clause — this role can append to
    # the audit log and can never read it back.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_audit') THEN
                EXECUTE 'CREATE POLICY audit_append ON core.audit_logs FOR INSERT TO linck_audit WITH CHECK (true)';
            END IF;
        END
        $$
        """
    )


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS audit_append ON core.audit_logs")
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_migrator') THEN
                EXECUTE 'ALTER FUNCTION core.write_audit_log() OWNER TO linck_migrator';
            END IF;
        END
        $$
        """
    )

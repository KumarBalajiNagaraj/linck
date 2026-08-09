"""make an ambiguous pre-registered email a hard error instead of a coin flip

core.resolve_pending_user was `LIMIT 1` with no ORDER BY. If the same person is
pre-registered in two tenants — which is not exotic, an accountant who works for
two clients, or a Linck operator with a login in several customer orgs — then
which tenant they land in on first sign-in is whatever the planner happened to
return first. It could differ between two runs of the same query.

That is a silent authorization defect: the person gets a real session, in a real
tenant, that may not be the tenant anyone intended, and nothing anywhere logs
that a choice was made.

Failing closed is the only defensible behaviour. An operator can then delete the
duplicate registration or, once tenant selection exists, the sign-in flow can ask.

Revision ID: 0003_resolve_ambiguity
Revises: 0002_rls_audit_seed
"""
from collections.abc import Sequence

from alembic import op

revision: str = "0003_resolve_ambiguity"
down_revision: str | None = "0002_rls_audit_seed"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION core.resolve_pending_user(p_email text, p_hosted_domain text)
        RETURNS TABLE (user_id uuid, organization_id uuid, status text)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = core, pg_temp
        AS $$
        DECLARE
            v_count int;
        BEGIN
            SELECT count(*) INTO v_count
            FROM core.users u
            JOIN core.organizations o ON o.id = u.organization_id
            WHERE lower(u.email) = lower(p_email)
              AND u.status IN ('invited', 'active')
              AND o.status = 'active'
              AND (
                    cardinality(o.google_hosted_domains) = 0
                    OR p_hosted_domain = ANY (o.google_hosted_domains)
                  );

            IF v_count > 1 THEN
                -- Deliberately does NOT name the tenants. This runs before the
                -- caller has proven anything, so the error text is visible to
                -- an unauthenticated party and must not confirm which
                -- organizations a given email belongs to.
                RAISE EXCEPTION
                    'ambiguous pre-registration for this email across % organizations', v_count
                    USING ERRCODE = 'cardinality_violation';
            END IF;

            RETURN QUERY
            SELECT u.id, u.organization_id, u.status
            FROM core.users u
            JOIN core.organizations o ON o.id = u.organization_id
            WHERE lower(u.email) = lower(p_email)
              AND u.status IN ('invited', 'active')
              AND o.status = 'active'
              AND (
                    cardinality(o.google_hosted_domains) = 0
                    OR p_hosted_domain = ANY (o.google_hosted_domains)
                  );
        END;
        $$
        """
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS core.resolve_pending_user(text, text)")
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

"""Invariant lints. These are the ones that must run in CI on every migration.

Every property here fails silently in production if it regresses. A table added
without FORCE ROW LEVEL SECURITY does not error — it just returns every tenant's
rows to whoever asks. A quantity stored as double precision does not error — it
just makes the tonnage on an invoice disagree with the tonnage on the weighbridge
slip by a few paise, forever, in a way nobody can reconstruct. A table without
the audit trigger does not error either; it just has no history.

Each lint covers every schema docs/DATABASE.md names (BUSINESS_SCHEMAS), not only
`core`: a gate that skips the newest tables is worse than none, because it reads
as a pass.
"""

from __future__ import annotations

from sqlalchemy import text

from app.core.db import check_rls_posture, tenant_session
from app.models.base import BUSINESS_SCHEMAS

# organizations is its own tenant key (its policy is `id = current_setting(...)`,
# tested separately below); permissions is global reference data, identical for
# every tenant and deliberately unfiltered.
NOT_TENANT_SCOPED = {"core.organizations", "core.permissions"}

# The tables LIN-20 added. Named here so the lint cannot pass by not finding them.
LIN20_TABLES = {
    "core.files",
    "master.parties",
    "sales.purchase_orders",
    "fleet.breakdowns",
    "finance.payments",
    "finance.whatsapp_import_batches",
    "finance.whatsapp_import_claims",
    "finance.expense_bills",
    "finance.expense_bill_fields",
    "finance.expense_bill_events",
}
# And LIN-10's, the first table in `ai`.
LIN10_TABLES = {"ai.industry_digests"}
NAMED_TABLES = LIN20_TABLES | LIN10_TABLES

SCHEMAS = {"schemas": list(BUSINESS_SCHEMAS)}

POSTURE_SQL = """
    SELECT n.nspname || '.' || c.relname,
           c.relrowsecurity,
           c.relforcerowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY(:schemas)
"""


async def test_every_tenant_table_enables_and_forces_rls() -> None:
    async with tenant_session(None) as session:
        rows = (await session.execute(text(POSTURE_SQL), SCHEMAS)).all()

    tables = {name: (enabled, forced, policies) for name, enabled, forced, policies in rows}
    assert "core.sites" in tables, "the posture query found nothing — it is checking the wrong catalog"
    missing = NAMED_TABLES - tables.keys()
    assert not missing, f"the posture query does not reach {sorted(missing)}"

    problems: list[str] = []
    for name, (enabled, forced, policies) in sorted(tables.items()):
        if name in NOT_TENANT_SCOPED:
            continue
        if not enabled:
            problems.append(f"{name}: row level security is not enabled")
        # FORCE is the one that matters. Without it the table's OWNER bypasses
        # every policy, so the day the app connects as the owner the product
        # keeps working and starts returning other tenants' rows.
        if not forced:
            problems.append(f"{name}: RLS is enabled but not FORCED — the owner bypasses it")
        if policies == 0:
            problems.append(f"{name}: RLS is on but no policy exists")

    assert problems == [], "\n".join(problems)


async def test_organizations_is_not_enumerable() -> None:
    """A tenant must not be able to list the platform's other customers."""
    async with tenant_session(None) as session:
        row = (
            await session.execute(
                text(POSTURE_SQL + " AND n.nspname = 'core' AND c.relname = 'organizations'"), SCHEMAS
            )
        ).one()

    _, enabled, forced, policies = row
    assert enabled and forced and policies >= 1


async def test_every_rls_protected_table_has_an_organization_id() -> None:
    """The policies all resolve on this column, so a table without it cannot be
    filtered — and would silently be protected by a policy that never matches.

    NOT NULL too, except on the audit log, which must be able to record a write
    that no tenant owns rather than refuse it (migration 0005)."""
    async with tenant_session(None) as session:
        rows = (
            (
                await session.execute(
                    text(
                        """
                        SELECT n.nspname || '.' || c.relname
                        FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY(:schemas) AND c.relrowsecurity
                          AND (n.nspname, c.relname) <> ('core', 'organizations')
                          AND NOT EXISTS (
                                SELECT 1 FROM pg_attribute a
                                WHERE a.attrelid = c.oid AND a.attname = 'organization_id'
                                  AND a.attnum > 0 AND NOT a.attisdropped
                                  AND (a.attnotnull OR (n.nspname, c.relname) = ('core', 'audit_logs'))
                          )
                        """
                    ),
                    SCHEMAS,
                )
            )
            .scalars()
            .all()
        )

    assert rows == [], f"RLS-protected tables with no NOT NULL organization_id: {rows}"


async def test_boot_time_posture_check_passes() -> None:
    """The same assertion the API makes at startup, so the two cannot drift."""
    assert await check_rls_posture() == []


async def test_no_money_or_quantity_is_stored_as_a_float() -> None:
    async with tenant_session(None) as session:
        offenders = (
            (
                await session.execute(
                    text(
                        """
                        SELECT table_schema || '.' || table_name || '.' || column_name || ' :: ' || data_type
                        FROM information_schema.columns
                        WHERE table_schema = ANY(:schemas)
                          AND (
                                data_type IN ('real', 'double precision', 'money')
                                OR udt_name IN ('float4', 'float8', 'money', '_float4', '_float8', '_money')
                          )
                        ORDER BY 1
                        """
                    ),
                    SCHEMAS,
                )
            )
            .scalars()
            .all()
        )

    assert offenders == [], (
        "binary floating point in a ledger — rupees and tonnes must be numeric: " + ", ".join(offenders)
    )


# Core tables from before the audit gate existed that do not carry the trigger.
# audit_logs is the log itself; sessions churn on every refresh and hold token
# hashes. The rest are real gaps, listed so a NEW table can never join them
# silently — shrink this set, never grow it.
UNAUDITED = {
    "core.audit_logs",
    "core.sessions",
    "core.user_identities",
    "core.roles",
    "core.role_permissions",
    "core.invitations",
    "core.gst_registrations",
    "core.whatsapp_messages",
}


async def test_every_tenant_table_has_the_audit_trigger() -> None:
    """One generic row trigger on every business table, so a data fix in psql is history too."""
    async with tenant_session(None) as session:
        rows = (
            (
                await session.execute(
                    text(
                        """
                        SELECT n.nspname || '.' || c.relname
                        FROM pg_class c
                        JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE c.relkind IN ('r', 'p') AND n.nspname = ANY(:schemas) AND c.relrowsecurity
                          AND NOT EXISTS (
                                SELECT 1 FROM pg_trigger t
                                WHERE t.tgrelid = c.oid AND NOT t.tgisinternal
                                  AND t.tgfoid = 'core.write_audit_log()'::regprocedure
                          )
                        """
                    ),
                    SCHEMAS,
                )
            )
            .scalars()
            .all()
        )

    unaudited = set(rows) - UNAUDITED - NOT_TENANT_SCOPED
    assert unaudited == set(), f"tenant tables without the audit trigger: {sorted(unaudited)}"
    assert not (NAMED_TABLES & set(rows))


# Single-column references between core tables from before the composite rule
# was enforced. Listed for the same reason as UNAUDITED.
SINGLE_COLUMN_FKS_FROM = {
    "core.gst_registrations",
    "core.sites",
    "core.user_identities",
    "core.sessions",
    "core.role_permissions",
    "core.role_assignments",
    "core.whatsapp_messages",
}


async def test_every_reference_between_tenant_tables_is_tenant_safe() -> None:
    """`(organization_id, x_id) -> parent (organization_id, id)`, so no row can point into another tenant.

    The only single-column references allowed are to the tenant root itself and
    to the global permission catalogue.
    """
    async with tenant_session(None) as session:
        rows = (
            await session.execute(
                text(
                    """
                    SELECT n.nspname || '.' || c.relname AS source,
                           con.conname,
                           fn.nspname || '.' || f.relname AS target,
                           (SELECT array_agg(a.attname ORDER BY k.i)
                              FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                              JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n) AS cols,
                           (SELECT array_agg(a.attname ORDER BY k.i)
                              FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                              JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n)
                           AS target_cols
                    FROM pg_constraint con
                    JOIN pg_class c ON c.oid = con.conrelid
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    JOIN pg_class f ON f.oid = con.confrelid
                    JOIN pg_namespace fn ON fn.oid = f.relnamespace
                    WHERE con.contype = 'f' AND n.nspname = ANY(:schemas)
                    """
                ),
                SCHEMAS,
            )
        ).all()

    assert any(source in LIN20_TABLES for source, *_ in rows), "the query found none of the new references"
    assert any(source in LIN10_TABLES for source, *_ in rows), "the query does not reach ai.industry_digests"
    unsafe = []
    for source, name, target, cols, target_cols in rows:
        if target in NOT_TENANT_SCOPED or source in SINGLE_COLUMN_FKS_FROM:
            continue
        paired = list(zip(cols, target_cols, strict=True))
        if ("organization_id", "organization_id") not in paired:
            unsafe.append(f"{source}.{name} -> {target} {cols}")
    assert unsafe == [], "references that could cross tenants:\n" + "\n".join(unsafe)


async def test_the_history_and_the_payments_are_append_only_for_the_app_role() -> None:
    """A signature or a payment, once recorded, is corrected by another row, never edited.

    Through the grants rather than an application rule, like core.audit_logs.
    """
    async with tenant_session(None) as session:
        rows = (
            await session.execute(
                text(
                    """
                    SELECT t,
                           has_table_privilege(current_user, t, 'INSERT'),
                           has_table_privilege(current_user, t, 'SELECT'),
                           has_table_privilege(current_user, t, 'UPDATE'),
                           has_table_privilege(current_user, t, 'DELETE')
                    FROM unnest(ARRAY['finance.expense_bill_events', 'finance.payments', 'core.audit_logs']) t
                    """
                )
            )
        ).all()

    assert [tuple(r) for r in rows] == [
        ("finance.expense_bill_events", True, True, False, False),
        ("finance.payments", True, True, False, False),
        ("core.audit_logs", True, True, False, False),
    ]

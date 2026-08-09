"""Invariant lints. These are the ones that must run in CI on every migration.

Both properties here fail silently in production if they regress. A table added
without FORCE ROW LEVEL SECURITY does not error — it just returns every tenant's
rows to whoever asks. A quantity stored as double precision does not error — it
just makes the tonnage on an invoice disagree with the tonnage on the weighbridge
slip by a few paise, forever, in a way nobody can reconstruct.
"""

from __future__ import annotations

from sqlalchemy import text

from app.core.db import check_rls_posture, tenant_session

# organizations is its own tenant key (its policy is `id = current_setting(...)`,
# tested separately below); permissions is global reference data, identical for
# every tenant and deliberately unfiltered.
NOT_TENANT_SCOPED = {"organizations", "permissions"}

POSTURE_SQL = """
    SELECT c.relname,
           c.relrowsecurity,
           c.relforcerowsecurity,
           (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind = 'r' AND n.nspname = 'core'
"""


async def test_every_tenant_table_enables_and_forces_rls() -> None:
    async with tenant_session(None) as session:
        rows = (await session.execute(text(POSTURE_SQL))).all()

    tables = {name: (enabled, forced, policies) for name, enabled, forced, policies in rows}
    assert "sites" in tables, "the posture query found nothing — it is checking the wrong catalog"

    problems: list[str] = []
    for name, (enabled, forced, policies) in sorted(tables.items()):
        if name in NOT_TENANT_SCOPED:
            continue
        if not enabled:
            problems.append(f"core.{name}: row level security is not enabled")
        # FORCE is the one that matters. Without it the table's OWNER bypasses
        # every policy, so the day the app connects as the owner the product
        # keeps working and starts returning other tenants' rows.
        if not forced:
            problems.append(f"core.{name}: RLS is enabled but not FORCED — the owner bypasses it")
        if policies == 0:
            problems.append(f"core.{name}: RLS is on but no policy exists")

    assert problems == [], "\n".join(problems)


async def test_organizations_is_not_enumerable() -> None:
    """A tenant must not be able to list the platform's other customers."""
    async with tenant_session(None) as session:
        row = (
            await session.execute(
                text(POSTURE_SQL + " AND c.relname = 'organizations'"),
            )
        ).one()

    _, enabled, forced, policies = row
    assert enabled and forced and policies >= 1


async def test_every_rls_protected_table_has_an_organization_id() -> None:
    """The policies all resolve on this column, so a table without it cannot be
    filtered — and would silently be protected by a policy that never matches."""
    async with tenant_session(None) as session:
        rows = (
            await session.execute(
                text(
                    """
                    SELECT c.relname
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE c.relkind = 'r' AND n.nspname = 'core' AND c.relrowsecurity
                      AND c.relname <> 'organizations'
                      AND NOT EXISTS (
                            SELECT 1 FROM information_schema.columns col
                            WHERE col.table_schema = 'core'
                              AND col.table_name = c.relname
                              AND col.column_name = 'organization_id'
                      )
                    """
                )
            )
        ).scalars().all()

    assert rows == [], f"RLS-protected tables with no organization_id: {rows}"


async def test_boot_time_posture_check_passes() -> None:
    """The same assertion the API makes at startup, so the two cannot drift."""
    assert await check_rls_posture() == []


async def test_no_money_or_quantity_is_stored_as_a_float() -> None:
    async with tenant_session(None) as session:
        offenders = (
            await session.execute(
                text(
                    """
                    SELECT table_name || '.' || column_name || ' :: ' || data_type
                    FROM information_schema.columns
                    WHERE table_schema = 'core'
                      AND (
                            data_type IN ('real', 'double precision', 'money')
                            OR udt_name IN ('float4', 'float8', 'money')
                      )
                    ORDER BY 1
                    """
                )
            )
        ).scalars().all()

    assert offenders == [], (
        "binary floating point in a ledger — rupees and tonnes must be numeric: " + ", ".join(offenders)
    )

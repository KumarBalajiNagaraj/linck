"""Tenant A's rows must be invisible, unwritable and unforgeable from tenant B.

Every assertion here is made through the unprivileged ``linck_app`` role using
the real ``tenant_session`` helper. Ground truth — did the row actually change?
— is read back through the privileged connection, because an UPDATE blocked by
RLS does not raise: it silently matches zero rows, which is precisely the
failure mode that looks like success from inside the request.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable

import psycopg
import pytest
from conftest import Tenant
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.db import tenant_session


async def test_tenant_a_can_see_its_own_site(tenant_a: Tenant) -> None:
    """The control. Without this, every assertion below could pass on an empty table."""
    async with tenant_session(str(tenant_a.org_id)) as session:
        names = (
            (
                await session.execute(
                    text("SELECT name FROM core.sites WHERE id = :id"), {"id": str(tenant_a.site_id)}
                )
            )
            .scalars()
            .all()
        )
    assert names == [tenant_a.site_name]


async def test_select_cannot_reach_another_tenants_site(tenant_a: Tenant, tenant_b: Tenant) -> None:
    async with tenant_session(str(tenant_b.org_id)) as session:
        rows = (
            await session.execute(
                text("SELECT id FROM core.sites WHERE id = :id"), {"id": str(tenant_a.site_id)}
            )
        ).all()
        # Not just the targeted row — B must not see A's site by any route.
        visible_orgs = (
            (await session.execute(text("SELECT DISTINCT organization_id FROM core.sites"))).scalars().all()
        )

    assert rows == []
    assert tenant_a.org_id not in visible_orgs


async def test_update_cannot_reach_another_tenants_site(
    tenant_a: Tenant, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    async with tenant_session(str(tenant_b.org_id)) as session:
        result = await session.execute(
            text("UPDATE core.sites SET name = :name WHERE id = :id"),
            {"name": "renamed by another tenant", "id": str(tenant_a.site_id)},
        )
    assert result.rowcount == 0

    with admin.cursor() as cur:
        cur.execute("SELECT name FROM core.sites WHERE id = %s", (tenant_a.site_id,))
        row = cur.fetchone()
    assert row is not None, "the fixture site was destroyed by the update attempt"
    assert row[0] == tenant_a.site_name


async def test_delete_cannot_reach_another_tenants_site(
    tenant_a: Tenant, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    async with tenant_session(str(tenant_b.org_id)) as session:
        result = await session.execute(
            text("DELETE FROM core.sites WHERE id = :id"), {"id": str(tenant_a.site_id)}
        )
    assert result.rowcount == 0

    with admin.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.sites WHERE id = %s", (tenant_a.site_id,))
        assert cur.fetchone()[0] == 1


async def test_insert_carrying_another_tenants_org_id_is_rejected(
    tenant_a: Tenant, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    """The WITH CHECK half of the policy.

    USING protects reads and the rows an UPDATE can find; only WITH CHECK stops a
    request from writing a row stamped with someone else's organization_id. Drop
    the WITH CHECK clause and this is how tenant B plants a row inside tenant A.
    """
    forged_id = uuid.uuid4()

    with pytest.raises(DBAPIError) as caught:
        async with tenant_session(str(tenant_b.org_id)) as session:
            await session.execute(
                text(
                    """
                    INSERT INTO core.sites
                        (id, organization_id, legal_entity_id, code, name, site_type, state_code)
                    VALUES (:id, :org, :legal_entity, :code, 'planted', 'stockyard', '33')
                    """
                ),
                {
                    "id": str(forged_id),
                    "org": str(tenant_a.org_id),
                    "legal_entity": str(tenant_b.legal_entity_id),
                    "code": f"FORGED-{forged_id.hex[:8]}",
                },
            )

    assert "row-level security" in str(caught.value).lower()

    with admin.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.sites WHERE id = %s", (forged_id,))
        assert cur.fetchone()[0] == 0


async def test_no_tenant_context_means_no_rows(
    tenant_a: Tenant, tenant_b: Tenant, make_user: Callable[..., object]
) -> None:
    """The default is deny.

    ``tenant_session(None)`` is the pre-authentication path — the request knows a
    Google subject and nothing else. If an unset GUC read as "no filter" instead
    of "no rows", the sign-in path would be a full table scan of the platform.

    A user is planted first so that "zero rows" means the policy denied them, not
    that the tables happened to be empty.
    """
    make_user(tenant_a, f"deny-by-default-{uuid.uuid4().hex[:8]}@example.com", "Planted Person")

    async with tenant_session(None) as session:
        sites = (await session.execute(text("SELECT count(*) FROM core.sites"))).scalar_one()
        users = (await session.execute(text("SELECT count(*) FROM core.users"))).scalar_one()
        orgs = (await session.execute(text("SELECT count(*) FROM core.organizations"))).scalar_one()

    assert sites == 0
    assert users == 0
    assert orgs == 0


# ---------------------------------------------------------------------------
# Every table LIN-20 added: the same four refusals, one table at a time
# ---------------------------------------------------------------------------

# Parents before children, as they are planted.
LIN20_TABLES = [
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
]
APPEND_ONLY = {"finance.payments", "finance.expense_bill_events"}


@pytest.fixture(scope="module")
def planted(
    admin: psycopg.Connection, tenant_a: Tenant, make_user: Callable[..., uuid.UUID]
) -> dict[str, uuid.UUID]:
    """One row in every new table, all belonging to tenant A and wired to each other."""
    tag = uuid.uuid4().hex[:10]
    user = make_user(tenant_a, f"planter-{tag}@example.com", "Planter")
    ids = {table: uuid.uuid4() for table in LIN20_TABLES}
    row = {
        "org": tenant_a.org_id,
        "site": tenant_a.site_id,
        "user": user,
        "tag": tag,
        "utr": f"PLANT{tag.upper()}",
        **{table.replace(".", "_"): row_id for table, row_id in ids.items()},
    }
    # One statement at a time: a parameterised call takes exactly one.
    statements = """
            INSERT INTO core.files
                (id, organization_id, purpose, sha256, mime_type, size_bytes, original_name, uploaded_by)
            VALUES (%(core_files)s, %(org)s, 'expense_bill', repeat('a', 64), 'image/jpeg', 10, 'slip.jpg',
                    %(user)s);

            INSERT INTO master.parties
                (id, organization_id, display_name, legal_name, party_roles, served_from_site_id)
            VALUES (%(master_parties)s, %(org)s, 'Planted Builder', 'Planted Builder', '{customer}',
                    %(site)s);

            INSERT INTO sales.purchase_orders
                (id, organization_id, financial_year, serial, number, customer_po_ref, customer_party_id,
                 site_id, delivery_site, product_code, ordered_units, rate_per_unit, value, received_on,
                 deliver_by, taken_by, taken_by_name)
            VALUES (%(sales_purchase_orders)s, %(org)s, 'planted', 1, 'SO/planted/' || %(tag)s, 'PO-1',
                    %(master_parties)s, %(site)s, 'Site 1', 'MSAND', 10, 4200.00, 42000.00, now(), now(),
                    %(user)s, 'Planter');

            INSERT INTO fleet.breakdowns
                (id, organization_id, financial_year, serial, number, site_id, vehicle_ref, reported_at,
                 reported_by, location, cause, recorded_by)
            VALUES (%(fleet_breakdowns)s, %(org)s, 'planted', 1, 'BD/planted/' || %(tag)s, %(site)s,
                    'veh-' || %(tag)s, now(), 'Planter', 'GST Road', 'Gearbox oil leak', %(user)s);

            INSERT INTO finance.payments
                (id, organization_id, payment_date, method, amount, reference_no, recorded_by)
            VALUES (%(finance_payments)s, %(org)s, current_date, 'neft', 41277.60, %(utr)s, %(user)s);

            INSERT INTO finance.whatsapp_import_batches
                (id, organization_id, source, claims_received, claims_imported, imported_by)
            VALUES (%(finance_whatsapp_import_batches)s, %(org)s, 'export', 1, 1, %(user)s);

            INSERT INTO finance.whatsapp_import_claims
                (id, organization_id, batch_id, claim_key, sender, posted_at)
            VALUES (%(finance_whatsapp_import_claims)s, %(org)s, %(finance_whatsapp_import_batches)s,
                    'planted|' || %(tag)s, '+919578246168', now());

            INSERT INTO finance.expense_bills
                (id, organization_id, desk, site_id, kind, bill_date, litres, amount, status, provenance,
                 submitted_by_ref, submitted_by_name, created_by, attachment_file_id, whatsapp_claim_id,
                 payment_id, vehicle_ref)
            VALUES (%(finance_expense_bills)s, %(org)s, 'fleet', %(site)s, 'diesel', current_date, 432,
                    41277.60, 'paid', 'confirmed', 'driver:drv-001', 'Murugan S', %(user)s, %(core_files)s,
                    %(finance_whatsapp_import_claims)s, %(finance_payments)s, 'veh-001');

            INSERT INTO finance.expense_bill_fields
                (id, organization_id, bill_id, position, key, label, value)
            VALUES (%(finance_expense_bill_fields)s, %(org)s, %(finance_expense_bills)s, 0, 'amount',
                    'Amount', '41277.60');

            INSERT INTO finance.expense_bill_events
                (id, organization_id, bill_id, seq, action, from_status, to_status, actor_user_id,
                 actor_name, payment_id)
            VALUES (%(finance_expense_bill_events)s, %(org)s, %(finance_expense_bills)s, 1, 'pay', 'passed',
                    'paid', %(user)s, 'Planter', %(finance_payments)s)
    """
    with admin.cursor() as cur:
        for statement in statements.split(";\n\n"):
            cur.execute(statement, row)
    return ids


@pytest.mark.parametrize("table", LIN20_TABLES)
async def test_a_tenant_sees_its_own_new_rows(
    table: str, planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    """The control for every refusal below."""
    count = text(f"SELECT count(*) FROM {table} WHERE id = :id")
    async with tenant_session(str(tenant_a.org_id)) as session:
        found = (await session.execute(count, {"id": str(planted[table])})).scalar_one()
    assert found == 1


@pytest.mark.parametrize("table", LIN20_TABLES)
async def test_select_cannot_reach_another_tenants_new_rows(
    table: str, planted: dict[str, uuid.UUID], tenant_a: Tenant, tenant_b: Tenant
) -> None:
    count_by_id = text(f"SELECT count(*) FROM {table} WHERE id = :id")
    count_by_org = text(f"SELECT count(*) FROM {table} WHERE organization_id = :org")
    async with tenant_session(str(tenant_b.org_id)) as session:
        by_id = (await session.execute(count_by_id, {"id": str(planted[table])})).scalar_one()
        by_org = (await session.execute(count_by_org, {"org": str(tenant_a.org_id)})).scalar_one()
    assert (by_id, by_org) == (0, 0)


@pytest.mark.parametrize("table", LIN20_TABLES)
async def test_update_and_delete_cannot_reach_another_tenants_new_rows(
    table: str, planted: dict[str, uuid.UUID], tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    row_id = str(planted[table])
    for statement in (f"UPDATE {table} SET id = id WHERE id = :id", f"DELETE FROM {table} WHERE id = :id"):
        if table in APPEND_ONLY:
            # Not even reachable as a question: the app role may not UPDATE or
            # DELETE these at all, in any tenant.
            with pytest.raises(DBAPIError, match="permission denied"):
                async with tenant_session(str(tenant_b.org_id)) as session:
                    await session.execute(text(statement), {"id": row_id})
        else:
            async with tenant_session(str(tenant_b.org_id)) as session:
                result = await session.execute(text(statement), {"id": row_id})
            assert result.rowcount == 0, statement

    with admin.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {table} WHERE id = %s", (planted[table],))
        assert cur.fetchone()[0] == 1


@pytest.mark.parametrize("table", LIN20_TABLES)
async def test_insert_carrying_another_tenants_org_id_is_rejected_on_new_tables(
    table: str, planted: dict[str, uuid.UUID], tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    """Tenant B writes a copy of tenant A's row, A's organization_id and all.

    WITH CHECK refuses it before any key or constraint is looked at, so the
    only thing this can fail on is the policy.
    """
    forged_id = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(f"SELECT to_jsonb(t) FROM {table} t WHERE id = %s", (planted[table],))
        row = cur.fetchone()[0]
    row["id"] = str(forged_id)

    forge = text(
        f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table}, CAST(:row AS jsonb))"
    )
    with pytest.raises(DBAPIError) as caught:
        async with tenant_session(str(tenant_b.org_id)) as session:
            await session.execute(forge, {"row": json.dumps(row)})
    assert "row-level security" in str(caught.value).lower()

    with admin.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {table} WHERE id = %s", (forged_id,))
        assert cur.fetchone()[0] == 0


@pytest.mark.parametrize("table", sorted(APPEND_ONLY))
async def test_history_and_payments_cannot_be_edited_even_by_their_own_tenant(
    table: str, planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    for statement in (f"UPDATE {table} SET id = id WHERE id = :id", f"DELETE FROM {table} WHERE id = :id"):
        with pytest.raises(DBAPIError, match="permission denied"):
            async with tenant_session(str(tenant_a.org_id)) as session:
                await session.execute(text(statement), {"id": str(planted[table])})

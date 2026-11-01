"""Every table LIN-22 added keeps to its tenant, and its keys hold without the API.

The same four refusals test_tenant_isolation.py makes of the LIN-20 tables,
one table at a time, through the unprivileged app role; then the structural
rules the vehicle P&L leans on, asserted against the database itself, so a
data fix in psql cannot break them either:

  - a line of a sheet or of one of its trips names a trip of its own sheet;
  - a diesel bill or fuel entry is linked once; a linked bill repeats none of its figures;
  - a GST purchase names the vendor's GSTIN; maintenance says which kind;
  - a customer has a site it is served from, a vendor need not.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable

import psycopg
import pytest
from conftest import Tenant
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.db import tenant_session

# Parents before children, as they are planted.
LIN22_TABLES = [
    "master.items",
    "master.party_locations",
    "master.gst_rates",
    "logistics.trip_sheets",
    "logistics.trips",
    "logistics.diesel_lines",
    "logistics.enroute_expenses",
    "procurement.trip_purchases",
    "procurement.trip_purchase_files",
    "sales.trip_sales",
    "sales.trip_closures",
    "finance.trip_payments",
]


@pytest.fixture(scope="module")
def planted(
    admin: psycopg.Connection, tenant_a: Tenant, make_user: Callable[..., uuid.UUID]
) -> dict[str, uuid.UUID]:
    """One row in every new table, all tenant A's and wired to each other."""
    tag = uuid.uuid4().hex[:10]
    user = make_user(tenant_a, f"pl-planter-{tag}@example.com", "Planter")
    ids = {table: uuid.uuid4() for table in LIN22_TABLES}
    extra = {
        "vendor": uuid.uuid4(),
        "customer": uuid.uuid4(),
        "bill": uuid.uuid4(),
        "file": uuid.uuid4(),
        "other_sheet": uuid.uuid4(),
        "other_trip": uuid.uuid4(),
    }
    row = {
        "org": tenant_a.org_id,
        "site": tenant_a.site_id,
        "user": user,
        "tag": tag,
        "vehicle": f"veh-{tag}",
        **extra,
        **{table.replace(".", "_"): row_id for table, row_id in ids.items()},
    }
    statements = """
            INSERT INTO master.parties (id, organization_id, display_name, legal_name, party_roles, gstin)
            VALUES (%(vendor)s, %(org)s, 'Planted Quarry', 'Planted Quarry', '{vendor}', NULL);

            INSERT INTO master.parties
                (id, organization_id, display_name, legal_name, party_roles, served_from_site_id)
            VALUES (%(customer)s, %(org)s, 'Planted Builder', 'Planted Builder', '{customer}', %(site)s);

            INSERT INTO master.items (id, organization_id, code, name, hsn_code, gst_rate_pct, unit)
            VALUES (%(master_items)s, %(org)s, 'PL' || upper(%(tag)s), 'M-Sand ' || %(tag)s, '2517', 5,
                    'unit');

            INSERT INTO master.party_locations (id, organization_id, party_id, name)
            VALUES (%(master_party_locations)s, %(org)s, %(vendor)s, 'Pallur yard');

            INSERT INTO master.gst_rates (id, organization_id, rate_pct)
            VALUES (%(master_gst_rates)s, %(org)s, 99.97);

            INSERT INTO finance.expense_bills
                (id, organization_id, desk, site_id, kind, bill_number, bill_date, litres, amount, status,
                 provenance, submitted_by_ref, submitted_by_name, created_by, vehicle_ref)
            VALUES (%(bill)s, %(org)s, 'fleet', %(site)s, 'diesel', 'HP-' || %(tag)s, current_date, 30,
                    2833.21, 'submitted', 'human', 'user:x', 'Planter', %(user)s, %(vehicle)s);

            INSERT INTO core.files
                (id, organization_id, purpose, sha256, mime_type, size_bytes, original_name, uploaded_by)
            VALUES (%(file)s, %(org)s, 'trip_document', repeat('b', 64), 'image/jpeg', 10, 'bill.jpg',
                    %(user)s);

            INSERT INTO logistics.trip_sheets
                (id, organization_id, financial_year, serial, sheet_number, site_id, vehicle_ref,
                 registration_number, start_date, start_km, end_km, batta, created_by, created_by_name)
            VALUES (%(logistics_trip_sheets)s, %(org)s, 'planted', 1, 'TS/planted/' || %(tag)s, %(site)s,
                    %(vehicle)s, 'TN29AB1001', current_date, 100, 186, 500, %(user)s, 'Planter');

            INSERT INTO logistics.trip_sheets
                (id, organization_id, financial_year, serial, sheet_number, site_id, vehicle_ref,
                 registration_number, start_date, created_by, created_by_name)
            VALUES (%(other_sheet)s, %(org)s, 'planted', 2, 'TS/planted2/' || %(tag)s, %(site)s,
                    %(vehicle)s, 'TN29AB1001', current_date, %(user)s, 'Planter');

            INSERT INTO logistics.trips
                (id, organization_id, trip_sheet_id, financial_year, serial, trip_number, trip_date)
            VALUES (%(logistics_trips)s, %(org)s, %(logistics_trip_sheets)s, 'planted', 1,
                    'TRP/planted/' || %(tag)s, current_date);

            INSERT INTO logistics.trips
                (id, organization_id, trip_sheet_id, financial_year, serial, trip_number, trip_date)
            VALUES (%(other_trip)s, %(org)s, %(other_sheet)s, 'planted', 2, 'TRP/planted2/' || %(tag)s,
                    current_date);

            INSERT INTO logistics.diesel_lines
                (id, organization_id, trip_sheet_id, position, source, expense_bill_id)
            VALUES (%(logistics_diesel_lines)s, %(org)s, %(logistics_trip_sheets)s, 0, 'expense_bill',
                    %(bill)s);

            INSERT INTO logistics.enroute_expenses
                (id, organization_id, trip_sheet_id, trip_id, position, kind, location, reference, amount,
                 file_id)
            VALUES (%(logistics_enroute_expenses)s, %(org)s, %(logistics_trip_sheets)s, %(logistics_trips)s,
                    0, 'toll', 'Sriperumbudur', 'TXN-1', 235.00, %(file)s);

            INSERT INTO procurement.trip_purchases
                (id, organization_id, trip_id, position, vendor_party_id, location, item_id, hsn_code, unit,
                 quantity, rate, gst_billed, gst_rate_pct)
            VALUES (%(procurement_trip_purchases)s, %(org)s, %(logistics_trips)s, 0, %(vendor)s,
                    'Pallur yard', %(master_items)s, '2517', 'unit', 7, 2850.00, false, 0);

            INSERT INTO procurement.trip_purchase_files (id, organization_id, purchase_id, file_id)
            VALUES (%(procurement_trip_purchase_files)s, %(org)s, %(procurement_trip_purchases)s, %(file)s);

            INSERT INTO sales.trip_sales
                (id, organization_id, trip_id, position, customer_party_id, item_id, hsn_code, unit, quantity,
                 rate, gst_billed, gst_rate_pct, transport_amount)
            VALUES (%(sales_trip_sales)s, %(org)s, %(logistics_trips)s, 0, %(customer)s, %(master_items)s,
                    '2517', 'unit', 7, 4200.00, true, 5, 1500.00);

            INSERT INTO sales.trip_closures
                (id, organization_id, trip_id, customer_party_id, billed, closed_by, closed_by_name)
            VALUES (%(sales_trip_closures)s, %(org)s, %(logistics_trips)s, %(customer)s, 32445.00, %(user)s,
                    'Planter');

            INSERT INTO finance.trip_payments
                (id, organization_id, trip_sheet_id, trip_id, position, direction, party_id, paid_on, method,
                 amount, recorded_by)
            VALUES (%(finance_trip_payments)s, %(org)s, %(logistics_trip_sheets)s, %(logistics_trips)s, 0,
                    'in', %(customer)s, current_date, 'cash', 20000.00, %(user)s)
    """
    with admin.cursor() as cur:
        for statement in statements.split(";\n\n"):
            cur.execute(statement, row)
    return {**ids, **{f"extra.{k}": v for k, v in extra.items()}}


@pytest.mark.parametrize("table", LIN22_TABLES)
async def test_a_tenant_sees_its_own_rows(
    table: str, planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    """The control for every refusal below."""
    async with tenant_session(str(tenant_a.org_id)) as session:
        found = (
            await session.execute(
                text(f"SELECT count(*) FROM {table} WHERE id = :id"), {"id": str(planted[table])}
            )
        ).scalar_one()
    assert found == 1


@pytest.mark.parametrize("table", LIN22_TABLES)
async def test_select_cannot_reach_another_tenants_rows(
    table: str, planted: dict[str, uuid.UUID], tenant_a: Tenant, tenant_b: Tenant
) -> None:
    async with tenant_session(str(tenant_b.org_id)) as session:
        by_id = (
            await session.execute(
                text(f"SELECT count(*) FROM {table} WHERE id = :id"), {"id": str(planted[table])}
            )
        ).scalar_one()
        by_org = (
            await session.execute(
                text(f"SELECT count(*) FROM {table} WHERE organization_id = :org"),
                {"org": str(tenant_a.org_id)},
            )
        ).scalar_one()
    assert (by_id, by_org) == (0, 0)


@pytest.mark.parametrize("table", LIN22_TABLES)
async def test_update_and_delete_cannot_reach_another_tenants_rows(
    table: str, planted: dict[str, uuid.UUID], tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    row_id = str(planted[table])
    for statement in (f"UPDATE {table} SET id = id WHERE id = :id", f"DELETE FROM {table} WHERE id = :id"):
        async with tenant_session(str(tenant_b.org_id)) as session:
            result = await session.execute(text(statement), {"id": row_id})
        assert result.rowcount == 0, statement
    with admin.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {table} WHERE id = %s", (planted[table],))
        assert cur.fetchone()[0] == 1


@pytest.mark.parametrize("table", LIN22_TABLES)
async def test_insert_carrying_another_tenants_org_id_is_rejected(
    table: str, planted: dict[str, uuid.UUID], tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    """Tenant B writes a copy of tenant A's row, A's organization_id and all; WITH CHECK refuses it."""
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


# --------------------------------------------------------------- the keys


async def _refused(tenant: Tenant, sql: str, params: dict[str, object], constraint: str) -> None:
    with pytest.raises(IntegrityError) as caught:
        async with tenant_session(str(tenant.org_id)) as session:
            await session.execute(text(sql), params)
    assert constraint in str(caught.value), caught.value


@pytest.mark.parametrize(
    ("table", "constraint"),
    [
        ("logistics.diesel_lines", "fk_diesel_lines_organization_id_trip_sheet_id_trip_id"),
        ("logistics.enroute_expenses", "fk_enroute_expenses_organization_id_trip_sheet_id_trip_id"),
        ("finance.trip_payments", "fk_trip_payments_organization_id_trip_sheet_id_trip_id"),
    ],
)
async def test_a_line_names_a_trip_of_its_own_sheet(
    table: str, constraint: str, planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    await _refused(
        tenant_a,
        f"UPDATE {table} SET trip_id = :trip WHERE id = :id",
        {"trip": str(planted["extra.other_trip"]), "id": str(planted[table])},
        constraint,
    )


async def test_a_fill_is_linked_once_and_a_bill_repeats_none_of_its_figures(
    planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    await _refused(
        tenant_a,
        "INSERT INTO logistics.diesel_lines"
        " (organization_id, trip_sheet_id, position, source, expense_bill_id)"
        " VALUES (:org, :sheet, 1, 'expense_bill', :bill)",
        {
            "org": str(tenant_a.org_id),
            "sheet": str(planted["extra.other_sheet"]),
            "bill": str(planted["extra.bill"]),
        },
        "uq_diesel_lines_organization_id_expense_bill_id",
    )
    await _refused(
        tenant_a,
        "UPDATE logistics.diesel_lines SET litres = 30 WHERE id = :id",
        {"id": str(planted["logistics.diesel_lines"])},
        "ck_diesel_lines_figures_typed_once",
    )


async def test_a_gst_purchase_names_the_vendors_gstin(
    planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    await _refused(
        tenant_a,
        "UPDATE procurement.trip_purchases SET gst_billed = true WHERE id = :id",
        {"id": str(planted["procurement.trip_purchases"])},
        "ck_trip_purchases_gst_bill_has_gstin",
    )


async def test_maintenance_says_which_kind(planted: dict[str, uuid.UUID], tenant_a: Tenant) -> None:
    await _refused(
        tenant_a,
        "UPDATE logistics.enroute_expenses SET kind = 'maintenance' WHERE id = :id",
        {"id": str(planted["logistics.enroute_expenses"])},
        "ck_enroute_expenses_maintenance_kind_known",
    )
    await _refused(
        tenant_a,
        "UPDATE logistics.enroute_expenses SET kind = 'maintenance', maintenance_kind = 'misc'"
        " WHERE id = :id",
        {"id": str(planted["logistics.enroute_expenses"])},
        "ck_enroute_expenses_misc_described",
    )


async def test_a_customer_is_served_from_a_site_and_a_vendor_need_not_be(
    planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    await _refused(
        tenant_a,
        "UPDATE master.parties SET served_from_site_id = NULL WHERE id = :id",
        {"id": str(planted["extra.customer"])},
        "ck_parties_customer_has_site",
    )
    async with tenant_session(str(tenant_a.org_id)) as session:
        site = (
            await session.execute(
                text("SELECT served_from_site_id FROM master.parties WHERE id = :id"),
                {"id": str(planted["extra.vendor"])},
            )
        ).scalar_one()
    assert site is None

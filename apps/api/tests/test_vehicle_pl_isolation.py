"""Every table LIN-22 added keeps to its tenant, and its keys hold without the API.

The same four refusals test_tenant_isolation.py makes of the LIN-20 tables,
one table at a time, through the unprivileged app role; then the structural
rules the vehicle P&L leans on, asserted against the database itself, so a
data fix in psql cannot break them either:

  - a trip's vehicle and date are its vehicle day's;
  - a trip's part of a diesel fill names a fill posted to its own day;
  - a fill is posted once; a linked line repeats none of its fill's figures;
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
    "logistics.vehicle_duty_logs",
    "logistics.trips",
    "logistics.duty_fuel_links",
    "logistics.trip_diesel",
    "logistics.trip_costs",
    "procurement.trip_purchases",
    "procurement.trip_purchase_files",
    "sales.trip_sales",
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
    extra = {"vendor": uuid.uuid4(), "customer": uuid.uuid4(), "bill": uuid.uuid4(), "file": uuid.uuid4()}
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
            INSERT INTO master.parties (id, organization_id, display_name, legal_name, party_roles)
            VALUES (%(vendor)s, %(org)s, 'Planted Quarry', 'Planted Quarry', '{vendor}');

            INSERT INTO master.parties
                (id, organization_id, display_name, legal_name, party_roles, served_from_site_id)
            VALUES (%(customer)s, %(org)s, 'Planted Builder', 'Planted Builder', '{customer}', %(site)s);

            INSERT INTO master.items (id, organization_id, code, name, hsn_code, gst_rate_pct, unit)
            VALUES (%(master_items)s, %(org)s, 'PL' || upper(%(tag)s), 'M-Sand', '2517', 5, 'unit');

            INSERT INTO finance.expense_bills
                (id, organization_id, desk, site_id, kind, bill_number, bill_date, litres, amount, status,
                 provenance, submitted_by_ref, submitted_by_name, created_by, vehicle_ref)
            VALUES (%(bill)s, %(org)s, 'fleet', %(site)s, 'diesel', 'HP-' || %(tag)s, current_date, 30,
                    2833.21, 'submitted', 'human', 'user:x', 'Planter', %(user)s, %(vehicle)s);

            INSERT INTO core.files
                (id, organization_id, purpose, sha256, mime_type, size_bytes, original_name, uploaded_by)
            VALUES (%(file)s, %(org)s, 'purchase_invoice', repeat('b', 64), 'image/jpeg', 10, 'invoice.jpg',
                    %(user)s);

            INSERT INTO logistics.vehicle_duty_logs (id, organization_id, vehicle_ref, duty_date)
            VALUES (%(logistics_vehicle_duty_logs)s, %(org)s, %(vehicle)s, current_date);

            INSERT INTO logistics.trips
                (id, organization_id, financial_year, serial, trip_number, duty_log_id, site_id, vehicle_ref,
                 registration_number, trip_date, start_km, end_km, created_by, created_by_name)
            VALUES (%(logistics_trips)s, %(org)s, 'planted', 1, 'TRP/planted/' || %(tag)s,
                    %(logistics_vehicle_duty_logs)s, %(site)s, %(vehicle)s, 'TN29AB1001', current_date,
                    100, 140, %(user)s, 'Planter');

            INSERT INTO logistics.duty_fuel_links (id, organization_id, duty_log_id, source, expense_bill_id)
            VALUES (%(logistics_duty_fuel_links)s, %(org)s, %(logistics_vehicle_duty_logs)s, 'expense_bill',
                    %(bill)s);

            INSERT INTO logistics.trip_diesel
                (id, organization_id, trip_id, position, source, link_id, duty_log_id)
            VALUES (%(logistics_trip_diesel)s, %(org)s, %(logistics_trips)s, 0, 'expense_bill',
                    %(logistics_duty_fuel_links)s, %(logistics_vehicle_duty_logs)s);

            INSERT INTO logistics.trip_costs (id, organization_id, trip_id, position, kind, amount)
            VALUES (%(logistics_trip_costs)s, %(org)s, %(logistics_trips)s, 0, 'batta', 600.00);

            INSERT INTO procurement.trip_purchases
                (id, organization_id, trip_id, position, vendor_party_id, item_id, hsn_code, unit, quantity,
                 rate, gst_billed, gst_rate_pct)
            VALUES (%(procurement_trip_purchases)s, %(org)s, %(logistics_trips)s, 0, %(vendor)s,
                    %(master_items)s, '2517', 'unit', 7, 2850.00, true, 5);

            INSERT INTO procurement.trip_purchase_files (id, organization_id, purchase_id, file_id)
            VALUES (%(procurement_trip_purchase_files)s, %(org)s, %(procurement_trip_purchases)s, %(file)s);

            INSERT INTO sales.trip_sales
                (id, organization_id, trip_id, position, customer_party_id, item_id, hsn_code, unit, quantity,
                 rate, gst_billed, gst_rate_pct, transport_amount, transport_gst_rate_pct)
            VALUES (%(sales_trip_sales)s, %(org)s, %(logistics_trips)s, 0, %(customer)s, %(master_items)s,
                    '2517', 'unit', 7, 4200.00, true, 5, 1500.00, 18);

            INSERT INTO finance.trip_payments
                (id, organization_id, trip_id, position, direction, party_id, paid_on, method, amount,
                 recorded_by)
            VALUES (%(finance_trip_payments)s, %(org)s, %(logistics_trips)s, 0, 'in', %(customer)s,
                    current_date, 'cash', 20000.00, %(user)s)
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


async def test_a_trips_vehicle_and_date_are_its_days(planted: dict[str, uuid.UUID], tenant_a: Tenant) -> None:
    await _refused(
        tenant_a,
        "UPDATE logistics.trips SET trip_date = trip_date - 1 WHERE id = :id",
        {"id": str(planted["logistics.trips"])},
        "fk_trips_organization_id_duty_log_id_vehicle_ref_trip_date",
    )


async def test_a_link_names_a_fill_of_the_trips_own_day(
    planted: dict[str, uuid.UUID], tenant_a: Tenant, admin: psycopg.Connection
) -> None:
    other_day = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(
            "INSERT INTO logistics.vehicle_duty_logs (id, organization_id, vehicle_ref, duty_date)"
            " VALUES (%s, %s, 'veh-elsewhere', current_date - 1)",
            (other_day, tenant_a.org_id),
        )
    await _refused(
        tenant_a,
        "UPDATE logistics.duty_fuel_links SET duty_log_id = :day WHERE id = :id",
        {"day": str(other_day), "id": str(planted["logistics.duty_fuel_links"])},
        "fk_trip_diesel_organization_id_duty_log_id_link_id",
    )


async def test_a_fill_is_posted_once_and_a_link_repeats_none_of_its_figures(
    planted: dict[str, uuid.UUID], tenant_a: Tenant
) -> None:
    await _refused(
        tenant_a,
        "INSERT INTO logistics.duty_fuel_links (organization_id, duty_log_id, source, expense_bill_id)"
        " VALUES (:org, :day, 'expense_bill', :bill)",
        {
            "org": str(tenant_a.org_id),
            "day": str(planted["logistics.vehicle_duty_logs"]),
            "bill": str(planted["extra.bill"]),
        },
        "uq_duty_fuel_links_organization_id_expense_bill_id",
    )
    await _refused(
        tenant_a,
        "UPDATE logistics.trip_diesel SET litres = 30 WHERE id = :id",
        {"id": str(planted["logistics.trip_diesel"])},
        "ck_trip_diesel_figures_typed_once",
    )
    await _refused(
        tenant_a,
        "UPDATE logistics.duty_fuel_links SET amount = 2833.21 WHERE id = :id",
        {"id": str(planted["logistics.duty_fuel_links"])},
        "ck_duty_fuel_links_figures_from_the_source",
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

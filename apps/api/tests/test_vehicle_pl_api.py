"""The vehicle P&L through the API: the golden figures on the server, the shapes, scope and tenancy.

The trips in packages/domain/src/vehicle-pl.fixtures.json are entered through
POST /vehicle-pl/trips exactly as the trip page would, and what comes back —
each line's figures, each trip's P&L, the trip-wise, vehicle-wise and monthly
reports and both money-due lists — must be the figures worked by hand there.
So the TypeScript, the Python rules and the API path all answer to one file.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import psycopg
import pytest
from conftest import Person, Tenant

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages" / "domain" / "src" / "vehicle-pl.fixtures.json"
    ).read_text(encoding="utf-8")
)
TRIPS = {t["id"]: t for t in FIXTURES["trips"]}
IST = ZoneInfo("Asia/Kolkata")

TRIP_KEYS = {
    "id",
    "tripNumber",
    "date",
    "siteId",
    "vehicleId",
    "registrationNumber",
    "vehicleModel",
    "driverId",
    "driverName",
    "driverPhone",
    "startKm",
    "endKm",
    "customers",
    "vendors",
    "materials",
    "pl",
    "createdBy",
    "createdAt",
    "updatedAt",
    "notes",
    "diesel",
    "purchases",
    "sales",
    "costs",
    "payments",
    "dues",
}
PL_KEYS = set(FIXTURES["cases"][0]["expect"]["t1"]["pl"])
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00 a photo of a quarry invoice"

READ = "fleet.trip_pl.read"
WRITE = "fleet.trip_pl.write"
REPORT = "finance.pl_report.read"


def today() -> date:
    return datetime.now(tz=IST).date()


@dataclass
class Book:
    """One tenant's masters, named by the fixtures' ids, and the people who use them."""

    tenant: Tenant
    plant: uuid.UUID
    elsewhere: uuid.UUID
    writer: Person
    reader: Person
    director: Person
    far_writer: Person
    outsider: Person
    parties: dict[str, str]
    materials: dict[str, str]
    bills: dict[str, str]


def plant_bill(
    admin: psycopg.Connection,
    tenant: Tenant,
    user: uuid.UUID,
    bill_number: str,
    vehicle: str | None,
    litres: str,
    amount: str,
) -> str:
    """A fleet diesel bill already in Expenses, as LIN-20 stores one."""
    bill_id = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(
            """
            INSERT INTO finance.expense_bills
                (id, organization_id, desk, site_id, kind, bill_number, bill_date, vendor, vehicle_ref,
                 litres, amount, status, provenance, submitted_by_ref, submitted_by_name, created_by)
            VALUES (%s, %s, 'fleet', %s, 'diesel', %s, current_date - 120, 'HP Bunk, Vandalur', %s, %s, %s,
                    'submitted', 'human', %s, 'Planter', %s)
            """,
            (
                bill_id,
                tenant.org_id,
                tenant.site_id,
                bill_number,
                vehicle,
                litres,
                amount,
                f"user:{user}",
                user,
            ),
        )
    return str(bill_id)


async def make_masters(client) -> tuple[dict[str, str], dict[str, str]]:  # type: ignore[no-untyped-def]
    """Two materials, three vendors and five customers, added the way the trip page adds them."""
    materials = {}
    for code, name in (("MSAND", "M-Sand"), ("AGG20", "20mm Aggregate")):
        r = await client.post(
            "/vehicle-pl/materials",
            json={"code": code, "name": name, "hsnCode": "2517", "gstRatePct": 5, "unit": "unit"},
        )
        assert r.status_code == 201, r.text
        materials[code] = r.json()["id"]
    parties = {}
    for key, name in (
        ("ven-qry", "Pallur Blue Metal Quarry"),
        ("ven-loc", "Local Sand Depot"),
        ("ven-crs", "Sri Balaji Crusher"),
    ):
        r = await client.post("/vehicle-pl/parties", json={"role": "vendor", "name": name})
        assert r.status_code == 201, r.text
        parties[key] = r.json()["id"]
    return parties, materials


def wire(trip: dict[str, Any], book: Book, *, site: uuid.UUID | None = None) -> dict[str, Any]:
    """A fixture trip as the trip page sends it."""
    p = book.parties
    diesel = []
    for d in trip["diesel"]:
        if d["source"] == "typed":
            diesel.append(
                {
                    "source": "typed",
                    "litres": d["litres"],
                    "rate": d["rate"],
                    "billNumber": d.get("billNumber") or "",
                }
            )
        elif d["source"] == "expense_bill":
            diesel.append({"source": "expense_bill", "expenseBillId": book.bills[d["expenseBillId"]]})
        else:
            diesel.append(
                {
                    "source": "fuel_entry",
                    "fuelEntryId": d["fuelEntryId"],
                    "litres": d["litres"],
                    "amount": d["amount"],
                    "billNumber": d.get("billNumber") or "",
                    "vendor": "Own bunk",
                }
            )
    return {
        "siteId": str(site or book.plant),
        "date": trip["date"],
        "vehicleId": trip["vehicleId"],
        "registrationNumber": f"TN 29 AB {trip['vehicleId'][-3:]}",
        "vehicleModel": "Tata Signa 3525.TK",
        "driverName": "Murugan S",
        "driverPhone": "9840012345",
        "startKm": trip["startKm"],
        "endKm": trip["endKm"],
        "diesel": diesel,
        "purchases": [
            {
                "vendorId": p[x["vendorId"]],
                "materialId": book.materials["MSAND"],
                "quantity": x["quantity"],
                "rate": x["rate"],
                "gstBilled": x["gstBilled"],
                "gstRatePct": x["gstRatePct"],
                "invoiceNumber": f"INV-{x['id']}",
            }
            for x in trip["purchases"]
        ],
        "sales": [
            {
                "customerId": p[x["customerId"]],
                "materialId": book.materials["MSAND"],
                "quantity": x["quantity"],
                "rate": x["rate"],
                "gstBilled": x["gstBilled"],
                "gstRatePct": x["gstRatePct"],
                "transport": x.get("transport"),
                "transportGstRatePct": x.get("transportGstRatePct"),
                "challanNumber": f"DC-{x['id']}",
            }
            for x in trip["sales"]
        ],
        "costs": [
            {"kind": c["kind"], "amount": c["amount"], "description": "as paid"} for c in trip["costs"]
        ],
        "payments": [
            {
                "direction": m["direction"],
                "partyId": p[m["partyId"]],
                "paidOn": trip["date"],
                "mode": "UPI",
                "amount": m["amount"],
            }
            for m in trip["payments"]
        ],
    }


@pytest.fixture(scope="module")
def book(
    admin: psycopg.Connection,
    make_tenant: Callable[..., Tenant],
    make_site: Callable[..., uuid.UUID],
    make_person: Callable[..., Person],
) -> Book:
    """Every golden trip entered through the API, in a tenant of its own.

    Entered once for the module, in an event loop of its own that hands the
    connection pool back empty, as every test does (conftest.py).
    """
    tenant = make_tenant("plbook")
    elsewhere = make_site(tenant, "Thiruvallur Crusher", "crusher_plant")
    writer = make_person(tenant, "Anbu Selvan M", [READ, WRITE], sites=[tenant.site_id])
    book = Book(
        tenant=tenant,
        plant=tenant.site_id,
        elsewhere=elsewhere,
        writer=writer,
        reader=make_person(tenant, "Reader", [READ], sites=[tenant.site_id]),
        director=make_person(tenant, "Balaji N", [READ, REPORT]),
        far_writer=make_person(tenant, "Far Writer", [READ, WRITE], sites=[elsewhere]),
        outsider=make_person(tenant, "Outsider", ["fleet.board.read"]),
        parties={},
        materials={},
        bills={},
    )
    book.bills["bill-881"] = plant_bill(admin, tenant, writer.user_id, "HP-881", "veh-003", "30", "2833.21")
    book.bills["bill-990"] = plant_bill(admin, tenant, writer.user_id, "HP-990", "veh-002", "50", "4700.00")

    async def enter() -> None:
        import httpx

        from app.core import db as core_db
        from app.main import app

        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://api", headers=writer.headers
        ) as client:
            book.parties, book.materials = await make_masters(client)
            for i in range(1, 6):
                r = await client.post(
                    "/vehicle-pl/parties",
                    json={"role": "customer", "name": f"Builder {i}", "siteId": str(tenant.site_id)},
                )
                assert r.status_code == 201, r.text
                book.parties[f"cus-0{i}"] = r.json()["id"]
            for fixture_id in FIXTURES["reports"]["trips"]:
                r = await client.post("/vehicle-pl/trips", json=wire(TRIPS[fixture_id], book))
                assert r.status_code == 201, r.text
                book.bills[fixture_id] = r.json()["id"]
        await core_db.engine.dispose()

    asyncio.run(enter())
    # Rejected after it was linked: it stays on the trip and counts nothing.
    with admin.cursor() as cur:
        cur.execute(
            "UPDATE finance.expense_bills SET status = 'rejected' WHERE id = %s", (book.bills["bill-990"],)
        )
    return book


def trip_id(book: Book, fixture_id: str) -> str:
    return book.bills[fixture_id]


# ------------------------------------------------------- the golden figures


# The cases whose trips the book enters (the reports' trips).
BOOK_CASES = [c for c in FIXTURES["cases"] if set(c["trips"]) <= set(FIXTURES["reports"]["trips"])]


@pytest.mark.parametrize("case", BOOK_CASES, ids=lambda c: c["name"])
async def test_the_api_gives_the_golden_figures(api, book: Book, case: dict) -> None:  # type: ignore[no-untyped-def, type-arg]
    client = api(book.reader)
    for fixture_id, expected in case["expect"].items():
        r = await client.get(f"/vehicle-pl/trips/{trip_id(book, fixture_id)}")
        assert r.status_code == 200, r.text
        trip = r.json()
        assert trip["pl"] == expected["pl"]
        fixture = TRIPS[fixture_id]
        for line, fx in zip(trip["purchases"], fixture["purchases"], strict=True):
            assert {k: line[k] for k in expected["purchases"][fx["id"]]} == expected["purchases"][fx["id"]]
        for line, fx in zip(trip["sales"], fixture["sales"], strict=True):
            assert {k: line[k] for k in expected["sales"][fx["id"]]} == expected["sales"][fx["id"]]
        for line, fx in zip(trip["diesel"], fixture["diesel"], strict=True):
            assert {k: line[k] for k in expected["diesel"][fx["id"]]} == expected["diesel"][fx["id"]]
        names = {v: k for k, v in book.parties.items()}
        dues = [
            {**{k: d[k] for k in ("role", "billed", "settled", "due")}, "partyId": names[d["partyId"]]}
            for d in trip["dues"]
        ]
        assert dues == expected["dues"]


async def test_the_reports_add_up_to_the_golden_totals(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.director)
    expected = FIXTURES["reports"]["expect"]
    trips = (await client.get("/vehicle-pl/reports/trips")).json()
    assert trips["total"] == expected["total"]
    assert len(trips["rows"]) == len(FIXTURES["reports"]["trips"])

    vehicles = (await client.get("/vehicle-pl/reports/vehicles")).json()
    assert [
        {k: v for k, v in r.items() if k not in ("registrationNumber", "vehicleModel")}
        for r in vehicles["rows"]
    ] == expected["byVehicle"]
    assert vehicles["total"] == expected["total"]
    assert vehicles["rows"][0]["registrationNumber"] == "TN 29 AB 003"

    months = (await client.get("/vehicle-pl/reports/months")).json()
    assert months["rows"] == expected["byMonth"]

    names = {v: k for k, v in book.parties.items()}
    for path, key in (("customers", "customers"), ("vendors", "vendors")):
        report = (await client.get(f"/vehicle-pl/reports/{path}")).json()
        rows = [
            {k: r[k] for k in ("role", "trips", "billed", "settled", "due", "firstDate", "lastDate")}
            | {"partyId": names[r["partyId"]]}
            for r in report["rows"]
        ]
        assert rows == expected[key]
        assert report["total"]["due"] == (
            expected["total"]["customerDue"] if key == "customers" else expected["total"]["vendorDue"]
        )


async def test_a_shared_fill_names_the_trips_it_is_split_with(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    r = await api(book.reader).get(f"/vehicle-pl/trips/{trip_id(book, 't3b')}")
    line = r.json()["diesel"][0]
    assert line["source"] == "expense_bill" and line["billNumber"] == "HP-881" and line["litres"] == 30
    assert line["counted"] is True and line["billStatus"] == "submitted"
    numbers = {t["id"]: t["tripNumber"] for t in (await api(book.reader).get("/vehicle-pl/trips")).json()}
    assert sorted(line["sharedWith"]) == sorted(
        [numbers[trip_id(book, "t3a")], numbers[trip_id(book, "t3c")]]
    )
    rejected = (await api(book.reader).get(f"/vehicle-pl/trips/{trip_id(book, 't7a')}")).json()["diesel"][1]
    assert (rejected["billStatus"], rejected["counted"], rejected["shareAmount"]) == (
        "rejected",
        False,
        "0.00",
    )


# ------------------------------------------------------------------ shapes


async def test_a_trip_comes_back_in_the_wire_shape(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    trip = (await api(book.reader).get(f"/vehicle-pl/trips/{trip_id(book, 't1')}")).json()
    assert set(trip) == TRIP_KEYS
    assert set(trip["pl"]) == PL_KEYS
    assert trip["tripNumber"].startswith("TRP/26-27/")
    assert trip["date"] == "2026-08-04" and trip["startKm"] == 218400 and trip["endKm"] == 218486
    assert trip["purchases"][0]["rate"] == "2850.00" and trip["purchases"][0]["quantity"] == 7
    assert trip["purchases"][0]["hsnCode"] == "2517" and trip["purchases"][0]["unit"] == "unit"
    assert trip["purchases"][0]["materialName"] == "M-Sand"
    assert trip["sales"][0]["challanNumber"] == "DC-t1-s1"
    assert trip["payments"][0]["mode"] == "UPI" and trip["payments"][0]["paidOn"] == "2026-08-04"
    assert trip["customers"] == ["Builder 1"] and trip["vendors"] == ["Pallur Blue Metal Quarry"]
    assert trip["createdBy"] == "Anbu Selvan M"


async def test_the_trip_list_finds_by_number_vehicle_people_and_papers(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.director)
    every = (await client.get("/vehicle-pl/trips")).json()
    assert [t["date"] for t in every] == sorted((t["date"] for t in every), reverse=True)

    async def ids(**params: str) -> set[str]:
        r = await client.get("/vehicle-pl/trips", params=params)
        assert r.status_code == 200, r.text
        return {t["id"] for t in r.json()}

    t1 = trip_id(book, "t1")
    assert await ids(q="tn29ab001") >= {t1}
    assert t1 in await ids(q="builder 1")
    assert await ids(q="INV-t2-p2") == {trip_id(book, "t2")}
    assert await ids(q="DC-t5") == {trip_id(book, "t5")}
    assert await ids(q="Sri Balaji") == {trip_id(book, "t2"), trip_id(book, "t5")}
    assert await ids(vehicleId="veh-003") == {trip_id(book, i) for i in ("t3a", "t3b", "t3c")}
    assert await ids(customerId=book.parties["cus-03"]) == {trip_id(book, "t3a"), trip_id(book, "t3b")}
    assert await ids(vendorId=book.parties["ven-loc"]) == {trip_id(book, "t2")}
    assert await ids(**{"from": "2026-07-01", "to": "2026-07-31"}) == {trip_id(book, "t5")}
    assert await ids(q="100%") == set()


async def test_masters_list_what_a_line_can_name(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    masters = (await api(book.reader).get("/vehicle-pl/masters")).json()
    assert {m["code"]: (m["hsnCode"], m["gstRatePct"], m["unit"]) for m in masters["materials"]} == {
        "MSAND": ("2517", 5, "unit"),
        "AGG20": ("2517", 5, "unit"),
    }
    assert {v["name"] for v in masters["vendors"]} == {
        "Pallur Blue Metal Quarry",
        "Local Sand Depot",
        "Sri Balaji Crusher",
    }
    assert len(masters["customers"]) == 5


# ----------------------------------------------------------- add, edit, delete


@pytest.fixture
async def fresh(api, book: Book):  # type: ignore[no-untyped-def]
    """A trip of its own for a test to change, on a vehicle no golden trip uses."""
    body = wire(TRIPS["t1"], book) | {
        "vehicleId": f"veh-{uuid.uuid4().hex[:6]}",
        "date": (today() - timedelta(days=3)).isoformat(),
    }
    r = await api(book.writer).post("/vehicle-pl/trips", json=body)
    assert r.status_code == 201, r.text
    return r.json(), body


async def test_an_edit_keeps_line_ids_and_works_the_figures_again(api, book: Book, fresh) -> None:  # type: ignore[no-untyped-def]
    trip, body = fresh
    client = api(book.writer)
    diesel_id, purchase_id = trip["diesel"][0]["id"], trip["purchases"][0]["id"]
    edited = body | {
        "diesel": [{**body["diesel"][0], "id": diesel_id, "rate": "90.00"}],
        "purchases": [{**body["purchases"][0], "id": purchase_id}],
        "sales": [{**body["sales"][0], "id": trip["sales"][0]["id"]}],
        # One cost removed, one corrected, one added.
        "costs": [
            {**body["costs"][0], "id": trip["costs"][0]["id"], "amount": "700.00"},
            {"kind": "other", "amount": "50.00", "description": "tea"},
        ],
        "payments": [{**body["payments"][0], "id": trip["payments"][0]["id"]}],
    }
    r = await client.put(f"/vehicle-pl/trips/{trip['id']}", json=edited)
    assert r.status_code == 200, r.text
    after = r.json()
    assert after["diesel"][0]["id"] == diesel_id and after["diesel"][0]["amount"] == "2565.00"
    assert after["purchases"][0]["id"] == purchase_id
    assert [c["amount"] for c in after["costs"]] == ["700.00", "50.00"]
    assert after["costs"][0]["id"] == trip["costs"][0]["id"]
    # 10950.00 − 2565.00 − 700.00 − 50.00; the vendor's payment is gone, so all of their bill is due.
    assert after["pl"]["net"] == "7635.00"
    assert after["pl"]["vendorDue"] == "20947.50" and after["pl"]["customerDue"] == "12640.00"
    assert after["tripNumber"] == trip["tripNumber"]


async def test_a_line_of_another_trip_cannot_be_edited_through_this_one(api, book: Book, fresh) -> None:  # type: ignore[no-untyped-def]
    trip, body = fresh
    other = (await api(book.reader).get(f"/vehicle-pl/trips/{trip_id(book, 't6')}")).json()
    r = await api(book.writer).put(
        f"/vehicle-pl/trips/{trip['id']}",
        json=body | {"costs": [{**body["costs"][0], "id": other["costs"][0]["id"]}]},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["problem"] == {
        "code": "invalid",
        "field": "costs[0].id",
        "reason": "not a line of this trip",
    }


async def test_delete_removes_the_trip_and_its_day(api, book: Book, fresh, admin: psycopg.Connection) -> None:  # type: ignore[no-untyped-def]
    trip, body = fresh
    client = api(book.writer)
    assert (await api(book.reader).delete(f"/vehicle-pl/trips/{trip['id']}")).status_code == 403
    assert (await client.delete(f"/vehicle-pl/trips/{trip['id']}")).status_code == 204
    assert (await client.get(f"/vehicle-pl/trips/{trip['id']}")).status_code == 404
    with admin.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM logistics.vehicle_duty_logs WHERE vehicle_ref = %s", (body["vehicleId"],)
        )
        assert cur.fetchone()[0] == 0
        cur.execute("SELECT count(*) FROM finance.trip_payments WHERE trip_id = %s", (trip["id"],))
        assert cur.fetchone()[0] == 0


async def test_a_new_trips_lines_carry_no_ids(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    body = wire(TRIPS["t4"], book)
    body["costs"][0]["id"] = str(uuid.uuid4())
    assert (await api(book.writer).post("/vehicle-pl/trips", json=body)).status_code == 422


# ------------------------------------------------------- the rules, enforced


async def test_a_trip_is_checked_like_the_trip_page_checks_it(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    base = wire(TRIPS["t1"], book) | {
        "vehicleId": "veh-checks",
        "date": (today() - timedelta(days=2)).isoformat(),
    }

    async def problem(body: dict) -> dict:  # type: ignore[type-arg]
        r = await client.post("/vehicle-pl/trips", json=body)
        assert r.status_code in (409, 422), r.text
        return r.json()["detail"]["problem"]

    assert (await problem(base | {"date": (today() + timedelta(days=1)).isoformat()}))["field"] == "date"
    assert (await problem(base | {"startKm": 500, "endKm": 400}))["field"] == "endKm"
    wrong_role = {**base["purchases"][0], "vendorId": book.parties["cus-01"]}
    assert (await problem(base | {"purchases": [wrong_role]}))["field"] == "purchases[0].vendorId"
    stranger = {**base["payments"][0], "partyId": book.parties["cus-02"]}
    assert (await problem(base | {"payments": [stranger]}))["reason"] == "not a customer of this trip"
    later = {**base["payments"][0], "paidOn": (today() + timedelta(days=1)).isoformat()}
    assert (await problem(base | {"payments": [later]}))["field"] == "payments[0].paidOn"
    no_rate = {**base["sales"][0], "transportGstRatePct": None}
    assert (await problem(base | {"sales": [no_rate]}))["field"] == "sales[0].transportGstRatePct"
    free = {**base["sales"][0], "rate": "0"}
    assert (await problem(base | {"sales": [free]}))["field"] == "sales[0].rate"
    retyped = {"source": "expense_bill", "expenseBillId": book.bills["bill-881"], "litres": 30}
    assert (await problem(base | {"diesel": [retyped]}))[
        "reason"
    ] == "a linked bill's figures come from the bill"
    twice = {**base["payments"][0], "reference": "UTR12345678"}
    assert (await problem(base | {"payments": [twice, twice]}))["code"] == "reference-used"
    r = await client.post("/vehicle-pl/trips", json=base | {"notes": "x" * 1001})
    assert r.status_code == 422
    r = await client.post("/vehicle-pl/trips", json=base | {"profit": "1000000.00"})
    assert r.status_code == 422, "a figure the rules derive cannot be sent"


async def test_a_fill_is_never_counted_twice(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    day = wire(TRIPS["t3a"], book)
    bill = {"source": "expense_bill", "expenseBillId": book.bills["bill-881"]}

    async def problem(body: dict) -> dict:  # type: ignore[type-arg]
        r = await client.post("/vehicle-pl/trips", json=body)
        assert r.status_code == 409, r.text
        return r.json()["detail"]["problem"]

    assert (await problem(day | {"diesel": [bill, bill]}))["code"] == "diesel-linked-twice"
    typed = {"source": "typed", "litres": 30, "rate": "94.44", "billNumber": "hp 881"}
    found = await problem(day | {"vehicleId": "veh-003", "diesel": [typed]})
    assert (found["code"], found["line"], found["billId"]) == (
        "diesel-bill-exists",
        0,
        book.bills["bill-881"],
    )
    # The same fill on another day of the vehicle: it belongs to the day it was posted to.
    elsewhere = await problem(day | {"date": "2026-08-07", "diesel": [bill]})
    assert elsewhere["code"] == "diesel-linked-elsewhere" and len(elsewhere["trips"]) == 3
    # A bill of another vehicle.
    assert (await problem(day | {"vehicleId": "veh-002", "diesel": [bill]}))["code"] == "diesel-other-vehicle"
    # A typed bill number already typed on another trip of the vehicle.
    again = {"source": "typed", "litres": 5, "rate": "94.00", "billNumber": "HP 1102"}
    repeat = await problem(wire(TRIPS["t1"], book) | {"date": "2026-08-03", "diesel": [again]})
    assert repeat["code"] == "diesel-bill-on-trip"
    # A rejected bill cannot be linked anew.
    void = {"source": "expense_bill", "expenseBillId": book.bills["bill-990"]}
    assert (await problem(wire(TRIPS["t2"], book) | {"date": "2026-08-01", "diesel": [void]}))[
        "code"
    ] == "diesel-bill-void"


async def test_moving_a_trip_takes_its_own_fill_with_it(api, book: Book, admin: psycopg.Connection) -> None:  # type: ignore[no-untyped-def]
    """A fill only this trip links moves with it when its date is corrected; a shared one cannot."""
    client = api(book.writer)
    bill = plant_bill(admin, book.tenant, book.writer.user_id, "IOC-MOVE-1", "veh-move", "40", "3760.00")
    body = wire(TRIPS["t4"], book) | {
        "vehicleId": "veh-move",
        "date": "2026-07-01",
        "diesel": [{"source": "expense_bill", "expenseBillId": bill}],
    }
    created = (await client.post("/vehicle-pl/trips", json=body)).json()
    assert created["pl"]["diesel"] == "3760.00"
    moved = await client.put(f"/vehicle-pl/trips/{created['id']}", json=body | {"date": "2026-07-02"})
    assert moved.status_code == 200, moved.text
    assert moved.json()["pl"]["diesel"] == "3760.00"
    with admin.cursor() as cur:
        cur.execute(
            "SELECT d.duty_date FROM logistics.duty_fuel_links l"
            " JOIN logistics.vehicle_duty_logs d ON d.id = l.duty_log_id WHERE l.expense_bill_id = %s",
            (bill,),
        )
        assert cur.fetchone()[0] == date(2026, 7, 2)
        cur.execute("SELECT count(*) FROM logistics.vehicle_duty_logs WHERE vehicle_ref = 'veh-move'")
        assert cur.fetchone()[0] == 1, "the emptied day went"
    shared = await client.put(
        f"/vehicle-pl/trips/{trip_id(book, 't3b')}", json=wire(TRIPS["t3b"], book) | {"date": "2026-08-05"}
    )
    assert (
        shared.status_code == 409 and shared.json()["detail"]["problem"]["code"] == "diesel-linked-elsewhere"
    )


async def test_a_customer_or_vendor_already_in_the_master_takes_the_role(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    gstin = "33AABCU9603R1ZU"
    customer = await client.post(
        "/vehicle-pl/parties",
        json={"role": "customer", "name": "Dual Firm", "gstin": gstin, "siteId": str(book.plant)},
    )
    assert customer.status_code == 201, customer.text
    vendor = await client.post(
        "/vehicle-pl/parties", json={"role": "vendor", "name": "Dual Firm Again", "gstin": gstin}
    )
    assert vendor.json()["id"] == customer.json()["id"]
    assert sorted(vendor.json()["roles"]) == ["customer", "vendor"]
    assert (
        await client.post("/vehicle-pl/parties", json={"role": "customer", "name": "No site"})
    ).status_code == 422
    bad = await client.post(
        "/vehicle-pl/parties", json={"role": "vendor", "name": "Bad", "gstin": "33AABCU9603R1ZX"}
    )
    assert bad.status_code == 422


async def test_a_material_code_is_used_once_and_a_retired_one_is_not_offered(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    again = await client.post(
        "/vehicle-pl/materials",
        json={"code": "MSAND", "name": "Again", "hsnCode": "2517", "gstRatePct": 5, "unit": "unit"},
    )
    assert again.status_code == 409 and again.json()["detail"]["problem"]["code"] == "code-used"
    made = (
        await client.post(
            "/vehicle-pl/materials",
            json={"code": "GSB", "name": "GSB", "hsnCode": "2517", "gstRatePct": 5, "unit": "tonne"},
        )
    ).json()
    retired = await client.patch(
        f"/vehicle-pl/materials/{made['id']}", json={"active": False, "gstRatePct": 18}
    )
    assert retired.json()["active"] is False and retired.json()["gstRatePct"] == 18
    body = wire(TRIPS["t2"], book) | {"date": "2026-07-20"}
    body["purchases"][0]["materialId"] = made["id"]
    r = await client.post("/vehicle-pl/trips", json=body)
    assert r.status_code == 422 and r.json()["detail"]["problem"]["reason"] == "no longer in use"


async def test_the_gst_rate_and_hsn_default_from_the_material(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    body = wire(TRIPS["t4"], book) | {"date": "2026-06-01", "vehicleId": "veh-default"}
    body["sales"] = [
        {
            "customerId": book.parties["cus-01"],
            "materialId": book.materials["AGG20"],
            "quantity": 2,
            "rate": "1000.00",
            "gstBilled": True,
        }
    ]
    trip = (await api(book.writer).post("/vehicle-pl/trips", json=body)).json()
    assert (trip["sales"][0]["gstRatePct"], trip["sales"][0]["hsnCode"], trip["sales"][0]["gstAmount"]) == (
        5,
        "2517",
        "100.00",
    )


# ------------------------------------------------------------- attachments


async def test_an_invoice_photo_goes_on_a_purchase_and_is_read_with_the_trip(  # type: ignore[no-untyped-def]
    api, book: Book, file_dir: Path, make_person: Callable[..., Person], make_tenant: Callable[..., Tenant]
) -> None:
    client = api(book.writer)
    up = await client.post("/vehicle-pl/attachments", files={"file": ("quarry bill.jpg", JPEG, "image/jpeg")})
    assert up.status_code == 201, up.text
    file_id = up.json()["id"]
    body = wire(TRIPS["t2"], book) | {"date": "2026-07-21", "vehicleId": "veh-photo"}
    body["purchases"][0]["attachmentIds"] = [file_id]
    trip = (await client.post("/vehicle-pl/trips", json=body)).json()
    attachment = trip["purchases"][0]["attachments"][0]
    assert (
        attachment["fileName"] == "quarry bill.jpg"
        and attachment["url"] == f"/vehicle-pl/attachments/{file_id}"
    )
    got = await api(book.reader).get(attachment["url"])
    assert (
        got.status_code == 200 and got.content == JPEG and got.headers["x-content-type-options"] == "nosniff"
    )
    assert (await api(book.far_writer).get(attachment["url"])).status_code == 403
    # Already on a purchase: not a second one's.
    again = wire(TRIPS["t2"], book) | {"date": "2026-07-22", "vehicleId": "veh-photo", "diesel": []}
    again["purchases"][0]["attachmentIds"] = [file_id]
    assert (await client.post("/vehicle-pl/trips", json=again)).status_code == 422
    # Another tenant cannot fetch it at all.
    other = make_tenant("plphoto")
    stranger = make_person(other, "Stranger", [READ, WRITE, REPORT])
    assert (await api(stranger).get(attachment["url"])).status_code == 404
    # Dropping it from the purchase takes it off; the upload stays the uploader's.
    body["purchases"][0]["id"] = trip["purchases"][0]["id"]
    body["purchases"][0]["attachmentIds"] = []
    keep_ids = body | {
        "diesel": [{**body["diesel"][0], "id": trip["diesel"][0]["id"]}],
        "purchases": [body["purchases"][0], {**body["purchases"][1], "id": trip["purchases"][1]["id"]}],
        "sales": [{**body["sales"][0], "id": trip["sales"][0]["id"]}],
        "costs": [{**body["costs"][0], "id": trip["costs"][0]["id"]}],
        "payments": [{**m, "id": trip["payments"][i]["id"]} for i, m in enumerate(body["payments"])],
    }
    after = (await client.put(f"/vehicle-pl/trips/{trip['id']}", json=keep_ids)).json()
    assert after["purchases"][0]["attachments"] == []
    assert (await api(book.reader).get(attachment["url"])).status_code == 404
    assert (await client.get(attachment["url"])).status_code == 200
    wrong = await client.post("/vehicle-pl/attachments", files={"file": ("x.html", b"<html>", "image/jpeg")})
    assert wrong.status_code == 415


# ------------------------------------------------------- who may do what, where


async def test_reading_and_writing_follow_the_trips_site(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    t1 = trip_id(book, "t1")
    assert (await api(book.outsider).get("/vehicle-pl/trips")).status_code == 403
    assert (await api(book.outsider).get(f"/vehicle-pl/trips/{t1}")).status_code == 403
    assert (await api(book.far_writer).get(f"/vehicle-pl/trips/{t1}")).status_code == 403
    assert (await api(book.far_writer).get("/vehicle-pl/trips")).json() == []
    body = wire(TRIPS["t4"], book) | {"date": "2026-06-02"}
    refused = await api(book.far_writer).post("/vehicle-pl/trips", json=body)
    assert refused.status_code == 403
    assert refused.json()["detail"]["problem"] == {"code": "needs-permission", "permission": WRITE}
    assert (await api(book.reader).post("/vehicle-pl/trips", json=body)).status_code == 403
    assert (await api(book.reader).get(f"/vehicle-pl/trips/{t1}")).status_code == 200
    assert (await api(book.director).get(f"/vehicle-pl/trips/{t1}")).status_code == 200
    assert (await api(book.director).post("/vehicle-pl/trips", json=body)).status_code == 403
    # Moving a trip to a site the writer does not hold is refused too.
    t4 = (await api(book.reader).get(f"/vehicle-pl/trips/{trip_id(book, 't4')}")).json()
    moved = wire(TRIPS["t4"], book, site=book.elsewhere)
    moved["diesel"][0]["id"] = t4["diesel"][0]["id"]
    moved["costs"][0]["id"] = t4["costs"][0]["id"]
    assert (await api(book.writer).put(f"/vehicle-pl/trips/{t4['id']}", json=moved)).status_code == 403


async def test_the_reports_are_the_directors_and_accounts(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    for path in ("vehicles", "months", "customers", "vendors"):
        r = await api(book.writer).get(f"/vehicle-pl/reports/{path}")
        assert r.status_code == 403 and r.json()["detail"]["problem"]["permission"] == REPORT, path
        assert (await api(book.director).get(f"/vehicle-pl/reports/{path}")).status_code == 200
    # Whoever enters trips sees the trip-wise list of their own sites.
    assert (await api(book.writer).get("/vehicle-pl/reports/trips")).status_code == 200
    assert (await api(book.outsider).get("/vehicle-pl/reports/trips")).status_code == 403
    assert (await api(book.outsider).get("/vehicle-pl/masters")).status_code == 403


async def test_another_tenant_sees_nothing_and_can_name_nothing(  # type: ignore[no-untyped-def]
    api, book: Book, make_tenant: Callable[..., Tenant], make_person: Callable[..., Person]
) -> None:
    other = make_tenant("plother")
    them = make_person(other, "Other Writer", [READ, WRITE, REPORT])
    client = api(them)
    t1 = trip_id(book, "t1")
    assert (await client.get(f"/vehicle-pl/trips/{t1}")).status_code == 404
    assert (
        await client.put(f"/vehicle-pl/trips/{t1}", json=wire(TRIPS["t1"], book, site=other.site_id))
    ).status_code == 404
    assert (await client.delete(f"/vehicle-pl/trips/{t1}")).status_code == 404
    assert (await client.get("/vehicle-pl/trips")).json() == []
    assert (await client.get("/vehicle-pl/reports/vendors")).json()["rows"] == []
    masters = (await client.get("/vehicle-pl/masters")).json()
    assert masters == {"customers": [], "vendors": [], "materials": []}
    # Naming the first tenant's vendor, material or bill from the second is naming nothing.
    body = wire(TRIPS["t3a"], book, site=other.site_id)
    r = await client.post("/vehicle-pl/trips", json=body)
    assert r.status_code == 422 and r.json()["detail"]["problem"]["field"] == "purchases[0].vendorId"
    body["purchases"], body["sales"], body["payments"] = [], [], []
    r = await client.post("/vehicle-pl/trips", json=body)
    assert r.status_code == 422 and r.json()["detail"]["problem"]["field"] == "diesel[0].expenseBillId"
    assert (
        await client.patch(f"/vehicle-pl/materials/{book.materials['MSAND']}", json={"gstRatePct": 28})
    ).status_code == 404


async def test_a_vehicles_diesel_bills_say_which_trips_already_share_them(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    bills = (await api(book.writer).get("/vehicle-pl/diesel-bills", params={"vehicleId": "veh-003"})).json()
    bill = next(b for b in bills if b["id"] == book.bills["bill-881"])
    assert (bill["billNumber"], bill["litres"], bill["amount"], bill["status"]) == (
        "HP-881",
        30,
        "2833.21",
        "submitted",
    )
    assert {t["tripId"] for t in bill["linkedTrips"]} == {trip_id(book, i) for i in ("t3a", "t3b", "t3c")}
    # A rejected bill is not offered; another vehicle's never is.
    others = (await api(book.writer).get("/vehicle-pl/diesel-bills", params={"vehicleId": "veh-002"})).json()
    assert book.bills["bill-990"] not in {b["id"] for b in others}
    assert book.bills["bill-881"] not in {b["id"] for b in others}
    assert (
        await api(book.outsider).get("/vehicle-pl/diesel-bills", params={"vehicleId": "veh-003"})
    ).status_code == 403


async def test_a_correction_to_a_linked_bill_shows_on_the_trip(  # type: ignore[no-untyped-def]
    api, book: Book, admin: psycopg.Connection
) -> None:
    """Values recalculate when inputs change: the trip reads the bill, it never copied it."""
    bill = plant_bill(admin, book.tenant, book.writer.user_id, "HP-RECALC", "veh-recalc", "10", "1000.00")
    body = wire(TRIPS["t4"], book) | {
        "vehicleId": "veh-recalc",
        "date": "2026-07-05",
        "diesel": [{"source": "expense_bill", "expenseBillId": bill}],
    }
    trip = (await api(book.writer).post("/vehicle-pl/trips", json=body)).json()
    assert (trip["pl"]["diesel"], trip["pl"]["net"]) == ("1000.00", "-1400.00")
    with admin.cursor() as cur:
        cur.execute("UPDATE finance.expense_bills SET amount = 1200.00, litres = 12 WHERE id = %s", (bill,))
    after = (await api(book.reader).get(f"/vehicle-pl/trips/{trip['id']}")).json()
    assert (after["pl"]["diesel"], after["pl"]["dieselLitres"], after["pl"]["net"]) == (
        "1200.00",
        12,
        "-1600.00",
    )

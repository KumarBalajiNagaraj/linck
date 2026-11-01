"""The vehicle P&L through the API: the golden figures on the server, the shapes, scope and tenancy.

The trip sheets in packages/domain/src/vehicle-pl.fixtures.json are entered
through POST /vehicle-pl/sheets exactly as the trip sheet page would, and what
comes back — each line's figures, each trip's share of its sheet's costs, each
P&L and status, the trip-wise, vehicle-wise and monthly reports and both
money-due lists — must be the figures worked by hand there. So the TypeScript,
the Python rules and the API path all answer to one file.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from decimal import Decimal
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
SHEETS = {s["id"]: s for s in FIXTURES["sheets"]}
IST = ZoneInfo("Asia/Kolkata")
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00 a photo of a quarry bill"

READ = "fleet.trip_pl.read"
WRITE = "fleet.trip_pl.write"
REPORT = "finance.pl_report.read"
CLOSE = "finance.receipt.verify"

QUARRY_GSTIN = "33AABCP1234Q1ZE"
CRUSHER_GSTIN = "33AAGCS5678R1ZG"
BUILDER_GSTIN = "33AABCU9603R1ZU"

SHEET_KEYS = {
    "id",
    "sheetNumber",
    "siteId",
    "vehicleId",
    "registrationNumber",
    "vehicleModel",
    "driverId",
    "driverName",
    "driverPhone",
    "startDate",
    "endDate",
    "startKm",
    "endKm",
    "tripNumbers",
    "customers",
    "vendors",
    "materials",
    "basis",
    "pl",
    "createdBy",
    "createdAt",
    "updatedAt",
    "batta",
    "notes",
    "diesel",
    "enRoute",
    "payments",
    "own",
    "dues",
    "unsettled",
    "trips",
}
TRIP_KEYS = {
    "id",
    "tripNumber",
    "date",
    "startKm",
    "endKm",
    "batta",
    "notes",
    "diesel",
    "enRoute",
    "purchases",
    "sales",
    "payments",
    "pl",
    "own",
    "share",
    "dues",
    "customers",
    "vendors",
    "materials",
}
PL_KEYS = set(FIXTURES["cases"][0]["expect"]["pl"])


def today() -> date:
    return datetime.now(tz=IST).date()


def num(value: Any) -> int | float | None:
    """A fixture quantity as the JSON number the page sends."""
    if value is None:
        return None
    d = Decimal(str(value))
    return int(d) if d == d.to_integral_value() else float(d)


@dataclass
class Book:
    """One tenant's masters, named by the fixtures' ids, and the people who use them."""

    tenant: Tenant
    plant: uuid.UUID
    elsewhere: uuid.UUID
    writer: Person
    reader: Person
    director: Person
    accounts: Person
    far_writer: Person
    outsider: Person
    parties: dict[str, str] = field(default_factory=dict)
    materials: dict[str, str] = field(default_factory=dict)
    bills: dict[str, str] = field(default_factory=dict)
    sheets: dict[str, dict[str, Any]] = field(default_factory=dict)

    def key_of(self, party_id: str) -> str:
        return {v: k for k, v in self.parties.items()}[party_id]


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


def _diesel(d: dict[str, Any], book: Book) -> dict[str, Any]:
    if d["source"] == "typed":
        return {
            "source": "typed",
            "litres": num(d["litres"]),
            "rate": d["rate"],
            "billNumber": d.get("billNumber") or "",
        }
    if d["source"] == "expense_bill":
        return {"source": "expense_bill", "expenseBillId": book.bills[d["expenseBillId"]]}
    return {
        "source": "fuel_entry",
        "fuelEntryId": d["fuelEntryId"],
        "litres": num(d["litres"]),
        "amount": d["amount"],
        "billNumber": d.get("billNumber") or "",
        "vendor": "Own bunk",
    }


def _en_route(e: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": e["kind"], "amount": e["amount"], "location": "Sriperumbudur"}
    if e["kind"] == "maintenance":
        out["maintenanceKind"] = "greasing"
    if e["kind"] == "toll":
        out["reference"] = f"TXN-{e['id']}"
    return out


def _payments(lines: list[dict[str, Any]], book: Book, day: str) -> list[dict[str, Any]]:
    return [
        {
            "direction": m["direction"],
            "partyId": book.parties[m["partyId"]],
            "paidOn": day,
            "mode": "UPI",
            "amount": m["amount"],
        }
        for m in lines
    ]


def ordered(sheet: dict[str, Any]) -> list[dict[str, Any]]:
    """A sheet's trips in the rules' order, so the numbers the API gives keep it."""
    return sorted(sheet["trips"], key=lambda t: (t["date"], t.get("tripNumber") or ""))


def wire(sheet: dict[str, Any], book: Book, *, site: uuid.UUID | None = None) -> dict[str, Any]:
    """A fixture sheet as the trip sheet page sends it."""
    p = book.parties
    return {
        "siteId": str(site or book.plant),
        "vehicleId": sheet["vehicleId"],
        "registrationNumber": f"TN 29 AB 00{sheet['vehicleId'][-1]}",
        "vehicleModel": "Tata Signa 3525.TK",
        "driverId": "drv-01",
        "driverName": "Murugan S",
        "driverPhone": "9840012345",
        "startDate": sheet["startDate"],
        "endDate": sheet.get("endDate"),
        "startKm": num(sheet.get("startKm")),
        "endKm": num(sheet.get("endKm")),
        "batta": sheet.get("batta"),
        "diesel": [_diesel(d, book) for d in sheet.get("diesel", [])],
        "enRoute": [_en_route(e) for e in sheet.get("enRoute", [])],
        "payments": _payments(sheet.get("payments", []), book, sheet["startDate"]),
        "trips": [
            {
                "date": t["date"],
                "startKm": num(t.get("startKm")),
                "endKm": num(t.get("endKm")),
                "batta": t.get("batta"),
                "diesel": [_diesel(d, book) for d in t.get("diesel", [])],
                "enRoute": [_en_route(e) for e in t.get("enRoute", [])],
                "purchases": [
                    {
                        "vendorId": p[x["vendorId"]],
                        "location": "Pallur yard",
                        "materialId": book.materials["MSAND"],
                        "quantity": num(x["quantity"]),
                        "rate": x["rate"],
                        "gstBilled": x["gstBilled"],
                        "gstRatePct": num(x["gstRatePct"]),
                        "invoiceNumber": f"INV-{x['id']}",
                    }
                    for x in t["purchases"]
                ],
                "sales": [
                    {
                        "customerId": p[x["customerId"]],
                        "location": "Oragadam site",
                        "poRef": f"PO-{x['id']}",
                        "materialId": book.materials["MSAND"],
                        "quantity": num(x["quantity"]),
                        "rate": x["rate"],
                        "transport": x.get("transport"),
                        "gstBilled": x["gstBilled"],
                        "gstRatePct": num(x["gstRatePct"]),
                        "challanNumber": f"DC-{x['id']}",
                    }
                    for x in t["sales"]
                ],
                "payments": _payments(t.get("payments", []), book, t["date"]),
            }
            for t in ordered(sheet)
        ],
    }


async def _enter(client, book: Book, admin: psycopg.Connection) -> None:  # type: ignore[no-untyped-def]
    for code, name in (("MSAND", "M-Sand"), ("AGG20", "20mm Aggregate")):
        r = await client.post(
            "/vehicle-pl/materials",
            json={"code": code, "name": name, "hsnCode": "2517", "gstRatePct": 5, "unit": "unit"},
        )
        assert r.status_code == 201, r.text
        book.materials[code] = r.json()["id"]
    for rate in (5, 12, 18):
        assert (await client.post("/vehicle-pl/gst-rates", json={"ratePct": rate})).status_code == 201
    for key, name, gstin, locations in (
        ("ven-qry", "Pallur Blue Metal Quarry", QUARRY_GSTIN, ["Pallur yard"]),
        ("ven-crs", "Sri Balaji Crusher", CRUSHER_GSTIN, []),
    ):
        r = await client.post(
            "/vehicle-pl/parties",
            json={"role": "vendor", "name": name, "gstin": gstin, "locations": locations},
        )
        assert r.status_code == 201, r.text
        book.parties[key] = r.json()["id"]
    for i in (1, 2, 3):
        r = await client.post(
            "/vehicle-pl/parties",
            json={
                "role": "customer",
                "name": f"Builder {i}",
                "siteId": str(book.plant),
                "locations": ["Oragadam site"],
            },
        )
        assert r.status_code == 201, r.text
        book.parties[f"cus-0{i}"] = r.json()["id"]
    for sheet_id in FIXTURES["reports"]["sheets"]:
        r = await client.post("/vehicle-pl/sheets", json=wire(SHEETS[sheet_id], book))
        assert r.status_code == 201, r.text
        book.sheets[sheet_id] = r.json()


@pytest.fixture(scope="module")
def book(
    admin: psycopg.Connection,
    make_tenant: Callable[..., Tenant],
    make_site: Callable[..., uuid.UUID],
    make_person: Callable[..., Person],
) -> Book:
    """Every golden sheet entered through the API, in a tenant of its own.

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
        accounts=make_person(tenant, "Kavitha R", [REPORT, CLOSE]),
        far_writer=make_person(tenant, "Far Writer", [READ, WRITE], sites=[elsewhere]),
        outsider=make_person(tenant, "Outsider", ["fleet.board.read"]),
    )
    book.bills["bill-881"] = plant_bill(admin, tenant, writer.user_id, "IOC-881", "veh-2", "30", "2833.21")
    book.bills["bill-990"] = plant_bill(admin, tenant, writer.user_id, "IOC-990", "veh-3", "52", "5000.00")

    async def enter() -> None:
        import httpx

        from app.core import db as core_db
        from app.main import app

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://api", headers=writer.headers
        ) as client:
            await _enter(client, book, admin)
        # Accounts confirm the first trip of s2 was paid in full.
        s2 = book.sheets["s2"]
        async with httpx.AsyncClient(
            transport=transport, base_url="http://api", headers=book.accounts.headers
        ) as client:
            r = await client.post(
                f"/vehicle-pl/sheets/{s2['id']}/trips/{s2['trips'][0]['id']}/close",
                json={"partyId": book.parties["cus-01"]},
            )
            assert r.status_code == 200, r.text
        await core_db.engine.dispose()

    asyncio.run(enter())
    # Rejected after it was linked: it stays on the sheet and counts nothing.
    with admin.cursor() as cur:
        cur.execute(
            "UPDATE finance.expense_bills SET status = 'rejected' WHERE id = %s", (book.bills["bill-990"],)
        )
    return book


def sheet_id(book: Book, fixture_id: str) -> str:
    return book.sheets[fixture_id]["id"]


def _dues(rows: list[dict[str, Any]], book: Book) -> list[dict[str, Any]]:
    """Dues with the fixtures' party names, in the rules' order (customers first, then by party)."""
    named = [
        {
            **{k: d[k] for k in ("role", "billed", "settled", "due", "status")},
            "partyId": book.key_of(d["partyId"]),
        }
        for d in rows
    ]
    return sorted(named, key=lambda d: (d["role"] != "customer", d["partyId"]))


def _figures(
    lines: list[dict[str, Any]], expected: dict[str, dict[str, Any]], fixture_lines: list[dict[str, Any]]
):  # type: ignore[no-untyped-def]
    return [
        {k: line[k] for k in expected[fx["id"]]} for line, fx in zip(lines, fixture_lines, strict=True)
    ], [expected[fx["id"]] for fx in fixture_lines]


# ------------------------------------------------------- the golden figures


@pytest.mark.parametrize("case", FIXTURES["cases"], ids=lambda c: c["name"])
async def test_the_api_gives_the_golden_figures(api, book: Book, case: dict) -> None:  # type: ignore[no-untyped-def, type-arg]
    r = await api(book.reader).get(f"/vehicle-pl/sheets/{sheet_id(book, case['sheet'])}")
    assert r.status_code == 200, r.text
    sheet, expected, fixture = r.json(), case["expect"], SHEETS[case["sheet"]]
    assert (sheet["pl"], sheet["own"], sheet["basis"]) == (expected["pl"], expected["own"], expected["basis"])
    got, want = _figures(sheet["diesel"], expected["diesel"], fixture.get("diesel", []))
    assert got == want
    assert _dues(sheet["dues"], book) == expected["dues"]
    assert _dues(sheet["unsettled"], book) == expected["unsettled"]
    assert len(sheet["trips"]) == len(expected["trips"])
    for trip, fx in zip(sheet["trips"], ordered(fixture), strict=True):
        calc = expected["trips"][fx["id"]]
        assert (trip["pl"], trip["own"], trip["share"]) == (calc["pl"], calc["own"], calc["share"]), fx["id"]
        for section in ("purchases", "sales", "diesel"):
            got, want = _figures(trip[section], calc[section], fx.get(section, []))
            assert got == want, (fx["id"], section)
        assert _dues(trip["dues"], book) == calc["dues"], fx["id"]


async def test_the_reports_add_up_to_the_golden_totals(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.director)
    expected = FIXTURES["reports"]["expect"]
    trips = (await client.get("/vehicle-pl/reports/trips")).json()
    assert trips["total"] == expected["total"]
    # Eleven trips; the sheet with none yet, whose costs are a loss of their own; and
    # the ₹1,000 paid on s2 that no trip's bill took.
    assert sorted(r["kind"] for r in trips["rows"]) == ["payment", "sheet"] + ["trip"] * 11
    paid_extra = next(r for r in trips["rows"] if r["kind"] == "payment")
    assert (paid_extra["pl"]["net"], paid_extra["pl"]["received"]) == ("0.00", "1000.00")

    vehicles = (await client.get("/vehicle-pl/reports/vehicles")).json()
    assert [
        {k: v for k, v in r.items() if k not in ("registrationNumber", "vehicleModel")}
        for r in vehicles["rows"]
    ] == expected["byVehicle"]
    assert vehicles["total"] == expected["total"]
    assert vehicles["rows"][0]["registrationNumber"] == "TN 29 AB 002"

    months = (await client.get("/vehicle-pl/reports/months")).json()
    assert months["rows"] == expected["byMonth"]

    for path, key in (("customers", "customers"), ("vendors", "vendors")):
        report = (await client.get(f"/vehicle-pl/reports/{path}")).json()
        rows = [
            {
                k: r[k]
                for k in ("role", "trips", "billed", "settled", "due", "status", "firstDate", "lastDate")
            }
            | {"partyId": book.key_of(r["partyId"])}
            for r in report["rows"]
        ]
        assert rows == expected[key]
        assert report["total"]["due"] == (
            expected["total"]["customerDue"] if key == "customers" else expected["total"]["vendorDue"]
        )


async def test_a_trip_takes_its_part_of_what_was_written_on_its_sheet(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    """s2's linked bill and fuel entry, batta and greasing, shared by trip km 40 : 35 : 25."""
    sheet = (await api(book.reader).get(f"/vehicle-pl/sheets/{sheet_id(book, 's2')}")).json()
    assert sheet["basis"] == "km"
    assert [t["share"]["diesel"] for t in sheet["trips"]] == ["1533.28", "1341.62", "958.30"]
    assert [t["pl"]["net"] for t in sheet["trips"]] == ["2946.72", "4203.38", "3716.70"]
    line = sheet["diesel"][0]
    assert (line["source"], line["billNumber"], line["litres"], line["billStatus"]) == (
        "expense_bill",
        "IOC-881",
        30,
        "submitted",
    )
    # The sheet's ₹20,000 from Builder 1 settled the first trip, then part of the third.
    first = sheet["trips"][0]["dues"][0]
    assert (first["status"], first["closedBy"]) == ("closed", "Kavitha R")
    rejected = (await api(book.reader).get(f"/vehicle-pl/sheets/{sheet_id(book, 's5')}")).json()["diesel"][0]
    assert (rejected["billStatus"], rejected["counted"], rejected["amount"]) == ("rejected", False, "0.00")


# ------------------------------------------------------------------ shapes


async def test_a_sheet_and_its_trips_come_back_in_the_wire_shape(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = (await api(book.reader).get(f"/vehicle-pl/sheets/{sheet_id(book, 's1')}")).json()
    assert set(sheet) == SHEET_KEYS
    assert set(sheet["pl"]) == PL_KEYS
    trip = sheet["trips"][0]
    assert set(trip) == TRIP_KEYS
    assert sheet["sheetNumber"].startswith("TS/26-27/") and trip["tripNumber"].startswith("TRP/26-27/")
    assert sheet["tripNumbers"] == [trip["tripNumber"]]
    assert (sheet["startDate"], sheet["startKm"], sheet["endKm"], sheet["batta"]) == (
        "2026-08-03",
        218400,
        218486,
        "500.00",
    )
    assert [e["kind"] for e in sheet["enRoute"]] == ["toll", "police"]
    assert sheet["enRoute"][0]["reference"] == "TXN-s1-e1"
    p, s = trip["purchases"][0], trip["sales"][0]
    assert (p["rate"], p["quantity"], p["hsnCode"], p["unit"], p["location"]) == (
        "2400.00",
        4.5,
        "2517",
        "unit",
        "Pallur yard",
    )
    assert (p["vendorGstin"], p["materialName"]) == (QUARRY_GSTIN, "M-Sand")
    assert (s["transport"], s["taxable"], s["total"], s["challanNumber"], s["poRef"]) == (
        "1500.00",
        "18600.00",
        "19530.00",
        "DC-t1-s1",
        "PO-t1-s1",
    )
    assert trip["payments"][0]["mode"] == "UPI" and trip["payments"][0]["paidOn"] == "2026-08-03"
    assert trip["customers"] == ["Builder 1"] and trip["vendors"] == ["Pallur Blue Metal Quarry"]
    assert sheet["createdBy"] == "Anbu Selvan M"


async def test_the_sheet_list_finds_by_number_vehicle_people_and_papers(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.director)
    every = (await client.get("/vehicle-pl/sheets")).json()
    assert [s["startDate"] for s in every["rows"]] == sorted(
        (s["startDate"] for s in every["rows"]), reverse=True
    )
    assert every["total"]["trips"] >= 11

    async def ids(**params: str) -> set[str]:
        r = await client.get("/vehicle-pl/sheets", params=params)
        assert r.status_code == 200, r.text
        return {s["id"] for s in r.json()["rows"]}

    s1, s2, s3, s5 = (sheet_id(book, k) for k in ("s1", "s2", "s3", "s5"))
    assert await ids(q=book.sheets["s1"]["sheetNumber"]) == {s1}
    assert await ids(q=book.sheets["s3"]["trips"][1]["tripNumber"]) == {s3}
    assert await ids(q="tn29ab001") >= {s1, s3}
    assert await ids(q="INV-t2b-p1") == {s2}
    assert await ids(q="DC-t5b") == {s5}
    assert await ids(q="builder 3") == {s3}
    assert await ids(vehicleId="veh-2") >= {s2}
    assert await ids(customerId=book.parties["cus-03"]) == {s3}
    assert await ids(vendorId=book.parties["ven-crs"]) == {s2, s3, s5}
    assert await ids(**{"from": "2026-07-01", "to": "2026-07-31"}) == {s5}
    assert await ids(q="100%") == set()


async def test_the_trip_report_keeps_the_trips_that_match(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.director)
    report = (await client.get("/vehicle-pl/reports/trips", params={"q": "Builder 3"})).json()
    assert len(report["rows"]) == 2 and all(r["customers"] == ["Builder 3"] for r in report["rows"])
    july = (
        await client.get("/vehicle-pl/reports/trips", params={"from": "2026-07-01", "to": "2026-07-31"})
    ).json()
    assert [r["date"] for r in july["rows"]] == ["2026-07-31"] and july["total"]["net"] == "-2020.00"


async def test_masters_list_what_a_line_can_name(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    masters = (await api(book.reader).get("/vehicle-pl/masters")).json()
    assert {m["code"]: (m["hsnCode"], m["gstRatePct"], m["unit"]) for m in masters["materials"]} == {
        "MSAND": ("2517", 5, "unit"),
        "AGG20": ("2517", 5, "unit"),
    }
    assert [(r["ratePct"], r["active"]) for r in masters["gstRates"]][:3] == [
        (5, True),
        (12, True),
        (18, True),
    ]
    quarry = next(v for v in masters["vendors"] if v["name"] == "Pallur Blue Metal Quarry")
    assert quarry["gstin"] == QUARRY_GSTIN and [x["name"] for x in quarry["locations"]] == ["Pallur yard"]
    assert {c["name"] for c in masters["customers"]} >= {"Builder 1", "Builder 2", "Builder 3"}


# ----------------------------------------------------------- add, edit, delete


@pytest.fixture
async def fresh(api, book: Book):  # type: ignore[no-untyped-def]
    """A sheet of its own for a test to change, on a vehicle no golden sheet uses."""
    day = (today() - timedelta(days=3)).isoformat()
    body = wire(SHEETS["s1"], book) | {
        "vehicleId": f"veh-{uuid.uuid4().hex[:6]}",
        "startDate": day,
        "endDate": day,
    }
    body["trips"][0]["date"] = day
    for m in body["trips"][0]["payments"]:
        m["paidOn"] = day
    r = await api(book.writer).post("/vehicle-pl/sheets", json=body)
    assert r.status_code == 201, r.text
    return r.json(), body


async def test_an_edit_keeps_ids_and_works_the_figures_again(api, book: Book, fresh) -> None:  # type: ignore[no-untyped-def]
    sheet, body = fresh
    trip = sheet["trips"][0]
    day = body["startDate"]
    edited = body | {
        "diesel": [{**body["diesel"][0], "id": sheet["diesel"][0]["id"], "rate": "90.00"}],
        # The police line goes; the toll line is corrected.
        "enRoute": [{**body["enRoute"][0], "id": sheet["enRoute"][0]["id"], "amount": "300.00"}],
        "trips": [
            {
                **body["trips"][0],
                "id": trip["id"],
                "purchases": [{**body["trips"][0]["purchases"][0], "id": trip["purchases"][0]["id"]}],
                "sales": [{**body["trips"][0]["sales"][0], "id": trip["sales"][0]["id"]}],
                "payments": [{**body["trips"][0]["payments"][0], "id": trip["payments"][0]["id"]}],
            },
            # A second load: the sheet's costs are now shared evenly by the two.
            {
                "date": day,
                "purchases": [],
                "sales": [{**body["trips"][0]["sales"][0], "quantity": 2, "transport": None}],
            },
        ],
    }
    r = await api(book.writer).put(f"/vehicle-pl/sheets/{sheet['id']}", json=edited)
    assert r.status_code == 200, r.text
    after = r.json()
    assert after["diesel"][0]["id"] == sheet["diesel"][0]["id"] and after["diesel"][0]["amount"] == "2700.00"
    assert [e["amount"] for e in after["enRoute"]] == ["300.00"]
    assert after["trips"][0]["id"] == trip["id"] and after["trips"][0]["tripNumber"] == trip["tripNumber"]
    assert after["trips"][1]["tripNumber"] > trip["tripNumber"]
    assert after["basis"] == "even"
    # Sales 18600.00 + 7600.00; material 10800.00; diesel 2700.00, batta 500.00, toll 300.00.
    assert after["pl"]["net"] == "11900.00"
    assert [t["share"]["diesel"] for t in after["trips"]] == ["1350.00", "1350.00"]
    assert after["sheetNumber"] == sheet["sheetNumber"]


async def test_a_line_of_another_sheet_cannot_be_edited_through_this_one(api, book: Book, fresh) -> None:  # type: ignore[no-untyped-def]
    sheet, body = fresh
    other = book.sheets["s3"]
    r = await api(book.writer).put(
        f"/vehicle-pl/sheets/{sheet['id']}",
        json=body | {"diesel": [{**body["diesel"][0], "id": other["diesel"][0]["id"]}]},
    )
    assert r.status_code == 422
    assert r.json()["detail"]["problem"] == {
        "code": "invalid",
        "field": "diesel[0].id",
        "reason": "not a line of this sheet",
    }
    r = await api(book.writer).put(
        f"/vehicle-pl/sheets/{sheet['id']}",
        json=body | {"trips": [{**body["trips"][0], "id": other["trips"][0]["id"]}]},
    )
    assert r.status_code == 422 and r.json()["detail"]["problem"]["field"] == "trips[0].id"


async def test_a_trip_taken_off_goes_with_its_lines_and_delete_takes_the_sheet(
    api, book: Book, fresh, admin: psycopg.Connection
) -> None:  # type: ignore[no-untyped-def]
    sheet, body = fresh
    client = api(book.writer)
    r = await client.put(f"/vehicle-pl/sheets/{sheet['id']}", json=body | {"trips": []})
    assert r.status_code == 200, r.text
    assert r.json()["trips"] == [] and r.json()["pl"]["net"] == "-3800.00"
    with admin.cursor() as cur:
        cur.execute("SELECT count(*) FROM logistics.trips WHERE id = %s", (sheet["trips"][0]["id"],))
        assert cur.fetchone()[0] == 0
    assert (await api(book.reader).delete(f"/vehicle-pl/sheets/{sheet['id']}")).status_code == 403
    assert (await client.delete(f"/vehicle-pl/sheets/{sheet['id']}")).status_code == 204
    assert (await client.get(f"/vehicle-pl/sheets/{sheet['id']}")).status_code == 404
    with admin.cursor() as cur:
        for table in ("logistics.diesel_lines", "logistics.enroute_expenses", "finance.trip_payments"):
            cur.execute(f"SELECT count(*) FROM {table} WHERE trip_sheet_id = %s", (sheet["id"],))
            assert cur.fetchone()[0] == 0, table


async def test_a_new_sheets_lines_carry_no_ids(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    body = wire(SHEETS["s4"], book)
    body["enRoute"][0]["id"] = str(uuid.uuid4())
    assert (await api(book.writer).post("/vehicle-pl/sheets", json=body)).status_code == 422


# ------------------------------------------------------- the rules, enforced


async def test_a_sheet_is_checked_like_the_page_checks_it(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    day = (today() - timedelta(days=2)).isoformat()
    base = wire(SHEETS["s1"], book) | {"vehicleId": "veh-checks", "startDate": day, "endDate": day}
    base["trips"][0]["date"] = day

    async def problem(body: dict) -> dict:  # type: ignore[type-arg]
        r = await client.post("/vehicle-pl/sheets", json=body)
        assert r.status_code in (409, 422), r.text
        return r.json()["detail"]["problem"]

    def trip_with(**changes: Any) -> dict[str, Any]:
        return base | {"trips": [base["trips"][0] | changes]}

    purchase, sale = base["trips"][0]["purchases"][0], base["trips"][0]["sales"][0]
    later = (today() + timedelta(days=1)).isoformat()
    assert (await problem(base | {"startDate": later, "endDate": None}))["field"] == "startDate"
    assert (await problem(trip_with(date=(today() - timedelta(days=9)).isoformat())))[
        "field"
    ] == "trips[0].date"
    assert (await problem(base | {"startKm": 500, "endKm": 400}))["field"] == "endKm"
    bad_vendor = (
        await client.post("/vehicle-pl/parties", json={"role": "vendor", "name": "No GSTIN Depot"})
    ).json()
    assert await problem(trip_with(purchases=[purchase | {"vendorId": bad_vendor["id"]}])) == {
        "code": "invalid",
        "field": "trips[0].purchases[0].vendorGstin",
        "reason": "required on a GST bill",
    }
    assert (await problem(trip_with(purchases=[purchase | {"gstRatePct": 7}])))[
        "reason"
    ] == "not one of your GST rates"
    assert (await problem(trip_with(sales=[sale | {"customerId": book.parties["ven-qry"]}])))[
        "reason"
    ] == "not a customer"
    assert (await problem(base | {"enRoute": [{"kind": "maintenance", "amount": "100"}]}))[
        "field"
    ] == "enRoute[0].maintenanceKind"
    misc = {"kind": "maintenance", "maintenanceKind": "misc", "amount": "100"}
    assert (await problem(base | {"enRoute": [misc]}))["field"] == "enRoute[0].description"
    stranger = {
        "direction": "in",
        "partyId": book.parties["cus-02"],
        "paidOn": day,
        "mode": "UPI",
        "amount": "10",
    }
    assert (await problem(trip_with(payments=[stranger])))["reason"] == "not a customer of this trip"
    twice = {
        "direction": "in",
        "partyId": book.parties["cus-01"],
        "paidOn": day,
        "mode": "NEFT",
        "amount": "10",
        "reference": "UTR123456",
    }
    assert (await problem(base | {"payments": [twice, twice]}))["code"] == "reference-used"
    # Fixed, it goes in: a typed misc, said what it was.
    r = await client.post(
        "/vehicle-pl/sheets", json=base | {"enRoute": [misc | {"description": "Horn repair"}]}
    )
    assert r.status_code == 201, r.text
    assert r.json()["enRoute"][0]["description"] == "Horn repair"


async def test_a_fill_is_never_counted_twice(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    day = (today() - timedelta(days=1)).isoformat()
    base = wire(SHEETS["s4"], book) | {"vehicleId": "veh-2", "startDate": day, "diesel": []}

    async def problem(diesel: list[dict[str, Any]], **changes: Any) -> dict[str, Any]:
        r = await client.post("/vehicle-pl/sheets", json=base | {"diesel": diesel} | changes)
        assert r.status_code == 409, r.text
        return r.json()["detail"]["problem"]

    linked = {"source": "expense_bill", "expenseBillId": book.bills["bill-881"]}
    elsewhere = await problem([linked])
    assert (elsewhere["code"], elsewhere["sheetNumber"]) == (
        "diesel-linked-elsewhere",
        book.sheets["s2"]["sheetNumber"],
    )
    typed = {"source": "typed", "litres": 10, "rate": "94.00", "billNumber": "ioc 881"}
    exists = await problem([typed])
    assert (exists["code"], exists["billId"]) == ("diesel-bill-exists", book.bills["bill-881"])
    again = {"source": "typed", "litres": 10, "rate": "94.00", "billNumber": "BK-4471"}
    on_sheet = await problem([again], vehicleId="veh-1")
    assert (on_sheet["code"], on_sheet["sheetNumber"]) == (
        "diesel-bill-on-sheet",
        book.sheets["s1"]["sheetNumber"],
    )
    other = await problem([linked], vehicleId="veh-9")
    assert other["code"] == "diesel-other-vehicle"
    void = await problem(
        [{"source": "expense_bill", "expenseBillId": book.bills["bill-990"]}], vehicleId="veh-3"
    )
    assert (void["code"], void["status"]) == ("diesel-bill-void", "rejected")
    fuel = {"source": "fuel_entry", "fuelEntryId": "fuel-017", "litres": 10.5, "amount": "999.99"}
    assert (await problem([fuel]))["code"] == "diesel-linked-elsewhere"
    two = {"source": "fuel_entry", "fuelEntryId": "fuel-900", "litres": 10, "amount": "940.00"}
    twice = await problem([two, two])
    assert (twice["code"], twice["field"]) == ("diesel-linked-twice", "diesel[1]")


async def test_a_bill_linked_on_a_trip_is_refused_on_the_sheet_too(
    api, book: Book, admin: psycopg.Connection
) -> None:  # type: ignore[no-untyped-def]
    bill = plant_bill(admin, book.tenant, book.writer.user_id, "IOC-4040", "veh-4", "20", "1880.00")
    day = (today() - timedelta(days=1)).isoformat()
    body = wire(SHEETS["s6"], book) | {"vehicleId": "veh-4", "startDate": day, "endDate": day, "diesel": []}
    for t in body["trips"]:
        t["date"] = day
    linked = {"source": "expense_bill", "expenseBillId": bill}
    body["trips"][0]["diesel"] = [linked]
    r = await api(book.writer).post("/vehicle-pl/sheets", json=body | {"diesel": [linked]})
    assert r.status_code == 409 and r.json()["detail"]["problem"]["code"] == "diesel-linked-twice"
    r = await api(book.writer).post("/vehicle-pl/sheets", json=body)
    assert r.status_code == 201, r.text
    assert r.json()["trips"][0]["diesel"][0]["amount"] == "1880.00"


async def test_a_customer_or_vendor_already_in_the_master_takes_the_role(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    r = await client.post(
        "/vehicle-pl/parties",
        json={
            "role": "customer",
            "name": "Pallur (buying)",
            "gstin": QUARRY_GSTIN,
            "siteId": str(book.plant),
        },
    )
    assert r.status_code == 201, r.text
    assert r.json()["id"] == book.parties["ven-qry"] and set(r.json()["roles"]) == {"vendor", "customer"}
    r = await client.post(
        f"/vehicle-pl/parties/{book.parties['ven-qry']}/locations", json={"name": "Padappai yard"}
    )
    assert [x["name"] for x in r.json()["locations"]] == ["Padappai yard", "Pallur yard"]
    builder = book.parties["cus-02"]
    assert (await client.patch(f"/vehicle-pl/parties/{builder}", json={"gstin": BUILDER_GSTIN})).json()[
        "gstin"
    ] == BUILDER_GSTIN
    r = await client.patch(f"/vehicle-pl/parties/{builder}", json={"gstin": "33AACCB4321K1Z1"})
    assert r.status_code == 409 and r.json()["detail"]["problem"]["code"] == "gstin-set"
    assert (
        await client.post("/vehicle-pl/parties", json={"role": "customer", "name": "No site"})
    ).status_code == 422


async def test_a_material_is_named_once_and_a_retired_one_is_not_offered(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    r = await client.post("/vehicle-pl/materials", json={"name": "m-sand", "gstRatePct": 5, "unit": "unit"})
    assert r.status_code == 409 and r.json()["detail"]["problem"]["code"] == "name-used"
    r = await client.post(
        "/vehicle-pl/materials", json={"code": "MSAND", "name": "Another", "gstRatePct": 5, "unit": "unit"}
    )
    assert r.status_code == 409 and r.json()["detail"]["problem"]["code"] == "code-used"
    r = await client.post("/vehicle-pl/materials", json={"name": "Boulder", "gstRatePct": 5, "unit": "load"})
    assert r.status_code == 201 and r.json()["hsnCode"] is None and r.json()["code"] is None
    boulder = r.json()["id"]
    assert (await client.patch(f"/vehicle-pl/materials/{boulder}", json={"active": False})).json()[
        "active"
    ] is False
    day = (today() - timedelta(days=1)).isoformat()
    body = wire(SHEETS["s1"], book) | {"vehicleId": "veh-retired", "startDate": day, "endDate": day}
    body["trips"][0] |= {"date": day, "payments": []}
    body["trips"][0]["purchases"][0]["materialId"] = boulder
    r = await client.post("/vehicle-pl/sheets", json=body)
    assert r.status_code == 422 and r.json()["detail"]["problem"]["reason"] == "no longer in use"


async def test_gst_rates_are_the_tenants_own_list(api, book: Book, fresh) -> None:  # type: ignore[no-untyped-def]
    client = api(book.writer)
    sheet, body = fresh
    rate = (await client.post("/vehicle-pl/gst-rates", json={"ratePct": 28})).json()
    assert (rate["ratePct"], rate["active"]) == (28, True)
    trip = sheet["trips"][0]
    at_28 = body | {
        "trips": [
            body["trips"][0]
            | {
                "id": trip["id"],
                "purchases": [
                    body["trips"][0]["purchases"][0] | {"id": trip["purchases"][0]["id"], "gstRatePct": 28}
                ],
                "sales": [],
                "payments": [],
            }
        ]
    }
    r = await client.put(f"/vehicle-pl/sheets/{sheet['id']}", json=at_28)
    assert r.status_code == 200, r.text
    assert r.json()["trips"][0]["purchases"][0]["gstAmount"] == "3024.00"
    assert (await client.patch(f"/vehicle-pl/gst-rates/{rate['id']}", json={"active": False})).json()[
        "active"
    ] is False
    # Switched off: a line already billed at it keeps it; a new line cannot take it.
    kept = r.json()["trips"][0]["purchases"][0]
    again = at_28 | {
        "trips": [at_28["trips"][0] | {"purchases": [at_28["trips"][0]["purchases"][0] | {"id": kept["id"]}]}]
    }
    assert (await client.put(f"/vehicle-pl/sheets/{sheet['id']}", json=again)).status_code == 200
    new_line = at_28["trips"][0]["purchases"][0] | {"id": None}
    r = await client.put(
        f"/vehicle-pl/sheets/{sheet['id']}",
        json=at_28
        | {"trips": [at_28["trips"][0] | {"purchases": [again["trips"][0]["purchases"][0], new_line]}]},
    )
    assert r.status_code == 422 and r.json()["detail"]["problem"]["reason"] == "that GST rate is switched off"
    assert (await client.post("/vehicle-pl/gst-rates", json={"ratePct": 28})).json()["active"] is True


async def test_the_rate_hsn_unit_and_gstin_come_from_the_masters_when_left_out(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    day = (today() - timedelta(days=1)).isoformat()
    body = wire(SHEETS["s1"], book) | {"vehicleId": "veh-defaults", "startDate": day, "endDate": day}
    body["trips"][0] |= {"date": day, "payments": []}
    for line in (*body["trips"][0]["purchases"], *body["trips"][0]["sales"]):
        line.pop("gstRatePct")
    r = await api(book.writer).post("/vehicle-pl/sheets", json=body)
    assert r.status_code == 201, r.text
    p, s = r.json()["trips"][0]["purchases"][0], r.json()["trips"][0]["sales"][0]
    assert (p["gstRatePct"], p["hsnCode"], p["unit"], p["vendorGstin"]) == (5, "2517", "unit", QUARRY_GSTIN)
    assert (s["gstRatePct"], s["gstAmount"]) == (5, "930.00")


async def test_photos_go_on_lines_and_are_read_with_the_sheet(  # type: ignore[no-untyped-def]
    api, book: Book, fresh
) -> None:
    sheet, body = fresh
    client = api(book.writer)

    async def upload(name: str) -> str:
        r = await client.post("/vehicle-pl/attachments", files={"file": (name, JPEG, "image/jpeg")})
        assert r.status_code == 201, r.text
        return r.json()["id"]

    bill, toll, dc = await upload("quarry.jpg"), await upload("toll.jpg"), await upload("dc.jpg")
    trip = sheet["trips"][0]
    with_photos = body | {
        "enRoute": [{**body["enRoute"][0], "id": sheet["enRoute"][0]["id"], "attachmentId": toll}],
        "trips": [
            body["trips"][0]
            | {
                "id": trip["id"],
                "purchases": [
                    {
                        **body["trips"][0]["purchases"][0],
                        "id": trip["purchases"][0]["id"],
                        "attachmentIds": [bill],
                    }
                ],
                "sales": [
                    {**body["trips"][0]["sales"][0], "id": trip["sales"][0]["id"], "dcAttachmentId": dc}
                ],
                "payments": [],
            }
        ],
    }
    r = await client.put(f"/vehicle-pl/sheets/{sheet['id']}", json=with_photos)
    assert r.status_code == 200, r.text
    after = r.json()
    assert after["enRoute"][0]["attachment"]["fileName"] == "toll.jpg"
    assert [a["id"] for a in after["trips"][0]["purchases"][0]["attachments"]] == [bill]
    url = after["trips"][0]["sales"][0]["dcAttachment"]["url"]
    got = await api(book.reader).get(url)
    assert got.status_code == 200 and got.content == JPEG
    assert (await api(book.far_writer).get(url)).status_code == 403
    # Someone else's upload cannot be put on a line.
    theirs = (
        await api(book.far_writer).post(
            "/vehicle-pl/attachments", files={"file": ("x.jpg", JPEG, "image/jpeg")}
        )
    ).json()["id"]
    stolen = with_photos | {"enRoute": [{**with_photos["enRoute"][0], "attachmentId": theirs}]}
    r = await client.put(f"/vehicle-pl/sheets/{sheet['id']}", json=stolen)
    assert r.status_code == 422 and r.json()["detail"]["problem"]["field"] == "enRoute[0].attachmentId"


async def test_reading_and_writing_follow_the_sheets_site(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    s1 = sheet_id(book, "s1")
    assert (await api(book.reader).get(f"/vehicle-pl/sheets/{s1}")).status_code == 200
    assert (await api(book.far_writer).get(f"/vehicle-pl/sheets/{s1}")).status_code == 403
    assert (await api(book.outsider).get("/vehicle-pl/sheets")).status_code == 403
    far = (await api(book.far_writer).get("/vehicle-pl/sheets")).json()["rows"]
    assert far == []
    body = wire(SHEETS["s4"], book) | {
        "vehicleId": "veh-far",
        "startDate": (today() - timedelta(days=1)).isoformat(),
    }
    assert (await api(book.far_writer).post("/vehicle-pl/sheets", json=body)).status_code == 403
    assert (await api(book.reader).post("/vehicle-pl/sheets", json=body)).status_code == 403
    r = await api(book.far_writer).post("/vehicle-pl/sheets", json=body | {"siteId": str(book.elsewhere)})
    assert r.status_code == 201, r.text


async def test_the_reports_are_the_directors_and_accounts(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    for path in ("vehicles", "months", "customers", "vendors"):
        assert (await api(book.reader).get(f"/vehicle-pl/reports/{path}")).status_code == 403, path
        assert (await api(book.accounts).get(f"/vehicle-pl/reports/{path}")).status_code == 200, path
    assert (await api(book.reader).get("/vehicle-pl/reports/trips")).status_code == 200
    assert (await api(book.outsider).get("/vehicle-pl/reports/trips")).status_code == 403


async def test_accounts_close_a_trip_paid_in_full_and_a_change_reopens_it(api, book: Book, fresh) -> None:  # type: ignore[no-untyped-def]
    sheet, body = fresh
    trip = sheet["trips"][0]
    path = f"/vehicle-pl/sheets/{sheet['id']}/trips/{trip['id']}/close"
    customer = book.parties["cus-01"]
    assert (await api(book.writer).post(path, json={"partyId": customer})).status_code == 403
    r = await api(book.accounts).post(path, json={"partyId": customer})
    assert r.status_code == 409 and r.json()["detail"]["problem"] == {
        "code": "not-paid-in-full",
        "due": "4530.00",
    }
    paid = {
        "direction": "in",
        "partyId": customer,
        "paidOn": body["startDate"],
        "mode": "Cash",
        "amount": "4530.00",
    }
    in_full = body | {"payments": [paid]}
    r = await api(book.writer).put(
        f"/vehicle-pl/sheets/{sheet['id']}", json=in_full | {"trips": [body["trips"][0] | {"id": trip["id"]}]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["trips"][0]["dues"][0]["status"] == "paid"
    r = await api(book.accounts).post(path, json={"partyId": customer})
    assert r.status_code == 200 and r.json()["trips"][0]["dues"][0]["status"] == "closed"
    # A sale corrected after: the trip is no longer closed as billed.
    current = r.json()["trips"][0]
    changed = body["trips"][0] | {
        "id": trip["id"],
        "purchases": [body["trips"][0]["purchases"][0] | {"id": current["purchases"][0]["id"]}],
        "sales": [body["trips"][0]["sales"][0] | {"id": current["sales"][0]["id"], "quantity": 4}],
        "payments": [body["trips"][0]["payments"][0] | {"id": current["payments"][0]["id"]}],
    }
    r = await api(book.writer).put(
        f"/vehicle-pl/sheets/{sheet['id']}",
        json=in_full | {"payments": [paid | {"id": r.json()["payments"][0]["id"]}], "trips": [changed]},
    )
    assert r.status_code == 200, r.text
    assert r.json()["trips"][0]["dues"][0]["status"] == "paid"
    r = await api(book.accounts).delete(path, params={"partyId": customer})
    assert r.status_code == 200 and r.json()["trips"][0]["dues"][0]["status"] == "paid"


async def test_another_tenant_sees_nothing_and_can_name_nothing(  # type: ignore[no-untyped-def]
    api, book: Book, make_tenant, make_person
) -> None:
    other = make_tenant("plother")
    stranger = make_person(other, "Stranger", [READ, WRITE, REPORT])
    client = api(stranger)
    assert (await client.get(f"/vehicle-pl/sheets/{sheet_id(book, 's1')}")).status_code == 404
    assert (await client.get("/vehicle-pl/sheets")).json()["rows"] == []
    assert (await client.get("/vehicle-pl/reports/customers")).json()["rows"] == []
    assert (await client.get("/vehicle-pl/masters")).json()["vendors"] == []
    body = wire(SHEETS["s1"], book) | {
        "siteId": str(other.site_id),
        "vehicleId": "veh-x",
        "startDate": "2026-08-03",
    }
    r = await client.post("/vehicle-pl/sheets", json=body)
    assert r.status_code == 422 and r.json()["detail"]["problem"]["field"].endswith("vendorId")


async def test_a_vehicles_diesel_bills_say_which_sheet_links_them(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    bills = (await api(book.writer).get("/vehicle-pl/diesel-bills", params={"vehicleId": "veh-2"})).json()
    bill = next(b for b in bills if b["id"] == book.bills["bill-881"])
    assert bill["linkedSheet"] == {
        "sheetId": sheet_id(book, "s2"),
        "sheetNumber": book.sheets["s2"]["sheetNumber"],
    }
    assert (bill["litres"], bill["amount"]) == (30, "2833.21")
    assert all(b["id"] != book.bills["bill-990"] for b in bills)


async def test_a_correction_to_a_linked_bill_shows_on_the_sheet(  # type: ignore[no-untyped-def]
    api, book: Book, admin: psycopg.Connection
) -> None:
    bill = plant_bill(admin, book.tenant, book.writer.user_id, "IOC-5150", "veh-5", "10", "940.00")
    day = (today() - timedelta(days=1)).isoformat()
    body = wire(SHEETS["s4"], book) | {
        "vehicleId": "veh-5",
        "startDate": day,
        "diesel": [{"source": "expense_bill", "expenseBillId": bill}],
        "payments": [],
    }
    created = (await api(book.writer).post("/vehicle-pl/sheets", json=body)).json()
    assert created["pl"]["diesel"] == "940.00"
    with admin.cursor() as cur:
        cur.execute("UPDATE finance.expense_bills SET amount = 1034.00, litres = 11 WHERE id = %s", (bill,))
    after = (await api(book.reader).get(f"/vehicle-pl/sheets/{created['id']}")).json()
    assert (after["pl"]["diesel"], after["diesel"][0]["litres"], after["diesel"][0]["rate"]) == (
        "1034.00",
        11,
        "94.00",
    )

"""Party invoices (LIN-27) through the API: drafts, numbers, cancel and delete, the tax, the money, scope.

Trip sheets are entered through POST /vehicle-pl/sheets as the trip sheet page
enters them, and invoices are made from their trips through
/vehicle-pl/invoices. Where an invoice bills the lines of
packages/domain/src/party-invoice.fixtures.json, its figures must be that
file's, worked by hand, so the TypeScript, the Python rules and the API answer
to one file. The database's own rules (one live invoice per sale line, an
issued invoice frozen, numbers never reused) are asserted against it too.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import psycopg
import pytest
from conftest import Person, Tenant
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError, IntegrityError

from app.core.db import tenant_session

FIXTURES = json.loads(
    (
        Path(__file__).resolve().parents[3] / "packages" / "domain" / "src" / "party-invoice.fixtures.json"
    ).read_text(encoding="utf-8")
)
GOLDEN = FIXTURES["invoices"]
IST = ZoneInfo("Asia/Kolkata")

PL_READ, PL_WRITE = "fleet.trip_pl.read", "fleet.trip_pl.write"
READ, WRITE, CANCEL, RECEIVE = (
    "sales.invoice.read",
    "sales.invoice.write",
    "sales.invoice.cancel",
    "finance.receipt.verify",
)

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin(state: str, pan: str) -> str:
    """A checksum-valid GSTIN, as buildGstin in packages/domain/src/gstin.ts makes one."""
    body = f"{state}{pan}1Z"
    total = 0
    for i, ch in enumerate(body):
        product = _ALPHABET.index(ch) * (1 if i % 2 == 0 else 2)
        total += product // 36 + product % 36
    return body + _ALPHABET[(36 - total % 36) % 36]


SELLER_TN = gstin("33", "AAFCK4521P")
SELLER_KA = gstin("29", "AAFCK4521P")
BUYER_TN = gstin("33", "AABCU9603R")
QUARRY = gstin("33", "AABCP1234Q")
LINE_FIGURES = (
    "amount",
    "transport",
    "taxable",
    "gstRatePct",
    "cgstPct",
    "sgstPct",
    "igstPct",
    "cgst",
    "sgst",
    "igst",
    "total",
)


def today() -> date:
    return datetime.now(tz=IST).date()


def financial_year(day: date) -> str:
    start = day.year if day.month >= 4 else day.year - 1
    return f"{start % 100:02d}-{(start + 1) % 100:02d}"


@dataclass
class Book:
    """One tenant's sites, sellers, masters and the people who invoice there."""

    tenant: Tenant
    plant: uuid.UUID
    yard: uuid.UUID
    depot: uuid.UUID
    tn_registration: uuid.UUID
    ka_registration: uuid.UUID
    writer: Person
    far_writer: Person
    accounts: Person
    reader: Person
    outsider: Person
    parties: dict[str, str] = field(default_factory=dict)
    locations: dict[str, str] = field(default_factory=dict)
    materials: dict[str, str] = field(default_factory=dict)


def _registration(
    admin: psycopg.Connection, tenant: Tenant, number: str, prefix: str, sites: list[uuid.UUID]
) -> uuid.UUID:
    """A GST registration of the tenant's company, and the sites that sell under it."""
    reg_id = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(
            """
            INSERT INTO core.gst_registrations
                (id, organization_id, legal_entity_id, gstin, state_code, legal_name, invoice_prefix)
            VALUES (%s, %s, %s, %s, %s, 'Invoice Test Minerals Pvt Ltd', %s)
            """,
            (reg_id, tenant.org_id, tenant.legal_entity_id, number, number[:2], prefix),
        )
        for site in sites:
            cur.execute(
                """
                UPDATE core.sites
                SET gst_registration_id = %s, state_code = %s,
                    address = jsonb_build_object('line1', 'Survey No. 112', 'city', 'Karapakkam',
                                                 'district', 'Chennai', 'pincode', '600097')
                WHERE id = %s
                """,
                (reg_id, number[:2], site),
            )
    return reg_id


async def _masters(client: httpx.AsyncClient, book: Book) -> None:
    for code, name, hsn in (("MSAND", "M-Sand", "2517"), ("AGG20", "20mm Aggregate", "2517")):
        r = await client.post(
            "/vehicle-pl/materials",
            json={"code": code, "name": name, "hsnCode": hsn, "gstRatePct": 5, "unit": "unit"},
        )
        assert r.status_code == 201, r.text
        book.materials[code] = r.json()["id"]
    r = await client.post(
        "/vehicle-pl/materials", json={"name": "Loose stone", "gstRatePct": 5, "unit": "load"}
    )
    assert r.status_code == 201, r.text
    book.materials["NOHSN"] = r.json()["id"]
    for rate in (5, 18):
        assert (await client.post("/vehicle-pl/gst-rates", json={"ratePct": rate})).status_code == 201
    r = await client.post(
        "/vehicle-pl/parties",
        json={"role": "vendor", "name": "Pallur Quarry", "gstin": QUARRY, "locations": ["Pallur yard"]},
    )
    assert r.status_code == 201, r.text
    book.parties["quarry"] = r.json()["id"]
    for key, name, number, address in (
        ("builder", "Casagrand Builder Pvt Ltd", BUYER_TN, "No. 5, OMR, Sholinganallur, Chennai - 600119"),
        ("walkin", "Counter Cash Sale", None, ""),
    ):
        r = await client.post(
            "/vehicle-pl/parties",
            json={
                "role": "customer",
                "name": name,
                "gstin": number,
                "siteId": str(book.plant),
                "locations": ["Oragadam site", "Attibele site", "Gate"],
                "address": address,
            },
        )
        assert r.status_code == 201, r.text
        party = r.json()
        book.parties[key] = party["id"]
        for location in party["locations"]:
            book.locations[f"{key}:{location['name']}"] = location["id"]
    # The builder's sites: one in Tamil Nadu, one across the border in Karnataka; the gate has no state yet.
    for name, state, address in (
        ("Oragadam site", "33", "SIPCOT Phase 2, Oragadam - 602105"),
        ("Attibele site", "29", "Hosur Road, Attibele - 562107"),
    ):
        r = await client.patch(
            f"/vehicle-pl/parties/{book.parties['builder']}/locations/{book.locations[f'builder:{name}']}",
            json={"stateCode": state, "address": address},
        )
        assert r.status_code == 200, r.text


@pytest.fixture(scope="module")
def book(
    admin: psycopg.Connection,
    make_tenant: Callable[..., Tenant],
    make_site: Callable[..., uuid.UUID],
    make_person: Callable[..., Person],
) -> Book:
    tenant = make_tenant("invbook")
    yard = make_site(tenant, "Attibele Stockyard", "stockyard")
    depot = make_site(tenant, "Vandalur Depot", "depot")
    tn = _registration(admin, tenant, SELLER_TN, "TST", [tenant.site_id])
    ka = _registration(admin, tenant, SELLER_KA, "KA", [yard])
    keys = [PL_READ, PL_WRITE, READ, WRITE]
    book = Book(
        tenant=tenant,
        plant=tenant.site_id,
        yard=yard,
        depot=depot,
        tn_registration=tn,
        ka_registration=ka,
        writer=make_person(tenant, "Anbu Selvan M", keys, sites=[tenant.site_id]),
        far_writer=make_person(tenant, "Hosur Clerk", keys, sites=[yard]),
        accounts=make_person(tenant, "Lakshmi N", [PL_READ, PL_WRITE, READ, WRITE, CANCEL, RECEIVE]),
        reader=make_person(tenant, "Vetrivel S", [READ], sites=[tenant.site_id]),
        outsider=make_person(tenant, "Outsider", ["fleet.board.read"]),
    )

    async def enter() -> None:
        from app.core import db as core_db
        from app.main import app

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://api", headers=book.writer.headers
        ) as c:
            await _masters(c, book)
        await core_db.engine.dispose()

    asyncio.run(enter())
    return book


# ------------------------------------------------------------------ helpers


def sale(
    book: Book,
    quantity: float | int = 6.5,
    rate: str = "4200.00",
    transport: str | None = "2500.00",
    *,
    customer: str = "builder",
    location: str = "Oragadam site",
    material: str = "MSAND",
    gst: bool = True,
    invoice_number: str = "",
) -> dict[str, Any]:
    return {
        "customerId": book.parties[customer],
        "location": location,
        "materialId": book.materials[material],
        "quantity": quantity,
        "rate": rate,
        "transport": transport,
        "gstBilled": gst,
        "gstRatePct": 5 if gst else None,
        "challanNumber": f"DC/{uuid.uuid4().hex[:5]}",
        "invoiceNumber": invoice_number,
    }


def paid(book: Book, amount: str, customer: str = "builder") -> dict[str, Any]:
    return {
        "direction": "in",
        "partyId": book.parties[customer],
        "paidOn": today().isoformat(),
        "mode": "UPI",
        "amount": amount,
    }


def trip(book: Book, *sales: dict[str, Any], payments: tuple[dict[str, Any], ...] = ()) -> dict[str, Any]:
    quantity = sales[0]["quantity"] if sales else 5
    return {
        "date": today().isoformat(),
        "purchases": [
            {
                "vendorId": book.parties["quarry"],
                "location": "Pallur yard",
                "materialId": book.materials["MSAND"],
                "quantity": quantity,
                "rate": "2400.00",
                "gstBilled": True,
                "gstRatePct": 5,
            }
        ],
        "sales": list(sales),
        "payments": list(payments),
    }


def sheet_body(
    book: Book, *trips: dict[str, Any], site: uuid.UUID | None = None, payments: tuple = ()
) -> dict:
    day = today().isoformat()
    return {
        "siteId": str(site or book.plant),
        "vehicleId": f"veh-{uuid.uuid4().hex[:6]}",
        "registrationNumber": "TN 29 AB 1001",
        "vehicleModel": "Tata Signa 3525.TK",
        "driverName": "Murugan S",
        "startDate": day,
        "endDate": day,
        "payments": list(payments),
        "trips": list(trips),
    }


async def enter_sheet(api, person: Person, body: dict) -> dict:  # type: ignore[no-untyped-def]
    r = await api(person).post("/vehicle-pl/sheets", json=body)
    assert r.status_code == 201, r.text
    return r.json()


def trip_ids(sheet: dict) -> list[str]:
    return [t["id"] for t in sheet["trips"]]


def page_of(sheet: dict) -> dict:
    """A saved sheet as the trip sheet page sends it back: every trip and line with its id."""

    def money_in(m: dict) -> dict:
        keys = ("id", "direction", "partyId", "paidOn", "mode", "reference", "amount", "note")
        return {k: m[k] for k in keys}

    return {
        **{k: sheet[k] for k in ("siteId", "vehicleId", "registrationNumber", "vehicleModel", "driverName")},
        "startDate": sheet["startDate"],
        "endDate": sheet["endDate"],
        "payments": [money_in(m) for m in sheet["payments"]],
        "trips": [
            {
                "id": t["id"],
                "date": t["date"],
                "purchases": [
                    {
                        **{
                            k: x[k]
                            for k in (
                                "id",
                                "vendorId",
                                "location",
                                "materialId",
                                "hsnCode",
                                "unit",
                                "quantity",
                            )
                        },
                        **{
                            k: x[k]
                            for k in ("rate", "gstBilled", "vendorGstin", "invoiceNumber", "invoiceDate")
                        },
                        "gstRatePct": x["gstRatePct"] if x["gstBilled"] else None,
                    }
                    for x in t["purchases"]
                ],
                "sales": [
                    {
                        **{
                            k: x[k] for k in ("id", "customerId", "location", "materialId", "hsnCode", "unit")
                        },
                        **{
                            k: x[k]
                            for k in ("quantity", "rate", "transport", "gstBilled", "partyGstin", "poRef")
                        },
                        **{k: x[k] for k in ("challanNumber", "invoiceNumber", "purchaseOrderId")},
                        "gstRatePct": x["gstRatePct"] if x["gstBilled"] else None,
                    }
                    for x in t["sales"]
                ],
                "payments": [money_in(m) for m in t["payments"]],
            }
            for t in sheet["trips"]
        ],
    }


async def draft(
    api, person: Person, book: Book, trips: list[str], customer: str = "builder"
) -> httpx.Response:  # type: ignore[no-untyped-def]
    return await api(person).post(
        "/vehicle-pl/invoices", json={"customerId": book.parties[customer], "tripIds": trips}
    )


async def made(api, person: Person, book: Book, trips: list[str], customer: str = "builder") -> dict:  # type: ignore[no-untyped-def]
    r = await draft(api, person, book, trips, customer)
    assert r.status_code == 201, r.text
    return r.json()


async def issued(api, person: Person, invoice_id: str) -> dict:  # type: ignore[no-untyped-def]
    r = await api(person).post(f"/vehicle-pl/invoices/{invoice_id}/issue")
    assert r.status_code == 200, r.text
    return r.json()


def problem(r: httpx.Response) -> dict:
    return r.json()["detail"]["problem"]


def series_count(admin: psycopg.Connection, registration: uuid.UUID) -> int:
    with admin.cursor() as cur:
        cur.execute(
            "SELECT last_serial FROM sales.invoice_series"
            " WHERE gst_registration_id = %s AND financial_year = %s",
            (registration, financial_year(today())),
        )
        row = cur.fetchone()
    return int(row[0]) if row else 0


# ------------------------------------------------------- the golden figures


async def test_a_draft_bills_a_trips_sale_lines_at_the_golden_figures(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    """One trip within the state: the fixture's first invoice, to the paisa, with CGST and SGST."""
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    golden = GOLDEN[0]["expect"]
    assert (invoice["status"], invoice["invoiceNumber"], invoice["invoiceDate"]) == ("draft", None, None)
    assert (invoice["supplyType"], invoice["placeOfSupply"], invoice["posBasis"]) == (
        "intra",
        "33",
        "delivery_location",
    )
    assert (invoice["kind"], invoice["buyerGstin"], invoice["seller"]["gstin"]) == (
        "b2b",
        BUYER_TN,
        SELLER_TN,
    )
    assert invoice["buyer"]["address"] == "No. 5, OMR, Sholinganallur, Chennai - 600119"
    assert invoice["shipTo"] == {"name": "Oragadam site", "address": "SIPCOT Phase 2, Oragadam - 602105"}
    assert invoice["seller"]["address"] == "Survey No. 112, Karapakkam, Chennai - 600097"
    assert {k: invoice["lines"][0][k] for k in LINE_FIGURES} == golden["lines"]["l1"]
    assert (invoice["taxable"], invoice["cgst"], invoice["sgst"], invoice["igst"]) == (
        golden["taxable"],
        golden["cgst"],
        golden["sgst"],
        golden["igst"],
    )
    assert (invoice["roundOff"], invoice["total"], invoice["words"]) == (
        golden["roundOff"],
        golden["total"],
        golden["words"],
    )
    assert invoice["byHsn"] == golden["byHsn"]
    line = invoice["lines"][0]
    assert (line["tripNumber"], line["sheetNumber"], line["hsnCode"], line["description"]) == (
        sheet["trips"][0]["tripNumber"],
        sheet["sheetNumber"],
        "2517",
        "M-Sand",
    )


async def test_three_trips_add_up_as_the_fixture_does_and_the_total_rounds_to_the_rupee(
    api, book: Book
) -> None:  # type: ignore[no-untyped-def]
    case = GOLDEN[1]
    lines = case["lines"]
    sheet = await enter_sheet(
        api,
        book.writer,
        sheet_body(
            book,
            *(
                trip(book, sale(book, float(x["quantity"]), x["rate"], x.get("transport"), material="AGG20"))
                for x in lines
            ),
        ),
    )
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    expect = case["expect"]
    got = [{k: line[k] for k in LINE_FIGURES} for line in invoice["lines"]]
    assert got == [expect["lines"][x["id"]] for x in lines]
    assert [
        invoice[k] for k in ("taxable", "cgst", "sgst", "beforeRounding", "roundOff", "total", "words")
    ] == [expect[k] for k in ("taxable", "cgst", "sgst", "beforeRounding", "roundOff", "total", "words")]
    assert invoice["tripNumbers"] == [t["tripNumber"] for t in sheet["trips"]]


async def test_goods_delivered_to_another_state_carry_igst(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    """A Tamil Nadu builder's site in Karnataka: the delivery decides, so IGST (the fixture's third case)."""
    case = GOLDEN[2]
    x, y = case["lines"]
    sheet = await enter_sheet(
        api,
        book.writer,
        sheet_body(
            book,
            trip(
                book,
                sale(book, x["quantity"], x["rate"], x["transport"], location="Attibele site"),
                sale(book, float(y["quantity"]), y["rate"], None, location="Attibele site"),
            ),
        ),
    )
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    expect = case["expect"]
    assert (invoice["placeOfSupply"], invoice["posBasis"], invoice["supplyType"]) == (
        "29",
        "delivery_location",
        "inter",
    )
    assert invoice["buyerGstin"] == BUYER_TN, "registered in Tamil Nadu, billed IGST all the same"
    assert [{k: line[k] for k in LINE_FIGURES} for line in invoice["lines"]] == [
        expect["lines"]["x"],
        expect["lines"]["y"],
    ]
    assert [invoice[k] for k in ("igst", "cgst", "sgst", "roundOff", "total", "words")] == [
        expect[k] for k in ("igst", "cgst", "sgst", "roundOff", "total", "words")
    ]


async def test_a_buyer_without_a_gstin_is_billed_b2c_in_the_sellers_state(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(
        api, book.writer, sheet_body(book, trip(book, sale(book, customer="walkin", location="Gate")))
    )
    invoice = await made(api, book.writer, book, trip_ids(sheet), customer="walkin")
    assert (invoice["kind"], invoice["buyerGstin"], invoice["buyer"]["stateCode"]) == ("b2c", None, None)
    assert (invoice["placeOfSupply"], invoice["posBasis"], invoice["supplyType"]) == (
        "33",
        "seller_state",
        "intra",
    )
    assert invoice["shipTo"] == {"name": "Gate", "address": ""}


async def test_a_drafts_place_of_supply_can_be_chosen_and_decides_the_tax(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book, location="Gate"))))
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    assert (invoice["placeOfSupply"], invoice["posBasis"]) == ("33", "buyer_gstin")
    r = await api(book.writer).patch(
        f"/vehicle-pl/invoices/{invoice['id']}",
        json={"placeOfSupply": "29", "buyerAddress": "Head office, Guindy"},
    )
    assert r.status_code == 200, r.text
    moved = r.json()
    assert (moved["placeOfSupply"], moved["posBasis"], moved["supplyType"]) == ("29", "chosen", "inter")
    assert (moved["igst"], moved["cgst"], moved["total"]) == ("1490.00", "0.00", "31290.00")
    assert moved["buyer"]["address"] == "Head office, Guindy"
    r = await api(book.writer).patch(f"/vehicle-pl/invoices/{invoice['id']}", json={"placeOfSupply": "99"})
    assert r.status_code == 422 and problem(r) == {
        "code": "invalid",
        "field": "placeOfSupply",
        "reason": "not a state",
    }
    # Issuing keeps what was chosen, and the address typed on the draft.
    final = await issued(api, book.writer, invoice["id"])
    assert (final["placeOfSupply"], final["posBasis"], final["igst"]) == ("29", "chosen", "1490.00")
    assert final["buyer"]["address"] == "Head office, Guindy"


# --------------------------------------------------------- what is refused


async def test_what_cannot_go_on_an_invoice_is_refused_with_its_reason(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(
        api,
        book.writer,
        sheet_body(
            book,
            trip(book, sale(book, gst=False)),
            trip(book, sale(book, invoice_number="TALLY/1187")),
            trip(book, sale(book, material="NOHSN")),
            trip(book, sale(book, location="Oragadam site"), sale(book, location="Attibele site")),
            trip(book, sale(book, customer="walkin")),
        ),
    )
    t = sheet["trips"]
    numbers = [x["tripNumber"] for x in t]
    cases = [
        ([t[0]["id"]], {"code": "sale-not-gst", "tripNumber": numbers[0]}),
        (
            [t[1]["id"]],
            {"code": "sale-billed-outside", "tripNumber": numbers[1], "invoiceNumber": "TALLY/1187"},
        ),
        ([t[2]["id"]], {"code": "sale-no-hsn", "tripNumber": numbers[2]}),
        ([t[3]["id"]], {"code": "places-differ", "states": ["29", "33"]}),
        ([t[4]["id"]], {"code": "trip-not-for-customer", "tripNumber": numbers[4]}),
    ]
    for trips, expected in cases:
        r = await draft(api, book.writer, book, trips)
        assert (r.status_code, problem(r)) == (409, expected), r.text
    r = await draft(api, book.writer, book, [str(uuid.uuid4())])
    assert (r.status_code, problem(r)) == (
        422,
        {"code": "invalid", "field": "tripIds[0]", "reason": "no such trip"},
    )
    r = await api(book.writer).post(
        "/vehicle-pl/invoices", json={"customerId": book.parties["builder"], "tripIds": []}
    )
    assert r.status_code == 422
    # A site with no GST registration has no GSTIN to bill from.
    depot = await enter_sheet(api, book.accounts, sheet_body(book, trip(book, sale(book)), site=book.depot))
    r = await draft(api, book.accounts, book, trip_ids(depot))
    assert r.status_code == 409 and problem(r)["code"] == "site-no-gstin"
    # The trips of two sites are two invoices.
    plant = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    yard = await enter_sheet(api, book.far_writer, sheet_body(book, trip(book, sale(book)), site=book.yard))
    r = await draft(api, book.accounts, book, trip_ids(plant) + trip_ids(yard))
    assert (r.status_code, problem(r)) == (409, {"code": "trips-other-site"})


# --------------------------------------------------------- the number


async def test_issuing_takes_the_next_number_and_freezes_the_invoice(
    api, book: Book, admin: psycopg.Connection
) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    before = series_count(admin, book.tn_registration)
    final = await issued(api, book.writer, invoice["id"])
    year = financial_year(today())
    assert final["invoiceNumber"] == f"TST/{year}/{before + 1:04d}"
    assert len(final["invoiceNumber"]) <= 16
    assert (final["status"], final["invoiceDate"], final["financialYear"]) == (
        "issued",
        today().isoformat(),
        year,
    )
    assert series_count(admin, book.tn_registration) == before + 1
    # Nothing it prints changes now: not through the API, not in psql.
    for r in (
        await api(book.writer).patch(
            f"/vehicle-pl/invoices/{invoice['id']}", json={"buyerAddress": "elsewhere"}
        ),
        await api(book.writer).delete(f"/vehicle-pl/invoices/{invoice['id']}"),
        await api(book.writer).post(f"/vehicle-pl/invoices/{invoice['id']}/issue"),
    ):
        assert (r.status_code, problem(r)["code"]) == (409, "not-a-draft"), r.text
    with admin.cursor() as cur:
        for statement in (
            "UPDATE sales.invoices SET total = total + 1, round_off = round_off + 1 WHERE id = %s",
            "UPDATE sales.invoices SET status = 'draft' WHERE id = %s",
            "UPDATE sales.invoice_lines SET quantity = quantity + 1 WHERE invoice_id = %s",
            "DELETE FROM sales.invoice_lines WHERE invoice_id = %s",
            "DELETE FROM sales.invoices WHERE id = %s",
        ):
            with pytest.raises(psycopg.errors.IntegrityConstraintViolation):
                cur.execute(statement, (invoice["id"],))
    r = await api(book.reader).get(f"/vehicle-pl/invoices/{invoice['id']}")
    assert r.status_code == 200 and r.json()["total"] == "31290.00"


async def test_two_issues_at_once_take_consecutive_numbers_with_no_gap_and_no_duplicate(
    api, book: Book, admin: psycopg.Connection
) -> None:  # type: ignore[no-untyped-def]
    sheets = [await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book)))) for _ in range(6)]
    drafts = [(await made(api, book.writer, book, trip_ids(sheet)))["id"] for sheet in sheets]
    before = series_count(admin, book.tn_registration)
    clients = [api(book.writer) for _ in drafts]
    answers = await asyncio.gather(
        *(c.post(f"/vehicle-pl/invoices/{i}/issue") for c, i in zip(clients, drafts, strict=True))
    )
    assert [r.status_code for r in answers] == [200] * len(drafts), [r.text for r in answers]
    numbers = [r.json()["invoiceNumber"] for r in answers]
    serials = sorted(int(n.rsplit("/", 1)[1]) for n in numbers)
    assert serials == list(range(before + 1, before + len(drafts) + 1)), numbers
    assert len(set(numbers)) == len(numbers)
    assert series_count(admin, book.tn_registration) == before + len(drafts)


async def test_the_same_draft_issued_twice_at_once_is_numbered_once(
    api, book: Book, admin: psycopg.Connection
) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    before = series_count(admin, book.tn_registration)
    answers = await asyncio.gather(
        api(book.writer).post(f"/vehicle-pl/invoices/{invoice['id']}/issue"),
        api(book.accounts).post(f"/vehicle-pl/invoices/{invoice['id']}/issue"),
    )
    assert sorted(r.status_code for r in answers) == [200, 409]
    assert series_count(admin, book.tn_registration) == before + 1


async def test_an_issue_that_fails_gives_its_number_back(api, book: Book, admin: psycopg.Connection) -> None:  # type: ignore[no-untyped-def]
    """A series whose next number would not fit in 16 characters refuses, and takes nothing."""
    sheet = await enter_sheet(api, book.far_writer, sheet_body(book, trip(book, sale(book)), site=book.yard))
    invoice = await made(api, book.far_writer, book, trip_ids(sheet))
    year = financial_year(today())
    with admin.cursor() as cur:
        cur.execute(
            "UPDATE core.gst_registrations SET invoice_prefix = 'ABCD' WHERE id = %s", (book.ka_registration,)
        )
        cur.execute(
            """
            INSERT INTO sales.invoice_series
                (organization_id, gst_registration_id, financial_year, last_serial)
            VALUES (%s, %s, %s, 99999)
            ON CONFLICT (organization_id, gst_registration_id, financial_year)
            DO UPDATE SET last_serial = 99999
            """,
            (book.tenant.org_id, book.ka_registration, year),
        )
    try:
        r = await api(book.far_writer).post(f"/vehicle-pl/invoices/{invoice['id']}/issue")
        assert (r.status_code, problem(r)) == (
            409,
            {"code": "series-full", "gstin": SELLER_KA, "financialYear": year},
        )
        assert series_count(admin, book.ka_registration) == 99999
        assert (await api(book.far_writer).get(f"/vehicle-pl/invoices/{invoice['id']}")).json()[
            "status"
        ] == "draft"
    finally:
        with admin.cursor() as cur:
            cur.execute(
                "UPDATE core.gst_registrations SET invoice_prefix = 'KA' WHERE id = %s",
                (book.ka_registration,),
            )
    final = await issued(api, book.far_writer, invoice["id"])
    assert final["invoiceNumber"] == f"KA/{year}/100000"
    assert (final["seller"]["gstin"], final["supplyType"], final["igst"]) == (SELLER_KA, "inter", "1490.00")
    with admin.cursor() as cur, pytest.raises(psycopg.errors.IntegrityConstraintViolation):
        cur.execute(
            "UPDATE sales.invoice_series SET last_serial = 5 WHERE gst_registration_id = %s",
            (book.ka_registration,),
        )


# ------------------------------------------------------ cancel and delete


async def test_a_draft_is_deleted_and_its_trips_are_free_again(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    r = await api(book.writer).delete(f"/vehicle-pl/invoices/{invoice['id']}")
    assert r.status_code == 204
    assert (await api(book.writer).get(f"/vehicle-pl/invoices/{invoice['id']}")).status_code == 404
    again = await made(api, book.writer, book, trip_ids(sheet))
    assert again["id"] != invoice["id"]


async def test_cancel_keeps_an_issued_invoice_on_record_and_frees_its_trips(
    api, book: Book, admin: psycopg.Connection
) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    first = await issued(api, book.writer, (await made(api, book.writer, book, trip_ids(sheet)))["id"])
    url = f"/vehicle-pl/invoices/{first['id']}"
    # Cancelling is accounts' work; deleting an issued invoice is nobody's.
    r = await api(book.writer).post(f"{url}/cancel", json={"reason": "Wrong rate on the DC"})
    assert (r.status_code, problem(r)) == (403, {"code": "needs-permission", "permission": CANCEL})
    r = await api(book.accounts).delete(url)
    assert (r.status_code, problem(r)["code"]) == (409, "not-a-draft")
    r = await api(book.accounts).post(f"{url}/cancel", json={"reason": "  "})
    assert r.status_code == 422
    r = await api(book.accounts).post(f"{url}/cancel", json={"reason": "Wrong rate on the DC"})
    assert r.status_code == 200, r.text
    cancelled = r.json()
    assert (cancelled["status"], cancelled["invoiceNumber"], cancelled["cancelReason"]) == (
        "cancelled",
        first["invoiceNumber"],
        "Wrong rate on the DC",
    )
    assert (cancelled["cancelledBy"], cancelled["total"], cancelled["due"]) == (
        "Lakshmi N",
        "31290.00",
        "0.00",
    )
    r = await api(book.accounts).post(f"{url}/cancel", json={"reason": "again"})
    assert (r.status_code, problem(r)) == (
        409,
        {"code": "already-cancelled", "invoiceNumber": first["invoiceNumber"]},
    )
    # The trip can be invoiced again, and the new invoice takes a new number.
    second = await issued(api, book.writer, (await made(api, book.writer, book, trip_ids(sheet)))["id"])
    assert second["invoiceNumber"] != first["invoiceNumber"]
    listed = (await api(book.reader).get("/vehicle-pl/invoices", params={"q": first["invoiceNumber"]})).json()
    assert [(r["id"], r["status"]) for r in listed["rows"]] == [(first["id"], "cancelled")]
    with admin.cursor() as cur, pytest.raises(psycopg.errors.IntegrityConstraintViolation):
        cur.execute("UPDATE sales.invoices SET cancel_reason = 'rewritten' WHERE id = %s", (first["id"],))
    # A draft is deleted, not cancelled.
    other = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    d = await made(api, book.writer, book, trip_ids(other))
    r = await api(book.accounts).post(f"/vehicle-pl/invoices/{d['id']}/cancel", json={"reason": "not needed"})
    assert (r.status_code, problem(r)) == (409, {"code": "not-issued", "status": "draft"})


# ------------------------------------------- one sale line, one live invoice


async def test_a_sale_line_is_never_on_two_live_invoices(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(
        api, book.writer, sheet_body(book, trip(book, sale(book)), trip(book, sale(book)))
    )
    t1, t2 = trip_ids(sheet)
    first = await made(api, book.writer, book, [t1])
    r = await draft(api, book.writer, book, [t2, t1])
    assert (r.status_code, problem(r)) == (
        409,
        {
            "code": "sale-on-invoice",
            "tripNumber": sheet["trips"][0]["tripNumber"],
            "invoiceId": first["id"],
            "invoiceNumber": None,
            "status": "draft",
        },
    )
    issued_first = await issued(api, book.writer, first["id"])
    r = await draft(api, book.writer, book, [t1])
    assert problem(r)["invoiceNumber"] == issued_first["invoiceNumber"]
    trips = (await api(book.writer).get("/vehicle-pl/invoices/trips")).json()["rows"]
    assert t1 not in {x["tripId"] for x in trips} and t2 in {x["tripId"] for x in trips}


async def test_two_drafts_of_one_trip_at_once_make_one(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    answers = await asyncio.gather(
        draft(api, book.writer, book, trip_ids(sheet)), draft(api, book.accounts, book, trip_ids(sheet))
    )
    assert sorted(r.status_code for r in answers) == [201, 409], [r.text for r in answers]


async def test_the_database_holds_a_sale_line_to_one_live_invoice(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    """Not only the API: a second live line for the same sale is refused by the partial unique index,
    and once the first invoice is cancelled the same insert goes in."""
    sheet = await enter_sheet(
        api, book.writer, sheet_body(book, trip(book, sale(book)), trip(book, sale(book)))
    )
    t1, t2 = trip_ids(sheet)
    first = await issued(api, book.writer, (await made(api, book.writer, book, [t1]))["id"])
    second = await made(api, book.writer, book, [t2])
    sale_id = first["lines"][0]["tripSaleId"]
    copy = text(
        """
        INSERT INTO sales.invoice_lines
            (organization_id, invoice_id, invoice_status, position, trip_sale_id, sheet_number, trip_number,
             trip_date, registration_number, description, hsn_code, unit, quantity, rate, amount, transport,
             taxable, gst_rate_pct, cgst, sgst, igst, total)
        SELECT organization_id, :draft, 'draft', 9, trip_sale_id, sheet_number, trip_number, trip_date,
               registration_number, description, hsn_code, unit, quantity, rate, amount, transport, taxable,
               gst_rate_pct, cgst, sgst, igst, total
        FROM sales.invoice_lines WHERE trip_sale_id = :sale
        """
    )
    with pytest.raises(IntegrityError) as caught:
        async with tenant_session(str(book.tenant.org_id)) as session:
            await session.execute(copy, {"draft": second["id"], "sale": sale_id})
    assert "uq_invoice_lines_live_trip_sale" in str(caught.value)
    r = await api(book.accounts).post(
        f"/vehicle-pl/invoices/{first['id']}/cancel", json={"reason": "Wrong party"}
    )
    assert r.status_code == 200
    async with tenant_session(str(book.tenant.org_id)) as session:
        await session.execute(copy, {"draft": second["id"], "sale": sale_id})
        found = (
            (
                await session.execute(
                    text(
                        "SELECT invoice_status FROM sales.invoice_lines WHERE trip_sale_id = :sale ORDER BY 1"
                    ),
                    {"sale": sale_id},
                )
            )
            .scalars()
            .all()
        )
    assert found == ["cancelled", "draft"]


async def test_money_matched_to_an_invoice_and_a_cancelled_invoice_keep_the_database_rules(
    api, book: Book
) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(
        api, book.writer, sheet_body(book, trip(book, sale(book), payments=(paid(book, "1000.00"),)))
    )
    invoice = await issued(api, book.writer, (await made(api, book.writer, book, trip_ids(sheet)))["id"])
    assert invoice["received"] == "1000.00"
    async with tenant_session(str(book.tenant.org_id)) as session:
        # Cancelling while money is matched would leave a cancelled invoice paid: refused.
        with pytest.raises(IntegrityError) as caught:
            await session.execute(
                text(
                    "UPDATE sales.invoices SET status = 'cancelled', cancelled_at = now(),"
                    " cancelled_by = created_by,"
                    " cancelled_by_name = 'x', cancel_reason = 'x' WHERE id = :id"
                ),
                {"id": invoice["id"]},
            )
    assert "ck_invoice_receipts_only_on_issued_invoices" in str(caught.value)


# ---------------------------------------------------- the trip sheet's side


async def test_an_invoiced_sale_line_stays_as_billed_on_its_trip(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    body = sheet_body(
        book, trip(book, sale(book)), trip(book, sale(book, customer="walkin", location="Gate"))
    )
    sheet = await enter_sheet(api, book.writer, body)
    invoice = await made(api, book.writer, book, [sheet["trips"][0]["id"]])
    url = f"/vehicle-pl/sheets/{sheet['id']}"
    shown = (await api(book.writer).get(url)).json()
    assert shown["trips"][0]["sales"][0]["invoice"] == {
        "id": invoice["id"],
        "number": None,
        "status": "draft",
    }
    assert shown["trips"][1]["sales"][0]["invoice"] is None

    def edited(change: Callable[[dict], object] | None = None) -> dict:
        page = page_of(shown)
        if change:
            change(page)
        return page

    assert (await api(book.writer).put(url, json=edited())).status_code == 200, (
        "sent back as shown: nothing moved"
    )
    refused = {
        "code": "sale-invoiced",
        "tripNumber": sheet["trips"][0]["tripNumber"],
        "invoiceId": invoice["id"],
        "invoiceNumber": None,
        "status": "draft",
    }
    for change in (
        lambda p: p["trips"][0]["sales"][0].update(quantity=7),
        lambda p: p["trips"][0]["sales"][0].update(location="Attibele site"),
        lambda p: p["trips"][0]["sales"][0].update(invoiceNumber="TALLY/9"),
    ):
        r = await api(book.writer).put(url, json=edited(change))
        assert (r.status_code, problem(r)) == (409, {**refused, "field": "trips[0].sales[0]"}), r.text
    r = await api(book.writer).put(url, json=edited(lambda p: p["trips"].pop(0)))
    assert (r.status_code, problem(r)) == (409, refused)
    r = await api(book.writer).delete(url)
    assert (r.status_code, problem(r)) == (409, refused)
    r = await api(book.accounts).put(url, json=edited(lambda p: p.update(siteId=str(book.yard))))
    assert (r.status_code, problem(r)) == (409, {**refused, "field": "siteId"}), r.text
    # The rest of the sheet is the sheet's own: the purchase, the other trip, a new trip.
    r = await api(book.writer).put(
        url,
        json=edited(
            lambda p: (
                p["trips"][0]["purchases"][0].update(rate="2300.00"),
                p["trips"][1]["sales"][0].update(quantity=3),
                p["trips"].append(trip(book, sale(book))),
            )
        ),
    )
    assert r.status_code == 200, r.text
    final = await issued(api, book.writer, invoice["id"])
    shown = (await api(book.writer).get(url)).json()
    assert shown["trips"][0]["sales"][0]["invoice"]["number"] == final["invoiceNumber"]
    # Cancelled, the trip is its own again; a line deleted leaves the cancelled invoice its copy.
    r = await api(book.accounts).post(
        f"/vehicle-pl/invoices/{invoice['id']}/cancel", json={"reason": "Re-billed"}
    )
    assert r.status_code == 200
    shown = (await api(book.writer).get(url)).json()
    assert shown["trips"][0]["sales"][0]["invoice"] is None
    r = await api(book.writer).put(url, json=edited(lambda p: p["trips"][0].update(sales=[])))
    assert r.status_code == 200, r.text
    kept = (await api(book.reader).get(f"/vehicle-pl/invoices/{invoice['id']}")).json()
    assert (kept["status"], kept["lines"][0]["tripSaleId"], kept["lines"][0]["total"]) == (
        "cancelled",
        None,
        "31290.00",
    )
    assert (await api(book.writer).delete(url)).status_code == 204
    assert (await api(book.reader).get(f"/vehicle-pl/invoices/{invoice['id']}")).json()[
        "invoiceNumber"
    ] == final["invoiceNumber"]


async def test_a_line_added_to_an_invoiced_trip_is_billed_on_its_own(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    first = await issued(api, book.writer, (await made(api, book.writer, book, trip_ids(sheet)))["id"])
    page = page_of((await api(book.writer).get(f"/vehicle-pl/sheets/{sheet['id']}")).json())
    page["trips"][0]["sales"].append(sale(book, 2, "4100.00", None))
    r = await api(book.writer).put(f"/vehicle-pl/sheets/{sheet['id']}", json=page)
    assert r.status_code == 200, r.text
    rows = (
        await api(book.writer).get("/vehicle-pl/invoices/trips", params={"q": sheet["sheetNumber"]})
    ).json()
    assert [(x["tripId"], x["lineCount"], x["taxable"]) for x in rows["rows"]] == [
        (trip_ids(sheet)[0], 1, "8200.00")
    ]
    second = await made(api, book.writer, book, trip_ids(sheet))
    assert [(x["quantity"], x["taxable"]) for x in second["lines"]] == [(2, "8200.00")]
    assert first["lines"][0]["tripSaleId"] != second["lines"][0]["tripSaleId"]


# ------------------------------------------------------- money received


async def test_money_paid_on_the_trips_is_matched_when_issued_and_can_be_matched_again(
    api, book: Book
) -> None:  # type: ignore[no-untyped-def]
    """A ₹31,290 trip paid ₹15,000 on the trip, and ₹20,000 paid on the sheet; a second trip of ₹17,955."""
    body = sheet_body(
        book,
        trip(book, sale(book), payments=(paid(book, "15000.00"),)),
        trip(book, sale(book, 4.5, "3800.00", None)),
        payments=(paid(book, "20000.00"),),
    )
    sheet = await enter_sheet(api, book.writer, body)
    t1, t2 = trip_ids(sheet)
    first = await issued(api, book.writer, (await made(api, book.writer, book, [t1]))["id"])
    assert (first["received"], first["due"], first["moneyStatus"]) == ("31290.00", "0.00", "paid")
    assert [(r["tripNumber"], r["amount"]) for r in first["receipts"]] == [
        (sheet["trips"][0]["tripNumber"], "15000.00"),
        (None, "16290.00"),
    ]
    assert [(u["onTrip"], u["free"]) for u in first["unmatched"]] == [(False, "3710.00")]
    second = await issued(api, book.writer, (await made(api, book.writer, book, [t2]))["id"])
    assert (second["received"], second["due"], second["moneyStatus"]) == ("3710.00", "14245.00", "part_paid")

    url = f"/vehicle-pl/invoices/{first['id']}/receipts"
    # Matching money is accounts' confirmation of money received.
    r = await api(book.writer).post(url, json={})
    assert (r.status_code, problem(r)) == (403, {"code": "needs-permission", "permission": RECEIVE})
    receipt = first["receipts"][1]
    r = await api(book.accounts).delete(f"{url}/{receipt['id']}")
    assert r.status_code == 200, r.text
    money = r.json()
    assert (money["received"], money["due"], money["moneyStatus"]) == ("15000.00", "16290.00", "part_paid")
    assert [(u["paymentId"], u["free"]) for u in money["unmatched"]] == [(receipt["paymentId"], "16290.00")]
    r = await api(book.accounts).post(url, json={"paymentId": receipt["paymentId"], "amount": "16290.01"})
    assert (r.status_code, problem(r)) == (409, {"code": "too-much", "free": "16290.00", "due": "16290.00"})
    r = await api(book.accounts).post(url, json={"paymentId": receipt["paymentId"], "amount": "6290.00"})
    assert r.status_code == 200 and r.json()["received"] == "21290.00"
    r = await api(book.accounts).post(url, json={})
    assert (r.status_code, r.json()["received"], r.json()["moneyStatus"]) == (200, "31290.00", "paid")
    r = await api(book.accounts).post(url, json={})
    assert r.status_code == 200 and r.json()["received"] == "31290.00", (
        "nothing more is due: nothing more is taken"
    )

    # A payment corrected on its sheet loses its matches; the invoice shows the money due again.
    page = page_of((await api(book.writer).get(f"/vehicle-pl/sheets/{sheet['id']}")).json())
    page["trips"][0]["payments"][0]["amount"] = "14000.00"
    r = await api(book.writer).put(f"/vehicle-pl/sheets/{sheet['id']}", json=page)
    assert r.status_code == 200, r.text
    money = (await api(book.reader).get(url)).json()
    assert (money["received"], money["due"]) == ("16290.00", "15000.00")
    assert {(u["onTrip"], u["free"]) for u in money["unmatched"]} == {(True, "14000.00")}

    # Cancelling lets the money go, back to be matched to whatever replaces it.
    r = await api(book.accounts).post(
        f"/vehicle-pl/invoices/{first['id']}/cancel", json={"reason": "Re-billed"}
    )
    assert r.status_code == 200 and (r.json()["received"], r.json()["receipts"]) == ("0.00", [])
    money = (await api(book.accounts).post(f"/vehicle-pl/invoices/{second['id']}/receipts", json={})).json()
    assert (money["received"], money["due"]) == ("17955.00", "0.00")


# ---------------------------------------------------- finding them again


async def test_invoices_are_listed_searched_and_filtered(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(
        api,
        book.writer,
        sheet_body(book, trip(book, sale(book), payments=(paid(book, "31290.00"),)), trip(book, sale(book))),
    )
    t1, t2 = trip_ids(sheet)
    paid_in_full = await issued(api, book.writer, (await made(api, book.writer, book, [t1]))["id"])
    open_draft = await made(api, book.writer, book, [t2])
    client = api(book.reader)
    listed = (await client.get("/vehicle-pl/invoices", params={"q": sheet["trips"][1]["tripNumber"]})).json()
    assert [r["id"] for r in listed["rows"]] == [open_draft["id"]]
    assert (await client.get("/vehicle-pl/invoices", params={"q": paid_in_full["invoiceNumber"]})).json()[
        "rows"
    ][0]["moneyStatus"] == "paid"
    statuses = {
        r["status"]
        for r in (await client.get("/vehicle-pl/invoices", params={"status": "draft"})).json()["rows"]
    }
    assert statuses == {"draft"}
    due = (await client.get("/vehicle-pl/invoices", params={"money": "due"})).json()["rows"]
    assert paid_in_full["id"] not in {r["id"] for r in due} and all(r["status"] == "issued" for r in due)
    everything = (await client.get("/vehicle-pl/invoices")).json()
    assert everything["rows"][0]["status"] == "draft", "drafts first"
    row = next(r for r in everything["rows"] if r["id"] == paid_in_full["id"])
    assert set(row) == {
        "id", "status", "invoiceNumber", "invoiceDate", "financialYear", "siteId", "customerId",
        "buyerName", "buyerGstin", "kind", "sellerGstin", "placeOfSupply", "supplyType", "tripNumbers",
        "lineCount", "taxable", "tax", "total", "received", "due", "moneyStatus", "createdBy", "createdAt",
        "issuedAt", "cancelledAt",
    }  # fmt: skip
    by_name = (await client.get("/vehicle-pl/invoices", params={"q": "casagrand"})).json()["rows"]
    assert {paid_in_full["id"], open_draft["id"]} <= {r["id"] for r in by_name}


async def test_the_trips_to_invoice_say_why_one_cannot_be(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(
        api,
        book.writer,
        sheet_body(
            book,
            trip(book, sale(book)),
            trip(book, sale(book, gst=False)),
            trip(book, sale(book, invoice_number="TALLY/77")),
        ),
    )
    rows = {
        r["tripId"]: r
        for r in (
            await api(book.reader).get("/vehicle-pl/invoices/trips", params={"q": sheet["sheetNumber"]})
        ).json()["rows"]
    }
    t = trip_ids(sheet)
    assert [(rows[i]["blocked"], rows[i]["outsideInvoiceNumber"]) for i in t] == [
        (None, ""),
        ("not-gst", ""),
        ("billed-outside", "TALLY/77"),
    ]
    assert (rows[t[0]]["taxable"], rows[t[0]]["total"], rows[t[0]]["customerGstin"]) == (
        "29800.00",
        "31290.00",
        BUYER_TN,
    )


# ------------------------------------------------------ scope and tenancy


async def test_a_person_sees_and_invoices_only_the_trips_at_their_sites(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    plant = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    yard = await enter_sheet(api, book.far_writer, sheet_body(book, trip(book, sale(book)), site=book.yard))
    r = await draft(api, book.far_writer, book, trip_ids(plant))
    assert (r.status_code, problem(r)) == (403, {"code": "needs-permission", "permission": WRITE})
    r = await draft(api, book.reader, book, trip_ids(plant))
    assert (r.status_code, problem(r)) == (403, {"code": "needs-permission", "permission": WRITE})
    at_plant = await made(api, book.writer, book, trip_ids(plant))
    at_yard = await made(api, book.far_writer, book, trip_ids(yard))
    r = await api(book.far_writer).get(f"/vehicle-pl/invoices/{at_plant['id']}")
    assert (r.status_code, problem(r)) == (403, {"code": "needs-permission", "permission": READ})
    for path in ("issue", "cancel"):
        r = await api(book.far_writer).post(
            f"/vehicle-pl/invoices/{at_plant['id']}/{path}", json={"reason": "x"}
        )
        assert r.status_code == 403
    assert (await api(book.far_writer).delete(f"/vehicle-pl/invoices/{at_plant['id']}")).status_code == 403
    mine = {r["id"] for r in (await api(book.far_writer).get("/vehicle-pl/invoices")).json()["rows"]}
    theirs = {r["id"] for r in (await api(book.reader).get("/vehicle-pl/invoices")).json()["rows"]}
    assert at_yard["id"] in mine and at_plant["id"] not in mine
    assert at_plant["id"] in theirs and at_yard["id"] not in theirs
    trips = {r["tripId"] for r in (await api(book.reader).get("/vehicle-pl/invoices/trips")).json()["rows"]}
    assert not trips & set(trip_ids(yard))
    r = await api(book.outsider).get("/vehicle-pl/invoices")
    assert (r.status_code, problem(r)) == (403, {"code": "needs-permission", "permission": READ})


async def test_another_tenant_cannot_find_read_or_touch_an_invoice(
    api, book: Book, tenant_b: Tenant, make_person: Callable[..., Person]
) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    stranger = make_person(tenant_b, "Stranger", [PL_READ, PL_WRITE, READ, WRITE, CANCEL, RECEIVE])
    client = api(stranger)
    url = f"/vehicle-pl/invoices/{invoice['id']}"
    for r in (
        await client.get(url),
        await client.patch(url, json={"notes": "mine now"}),
        await client.post(f"{url}/issue"),
        await client.post(f"{url}/cancel", json={"reason": "x"}),
        await client.get(f"{url}/receipts"),
        await client.delete(url),
    ):
        assert (r.status_code, problem(r)) == (404, {"code": "invoice-gone"}), r.text
    assert invoice["id"] not in {r["id"] for r in (await client.get("/vehicle-pl/invoices")).json()["rows"]}
    trips = (await client.get("/vehicle-pl/invoices/trips")).json()["rows"]
    assert not {r["tripId"] for r in trips} & set(trip_ids(sheet))
    r = await client.post(
        "/vehicle-pl/invoices", json={"customerId": book.parties["builder"], "tripIds": trip_ids(sheet)}
    )
    assert (r.status_code, problem(r)) == (
        422,
        {"code": "invalid", "field": "tripIds[0]", "reason": "no such trip"},
    )
    assert (await api(book.writer).get(url)).json()["status"] == "draft"


async def test_the_response_has_the_shape_the_screens_read(api, book: Book) -> None:  # type: ignore[no-untyped-def]
    sheet = await enter_sheet(api, book.writer, sheet_body(book, trip(book, sale(book))))
    invoice = await made(api, book.writer, book, trip_ids(sheet))
    assert set(invoice) >= {
        "seller", "buyer", "shipTo", "posBasis", "lines", "byHsn", "cgst", "sgst", "igst",
        "beforeRounding", "roundOff", "words", "notes", "issuedBy", "cancelledBy", "cancelReason", "irn",
        "irnAckNumber", "irnAckDate", "receipts", "unmatched",
    }  # fmt: skip
    assert (invoice["irn"], invoice["irnAckNumber"]) == (None, None), (
        "e-invoicing is not built: the columns wait"
    )
    assert set(invoice["lines"][0]) == {
        "id", "position", "tripSaleId", "tripId", "sheetId", "sheetNumber", "tripNumber", "tripDate",
        "registrationNumber", "challanNumber", "location", "description", "hsnCode", "unit", "quantity",
        "rate", *LINE_FIGURES,
    }  # fmt: skip
    assert invoice["lines"][0]["tripId"] == sheet["trips"][0]["id"]


# ------------------------------------------------- the tables keep to their tenant

LIN27_TABLES = ["sales.invoice_series", "sales.invoices", "sales.invoice_lines", "finance.invoice_receipts"]


@pytest.fixture(scope="module")
def planted(book: Book, admin: psycopg.Connection) -> dict[str, uuid.UUID]:
    """A row in each new table, all the book's: an issued invoice with money matched to it."""

    async def make() -> str:
        from app.core import db as core_db
        from app.main import app

        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(
            transport=transport, base_url="http://api", headers=book.writer.headers
        ) as c:
            r = await c.post(
                "/vehicle-pl/sheets",
                json=sheet_body(book, trip(book, sale(book), payments=(paid(book, "500.00"),))),
            )
            assert r.status_code == 201, r.text
            r = await c.post(
                "/vehicle-pl/invoices",
                json={"customerId": book.parties["builder"], "tripIds": [r.json()["trips"][0]["id"]]},
            )
            assert r.status_code == 201, r.text
            invoice_id = r.json()["id"]
            assert (await c.post(f"/vehicle-pl/invoices/{invoice_id}/issue")).status_code == 200
        await core_db.engine.dispose()
        return invoice_id

    invoice_id = asyncio.run(make())
    with admin.cursor() as cur:
        cur.execute("SELECT series_id FROM sales.invoices WHERE id = %s", (invoice_id,))
        series = cur.fetchone()[0]
        cur.execute("SELECT id FROM sales.invoice_lines WHERE invoice_id = %s", (invoice_id,))
        line = cur.fetchone()[0]
        cur.execute("SELECT id FROM finance.invoice_receipts WHERE invoice_id = %s", (invoice_id,))
        receipt = cur.fetchone()[0]
    return {
        "sales.invoice_series": series,
        "sales.invoices": uuid.UUID(invoice_id),
        "sales.invoice_lines": line,
        "finance.invoice_receipts": receipt,
    }


@pytest.mark.parametrize("table", LIN27_TABLES)
async def test_a_tenant_sees_its_own_invoice_rows(
    table: str, planted: dict[str, uuid.UUID], book: Book
) -> None:
    async with tenant_session(str(book.tenant.org_id)) as session:
        found = (
            await session.execute(
                text(f"SELECT count(*) FROM {table} WHERE id = :id"), {"id": str(planted[table])}
            )
        ).scalar_one()
    assert found == 1


@pytest.mark.parametrize("table", LIN27_TABLES)
async def test_another_tenant_cannot_select_update_or_delete_invoice_rows(
    table: str, planted: dict[str, uuid.UUID], book: Book, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    row_id = str(planted[table])
    async with tenant_session(str(tenant_b.org_id)) as session:
        seen = (
            await session.execute(
                text(f"SELECT count(*) FROM {table} WHERE id = :id OR organization_id = :org"),
                {"id": row_id, "org": str(book.tenant.org_id)},
            )
        ).scalar_one()
    assert seen == 0
    for statement in (f"UPDATE {table} SET id = id WHERE id = :id", f"DELETE FROM {table} WHERE id = :id"):
        async with tenant_session(str(tenant_b.org_id)) as session:
            assert (await session.execute(text(statement), {"id": row_id})).rowcount == 0, statement
    with admin.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM {table} WHERE id = %s", (planted[table],))
        assert cur.fetchone()[0] == 1


@pytest.mark.parametrize("table", LIN27_TABLES)
async def test_another_tenant_cannot_insert_a_copy_of_an_invoice_row(
    table: str, planted: dict[str, uuid.UUID], tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    """Tenant B writes a copy of the row, tenant A's organization_id and all: WITH CHECK refuses it."""
    forged_id = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(f"SELECT to_jsonb(t) FROM {table} t WHERE id = %s", (planted[table],))
        row = cur.fetchone()[0]
    row["id"] = str(forged_id)
    if table == "sales.invoice_lines":
        row["invoice_status"] = "draft"  # past the guard, which only lets a draft take lines
    forge = text(
        f"INSERT INTO {table} SELECT * FROM jsonb_populate_record(NULL::{table}, CAST(:row AS jsonb))"
    )
    with pytest.raises(DBAPIError) as caught:
        async with tenant_session(str(tenant_b.org_id)) as session:
            await session.execute(forge, {"row": json.dumps(row)})
    assert "row-level security" in str(caught.value).lower()

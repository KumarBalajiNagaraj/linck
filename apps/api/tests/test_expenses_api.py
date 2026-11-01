"""Expense bills through the API: the shapes the screens read, and the chain's rules enforced on the server.

Every request goes through the real app with a real signed-in session, so the
person acting is whoever the cookie says, never whoever the body claims.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from zoneinfo import ZoneInfo

import psycopg
import pytest
from conftest import FakeS3, Person, Tenant
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.db import tenant_session

IST = ZoneInfo("Asia/Kolkata")

EXPENSE_BILL_KEYS = {
    "id",
    "desk",
    "billNumber",
    "kind",
    "billDate",
    "vehicleId",
    "driverId",
    "vendor",
    "description",
    "litres",
    "amount",
    "status",
    "submittedBy",
    "submittedAt",
    "siteId",
    "provenance",
    "attachment",
    "capture",
    "submittedById",
    "history",
    "payment",
}
BILL_EVENT_KEYS = {"action", "from", "to", "byId", "by", "at", "note", "exception"}
CAPTURED_FIELD_KEYS = {"key", "label", "captured", "confidence", "value", "overridden", "overriddenBy"}

JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00 a photo of a bunk slip"
PDF = b"%PDF-1.7\n a scanned repair invoice"


def today() -> date:
    return datetime.now(tz=IST).date()


def paid_on() -> str:
    return today().isoformat()


def utr() -> str:
    return f"HDFC{uuid.uuid4().hex[:14].upper()}"


@dataclass(frozen=True)
class Desk:
    tenant: Tenant
    plant: uuid.UUID
    workshop: uuid.UUID
    elsewhere: uuid.UUID
    #: Uploads the fleet desk's bills; the fleet manager then validates them.
    clerk: Person
    fleet: Person
    stores: Person
    director: Person
    accounts: Person
    fleet_elsewhere: Person
    # Holds both the validate and the approve key: the one person who could sign twice in a row.
    owner: Person
    outsider: Person
    other_site: uuid.UUID
    other_org: uuid.UUID


@pytest.fixture(scope="module")
def desk(
    make_tenant: Callable[..., Tenant],
    make_site: Callable[..., uuid.UUID],
    make_person: Callable[..., Person],
) -> Desk:
    tenant = make_tenant("expenses")
    plant = tenant.site_id
    workshop = make_site(tenant, "Karapakkam Workshop")
    elsewhere = make_site(tenant, "Thiruvallur Crusher", "crusher_plant")
    other = make_tenant("expenses-other")
    return Desk(
        tenant=tenant,
        plant=plant,
        workshop=workshop,
        elsewhere=elsewhere,
        clerk=make_person(
            tenant, "Anbu Selvan M", ["fleet.expense.read", "fleet.expense.upload"], sites=[plant]
        ),
        fleet=make_person(
            tenant,
            "Fleet Manager",
            ["fleet.expense.read", "fleet.expense.upload", "fleet.expense.validate"],
            sites=[plant],
        ),
        stores=make_person(
            tenant, "Ganesh K", ["stores.expense.read", "stores.expense.upload"], sites=[workshop]
        ),
        director=make_person(tenant, "Director", ["finance.expense.read", "finance.expense.approve"]),
        accounts=make_person(
            tenant, "Lakshmi P", ["finance.expense.read", "finance.expense.pass", "finance.expense.pay"]
        ),
        fleet_elsewhere=make_person(
            tenant,
            "Fleet TVL",
            ["fleet.expense.read", "fleet.expense.upload", "fleet.expense.validate"],
            sites=[elsewhere],
        ),
        owner=make_person(
            tenant,
            "Owner",
            [
                "fleet.expense.read",
                "fleet.expense.upload",
                "fleet.expense.validate",
                "finance.expense.approve",
            ],
        ),
        outsider=make_person(
            other,
            "Someone Else",
            ["fleet.expense.read", "fleet.expense.upload", "fleet.expense.validate", "finance.expense.read"],
        ),
        other_site=other.site_id,
        other_org=other.org_id,
    )


def keyed(site: uuid.UUID, **over: object) -> dict:
    body = {
        "desk": "fleet",
        "siteId": str(site),
        "kind": "diesel",
        "billNumber": f"BK/{uuid.uuid4().hex[:6]}",
        "billDate": (today() - timedelta(days=2)).isoformat(),
        "vendor": "Sakthi Fuels, Karapakkam",
        "vehicleId": "veh-001",
        "driverId": "drv-001",
        "litres": 432,
        "amount": "41277.60",
    }
    body.update(over)
    return body


async def raise_bill(api, person: Person, site: uuid.UUID, **over: object) -> dict:  # type: ignore[no-untyped-def]
    r = await api(person).post("/expenses", json=keyed(site, **over))
    assert r.status_code == 201, r.text
    return r.json()


async def act(api, person: Person, bill: dict, action: str, **body: object):  # type: ignore[no-untyped-def]
    return await api(person).post(f"/expenses/{bill['id']}/actions", json={"action": action, **body})


async def walk(api, desk: Desk, bill: dict, *steps: str) -> dict:  # type: ignore[no-untyped-def]
    who = {"validate": desk.fleet, "approve": desk.director, "pass": desk.accounts}
    for step in steps:
        r = await act(api, who[step], bill, step)
        assert r.status_code == 200, r.text
        bill = r.json()
    return bill


def problem(response) -> dict:  # type: ignore[no-untyped-def]
    return response.json()["detail"]["problem"]


# ------------------------------------------------------------------ shapes


async def test_a_keyed_bill_comes_back_in_the_mock_shape(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    body = await raise_bill(api, desk.clerk, desk.plant, billDate="2026-08-08")
    assert set(body) == EXPENSE_BILL_KEYS, (
        "source is absent, not null, on a bill that did not come on WhatsApp"
    )
    assert body["amount"] == "41277.60" and body["litres"] == 432
    assert body["status"] == "submitted" and body["provenance"] == "human"
    assert body["submittedBy"] == "Anbu Selvan M" and body["submittedById"] == f"user:{desk.clerk.user_id}"
    # The bill's calendar date, as the screens carry it: IST midnight, in UTC.
    assert body["billDate"] == "2026-08-07T18:30:00Z"
    assert (body["history"], body["payment"], body["capture"], body["attachment"]) == ([], None, None, None)
    assert (body["vehicleId"], body["driverId"], body["siteId"]) == ("veh-001", "drv-001", str(desk.plant))

    again = await api(desk.director).get(f"/expenses/{body['id']}")
    assert again.status_code == 200 and again.json() == body


async def test_money_is_a_two_place_string_and_litres_a_number(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    body = await raise_bill(api, desk.clerk, desk.plant, amount="12500", litres=120.455)
    assert (body["amount"], body["litres"]) == ("12500.00", 120.455)
    refused = await api(desk.clerk).post("/expenses", json=keyed(desk.plant, amount=12500))
    assert refused.status_code == 422, "a JSON number is not accepted as money"
    too_fine = await api(desk.clerk).post("/expenses", json=keyed(desk.plant, litres=1.0001))
    assert too_fine.status_code == 422


async def test_the_client_cannot_say_who_raised_it_or_where_it_is(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    for field, value in [
        ("status", "paid"),
        ("provenance", "confirmed"),
        ("submittedById", "driver:drv-001"),
    ]:
        r = await api(desk.clerk).post("/expenses", json=keyed(desk.plant, **{field: value}))
        assert r.status_code == 422, field


async def test_bills_are_checked_like_the_upload_sheet_checks_them(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    cases = [
        ({"kind": "diesel", "litres": None}, "litres"),
        ({"kind": "repair", "litres": 10}, "litres"),
        ({"billDate": (today() + timedelta(days=1)).isoformat()}, "billDate"),
        ({"vendor": " "}, "vendor"),
        ({"amount": "0"}, "amount"),
        ({"kind": "repair", "litres": None, "vehicleId": None}, "vehicleId"),
    ]
    for over, field in cases:
        r = await api(desk.clerk).post("/expenses", json=keyed(desk.plant, **over))
        assert r.status_code == 422 and problem(r)["field"] == field, (over, r.text)
    stores = await api(desk.stores).post("/expenses", json=keyed(desk.workshop, desk="stores", kind="diesel"))
    assert problem(stores) == {
        "code": "invalid",
        "field": "kind",
        "reason": "the stores desk does not raise diesel bills",
    }


async def test_uploading_needs_the_desks_upload_key_at_that_site(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    r = await api(desk.clerk).post("/expenses", json=keyed(desk.elsewhere))
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "fleet.expense.upload",
    }
    r = await api(desk.director).post("/expenses", json=keyed(desk.plant))
    assert r.status_code == 403


# --------------------------------------------------------------- the chain


async def test_the_chain_validate_approve_pass_pay_each_step_logged(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    bill = await walk(api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate", "approve", "pass")
    reference = utr()
    paid = await act(
        api,
        desk.accounts,
        bill,
        "pay",
        payment={"utr": reference.lower(), "paidOn": paid_on(), "mode": "NEFT"},
    )
    assert paid.status_code == 200, paid.text
    body = paid.json()
    assert body["status"] == "paid"
    assert body["payment"] == {"utr": reference, "paidOn": paid_on(), "mode": "NEFT"}
    assert [(e["action"], e["from"], e["to"], e["by"]) for e in body["history"]] == [
        ("validate", "submitted", "validated", "Fleet Manager"),
        ("approve", "validated", "approved", "Director"),
        ("pass", "approved", "passed", "Lakshmi P"),
        ("pay", "passed", "paid", "Lakshmi P"),
    ]
    assert all(set(e) == BILL_EVENT_KEYS for e in body["history"])
    assert not any(e["exception"] for e in body["history"])
    assert body["history"][1]["byId"] == f"user:{desk.director.user_id}"


async def test_each_step_needs_its_key_at_the_bills_site(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    bill = await raise_bill(api, desk.clerk, desk.plant)
    r = await act(api, desk.director, bill, "validate")
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "fleet.expense.validate",
    }
    r = await act(api, desk.director, bill, "approve")
    assert r.status_code == 409 and problem(r) == {
        "code": "wrong-step",
        "status": "submitted",
        "action": "approve",
    }
    # The same key at another site is not the key here; nor is reading the bill.
    r = await act(api, desk.fleet_elsewhere, bill, "validate")
    assert r.status_code == 403
    validated = await walk(api, desk, bill, "validate")
    r = await act(api, desk.fleet, validated, "approve")
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "finance.expense.approve",
    }


async def test_a_stores_bill_is_validated_under_the_stores_key(  # type: ignore[no-untyped-def]
    api, desk: Desk, make_person: Callable[..., Person]
) -> None:
    bill = await raise_bill(
        api,
        desk.stores,
        desk.workshop,
        desk="stores",
        kind="spares",
        litres=None,
        vehicleId=None,
        driverId=None,
    )
    r = await act(api, desk.fleet, bill, "validate")
    assert r.status_code == 403 and problem(r)["permission"] == "stores.expense.read"
    workshop_fleet = make_person(
        desk.tenant,
        "Fleet at the workshop",
        ["stores.expense.read", "stores.expense.validate"],
        sites=[desk.workshop],
    )
    r = await act(api, workshop_fleet, bill, "validate")
    assert r.status_code == 200 and r.json()["status"] == "validated"


async def test_nobody_signs_twice_and_the_submitter_counts(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    own = await raise_bill(api, desk.owner, desk.plant)
    r = await act(api, desk.owner, own, "validate")
    assert r.status_code == 409 and problem(r) == {"code": "second-signature"}
    r = await act(api, desk.owner, own, "validate", note="Driver on leave; checked the slip myself")
    assert r.status_code == 200
    event = r.json()["history"][0]
    assert (event["exception"], event["note"]) == (True, "Driver on leave; checked the slip myself")

    # Validated by one person, approved by the same person: a second signature again.
    fresh = await raise_bill(api, desk.clerk, desk.plant)
    validated = (await act(api, desk.owner, fresh, "validate")).json()
    assert validated["history"][0]["exception"] is False
    r = await act(api, desk.owner, validated, "approve")
    assert r.status_code == 409 and problem(r) == {"code": "second-signature"}


async def test_accounts_passing_then_paying_is_one_job(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    bill = await walk(api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate", "approve", "pass")
    r = await act(
        api, desk.accounts, bill, "pay", payment={"utr": utr(), "paidOn": paid_on(), "mode": "RTGS"}
    )
    assert r.status_code == 200 and r.json()["history"][-1]["exception"] is False


async def test_a_hard_block_tenant_refuses_a_second_signature_even_with_a_note(  # type: ignore[no-untyped-def]
    api, make_tenant: Callable[..., Tenant], make_person: Callable[..., Person], admin: psycopg.Connection
) -> None:
    tenant = make_tenant("hard-block")
    with admin.cursor() as cur:
        cur.execute(
            "UPDATE core.organizations SET segregation_enforcement = 'hard_block' WHERE id = %s",
            (tenant.org_id,),
        )
    manager = make_person(
        tenant, "Solo Manager", ["fleet.expense.read", "fleet.expense.upload", "fleet.expense.validate"]
    )
    bill = await raise_bill(api, manager, tenant.site_id)
    r = await act(api, manager, bill, "validate", note="Nobody else is here today")
    assert r.status_code == 409 and problem(r) == {"code": "second-signature"}


async def test_reject_needs_a_reason_and_is_for_the_step_owner(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    bill = await walk(api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate", "approve")
    r = await act(api, desk.director, bill, "reject", note="x")
    assert r.status_code == 403 and problem(r) == {"code": "only-step-owner", "step": "pass"}
    r = await act(api, desk.accounts, bill, "reject")
    assert r.status_code == 409 and problem(r) == {"code": "needs-reason", "action": "reject"}
    r = await act(api, desk.accounts, bill, "reject", note="Duplicate of BK/48213")
    assert r.status_code == 200 and r.json()["status"] == "rejected"


async def test_send_back_forgets_the_last_signature(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    bill = await walk(api, desk, await raise_bill(api, desk.owner, desk.plant), "validate")
    r = await act(api, desk.director, bill, "send_back", note="Bill number is the bunk's phone number")
    assert r.status_code == 200 and r.json()["status"] == "submitted"
    # The fleet manager signed, and was sent back: signing again is clean.
    r = await act(api, desk.fleet, r.json(), "validate")
    assert r.status_code == 200 and r.json()["history"][-1]["exception"] is False


async def test_delete_only_before_anyone_signs_and_restore(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    bill = await raise_bill(api, desk.clerk, desk.plant)
    r = await act(api, desk.fleet, bill, "delete", note=" ")
    assert r.status_code == 409 and problem(r) == {"code": "needs-reason", "action": "delete"}
    r = await act(api, desk.director, bill, "delete", note="Posted twice")
    assert r.status_code == 403 and problem(r) == {"code": "only-desk-deletes"}
    deleted = await act(api, desk.fleet, bill, "delete", note="Posted twice")
    assert deleted.status_code == 200 and deleted.json()["status"] == "deleted"
    restored = await act(api, desk.fleet, deleted.json(), "restore")
    assert restored.status_code == 200 and restored.json()["status"] == "submitted"

    signed = await walk(api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate")
    r = await act(api, desk.fleet, signed, "delete", note="Changed my mind")
    assert r.status_code == 409 and problem(r) == {
        "code": "wrong-step",
        "status": "validated",
        "action": "delete",
    }


async def test_payment_needs_a_real_utr_used_once_and_no_future_date(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    first = await walk(
        api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate", "approve", "pass"
    )
    second = await walk(
        api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate", "approve", "pass"
    )
    reference = utr()

    def pay(bill: dict, **payment: object):  # type: ignore[no-untyped-def]
        return act(
            api,
            desk.accounts,
            bill,
            "pay",
            payment={"utr": reference, "paidOn": paid_on(), "mode": "NEFT", **payment},
        )

    r = await act(api, desk.accounts, first, "pay")
    assert r.status_code == 409 and problem(r) == {"code": "needs-payment"}
    r = await pay(first, utr="12")
    assert problem(r) == {"code": "bad-utr"}
    r = await pay(first, paidOn=(today() + timedelta(days=1)).isoformat())
    assert problem(r) == {"code": "future-payment-date"}
    assert (await pay(first)).status_code == 200
    r = await pay(second)
    assert r.status_code == 409 and problem(r) == {"code": "utr-used", "utr": reference}
    cash = await pay(second, utr="", mode="Cash")
    assert cash.status_code == 200 and cash.json()["payment"] == {
        "utr": "",
        "paidOn": paid_on(),
        "mode": "Cash",
    }


async def test_a_utr_is_unique_per_tenant(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    reference = utr()
    bill = await walk(api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate", "approve", "pass")
    r = await act(
        api, desk.accounts, bill, "pay", payment={"utr": reference, "paidOn": paid_on(), "mode": "IMPS"}
    )
    assert r.status_code == 200

    record = text(
        "INSERT INTO finance.payments"
        " (organization_id, payment_date, method, amount, reference_no, recorded_by)"
        " VALUES (:org, current_date, 'imps', 1, :utr, :user)"
    )
    # Another tenant may hold the same reference: its payments are not this tenant's.
    async with tenant_session(str(desk.other_org)) as db:
        await db.execute(
            record, {"org": str(desk.other_org), "utr": reference, "user": str(desk.outsider.user_id)}
        )
    # The same tenant may not, even past the API.
    with pytest.raises(IntegrityError, match="uq_payments_organization_id_reference_no"):
        async with tenant_session(str(desk.tenant.org_id)) as db:
            await db.execute(
                record, {"org": str(desk.tenant.org_id), "utr": reference, "user": str(desk.accounts.user_id)}
            )


# ----------------------------------------------------------------- batches


async def test_batch_approve_does_the_clean_ones_and_says_why_the_rest_were_left_out(  # type: ignore[no-untyped-def]
    api, desk: Desk, make_person: Callable[..., Person]
) -> None:
    a = await walk(
        api, desk, await raise_bill(api, desk.clerk, desk.plant, amount="100.10", litres=1), "validate"
    )
    b = await walk(
        api, desk, await raise_bill(api, desk.clerk, desk.plant, amount="200.20", litres=2.5), "validate"
    )
    c = await raise_bill(api, desk.clerk, desk.plant)
    d = await raise_bill(api, desk.owner, desk.elsewhere)
    d = (await act(api, desk.fleet_elsewhere, d, "validate")).json()
    plant_director = make_person(
        desk.tenant,
        "Plant Director",
        ["finance.expense.read", "finance.expense.approve"],
        sites=[desk.plant, desk.elsewhere],
    )
    plant_director_here_only = make_person(
        desk.tenant, "Director KRP", ["finance.expense.approve", "fleet.expense.read"], sites=[desk.plant]
    )
    ids = [a["id"], b["id"], c["id"], d["id"]]

    dry = await api(plant_director_here_only).post(
        "/expenses/actions/batch", json={"action": "approve", "ids": ids, "dryRun": True}
    )
    assert dry.status_code == 200
    plan = dry.json()
    assert plan["done"] is False and [x["id"] for x in plan["eligible"]] == [a["id"], b["id"]]
    assert plan["totalPaise"] == 30030 and plan["litres"] == 3.5
    assert [(s["id"], s["problem"]) for s in plan["skipped"]] == [
        (d["id"], {"code": "needs-permission", "permission": "fleet.expense.read"}),
        (c["id"], {"code": "wrong-step", "status": "submitted", "action": "approve"}),
    ]
    assert (await api(desk.director).get(f"/expenses/{a['id']}")).json()["status"] == "validated", (
        "a dry run changes nothing"
    )

    done = await api(plant_director).post("/expenses/actions/batch", json={"action": "approve", "ids": ids})
    result = done.json()
    assert result["done"] is True
    assert sorted(x["id"] for x in result["eligible"]) == sorted([a["id"], b["id"], d["id"]])
    assert all(x["status"] == "approved" for x in result["eligible"])
    assert [(s["id"], s["problem"]["code"]) for s in result["skipped"]] == [(c["id"], "wrong-step")]


async def test_a_batch_never_carries_a_second_signature(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    own = await raise_bill(api, desk.owner, desk.plant)
    clean = await raise_bill(api, desk.clerk, desk.plant)
    r = await api(desk.owner).post(
        "/expenses/actions/batch", json={"action": "validate", "ids": [own["id"], clean["id"]]}
    )
    result = r.json()
    assert [x["id"] for x in result["eligible"]] == [clean["id"]]
    assert result["skipped"][0]["id"] == own["id"]
    assert result["skipped"][0]["problem"] == {"code": "batch-second-signature"}
    assert result["skipped"][0]["bill"]["status"] == "submitted"


async def test_a_batch_payment_is_one_transfer_with_one_utr(  # type: ignore[no-untyped-def]
    api, desk: Desk, admin: psycopg.Connection
) -> None:
    bills = [
        await walk(
            api,
            desk,
            await raise_bill(api, desk.clerk, desk.plant, amount=amount),
            "validate",
            "approve",
            "pass",
        )
        for amount in ("1000.50", "2000.25")
    ]
    reference = utr()
    r = await api(desk.accounts).post(
        "/expenses/actions/batch",
        json={
            "action": "pay",
            "ids": [b["id"] for b in bills],
            "payment": {"utr": reference, "paidOn": paid_on(), "mode": "NEFT"},
        },
    )
    assert r.status_code == 200, r.text
    assert {x["payment"]["utr"] for x in r.json()["eligible"]} == {reference}
    with admin.cursor() as cur:
        cur.execute(
            "SELECT count(*), sum(amount) FROM finance.payments WHERE reference_no = %s", (reference,)
        )
        assert cur.fetchone() == (1, Decimal("3000.75"))
    again = await walk(
        api, desk, await raise_bill(api, desk.clerk, desk.plant), "validate", "approve", "pass"
    )
    r = await api(desk.accounts).post(
        "/expenses/actions/batch",
        json={
            "action": "pay",
            "ids": [again["id"]],
            "payment": {"utr": reference, "paidOn": paid_on(), "mode": "NEFT"},
        },
    )
    assert r.status_code == 409 and problem(r) == {"code": "utr-used", "utr": reference}


# -------------------------------------------------------- scans and capture


async def upload(api, person: Person, content: bytes = JPEG, name: str = "slip.jpg", desk: str = "fleet"):  # type: ignore[no-untyped-def]
    return await api(person).post(
        "/expenses/attachments", files={"file": (name, content, "image/jpeg")}, data={"desk": desk}
    )


def capture(*fields: tuple[str, str | None, str]) -> dict:
    return {
        "engine": "tesseract.js 5 (eng)",
        "capturedAt": datetime.now(UTC).isoformat(),
        "warnings": [{"code": "litres-rate-mismatch", "expected": 41300, "stated": 41277.6}],
        "fields": [
            {
                "key": key,
                "label": key,
                "captured": captured,
                "confidence": 2 if captured else None,
                "value": value,
            }
            for key, captured, value in fields
        ],
    }


async def test_a_scan_is_stored_by_hash_and_served_back_safely(  # type: ignore[no-untyped-def]
    api, desk: Desk, file_dir: Path
) -> None:
    r = await upload(api, desk.clerk, name="../../etc/Slip 7.jpg")
    assert r.status_code == 201, r.text
    stored = r.json()
    assert set(stored) == {"id", "fileName", "mimeType", "sizeKb"}
    assert stored["fileName"] == "Slip 7.jpg" and stored["mimeType"] == "image/jpeg"
    assert (file_dir / str(desk.tenant.org_id) / hashlib.sha256(JPEG).hexdigest()).read_bytes() == JPEG

    bill = await raise_bill(api, desk.clerk, desk.plant, attachmentId=stored["id"])
    assert bill["attachment"] == {
        "fileName": "Slip 7.jpg",
        "mimeType": "image/jpeg",
        "sizeKb": 0,
        "url": f"/expenses/{bill['id']}/attachment",
    }
    got = await api(desk.director).get(bill["attachment"]["url"])
    assert got.status_code == 200 and got.content == JPEG
    assert got.headers["content-type"] == "image/jpeg"
    assert got.headers["x-content-type-options"] == "nosniff"
    # Opened in place, under the name it was uploaded with (RFC 5987, for the space).
    assert got.headers["content-disposition"] == "inline; filename*=utf-8''Slip%207.jpg"

    # One scan, one bill.
    r = await api(desk.clerk).post("/expenses", json=keyed(desk.plant, attachmentId=stored["id"]))
    assert r.status_code == 422 and problem(r)["field"] == "attachmentId"


async def test_a_scan_goes_through_the_bucket_and_back_under_the_bills_permission(  # type: ignore[no-untyped-def]
    api, desk: Desk, bucket: FakeS3
) -> None:
    """Production keeps scans in Spaces (LINCK_FILE_STORE=s3). The browser still
    only ever gets them from the API, after the same checks as from a disk."""
    content = JPEG + b" kept in the bucket"
    stored = (await upload(api, desk.clerk, content=content, name="Slip 8.jpg")).json()
    digest = hashlib.sha256(content).hexdigest()
    assert bucket.keys() == {f"{desk.tenant.org_id}/{digest}"}

    bill = await raise_bill(api, desk.clerk, desk.plant, attachmentId=stored["id"])
    got = await api(desk.director).get(bill["attachment"]["url"])
    assert got.status_code == 200 and got.content == content
    assert got.headers["content-type"] == "image/jpeg"
    assert got.headers["x-content-type-options"] == "nosniff"
    assert got.headers["content-disposition"] == "inline; filename*=utf-8''Slip%208.jpg"

    r = await api(desk.outsider).get(bill["attachment"]["url"])
    assert r.status_code == 404 and problem(r) == {"code": "bill-gone"}
    r = await api(desk.fleet_elsewhere).get(bill["attachment"]["url"])
    assert r.status_code == 403

    # Gone from the bucket, the bill says so rather than serving nothing.
    bucket.objects.clear()
    r = await api(desk.director).get(bill["attachment"]["url"])
    assert r.status_code == 404 and problem(r) == {"code": "file-missing"}


async def test_only_a_photo_or_a_pdf_and_only_so_big(  # type: ignore[no-untyped-def]
    api, desk: Desk, file_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    html = await upload(api, desk.clerk, content=b"<html><script>alert(1)</script></html>", name="slip.jpg")
    assert html.status_code == 415 and problem(html) == {"code": "wrong-file"}
    pdf = await upload(api, desk.clerk, content=PDF, name="invoice.pdf")
    assert pdf.status_code == 201 and pdf.json()["mimeType"] == "application/pdf"
    empty = await upload(api, desk.clerk, content=b"")
    assert empty.status_code == 422

    from app.core.settings import get_settings

    monkeypatch.setattr(get_settings(), "file_max_bytes", 64)
    big = await upload(api, desk.clerk, content=JPEG + b"x" * 64)
    assert big.status_code == 413 and problem(big) == {"code": "too-big"}

    no_key = await upload(api, desk.director)
    assert no_key.status_code == 403 and problem(no_key) == {
        "code": "needs-permission",
        "permission": "fleet.expense.upload",
    }


async def test_an_oversized_upload_is_refused_before_its_body_is_read(  # type: ignore[no-untyped-def]
    api, desk: Desk, file_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """FastAPI parses a multipart body before authentication runs, so the cap has to come first."""
    from app.core.settings import get_settings

    monkeypatch.setattr(get_settings(), "file_max_bytes", 1024)
    huge = JPEG + b"x" * (200 * 1024)
    # Not signed in at all: refused for its size before anyone asks who is sending it.
    r = await api().post(
        "/expenses/attachments", files={"file": ("big.jpg", huge, "image/jpeg")}, data={"desk": "fleet"}
    )
    assert r.status_code == 413 and r.json() == {"detail": {"problem": {"code": "too-big"}}}

    async def chunked():  # type: ignore[no-untyped-def]
        # No Content-Length to go by: counted as it arrives.
        yield b'--x\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\n\r\n'
        for _ in range(40):
            yield b"y" * 4096

    r = await api(desk.clerk).post(
        "/expenses/attachments",
        content=chunked(),
        headers={"Content-Type": "multipart/form-data; boundary=x"},
    )
    assert r.status_code == 413 and r.json() == {"detail": {"problem": {"code": "too-big"}}}
    assert not any(file_dir.rglob("*")) or all(p.is_dir() for p in file_dir.rglob("*"))


async def test_another_tenant_can_neither_fetch_a_scan_nor_attach_it(  # type: ignore[no-untyped-def]
    api, desk: Desk, file_dir: Path
) -> None:
    stored = (await upload(api, desk.clerk)).json()
    bill = await raise_bill(api, desk.clerk, desk.plant, attachmentId=stored["id"])
    r = await api(desk.outsider).get(f"/expenses/{bill['id']}/attachment")
    assert r.status_code == 404 and problem(r) == {"code": "bill-gone"}
    r = await api(desk.outsider).get(f"/expenses/{bill['id']}")
    assert r.status_code == 404
    r = await act(api, desk.outsider, bill, "validate")
    assert r.status_code == 404

    # A scan uploaded in one tenant cannot be put on a bill in another: under
    # RLS the other tenant cannot even see that the upload exists.
    unattached = (await upload(api, desk.clerk, content=JPEG + b"2")).json()
    r = await api(desk.outsider).post("/expenses", json=keyed(desk.other_site, attachmentId=unattached["id"]))
    assert r.status_code == 422 and problem(r) == {
        "code": "invalid",
        "field": "attachmentId",
        "reason": "no such upload of yours",
    }


async def test_someone_without_the_read_key_at_the_site_gets_no_scan(  # type: ignore[no-untyped-def]
    api, desk: Desk, file_dir: Path
) -> None:
    stored = (await upload(api, desk.clerk)).json()
    bill = await raise_bill(api, desk.clerk, desk.plant, attachmentId=stored["id"])
    r = await api(desk.fleet_elsewhere).get(f"/expenses/{bill['id']}/attachment")
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "fleet.expense.read",
    }
    r = await api(desk.stores).get(f"/expenses/{bill['id']}/attachment")
    assert r.status_code == 403


async def test_capture_keeps_the_reading_and_credits_the_uploader_with_corrections(  # type: ignore[no-untyped-def]
    api, desk: Desk, file_dir: Path
) -> None:
    stored = (await upload(api, desk.clerk)).json()
    bill = await raise_bill(
        api,
        desk.clerk,
        desk.plant,
        attachmentId=stored["id"],
        amount="41277.60",
        billNumber="BK/48213",
        capture=capture(
            ("billNumber", "BK/48213", "BK/48213"),
            ("amount", "41,277.6", "41277.60"),
            ("vendor", "SAKTHI FUELS", "Sakthi Fuels, Karapakkam"),
            ("vehicle", "TN29AB9999", ""),
            ("litres", None, "432"),
        ),
    )
    assert bill["provenance"] == "overridden"
    fields = {f["key"]: f for f in bill["capture"]["fields"]}
    assert all(set(f) == CAPTURED_FIELD_KEYS for f in fields.values())
    assert (fields["amount"]["overridden"], fields["billNumber"]["overridden"]) == (False, False)
    assert fields["vendor"] == {
        "key": "vendor",
        "label": "vendor",
        "captured": "SAKTHI FUELS",
        "confidence": 2,
        "value": "Sakthi Fuels, Karapakkam",
        "overridden": True,
        "overriddenBy": "Anbu Selvan M",
    }
    assert fields["vehicle"]["overridden"] is False, "a vehicle the form could not pick is not a correction"
    assert (fields["litres"]["captured"], fields["litres"]["confidence"]) == (None, None)
    assert bill["capture"]["warnings"] == [
        {"code": "litres-rate-mismatch", "expected": 41300, "stated": 41277.6}
    ]
    assert set(bill["capture"]) == {"engine", "capturedAt", "fields", "warnings"}

    unknown = await api(desk.fleet).post(
        "/expenses", json=keyed(desk.plant, capture={**capture(), "warnings": [{"code": "made-up"}]})
    )
    assert unknown.status_code == 422


async def test_a_correction_keeps_what_was_read_and_who_corrected_what(  # type: ignore[no-untyped-def]
    api, desk: Desk, file_dir: Path, make_person: Callable[..., Person]
) -> None:
    stored = (await upload(api, desk.clerk)).json()
    bill = await raise_bill(
        api,
        desk.clerk,
        desk.plant,
        attachmentId=stored["id"],
        vendor="Sakthi Fuels",
        capture=capture(("amount", "41277.60", "41277.60"), ("vendor", "SAKTHI FUELS", "Sakthi Fuels")),
    )
    assert bill["provenance"] == "confirmed"

    checker = make_person(
        desk.tenant, "Checker", ["fleet.expense.read", "fleet.expense.validate"], sites=[desk.plant]
    )
    r = await api(checker).patch(f"/expenses/{bill['id']}", json={"amount": "41,277.00"})
    assert r.status_code == 422, "money is typed as digits on the wire"
    r = await api(checker).patch(
        f"/expenses/{bill['id']}", json={"amount": "41270.00", "vendor": "Sakthi Fuels"}
    )
    assert r.status_code == 200, r.text
    corrected = r.json()
    fields = {f["key"]: f for f in corrected["capture"]["fields"]}
    assert corrected["amount"] == "41270.00" and corrected["provenance"] == "overridden"
    assert (fields["amount"]["captured"], fields["amount"]["value"]) == ("41277.60", "41270.00")
    assert (fields["amount"]["overridden"], fields["amount"]["overriddenBy"]) == (True, "Checker")
    assert fields["vendor"]["overridden"] is False

    # A later fix to the vendor by someone else does not make them the author of the amount.
    r = await api(desk.clerk).patch(f"/expenses/{bill['id']}", json={"vendor": "Sakthi Fuels, Karapakkam"})
    fields = {f["key"]: f for f in r.json()["capture"]["fields"]}
    assert fields["amount"]["overriddenBy"] == "Checker"
    assert fields["vendor"]["overriddenBy"] == "Anbu Selvan M"

    validated = (await act(api, checker, r.json(), "validate")).json()
    r = await api(desk.clerk).patch(f"/expenses/{bill['id']}", json={"vendor": "Too late"})
    assert r.status_code == 409 and problem(r) == {
        "code": "wrong-step",
        "status": validated["status"],
        "action": "correct",
    }


# ---------------------------------------------------------------- the list


async def test_the_list_shows_each_desk_where_its_read_key_reaches(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    vehicle = f"veh-{uuid.uuid4().hex[:6]}"
    fleet_bill = await raise_bill(
        api, desk.clerk, desk.plant, vehicleId=vehicle, billDate=(today() - timedelta(days=9)).isoformat()
    )
    stores_bill = await raise_bill(
        api,
        desk.stores,
        desk.workshop,
        desk="stores",
        kind="spares",
        litres=None,
        vehicleId=None,
        driverId=None,
    )

    def ids(response) -> set[str]:  # type: ignore[no-untyped-def]
        assert response.status_code == 200, response.text
        return {b["id"] for b in response.json()}

    assert stores_bill["id"] in ids(await api(desk.stores).get("/expenses"))
    assert fleet_bill["id"] not in ids(await api(desk.stores).get("/expenses"))
    assert fleet_bill["id"] not in ids(await api(desk.fleet_elsewhere).get("/expenses"))
    everything = ids(await api(desk.director).get("/expenses"))
    assert {fleet_bill["id"], stores_bill["id"]} <= everything

    by_vehicle = await api(desk.director).get("/expenses", params={"vehicleId": vehicle})
    assert ids(by_vehicle) == {fleet_bill["id"]}
    window = {
        "from": (today() - timedelta(days=10)).isoformat(),
        "to": (today() - timedelta(days=8)).isoformat(),
    }
    assert fleet_bill["id"] in ids(await api(desk.director).get("/expenses", params=window))
    assert stores_bill["id"] not in ids(await api(desk.director).get("/expenses", params=window))
    assert (
        ids(await api(desk.director).get("/expenses", params={"desk": "stores", "vehicleId": vehicle}))
        == set()
    )
    submitted = await api(desk.director).get(
        "/expenses", params=[("status", "submitted"), ("status", "validated")]
    )
    assert {b["status"] for b in submitted.json()} <= {"submitted", "validated"}

    r = await api(desk.stores).get("/expenses", params={"desk": "fleet"})
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "fleet.expense.read",
    }
    assert ids(await api(desk.outsider).get("/expenses")).isdisjoint(everything)

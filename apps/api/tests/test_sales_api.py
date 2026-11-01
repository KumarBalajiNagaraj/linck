"""Customers and their purchase orders through the API, in the shapes the sales screens read."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from conftest import Person, Tenant

CUSTOMER_KEYS = {
    "id",
    "name",
    "site",
    "gstin",
    "contactName",
    "phone",
    "creditLimit",
    "paymentTermsDays",
    "servedFromSiteId",
}
PURCHASE_ORDER_KEYS = {
    "id",
    "number",
    "customerPoRef",
    "receivedOn",
    "deliverBy",
    "customerId",
    "customerName",
    "deliverySite",
    "siteId",
    "productCode",
    "orderedUnits",
    "dispatchedUnits",
    "ratePerUnit",
    "value",
    "status",
    "takenBy",
}

_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin(pan: str, state: str = "33") -> str:
    """A checksum-valid GSTIN, as buildGstin in packages/domain/src/gstin.ts makes one."""
    body = f"{state}{pan}1Z"
    total = 0
    for i, ch in enumerate(body):
        product = _ALPHABET.index(ch) * (1 if i % 2 == 0 else 2)
        total += product // 36 + product % 36
    return body + _ALPHABET[(36 - total % 36) % 36]


def a_pan() -> str:
    digits = f"{uuid.uuid4().int % 10000:04d}"
    letters = "".join(_ALPHABET[10 + (uuid.uuid4().int % 26)] for _ in range(3))
    return f"AA{letters}{digits}K"


@dataclass(frozen=True)
class Desk:
    tenant: Tenant
    plant: uuid.UUID
    other_plant: uuid.UUID
    coordinator: Person
    manager: Person
    reader_elsewhere: Person
    outsider: Person


@pytest.fixture(scope="module")
def desk(
    make_tenant: Callable[..., Tenant],
    make_site: Callable[..., uuid.UUID],
    make_person: Callable[..., Person],
) -> Desk:
    tenant = make_tenant("sales")
    other_plant = make_site(tenant, "Thiruvallur Crusher", "crusher_plant")
    coordinator = make_person(
        tenant,
        "Vetrivel S",
        ["sales.customer.read", "sales.customer.write", "sales.order.read", "sales.order.write"],
        sites=[tenant.site_id],
    )
    manager = make_person(
        tenant, "Sales Manager", ["sales.customer.read", "sales.order.read", "sales.order.approve"]
    )
    reader = make_person(tenant, "TVL Desk", ["sales.customer.read", "sales.order.read"], sites=[other_plant])
    other = make_tenant("sales-other")
    outsider = make_person(
        other, "Someone Else", ["sales.customer.read", "sales.order.read", "sales.order.approve"]
    )
    return Desk(tenant, tenant.site_id, other_plant, coordinator, manager, reader, outsider)


def customer_body(site: uuid.UUID, **over: object) -> dict:
    body = {
        "name": f"Casagrand Builder {uuid.uuid4().hex[:4]}",
        "site": "Sholinganallur Phase 2",
        "gstin": gstin(a_pan()),
        "contactName": "Arun Prakash",
        "phone": "9840012345",
        "creditLimit": "2500000",
        "paymentTermsDays": 30,
        "servedFromSiteId": str(site),
    }
    body.update(over)
    return body


async def new_customer(api, desk: Desk, **over: object) -> dict:  # type: ignore[no-untyped-def]
    r = await api(desk.coordinator).post("/customers", json=customer_body(desk.plant, **over))
    assert r.status_code == 201, r.text
    return r.json()


def order_body(customer: dict, site: uuid.UUID, **over: object) -> dict:
    body = {
        "customerPoRef": f"PO-CAS-{uuid.uuid4().hex[:4]}",
        "deliverBy": (datetime.now(UTC) + timedelta(days=7)).isoformat(),
        "customerId": customer["id"],
        "siteId": str(site),
        "productCode": "MSAND",
        "orderedUnits": 40,
        "ratePerUnit": "4825.50",
    }
    body.update(over)
    return body


def problem(response) -> dict:  # type: ignore[no-untyped-def]
    return response.json()["detail"]["problem"]


# ---------------------------------------------------------------- customers


async def test_a_customer_comes_back_in_the_mock_shape(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    created = await new_customer(api, desk, creditLimit="2500000")
    assert set(created) == CUSTOMER_KEYS
    assert created["creditLimit"] == "2500000.00" and created["paymentTermsDays"] == 30
    assert created["servedFromSiteId"] == str(desk.plant)

    # Read org-wide: "served from" is a fact about the customer, not a filter.
    listed = await api(desk.reader_elsewhere).get("/customers")
    assert listed.status_code == 200 and created in listed.json()
    got = await api(desk.manager).get(f"/customers/{created['id']}")
    assert got.json() == created


async def test_a_walk_in_customer_has_no_gstin(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    counter = await new_customer(
        api, desk, name="Counter Cash Sale", gstin=None, creditLimit="0", paymentTermsDays=0
    )
    assert (counter["gstin"], counter["creditLimit"]) == (None, "0.00")


async def test_a_gstin_must_be_real_and_unique_in_the_tenant(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    good = gstin(a_pan())
    bad = good[:-1] + ("0" if good[-1] != "0" else "1")
    r = await api(desk.coordinator).post("/customers", json=customer_body(desk.plant, gstin=bad))
    assert r.status_code == 422 and problem(r)["field"] == "gstin"
    await new_customer(api, desk, gstin=good)
    r = await api(desk.coordinator).post("/customers", json=customer_body(desk.plant, gstin=good))
    assert r.status_code == 409 and problem(r) == {"code": "gstin-used", "gstin": good}


async def test_writing_a_customer_needs_the_key_where_they_are_served_from(  # type: ignore[no-untyped-def]
    api, desk: Desk
) -> None:
    r = await api(desk.coordinator).post("/customers", json=customer_body(desk.other_plant))
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "sales.customer.write",
    }
    r = await api(desk.manager).post("/customers", json=customer_body(desk.plant))
    assert r.status_code == 403


async def test_a_customer_is_updated_field_by_field(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    created = await new_customer(api, desk)
    r = await api(desk.coordinator).patch(
        f"/customers/{created['id']}",
        json={"creditLimit": "3000000.50", "paymentTermsDays": 45, "gstin": None},
    )
    assert r.status_code == 200, r.text
    updated = r.json()
    assert (updated["creditLimit"], updated["paymentTermsDays"], updated["gstin"]) == ("3000000.50", 45, None)
    assert updated["name"] == created["name"], "fields not sent stay as they were"
    r = await api(desk.coordinator).patch(
        f"/customers/{created['id']}", json={"servedFromSiteId": str(desk.other_plant)}
    )
    assert r.status_code == 403, "moving a customer to another plant needs the key there too"
    r = await api(desk.coordinator).patch(f"/customers/{created['id']}", json={"name": None})
    assert r.status_code == 422


async def test_another_tenants_customers_do_not_exist(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    created = await new_customer(api, desk)
    assert (await api(desk.outsider).get(f"/customers/{created['id']}")).status_code == 404
    assert created["id"] not in {c["id"] for c in (await api(desk.outsider).get("/customers")).json()}


# -------------------------------------------------------------------- orders


async def test_an_order_is_numbered_valued_and_waits_for_approval(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    customer = await new_customer(api, desk)
    r = await api(desk.coordinator).post("/purchase-orders", json=order_body(customer, desk.plant))
    assert r.status_code == 201, r.text
    order = r.json()
    assert set(order) == PURCHASE_ORDER_KEYS
    now = datetime.now(ZoneInfo("Asia/Kolkata"))
    start = now.year if now.month >= 4 else now.year - 1
    assert order["number"].startswith(f"SO/{start % 100:02d}-{(start + 1) % 100:02d}/")
    assert (order["orderedUnits"], order["dispatchedUnits"]) == (40, 0)
    assert (order["ratePerUnit"], order["value"]) == ("4825.50", "193020.00")
    assert (order["status"], order["takenBy"]) == ("pending_approval", "Vetrivel S")
    assert (order["customerName"], order["deliverySite"]) == (customer["name"], "Sholinganallur Phase 2")

    following = (
        await api(desk.coordinator).post("/purchase-orders", json=order_body(customer, desk.plant))
    ).json()
    serial = int(order["number"].rsplit("/", 1)[1])
    assert following["number"] == order["number"].rsplit("/", 1)[0] + f"/{serial + 1:03d}"


async def test_the_value_is_rounded_to_the_paisa_in_decimal(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    customer = await new_customer(api, desk)
    body = order_body(customer, desk.plant, orderedUnits=7.125, ratePerUnit="3333.33")
    order = (await api(desk.coordinator).post("/purchase-orders", json=body)).json()
    # 7.125 × 3333.33 = 23749.97625 → 23749.98, never a float's 23749.976249999...
    assert (order["orderedUnits"], order["value"]) == (7.125, "23749.98")


async def test_approval_and_rejection_are_the_managers_and_final(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    customer = await new_customer(api, desk)
    first = (
        await api(desk.coordinator).post("/purchase-orders", json=order_body(customer, desk.plant))
    ).json()
    second = (
        await api(desk.coordinator).post("/purchase-orders", json=order_body(customer, desk.plant))
    ).json()

    r = await api(desk.coordinator).post(f"/purchase-orders/{first['id']}/approve", json={})
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "sales.order.approve",
    }
    r = await api(desk.manager).post(
        f"/purchase-orders/{first['id']}/approve", json={"reason": "Rate as per contract"}
    )
    assert r.status_code == 200 and r.json()["status"] == "approved"
    r = await api(desk.manager).post(
        f"/purchase-orders/{first['id']}/reject", json={"reason": "Changed my mind"}
    )
    assert r.status_code == 409 and problem(r) == {
        "code": "wrong-step",
        "status": "approved",
        "action": "reject",
    }

    r = await api(desk.manager).post(f"/purchase-orders/{second['id']}/reject", json={"reason": "  "})
    assert r.status_code == 409 and problem(r) == {"code": "needs-reason", "action": "reject"}
    r = await api(desk.manager).post(
        f"/purchase-orders/{second['id']}/reject", json={"reason": "Credit limit exceeded"}
    )
    assert r.status_code == 200 and r.json()["status"] == "rejected"
    r = await api(desk.manager).post(f"/purchase-orders/{second['id']}/approve", json={})
    assert r.status_code == 409 and problem(r)["code"] == "wrong-step"


async def test_orders_are_read_where_the_read_key_reaches(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    customer = await new_customer(api, desk)
    order = (
        await api(desk.coordinator).post("/purchase-orders", json=order_body(customer, desk.plant))
    ).json()
    r = await api(desk.reader_elsewhere).get(f"/purchase-orders/{order['id']}")
    assert r.status_code == 403
    assert order["id"] not in {
        o["id"] for o in (await api(desk.reader_elsewhere).get("/purchase-orders")).json()
    }
    mine = await api(desk.manager).get(
        "/purchase-orders", params={"customerId": customer["id"], "status": "pending_approval"}
    )
    assert [o["id"] for o in mine.json()] == [order["id"]]
    r = await api(desk.coordinator).post("/purchase-orders", json=order_body(customer, desk.other_plant))
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "sales.order.write",
    }


async def test_another_tenant_can_neither_read_nor_decide_an_order(api, desk: Desk) -> None:  # type: ignore[no-untyped-def]
    customer = await new_customer(api, desk)
    order = (
        await api(desk.coordinator).post("/purchase-orders", json=order_body(customer, desk.plant))
    ).json()
    assert (await api(desk.outsider).get(f"/purchase-orders/{order['id']}")).status_code == 404
    r = await api(desk.outsider).post(f"/purchase-orders/{order['id']}/approve", json={})
    assert r.status_code == 404
    assert (await api(desk.manager).get(f"/purchase-orders/{order['id']}")).json()[
        "status"
    ] == "pending_approval"
    # Nor can an order be raised here against another tenant's customer.
    theirs = {**customer, "id": str(uuid.uuid4())}
    r = await api(desk.coordinator).post("/purchase-orders", json=order_body(theirs, desk.plant))
    assert r.status_code == 404

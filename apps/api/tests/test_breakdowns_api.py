"""The breakdown register through the API: its shape, one live breakdown per vehicle, and scope."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta

import pytest
from conftest import Person, Tenant

BREAKDOWN_KEYS = {
    "id",
    "number",
    "vehicleId",
    "driverId",
    "reportedAt",
    "reportedBy",
    "location",
    "cause",
    "status",
    "resolvedAt",
    "downtimeHours",
    "repairCost",
    # The one addition to the mock shape: the API has no vehicle to find the site through.
    "siteId",
}


@pytest.fixture(scope="module")
def tenant(make_tenant: Callable[..., Tenant]) -> Tenant:
    return make_tenant("breakdowns")


@pytest.fixture(scope="module")
def fleet(tenant: Tenant, make_person: Callable[..., Person]) -> Person:
    return make_person(
        tenant, "Fleet Manager", ["fleet.breakdown.read", "fleet.vehicle.write"], sites=[tenant.site_id]
    )


def reported(site: uuid.UUID, **over: object) -> dict:
    body = {
        "siteId": str(site),
        "vehicleId": f"veh-{uuid.uuid4().hex[:6]}",
        "driverId": "drv-004",
        "reportedAt": (datetime.now(UTC) - timedelta(hours=5)).isoformat(),
        "reportedBy": "Driver (WhatsApp)",
        "location": "GST Road, Chengalpattu",
        "cause": "Gearbox oil leak",
    }
    body.update(over)
    return body


def problem(response) -> dict:  # type: ignore[no-untyped-def]
    return response.json()["detail"]["problem"]


async def test_a_breakdown_is_numbered_and_counts_its_downtime(api, tenant: Tenant, fleet: Person) -> None:  # type: ignore[no-untyped-def]
    r = await api(fleet).post("/breakdowns", json=reported(tenant.site_id))
    assert r.status_code == 201, r.text
    b = r.json()
    assert set(b) == BREAKDOWN_KEYS
    assert b["number"].startswith("BD/") and b["status"] == "open"
    assert (b["resolvedAt"], b["repairCost"], b["reportedBy"]) == (None, None, "Driver (WhatsApp)")
    assert 4.9 <= b["downtimeHours"] <= 5.1, "an open breakdown counts to now"

    moved = await api(fleet).patch(
        f"/breakdowns/{b['id']}", json={"status": "in_workshop", "cause": "Gearbox seal"}
    )
    assert moved.status_code == 200 and (moved.json()["status"], moved.json()["cause"]) == (
        "in_workshop",
        "Gearbox seal",
    )

    resolved_at = datetime.now(UTC) - timedelta(hours=1)
    done = await api(fleet).post(
        f"/breakdowns/{b['id']}/resolve", json={"resolvedAt": resolved_at.isoformat(), "repairCost": "18500"}
    )
    assert done.status_code == 200, done.text
    closed = done.json()
    assert (closed["status"], closed["repairCost"], closed["downtimeHours"]) == ("resolved", "18500.00", 4)

    # The repair bill often arrives after the vehicle is back; nothing else changes once resolved.
    later = await api(fleet).patch(f"/breakdowns/{b['id']}", json={"repairCost": "19250.50"})
    assert later.status_code == 200 and later.json()["repairCost"] == "19250.50"
    r = await api(fleet).patch(f"/breakdowns/{b['id']}", json={"cause": "Something else"})
    assert r.status_code == 409 and problem(r) == {
        "code": "wrong-step",
        "status": "resolved",
        "action": "update",
    }
    r = await api(fleet).post(f"/breakdowns/{b['id']}/resolve", json={})
    assert r.status_code == 409


async def test_a_vehicle_is_down_once_at_a_time(api, tenant: Tenant, fleet: Person) -> None:  # type: ignore[no-untyped-def]
    first = (await api(fleet).post("/breakdowns", json=reported(tenant.site_id, vehicleId="veh-777"))).json()
    r = await api(fleet).post("/breakdowns", json=reported(tenant.site_id, vehicleId="veh-777"))
    assert r.status_code == 409 and problem(r) == {"code": "vehicle-already-down", "vehicle": "veh-777"}
    await api(fleet).post(f"/breakdowns/{first['id']}/resolve", json={})
    again = await api(fleet).post("/breakdowns", json=reported(tenant.site_id, vehicleId="veh-777"))
    assert again.status_code == 201, "once it is back on the road it can break down again"


async def test_resolving_cannot_be_dated_before_the_report_or_after_now(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, fleet: Person
) -> None:
    b = (await api(fleet).post("/breakdowns", json=reported(tenant.site_id))).json()
    too_early = (datetime.now(UTC) - timedelta(hours=9)).isoformat()
    r = await api(fleet).post(f"/breakdowns/{b['id']}/resolve", json={"resolvedAt": too_early})
    assert r.status_code == 422 and problem(r)["field"] == "resolvedAt"
    r = await api(fleet).post(
        f"/breakdowns/{b['id']}/resolve",
        json={"resolvedAt": (datetime.now(UTC) + timedelta(hours=1)).isoformat()},
    )
    assert r.status_code == 422


async def test_the_register_is_read_and_written_at_the_vehicles_site(  # type: ignore[no-untyped-def]
    api,
    tenant: Tenant,
    fleet: Person,
    make_site: Callable[..., uuid.UUID],
    make_person: Callable[..., Person],
    make_tenant: Callable[..., Tenant],
) -> None:
    elsewhere = make_site(tenant, "Thiruvallur Crusher", "crusher_plant")
    reader_elsewhere = make_person(tenant, "TVL Reader", ["fleet.breakdown.read"], sites=[elsewhere])
    reader_here = make_person(tenant, "KRP Reader", ["fleet.breakdown.read"], sites=[tenant.site_id])
    b = (await api(fleet).post("/breakdowns", json=reported(tenant.site_id))).json()

    assert b["id"] in {x["id"] for x in (await api(reader_here).get("/breakdowns")).json()}
    assert b["id"] not in {x["id"] for x in (await api(reader_elsewhere).get("/breakdowns")).json()}
    assert (await api(reader_elsewhere).get(f"/breakdowns/{b['id']}")).status_code == 403
    r = await api(reader_here).patch(f"/breakdowns/{b['id']}", json={"cause": "x"})
    assert r.status_code == 403 and problem(r) == {
        "code": "needs-permission",
        "permission": "fleet.vehicle.write",
    }
    r = await api(fleet).post("/breakdowns", json=reported(elsewhere))
    assert r.status_code == 403
    live = await api(reader_here).get("/breakdowns", params=[("status", "open"), ("status", "in_workshop")])
    assert {x["status"] for x in live.json()} <= {"open", "in_workshop"}

    outsider = make_person(
        make_tenant("breakdowns-other"), "Someone Else", ["fleet.breakdown.read", "fleet.vehicle.write"]
    )
    assert (await api(outsider).get(f"/breakdowns/{b['id']}")).status_code == 404
    assert (await api(outsider).post(f"/breakdowns/{b['id']}/resolve", json={})).status_code == 404

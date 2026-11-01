"""WhatsApp diesel imports: each driver's message becomes a bill once, however often it is imported."""

from __future__ import annotations

import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import psycopg
import pytest
from conftest import Person, Tenant

BILL_SOURCE_KEYS = {"channel", "claimKey", "via", "sender", "postedAt", "message", "attachments"}
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00 a bunk slip"


@pytest.fixture(scope="module")
def tenant(make_tenant: Callable[..., Tenant]) -> Tenant:
    return make_tenant("whatsapp-import")


@pytest.fixture(scope="module")
def fleet(tenant: Tenant, make_person: Callable[..., Person]) -> Person:
    return make_person(
        tenant, "Fleet Manager", ["fleet.expense.read", "fleet.expense.upload", "fleet.expense.validate"]
    )


def claim(site: uuid.UUID, key: str | None = None, *, message: str = "", **bill: object) -> dict:
    posted = datetime(2026, 8, 7, 4, 15, tzinfo=UTC)
    return {
        "claimKey": key or f"2026-08-07T04:15|{uuid.uuid4().hex}|1",
        "sender": "+91 95782 46168",
        "postedAt": posted.isoformat(),
        "message": message,
        "attachments": ["IMG-20260807-WA0001.jpg"],
        "bill": {
            "siteId": str(site),
            "vehicleId": "veh-001",
            "driverId": "drv-001",
            "billNumber": "BK/48213",
            "billDate": "2026-08-07",
            "vendor": "Sakthi Fuels, Karapakkam",
            "litres": 432,
            "amount": "41277.60",
            "submittedBy": "Murugan S",
            "submittedById": "driver:drv-001",
            "capture": {
                "engine": "WhatsApp message + slip (tesseract.js 5)",
                "capturedAt": posted.isoformat(),
                "warnings": [
                    {"code": "photo-only"},
                    {"code": "rate-out-of-band", "rate": 125.4, "min": 80, "max": 120},
                ],
                "fields": [
                    {
                        "key": "vehicle",
                        "label": "Vehicle",
                        "captured": "1001",
                        "confidence": 2,
                        "value": "TN29AB1001",
                    },
                    {
                        "key": "amount",
                        "label": "Amount",
                        "captured": "41277.6",
                        "confidence": 3,
                        "value": "41277.60",
                    },
                ],
            },
            **bill,
        },
    }


async def test_claims_become_proposed_fleet_diesel_bills_raised_by_the_driver(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, fleet: Person
) -> None:
    sent = claim(tenant.site_id, message="432 ltr 41277")
    r = await api(fleet).post(
        "/whatsapp/imports", json={"source": "export", "via": "Tippers KRP", "claims": [sent]}
    )
    assert r.status_code == 201, r.text
    result = r.json()
    assert set(result) == {"batch", "imported", "skipped"}
    assert result["skipped"] == []
    batch = result["batch"]
    assert (
        batch["source"],
        batch["via"],
        batch["claimsReceived"],
        batch["claimsImported"],
        batch["claimsSkipped"],
    ) == (
        "export",
        "Tippers KRP",
        1,
        1,
        0,
    )
    assert batch["importedBy"] == "Fleet Manager"

    [bill] = result["imported"]
    assert (bill["desk"], bill["kind"], bill["status"], bill["provenance"]) == (
        "fleet",
        "diesel",
        "submitted",
        "proposed",
    )
    assert (bill["submittedBy"], bill["submittedById"]) == ("Murugan S", "driver:drv-001")
    assert bill["submittedAt"] == "2026-08-07T04:15:00Z", "raised when the driver sent it"
    assert set(bill["source"]) == BILL_SOURCE_KEYS
    assert bill["source"] == {
        "channel": "whatsapp",
        "claimKey": sent["claimKey"],
        "via": "Tippers KRP",
        "sender": "+91 95782 46168",
        "postedAt": "2026-08-07T04:15:00Z",
        "message": "432 ltr 41277",
        "attachments": ["IMG-20260807-WA0001.jpg"],
    }
    # Nobody has corrected anything yet; the reconciliation is not a person.
    assert not any(f["overridden"] for f in bill["capture"]["fields"])
    assert bill["capture"]["warnings"][1] == {
        "code": "rate-out-of-band",
        "rate": 125.4,
        "min": 80,
        "max": 120,
    }

    # The importer is not the submitter, so validating is a clean second pair of
    # eyes, and confirms the reading.
    r = await api(fleet).post(f"/expenses/{bill['id']}/actions", json={"action": "validate"})
    assert r.status_code == 200, r.text
    assert r.json()["history"][0]["exception"] is False and r.json()["provenance"] == "confirmed"


async def test_a_re_import_adds_only_what_is_new_and_says_what_it_skipped(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, fleet: Person, admin: psycopg.Connection
) -> None:
    first, second = claim(tenant.site_id), claim(tenant.site_id)
    one = await api(fleet).post("/whatsapp/imports", json={"source": "inbox", "claims": [first, second]})
    assert one.status_code == 201
    first_import = one.json()["batch"]["importedAt"]

    # The same export again, from another phone, with one message the first did not have.
    third = claim(tenant.site_id)
    again = await api(fleet).post(
        "/whatsapp/imports", json={"source": "export", "via": "Tippers", "claims": [first, second, third]}
    )
    assert again.status_code == 201, again.text
    result = again.json()
    assert [b["source"]["claimKey"] for b in result["imported"]] == [third["claimKey"]]
    assert result["skipped"] == [
        {"claimKey": first["claimKey"], "reason": {"code": "already-imported", "on": first_import}},
        {"claimKey": second["claimKey"], "reason": {"code": "already-imported", "on": first_import}},
    ]
    assert (
        result["batch"]["claimsReceived"],
        result["batch"]["claimsImported"],
        result["batch"]["claimsSkipped"],
    ) == (
        3,
        1,
        2,
    )
    with admin.cursor() as cur:
        cur.execute(
            "SELECT count(*) FROM finance.expense_bills b JOIN finance.whatsapp_import_claims c"
            " ON c.id = b.whatsapp_claim_id WHERE c.claim_key = ANY(%s)",
            ([first["claimKey"], second["claimKey"], third["claimKey"]],),
        )
        assert cur.fetchone()[0] == 3, "one bill per message, never two"

    # The same message twice in one import is one bill too.
    fourth = claim(tenant.site_id)
    twice = await api(fleet).post("/whatsapp/imports", json={"source": "export", "claims": [fourth, fourth]})
    assert len(twice.json()["imported"]) == 1 and twice.json()["skipped"][0]["claimKey"] == fourth["claimKey"]


async def test_the_claim_key_is_per_tenant(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, fleet: Person, make_tenant: Callable[..., Tenant], make_person: Callable[..., Person]
) -> None:
    other = make_tenant("whatsapp-import-other")
    other_fleet = make_person(other, "Other Fleet", ["fleet.expense.read", "fleet.expense.upload"])
    key = f"shared|{uuid.uuid4().hex}|1"
    assert (
        len(
            (
                await api(fleet).post(
                    "/whatsapp/imports", json={"source": "export", "claims": [claim(tenant.site_id, key)]}
                )
            ).json()["imported"]
        )
        == 1
    )
    theirs = await api(other_fleet).post(
        "/whatsapp/imports", json={"source": "export", "claims": [claim(other.site_id, key)]}
    )
    assert len(theirs.json()["imported"]) == 1, "another tenant's imports neither block nor reveal this one"


async def test_an_import_needs_the_fleet_upload_key_at_every_bills_site(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, make_site: Callable[..., uuid.UUID], make_person: Callable[..., Person]
) -> None:
    elsewhere = make_site(tenant, "Thiruvallur Crusher", "crusher_plant")
    scoped = make_person(
        tenant, "Scoped Fleet", ["fleet.expense.read", "fleet.expense.upload"], sites=[tenant.site_id]
    )
    r = await api(scoped).post("/whatsapp/imports", json={"source": "export", "claims": [claim(elsewhere)]})
    assert r.status_code == 403 and r.json()["detail"]["problem"] == {
        "code": "needs-permission",
        "permission": "fleet.expense.upload",
    }
    reader = make_person(tenant, "Reader", ["fleet.expense.read"])
    assert (await api(reader).get("/whatsapp/imports")).status_code == 403
    # A user cannot be passed off as the driver who raised it.
    forged = claim(tenant.site_id, submittedById=f"user:{uuid.uuid4()}")
    assert (
        await api(scoped).post("/whatsapp/imports", json={"source": "export", "claims": [forged]})
    ).status_code == 422


async def test_imports_are_listed_newest_first_and_inbox_messages_are_marked(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, fleet: Person, admin: psycopg.Connection, file_dir: Path
) -> None:
    message_id = uuid.uuid4()
    with admin.cursor() as cur:
        cur.execute(
            "INSERT INTO core.whatsapp_messages"
            " (id, organization_id, wamid, phone_number_id, from_phone, sent_at, kind)"
            " VALUES (%s, %s, %s, '1098', '919578246168', now(), 'image')",
            (message_id, tenant.org_id, f"wamid.{uuid.uuid4().hex}"),
        )
    photo = await api(fleet).post(
        "/expenses/attachments", files={"file": ("wa.jpg", JPEG, "image/jpeg")}, data={"desk": "fleet"}
    )
    sent = claim(tenant.site_id, attachmentId=photo.json()["id"])
    r = await api(fleet).post(
        "/whatsapp/imports", json={"source": "inbox", "inboxMessageIds": [str(message_id)], "claims": [sent]}
    )
    assert r.status_code == 201, r.text
    [bill] = r.json()["imported"]
    assert bill["attachment"]["url"] == f"/expenses/{bill['id']}/attachment"
    assert (await api(fleet).get(bill["attachment"]["url"])).content == JPEG

    with admin.cursor() as cur:
        cur.execute(
            "SELECT imported_at IS NOT NULL, imported_by FROM core.whatsapp_messages WHERE id = %s",
            (message_id,),
        )
        assert cur.fetchone() == (True, fleet.user_id)

    listed = await api(fleet).get("/whatsapp/imports")
    assert listed.status_code == 200
    batches = listed.json()
    assert batches[0]["id"] == r.json()["batch"]["id"]
    stamps = [b["importedAt"] for b in batches]
    assert stamps == sorted(stamps, reverse=True)
    assert set(batches[0]) == {
        "id",
        "source",
        "via",
        "claimsReceived",
        "claimsImported",
        "claimsSkipped",
        "importedBy",
        "importedAt",
    }
    assert datetime.fromisoformat(batches[0]["importedAt"]) > datetime.now(UTC) - timedelta(minutes=5)

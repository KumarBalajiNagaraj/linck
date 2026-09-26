"""WhatsApp intake: Meta's signature, its payload shape, and storage under RLS.

The webhook is the one route in the API that nobody signs in to, so the two
things that stand between the internet and the expense ledger — the HMAC
signature and the tenant it writes under — are tested directly.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import uuid
from datetime import UTC, datetime

import httpx
import pytest
from conftest import Tenant
from sqlalchemy import select

from app.api import whatsapp as intake
from app.core.db import tenant_session
from app.core.settings import get_settings
from app.integrations.whatsapp import WhatsAppClient, messages_from_webhook, verify_signature
from app.models.core import WhatsAppMessage

SECRET = "test-app-secret"
PHONE_NUMBER_ID = "109876543210"


def signed(body: bytes, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def payload(*messages: dict, contacts: list[dict] | None = None) -> dict:
    return {
        "object": "whatsapp_business_account",
        "entry": [
            {
                "id": "WABA",
                "changes": [
                    {
                        "field": "messages",
                        "value": {
                            "messaging_product": "whatsapp",
                            "metadata": {
                                "display_phone_number": "919840000000",
                                "phone_number_id": PHONE_NUMBER_ID,
                            },
                            "contacts": contacts
                            or [{"wa_id": "919578246168", "profile": {"name": "Murugan"}}],
                            "messages": list(messages),
                        },
                    }
                ],
            }
        ],
    }


# A driver who cannot type: the slip photo, nothing else.
SLIP_PHOTO = {
    "from": "919578246168",
    "id": "wamid.HBgMOTE5NTc4MjQ2MTY4FQIAEhgUM0",
    "timestamp": "1786332120",
    "type": "image",
    "image": {"id": "1203987654321", "mime_type": "image/jpeg", "sha256": "abc"},
}


def test_signature_is_checked_against_the_raw_body() -> None:
    body = json.dumps(payload(SLIP_PHOTO)).encode()
    assert verify_signature(SECRET, body, signed(body))
    assert not verify_signature(SECRET, body + b" ", signed(body))
    assert not verify_signature(SECRET, body, signed(body, "someone-else"))
    assert not verify_signature(SECRET, body, None)
    # No secret configured is never "anything goes".
    assert not verify_signature("", body, signed(body, ""))


def test_a_photo_with_no_words_is_a_message() -> None:
    [m] = messages_from_webhook(payload(SLIP_PHOTO))
    assert m.kind == "image"
    assert m.caption == ""
    assert m.media_id == "1203987654321"
    assert m.from_phone == "919578246168"
    assert m.sender_name == "Murugan"
    assert m.sent_at == datetime.fromtimestamp(1786332120, tz=UTC)


def test_captions_and_text_are_kept_and_statuses_ignored() -> None:
    captioned = {**SLIP_PHOTO, "id": "wamid.2", "image": {**SLIP_PHOTO["image"], "caption": "1001 diesel"}}
    text = {
        "from": "919578246168",
        "id": "wamid.3",
        "timestamp": "1786332180",
        "type": "text",
        "text": {"body": "432 ltr"},
    }
    statuses = payload()
    statuses["entry"][0]["changes"][0]["value"] = {
        "metadata": {"phone_number_id": PHONE_NUMBER_ID},
        "statuses": [{"id": "x"}],
    }
    got = messages_from_webhook(payload(captioned, text))
    assert [(m.kind, m.caption, m.has_media) for m in got] == [
        ("image", "1001 diesel", True),
        ("text", "432 ltr", False),
    ]
    assert messages_from_webhook(statuses) == []


@pytest.fixture
def configured(monkeypatch: pytest.MonkeyPatch, tenant_a: Tenant, tmp_path) -> None:
    settings = get_settings()
    monkeypatch.setattr(settings, "whatsapp_app_secret", SECRET)
    monkeypatch.setattr(settings, "whatsapp_organization_id", str(tenant_a.org_id))
    monkeypatch.setattr(settings, "whatsapp_phone_number_id", PHONE_NUMBER_ID)
    monkeypatch.setattr(settings, "whatsapp_access_token", "token")
    monkeypatch.setattr(settings, "whatsapp_media_dir", str(tmp_path))


async def test_a_retried_delivery_is_stored_once(
    configured: None, tenant_a: Tenant, tenant_b: Tenant
) -> None:
    wamid = f"wamid.{uuid.uuid4().hex}"
    [message] = messages_from_webhook(payload({**SLIP_PHOTO, "id": wamid}))
    first = await intake.store_messages(str(tenant_a.org_id), [message])
    again = await intake.store_messages(str(tenant_a.org_id), [message])
    assert len(first) == 1
    assert again == []
    async with tenant_session(tenant_a.org_id) as db:
        assert (
            len((await db.scalars(select(WhatsAppMessage).where(WhatsAppMessage.wamid == wamid))).all()) == 1
        )
    # Another tenant cannot see the driver's photo.
    async with tenant_session(tenant_b.org_id) as db:
        assert (await db.scalars(select(WhatsAppMessage).where(WhatsAppMessage.wamid == wamid))).all() == []


async def test_the_photo_is_fetched_kept_by_hash_and_acknowledged(
    configured: None, tenant_a: Tenant, tmp_path
) -> None:
    jpeg = b"\xff\xd8\xff fake slip"
    calls: list[tuple[str, str]] = []

    def graph(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["Authorization"] == "Bearer token"
        if request.url.path.endswith("/1203987654321"):
            return httpx.Response(
                200, json={"url": "https://lookaside.example/slip", "mime_type": "image/jpeg"}
            )
        if request.url.host == "lookaside.example":
            return httpx.Response(200, content=jpeg)
        if request.url.path.endswith("/messages"):
            body = json.loads(request.content)
            assert body["type"] == "reaction" and body["reaction"]["emoji"] == "👍"
            return httpx.Response(200, json={"messages": [{"id": "wamid.ack"}]})
        return httpx.Response(404)

    client = WhatsAppClient(
        "https://graph.example/v21.0",
        "token",
        PHONE_NUMBER_ID,
        http=httpx.AsyncClient(transport=httpx.MockTransport(graph)),
    )
    [message] = messages_from_webhook(payload({**SLIP_PHOTO, "id": f"wamid.{uuid.uuid4().hex}"}))
    [(row_id, _)] = await intake.store_messages(str(tenant_a.org_id), [message])
    await intake.fetch_media(row_id, message, client)

    digest = hashlib.sha256(jpeg).hexdigest()
    assert (tmp_path / f"{digest}.jpg").read_bytes() == jpeg
    async with tenant_session(tenant_a.org_id) as db:
        row = await db.get(WhatsAppMessage, row_id)
        assert (
            row is not None
            and row.media_sha256 == digest
            and row.media_bytes == len(jpeg)
            and row.media_error is None
        )
    assert ("POST", f"/v21.0/{PHONE_NUMBER_ID}/messages") in calls
    await client.aclose()


async def test_a_failed_download_is_recorded_not_lost(configured: None, tenant_a: Tenant) -> None:
    client = WhatsAppClient(
        "https://graph.example/v21.0",
        "token",
        PHONE_NUMBER_ID,
        http=httpx.AsyncClient(transport=httpx.MockTransport(lambda r: httpx.Response(404))),
    )
    [message] = messages_from_webhook(payload({**SLIP_PHOTO, "id": f"wamid.{uuid.uuid4().hex}"}))
    [(row_id, _)] = await intake.store_messages(str(tenant_a.org_id), [message])
    await intake.fetch_media(row_id, message, client)
    async with tenant_session(tenant_a.org_id) as db:
        row = await db.get(WhatsAppMessage, row_id)
        assert row is not None and row.media_sha256 is None and "lookup failed" in (row.media_error or "")
    await client.aclose()


async def test_the_webhook_route_refuses_unsigned_posts_and_stores_signed_ones(
    configured: None, tenant_a: Tenant, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.main import app

    fetched: list[str] = []

    async def no_network(row_id: uuid.UUID, message, client=None) -> None:  # type: ignore[no-untyped-def]
        fetched.append(message.wamid)

    monkeypatch.setattr(intake, "fetch_media", no_network)
    wamid = f"wamid.{uuid.uuid4().hex}"
    body = json.dumps(payload({**SLIP_PHOTO, "id": wamid})).encode()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://api") as http:
        forged = await http.post(
            "/webhooks/whatsapp", content=body, headers={"X-Hub-Signature-256": signed(body, "guess")}
        )
        assert forged.status_code == 401
        ok = await http.post(
            "/webhooks/whatsapp",
            content=body,
            headers={"X-Hub-Signature-256": signed(body), "Content-Type": "application/json"},
        )
        assert ok.status_code == 200
        assert ok.json() == {"received": 1, "stored": 1}
        retried = await http.post(
            "/webhooks/whatsapp", content=body, headers={"X-Hub-Signature-256": signed(body)}
        )
        assert retried.json() == {"received": 1, "stored": 0}
    assert fetched == [wamid]


async def test_the_subscription_handshake(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.main import app

    monkeypatch.setattr(get_settings(), "whatsapp_verify_token", "linck-verify")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://api") as http:
        ok = await http.get(
            "/webhooks/whatsapp",
            params={"hub.mode": "subscribe", "hub.verify_token": "linck-verify", "hub.challenge": "42"},
        )
        assert ok.status_code == 200 and ok.text == "42"
        bad = await http.get(
            "/webhooks/whatsapp",
            params={"hub.mode": "subscribe", "hub.verify_token": "nope", "hub.challenge": "42"},
        )
        assert bad.status_code == 403

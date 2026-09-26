"""WhatsApp intake: Meta's webhook in, the fleet manager's inbox out.

    driver ──photo──▶ WhatsApp Business number ──webhook──▶ POST /webhooks/whatsapp
                                                             │ signature checked
                                                             │ one row per message id
                                                             │ photo downloaded, 👍 reaction sent
                                                             ▼
                              fleet manager ◀── GET /whatsapp/inbox ── core.whatsapp_messages
                                   │ reads each slip, reviews, adds bills
                                   └──▶ POST /whatsapp/inbox/imported

The webhook answers fast and always 200 once the signature is good, because
Meta retries anything slower or unhappy; the photo is fetched after the
response. Storing by message id makes a retried delivery a no-op.
"""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, PlainTextResponse
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from app.api.deps import CurrentSession, require
from app.core.db import tenant_session
from app.core.settings import Settings, get_settings
from app.integrations.whatsapp import (
    InboundMessage,
    WhatsAppClient,
    WhatsAppError,
    media_extension,
    messages_from_webhook,
    verify_signature,
)
from app.models.core import WhatsAppMessage

log = logging.getLogger("linck.whatsapp")

webhook_router = APIRouter(prefix="/webhooks/whatsapp", tags=["whatsapp"])
router = APIRouter(prefix="/whatsapp", tags=["whatsapp"])

# Importing slips is part of raising fleet bills; no separate key is needed.
IMPORT_PERMISSION = "fleet.expense.upload"


def _configured(settings: Settings) -> bool:
    return bool(settings.whatsapp_app_secret and settings.whatsapp_organization_id)


@webhook_router.get("", response_class=PlainTextResponse)
async def verify_subscription(
    mode: Annotated[str, Query(alias="hub.mode")] = "",
    token: Annotated[str, Query(alias="hub.verify_token")] = "",
    challenge: Annotated[str, Query(alias="hub.challenge")] = "",
) -> str:
    """The handshake Meta makes once, when the webhook URL is saved in the app dashboard."""
    settings = get_settings()
    if mode == "subscribe" and settings.whatsapp_verify_token and token == settings.whatsapp_verify_token:
        return challenge
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Verification token does not match")


@webhook_router.post("")
async def receive(request: Request, background: BackgroundTasks) -> dict[str, int]:
    settings = get_settings()
    if not _configured(settings):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="WhatsApp intake is not configured"
        )
    body = await request.body()
    if not verify_signature(settings.whatsapp_app_secret, body, request.headers.get("X-Hub-Signature-256")):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad signature")
    try:
        payload: dict[str, Any] = json.loads(body)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Body is not JSON") from exc

    messages = [
        m
        for m in messages_from_webhook(payload)
        # A number is one tenant's. Messages to any other number on the same
        # Meta app are not ours to keep.
        if not settings.whatsapp_phone_number_id or m.phone_number_id == settings.whatsapp_phone_number_id
    ]
    stored = await store_messages(settings.whatsapp_organization_id, messages)
    for row_id, message in stored:
        if message.has_media:
            background.add_task(fetch_media, row_id, message)
    return {"received": len(messages), "stored": len(stored)}


async def store_messages(
    organization_id: str, messages: list[InboundMessage]
) -> list[tuple[uuid.UUID, InboundMessage]]:
    """Insert each message once. Returns only the ones that were new."""
    new: list[tuple[uuid.UUID, InboundMessage]] = []
    if not messages:
        return new
    async with tenant_session(organization_id) as db:
        for m in messages:
            stmt = (
                insert(WhatsAppMessage)
                .values(
                    organization_id=uuid.UUID(organization_id),
                    wamid=m.wamid,
                    phone_number_id=m.phone_number_id,
                    from_phone=m.from_phone,
                    sender_name=m.sender_name,
                    sent_at=m.sent_at,
                    kind=m.kind,
                    caption=m.caption,
                    media_id=m.media_id,
                    media_mime=m.media_mime,
                    media_filename=m.media_filename,
                )
                .on_conflict_do_nothing(index_elements=["organization_id", "wamid"])
                .returning(WhatsAppMessage.id)
            )
            row_id = (await db.execute(stmt)).scalar_one_or_none()
            if row_id is not None:
                new.append((row_id, m))
    return new


async def fetch_media(
    row_id: uuid.UUID, message: InboundMessage, client: WhatsAppClient | None = None
) -> None:
    """Download the photo while its media id is still valid, keep it by content hash, and react 👍."""
    settings = get_settings()
    own_client = client is None
    try:
        client = client or WhatsAppClient(
            settings.whatsapp_graph_url, settings.whatsapp_access_token, settings.whatsapp_phone_number_id
        )
    except WhatsAppError as exc:
        await _record_media(row_id, error=str(exc))
        return
    try:
        content, mime = await client.download_media(message.media_id or "")
        digest = hashlib.sha256(content).hexdigest()
        folder = Path(settings.whatsapp_media_dir)
        folder.mkdir(parents=True, exist_ok=True)
        (folder / f"{digest}{media_extension(mime or message.media_mime)}").write_bytes(content)
        await _record_media(row_id, sha256=digest, size=len(content), mime=mime or message.media_mime)
        if settings.whatsapp_react_on_receipt:
            try:
                await client.react(message.from_phone, message.wamid)
            except WhatsAppError as exc:
                # The photo is safe; a missing thumbs-up is not worth failing over.
                log.warning("reaction to %s failed: %s", message.wamid, exc)
    except WhatsAppError as exc:
        log.error("media for %s: %s", message.wamid, exc)
        await _record_media(row_id, error=str(exc))
    finally:
        if own_client:
            await client.aclose()


async def _record_media(
    row_id: uuid.UUID,
    *,
    sha256: str | None = None,
    size: int | None = None,
    mime: str | None = None,
    error: str | None = None,
) -> None:
    settings = get_settings()
    async with tenant_session(settings.whatsapp_organization_id) as db:
        await db.execute(
            update(WhatsAppMessage)
            .where(WhatsAppMessage.id == row_id)
            .values(media_sha256=sha256, media_bytes=size, media_mime=mime, media_error=error)
        )


# ---------------------------------------------------------------------------
# The fleet manager's side
# ---------------------------------------------------------------------------


class InboxMessage(BaseModel):
    id: uuid.UUID
    wamid: str
    from_phone: str
    sender_name: str | None
    sent_at: datetime
    kind: str
    caption: str
    media_url: str | None
    media_mime: str | None
    media_error: str | None
    imported_at: datetime | None


ImportDep = Annotated[CurrentSession, Depends(require(IMPORT_PERMISSION))]


@router.get("/inbox", response_model=list[InboxMessage])
async def inbox(
    current: ImportDep, include_imported: bool = False, limit: int = Query(500, le=2000)
) -> list[InboxMessage]:
    """Messages waiting to be imported, oldest first — the order the fills happened in."""
    stmt = select(WhatsAppMessage).order_by(WhatsAppMessage.sent_at).limit(limit)
    if not include_imported:
        stmt = stmt.where(WhatsAppMessage.imported_at.is_(None))
    rows = (await current.db.scalars(stmt)).all()
    return [
        InboxMessage(
            id=r.id,
            wamid=r.wamid,
            from_phone=r.from_phone,
            sender_name=r.sender_name,
            sent_at=r.sent_at,
            kind=r.kind,
            caption=r.caption,
            media_url=f"/whatsapp/media/{r.id}" if r.media_sha256 else None,
            media_mime=r.media_mime,
            media_error=r.media_error,
            imported_at=r.imported_at,
        )
        for r in rows
    ]


@router.get("/media/{message_id}")
async def media(message_id: uuid.UUID, current: ImportDep) -> FileResponse:
    row = await current.db.get(WhatsAppMessage, message_id)
    if row is None or not row.media_sha256:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No photo for that message")
    path = Path(get_settings().whatsapp_media_dir) / f"{row.media_sha256}{media_extension(row.media_mime)}"
    if not path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="The photo is no longer on disk")
    return FileResponse(path, media_type=row.media_mime or "application/octet-stream")


class ImportedBody(BaseModel):
    ids: list[uuid.UUID]


@router.post("/inbox/imported")
async def mark_imported(body: ImportedBody, current: ImportDep) -> dict[str, int]:
    """Taken into the ledger: off the inbox, but kept, with who took it and when."""
    result = await current.db.execute(
        update(WhatsAppMessage)
        .where(WhatsAppMessage.id.in_(body.ids), WhatsAppMessage.imported_at.is_(None))
        .values(imported_at=datetime.now(tz=UTC), imported_by=current.user.id)
    )
    return {"imported": result.rowcount or 0}

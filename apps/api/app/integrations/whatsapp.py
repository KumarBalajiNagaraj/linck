"""WhatsApp Business Cloud API: what Meta sends us, and the three calls we make back.

Most drivers cannot read or write, so the intake is built around a photo, not
a message: a driver fills diesel, photographs the bunk's slip and sends the
photo to the fleet's WhatsApp Business number. That is the whole of their
part. Meta posts the message to our webhook; we keep the photo, and the fleet
manager's import reads the slip. A thumbs-up reaction on the driver's photo is
the receipt — a driver who cannot read a reply can still see it.

Two limits of the platform shape this, and are worth knowing before anyone
asks for "just read the drivers' group":

- The Cloud API receives messages sent TO the business number. It cannot read
  an ordinary WhatsApp group the number is not a party to. Drivers send slips
  to the number directly (it can be pinned in their chat list), or the
  group's "Export chat" file is imported instead — both paths end in the same
  claim reader.
- Media ids expire. A photo is downloaded as soon as its webhook arrives; the
  URL Meta returns for a media id is short-lived and needs the access token.

Pure parsing and signature checks live here with no I/O, so they are tested
without a network; `WhatsAppClient` holds the three HTTP calls.
"""

from __future__ import annotations

import hashlib
import hmac
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

import httpx

MEDIA_KINDS = frozenset({"image", "document"})


def verify_signature(app_secret: str, body: bytes, header: str | None) -> bool:
    """Meta signs every webhook POST: `X-Hub-Signature-256: sha256=<hex HMAC of the raw body>`.

    Compared in constant time. An empty secret never verifies — an unsigned
    webhook would let anyone on the internet post bills into the ledger.
    """
    if not app_secret or not header or not header.startswith("sha256="):
        return False
    expected = hmac.new(app_secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header.removeprefix("sha256="))


@dataclass(frozen=True)
class InboundMessage:
    """One message from a driver, as the claim reader needs it."""

    wamid: str
    phone_number_id: str
    from_phone: str
    sender_name: str | None
    sent_at: datetime
    kind: str
    caption: str
    media_id: str | None
    media_mime: str | None
    media_filename: str | None

    @property
    def has_media(self) -> bool:
        return self.media_id is not None


def messages_from_webhook(payload: dict[str, Any]) -> list[InboundMessage]:
    """Every message in a webhook payload; delivery statuses and anything unknown are skipped.

    The payload is `entry[].changes[].value`, whose `messages[]` carry the
    sender's number in `from`, and whose `contacts[]` carry the name the
    driver set on their own phone — shown, never trusted for identity.
    """
    out: list[InboundMessage] = []
    for entry in payload.get("entry") or []:
        for change in entry.get("changes") or []:
            if change.get("field") != "messages":
                continue
            value = change.get("value") or {}
            phone_number_id = str((value.get("metadata") or {}).get("phone_number_id") or "")
            names = {
                str(c.get("wa_id")): (c.get("profile") or {}).get("name")
                for c in value.get("contacts") or []
                if c.get("wa_id")
            }
            for m in value.get("messages") or []:
                kind = str(m.get("type") or "")
                sender = str(m.get("from") or "")
                wamid = str(m.get("id") or "")
                if not wamid or not sender:
                    continue
                body = m.get(kind) if isinstance(m.get(kind), dict) else {}
                if kind == "text":
                    caption = str((m.get("text") or {}).get("body") or "")
                else:
                    caption = str(body.get("caption") or "")
                media_id = str(body["id"]) if kind in MEDIA_KINDS and body.get("id") else None
                try:
                    sent_at = datetime.fromtimestamp(int(m.get("timestamp") or 0), tz=UTC)
                except (TypeError, ValueError):
                    sent_at = datetime.now(tz=UTC)
                out.append(
                    InboundMessage(
                        wamid=wamid,
                        phone_number_id=phone_number_id,
                        from_phone=sender,
                        sender_name=names.get(sender),
                        sent_at=sent_at,
                        kind=kind,
                        caption=caption.strip(),
                        media_id=media_id,
                        media_mime=str(body.get("mime_type")) if media_id and body.get("mime_type") else None,
                        media_filename=str(body.get("filename"))
                        if media_id and body.get("filename")
                        else None,
                    )
                )
    return out


EXTENSIONS = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
}


def media_extension(mime: str | None) -> str:
    return EXTENSIONS.get((mime or "").split(";")[0].strip(), ".bin")


class WhatsAppError(RuntimeError):
    pass


class WhatsAppClient:
    """The Graph API calls the intake makes. Every call carries the system-user access token."""

    def __init__(
        self, graph_url: str, access_token: str, phone_number_id: str, http: httpx.AsyncClient | None = None
    ):
        if not access_token:
            raise WhatsAppError("LINCK_WHATSAPP_ACCESS_TOKEN is not set")
        self._graph = graph_url.rstrip("/")
        self._phone_number_id = phone_number_id
        self._headers = {"Authorization": f"Bearer {access_token}"}
        self._http = http or httpx.AsyncClient(timeout=30)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def download_media(self, media_id: str) -> tuple[bytes, str | None]:
        """Two hops: the media id gives a short-lived URL, and the URL gives the bytes."""
        meta = await self._http.get(f"{self._graph}/{media_id}", headers=self._headers)
        if meta.status_code != 200:
            raise WhatsAppError(f"media {media_id}: lookup failed with {meta.status_code}")
        info = meta.json()
        url = info.get("url")
        if not url:
            raise WhatsAppError(f"media {media_id}: no download URL")
        blob = await self._http.get(url, headers=self._headers)
        if blob.status_code != 200:
            raise WhatsAppError(f"media {media_id}: download failed with {blob.status_code}")
        return blob.content, info.get("mime_type")

    async def react(self, to: str, message_id: str, emoji: str = "👍") -> None:
        """A reaction on the driver's own photo: the receipt a driver who cannot read can still see."""
        await self._send(
            {
                "messaging_product": "whatsapp",
                "recipient_type": "individual",
                "to": to,
                "type": "reaction",
                "reaction": {"message_id": message_id, "emoji": emoji},
            }
        )

    async def _send(self, body: dict[str, Any]) -> None:
        r = await self._http.post(
            f"{self._graph}/{self._phone_number_id}/messages", headers=self._headers, json=body
        )
        if r.status_code >= 300:
            raise WhatsAppError(f"send failed with {r.status_code}: {r.text[:200]}")

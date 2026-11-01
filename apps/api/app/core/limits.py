"""How large a request body may be, decided before anything reads it.

FastAPI reads and parses a request's body before any dependency runs, the
session check included, so without a cap anyone who can reach the API can make
it hold a body of any size. This caps every route, in front of the app:

- A declared Content-Length over the cap is refused at once, unread.
- A body that declares none is counted as it arrives and cut off at the cap.

Either way the answer is a 413 in the shape every refusal has,
`{"detail": {"problem": {"code": "too-big"}}}`, and the connection is then
closed, so the rest of the body is never read at all.

Every route takes the general cap, `max_body_bytes` (1 MB unless
LINCK_MAX_BODY_BYTES says otherwise), but two whose bodies are not a screen's
JSON:

- The bill upload: a scan of up to `file_max_bytes`, with room for the
  multipart framing. UploadSizeLimit (app/core/storage.py) holds that path to
  the same figure; it is named here as well so that no route is ever uncapped.
- Meta's WhatsApp webhook: 3 MB, the most Meta says one delivery can be.
  Refusing a real delivery would lose a driver's slip once Meta stops
  retrying. The body passes through untouched, so the signature is still
  checked over the exact bytes Meta signed.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping

from fastapi import HTTPException, status
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.settings import Settings, get_settings
from app.core.storage import MULTIPART_MARGIN

TOO_BIG = {"problem": {"code": "too-big"}}
#: The rest of a refused body is unwanted: the server closes the connection
#: instead of reading the body to its end to keep the connection alive.
CLOSE = {"Connection": "close"}

#: The largest payload Meta's webhook documentation says it sends.
WHATSAPP_WEBHOOK_MAX_BYTES = 3 * 1024 * 1024

#: The routes whose bodies are not small JSON, and the cap each takes instead.
OWN_CAPS: Mapping[str, Callable[[Settings], int]] = {
    "/expenses/attachments": lambda settings: settings.file_max_bytes + MULTIPART_MARGIN,
    "/webhooks/whatsapp": lambda settings: WHATSAPP_WEBHOOK_MAX_BYTES,
}


def body_cap(path: str, settings: Settings | None = None) -> int:
    """The most a request to `path` may carry, in bytes."""
    settings = settings or get_settings()
    own = OWN_CAPS.get(path)
    return own(settings) if own is not None else settings.max_body_bytes


class BodySizeLimit:
    """Refuse a body over its route's cap, before the route reads it.

    Raising from `receive` is what FastAPI expects of a middleware: an
    HTTPException met while it reads the body is passed through to its
    handler, so the refusal is the API's own 413 rather than a generic 400.
    That holds only while nothing between here and the route runs `receive`
    in a task group, so this sits inside request_id_middleware (app/main.py).
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        limit = body_cap(scope["path"])
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            refusal = JSONResponse(
                {"detail": TOO_BIG}, status_code=status.HTTP_413_CONTENT_TOO_LARGE, headers=CLOSE
            )
            await refusal(scope, receive, send)
            return

        seen = 0

        async def counted() -> Message:
            nonlocal seen
            message = await receive()
            if message["type"] == "http.request":
                seen += len(message.get("body", b""))
                if seen > limit:
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail=TOO_BIG, headers=CLOSE
                    )
            return message

        await self.app(scope, counted, send)

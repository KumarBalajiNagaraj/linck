"""Where uploaded files live: a directory per tenant, one file per SHA-256.

    <file_storage_dir>/<organization_id>/<sha256>

The same approach as the WhatsApp media store (app/api/whatsapp.py): bytes are
named by their hash, so a re-upload of the same scan is one file on disk, and
nothing about the name is the client's. Two things are added for uploads that
come from a browser rather than from Meta:

- The type is read from the bytes, never from the client's Content-Type or file
  name, and only a photo or a PDF is kept. A file that claims to be a JPEG and
  is an HTML page is refused rather than served back with a JPEG label.
- Each tenant has its own directory, so one tenant's file can never be named
  into another's, even by a matching hash, and a tenant's files can be exported
  or erased as a directory.

This is a seam: the rest of the API sees `FileStore` and core.files rows, so
object storage replaces the directory without touching a route.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import uuid
from dataclasses import dataclass
from pathlib import Path

from fastapi import HTTPException, UploadFile, status
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.settings import get_settings

_SHA256 = re.compile(r"^[0-9a-f]{64}$")
_CHUNK = 1024 * 1024
#: Room for the multipart framing and the form fields around the file.
MULTIPART_MARGIN = 64 * 1024


class UploadRefused(Exception):
    """Why an upload was not stored, as a short code: `too-big`, `wrong-file`, `empty`."""

    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


def sniff_mime(head: bytes) -> str | None:
    """The type the bytes are, if it is one we keep: JPEG, PNG, WebP or PDF."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    return None


def clean_file_name(name: str | None, fallback: str = "bill") -> str:
    """A name safe to keep and to put in a Content-Disposition header: no path,
    no quotes or control characters, at most 120 characters."""
    base = (name or "").replace("\\", "/").rsplit("/", 1)[-1]
    base = re.sub(r"[^\w.\- ()]", "_", base).strip(" .")
    return base[:120] or fallback


async def read_capped(upload: UploadFile, limit: int) -> bytes:
    """The upload's bytes, refusing anything over `limit` without reading it all into memory."""
    parts: list[bytes] = []
    size = 0
    while chunk := await upload.read(_CHUNK):
        size += len(chunk)
        if size > limit:
            raise UploadRefused("too-big")
        parts.append(chunk)
    if size == 0:
        raise UploadRefused("empty")
    return b"".join(parts)


@dataclass(frozen=True)
class StoredBytes:
    sha256: str
    size: int
    mime_type: str


class FileStore:
    def __init__(self, root: Path) -> None:
        self._root = root

    def path_for(self, organization_id: uuid.UUID | str, sha256: str) -> Path:
        # Both parts are validated rather than trusted: a path is built from
        # them, and neither may ever contain a separator or a dot-dot.
        if not _SHA256.match(sha256):
            raise ValueError("not a sha256 hex digest")
        return self._root / str(uuid.UUID(str(organization_id))) / sha256

    async def put(self, organization_id: uuid.UUID | str, content: bytes) -> StoredBytes:
        mime = sniff_mime(content[:16])
        if mime is None:
            raise UploadRefused("wrong-file")
        digest = hashlib.sha256(content).hexdigest()
        path = self.path_for(organization_id, digest)
        await asyncio.to_thread(_write_once, path, content)
        return StoredBytes(sha256=digest, size=len(content), mime_type=mime)


def _write_once(path: Path, content: bytes) -> None:
    """Content-addressed, so a file already there is already right. Written to
    a temporary name and renamed, so a reader never sees half a file."""
    if path.is_file():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f".{path.name}.{uuid.uuid4().hex}.part")
    try:
        tmp.write_bytes(content)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def file_store() -> FileStore:
    return FileStore(Path(get_settings().file_storage_dir))


class UploadSizeLimit:
    """Refuse an upload over the cap before its body is read.

    FastAPI parses a multipart body before any dependency runs, authentication
    included, so a cap checked inside the route only bites after the whole body
    has been spooled to disk, for anyone who can reach the URL. This sits in
    front of the named paths: a declared Content-Length over the cap is refused
    at once, and a body that declares none is counted as it arrives and cut off
    at the cap. `read_capped` still checks the file itself.
    """

    def __init__(self, app: ASGIApp, paths: tuple[str, ...]) -> None:
        self.app = app
        self.paths = frozenset(paths)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["path"] not in self.paths:
            await self.app(scope, receive, send)
            return
        limit = get_settings().file_max_bytes + MULTIPART_MARGIN
        declared = dict(scope["headers"]).get(b"content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > limit):
            refusal = JSONResponse(
                {"detail": {"problem": {"code": "too-big"}}}, status_code=status.HTTP_413_CONTENT_TOO_LARGE
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
                    # Raised while FastAPI reads the form; it passes HTTP errors through.
                    raise HTTPException(
                        status_code=status.HTTP_413_CONTENT_TOO_LARGE, detail={"problem": {"code": "too-big"}}
                    )
            return message

        await self.app(scope, counted, send)

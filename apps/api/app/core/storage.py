"""Where uploaded files live: one object per tenant per SHA-256 of its bytes.

    <organization_id>/<sha256>

under a directory (`LINCK_FILE_STORE=local`, for development) or in a private
S3-compatible bucket (`LINCK_FILE_STORE=s3`: DigitalOcean Spaces in production,
because App Platform's disk is wiped on every deploy). Bill scans and the slip
photos drivers send on WhatsApp both come through here.

Bytes are named by their hash, so a re-upload of the same scan is one object,
and nothing about the name is the client's. Three rules hold in every store:

- The type is read from the bytes, never from the client's Content-Type, the
  file name or what Meta says, and only a photo or a PDF is kept. A file that
  claims to be a JPEG and is an HTML page is refused rather than served back
  with a JPEG label.
- Each tenant has its own prefix, so one tenant's file can never be named into
  another's, even by a matching hash, and a tenant's files can be exported or
  erased as a prefix.
- Bytes go back out only through the API, streamed by a route that has just
  checked the tenant and the permission. The bucket is private, and no public
  or presigned URL is ever handed to a browser.

This is a seam: the rest of the API sees `FileStore` and the rows that point
into it (core.files, core.whatsapp_messages), never a path or a bucket.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import uuid
from abc import ABC, abstractmethod
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, BinaryIO, Protocol
from urllib.parse import quote

from botocore.exceptions import ClientError
from fastapi import HTTPException, UploadFile, status
from fastapi.responses import JSONResponse, StreamingResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app.core.settings import Settings, get_settings

_SHA256 = re.compile(r"[0-9a-f]{64}")
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


@dataclass(frozen=True)
class StoredFile:
    """A stored file on its way out: its length, and its bytes a chunk at a time."""

    size: int
    chunks: AsyncIterator[bytes]


def object_key(organization_id: uuid.UUID | str, sha256: str) -> str:
    """`<organization_id>/<sha256>`: the one name a file has, in every store.

    Both parts are validated rather than trusted: a path or an object key is
    built from them, and neither may ever carry a separator, a dot-dot or
    another tenant's prefix.
    """
    if not isinstance(sha256, str) or not _SHA256.fullmatch(sha256):
        raise ValueError("not a sha256 hex digest")
    return f"{uuid.UUID(str(organization_id))}/{sha256}"


class FileStore(ABC):
    """Write once, read back by tenant and hash. Subclasses only move bytes."""

    def __init__(self, *, max_bytes: int) -> None:
        self._max_bytes = max_bytes

    async def put(self, organization_id: uuid.UUID | str, content: bytes) -> StoredBytes:
        """Keep `content` for this tenant if it is a photo or a PDF within the
        cap; otherwise raise UploadRefused and write nothing."""
        if not content:
            raise UploadRefused("empty")
        # The upload route has refused anything bigger before reading it; this
        # is the cap for bytes that arrive another way, such as from Meta.
        if len(content) > self._max_bytes:
            raise UploadRefused("too-big")
        mime = sniff_mime(content[:16])
        if mime is None:
            raise UploadRefused("wrong-file")
        digest = hashlib.sha256(content).hexdigest()
        await self._write_once(object_key(organization_id, digest), content, mime)
        return StoredBytes(sha256=digest, size=len(content), mime_type=mime)

    async def open(self, organization_id: uuid.UUID | str, sha256: str) -> StoredFile | None:
        """This tenant's file with that hash, or None if it has none."""
        return await self._open(object_key(organization_id, sha256))

    @abstractmethod
    async def _write_once(self, key: str, content: bytes, mime_type: str) -> None: ...

    @abstractmethod
    async def _open(self, key: str) -> StoredFile | None: ...


class LocalFileStore(FileStore):
    """A directory per tenant under `root`. For development: a deployed
    container's disk does not outlive the next deploy."""

    def __init__(self, root: Path, *, max_bytes: int) -> None:
        super().__init__(max_bytes=max_bytes)
        self._root = root

    def path_for(self, organization_id: uuid.UUID | str, sha256: str) -> Path:
        return self._root / object_key(organization_id, sha256)

    async def _write_once(self, key: str, content: bytes, mime_type: str) -> None:
        await asyncio.to_thread(_write_file_once, self._root / key, content)

    async def _open(self, key: str) -> StoredFile | None:
        try:
            handle = await asyncio.to_thread(open, self._root / key, "rb")
        except FileNotFoundError:
            return None
        return StoredFile(size=os.fstat(handle.fileno()).st_size, chunks=_file_chunks(handle))


def _write_file_once(path: Path, content: bytes) -> None:
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


async def _file_chunks(handle: BinaryIO) -> AsyncIterator[bytes]:
    try:
        while chunk := await asyncio.to_thread(handle.read, _CHUNK):
            yield chunk
    finally:
        handle.close()


class S3Client(Protocol):
    """The three calls S3FileStore makes, as boto3's S3 client takes them.
    Tests pass a fake that keeps objects in a dict."""

    def head_object(self, *, Bucket: str, Key: str) -> dict[str, Any]: ...

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> dict[str, Any]: ...

    def get_object(self, *, Bucket: str, Key: str) -> dict[str, Any]: ...


#: How boto3 says "no such key": HEAD has no body to carry a code, so it is the status.
_MISSING = frozenset({"404", "NoSuchKey", "NotFound"})


def _error_code(exc: ClientError) -> str:
    return str(exc.response.get("Error", {}).get("Code", ""))


class S3FileStore(FileStore):
    """A private S3-compatible bucket: DigitalOcean Spaces in production.

    boto3 blocks, so every call runs in a worker thread; one client is shared,
    which boto3 supports across threads. Objects take the bucket's default ACL,
    which on a private bucket is private: nothing here can make one public.
    """

    def __init__(self, client: S3Client, bucket: str, *, max_bytes: int) -> None:
        super().__init__(max_bytes=max_bytes)
        self._client = client
        self._bucket = bucket

    async def _write_once(self, key: str, content: bytes, mime_type: str) -> None:
        await asyncio.to_thread(self._write_sync, key, content, mime_type)

    def _write_sync(self, key: str, content: bytes, mime_type: str) -> None:
        try:
            self._client.head_object(Bucket=self._bucket, Key=key)
            return  # Content-addressed: an object already there is already right.
        except ClientError as exc:
            # A key that may not list the bucket can get 403 rather than 404
            # for a missing object. The PUT is the call that is really
            # authorised, so it decides; bad credentials fail there too.
            if _error_code(exc) not in _MISSING | {"403", "AccessDenied"}:
                raise
        self._client.put_object(Bucket=self._bucket, Key=key, Body=content, ContentType=mime_type)

    async def _open(self, key: str) -> StoredFile | None:
        try:
            obj = await asyncio.to_thread(self._client.get_object, Bucket=self._bucket, Key=key)
        except ClientError as exc:
            # Only "no such key" is missing. Anything else, a refused key
            # included, is an error, so bad credentials never read as a
            # deleted file.
            if _error_code(exc) in _MISSING:
                return None
            raise
        return StoredFile(size=int(obj["ContentLength"]), chunks=_s3_chunks(obj["Body"]))


async def _s3_chunks(body: Any) -> AsyncIterator[bytes]:
    try:
        while chunk := await asyncio.to_thread(body.read, _CHUNK):
            yield chunk
    finally:
        body.close()


@lru_cache(maxsize=4)
def s3_client(endpoint_url: str, region: str, access_key_id: str, secret_access_key: str) -> S3Client:
    """One client per configuration, built once: boto3 takes the better part of
    a second to import and build one, and a client is safe to share."""
    import boto3
    from botocore.config import Config

    client: S3Client = boto3.client(
        "s3",
        endpoint_url=endpoint_url or None,
        region_name=region,
        aws_access_key_id=access_key_id,
        aws_secret_access_key=secret_access_key,
        config=Config(
            # botocore 1.36 started adding CRC checksums to every upload by
            # default, and not every S3-compatible service accepts them. Ask
            # for one only where the S3 API requires it.
            request_checksum_calculation="when_required",
            response_checksum_validation="when_required",
            connect_timeout=5,
            read_timeout=30,
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )
    return client


def file_store() -> FileStore:
    """The store the settings name. Cheap per request: the S3 client is cached."""
    return _store_for(get_settings())


def _store_for(settings: Settings) -> FileStore:
    if settings.file_store == "s3":
        client = s3_client(
            settings.s3_endpoint_url,
            settings.s3_region,
            settings.s3_access_key_id,
            settings.s3_secret_access_key,
        )
        return S3FileStore(client, settings.s3_bucket, max_bytes=settings.file_max_bytes)
    return LocalFileStore(Path(settings.file_storage_dir), max_bytes=settings.file_max_bytes)


def file_store_problems(settings: Settings) -> list[str]:
    """Why the configured store would lose or refuse files. Checked at boot.

    Uses no network, so a slow bucket cannot hold up a deploy; for `s3` it
    builds the client, so a malformed endpoint fails the boot rather than the
    first upload, and the first upload does not wait for boto3.
    """
    if settings.file_store == "local":
        if settings.environment == "local":
            return []
        return [
            "LINCK_FILE_STORE is 'local' outside local development, and a deployed container's disk "
            "does not survive the next deploy, so every upload would be lost. Set LINCK_FILE_STORE=s3 "
            "and the LINCK_S3_* settings (docs/DEPLOY.md)."
        ]
    required = ("s3_region", "s3_bucket", "s3_access_key_id", "s3_secret_access_key")
    missing = [f"LINCK_{name.upper()}" for name in required if not getattr(settings, name)]
    if missing:
        return [f"LINCK_FILE_STORE is 's3' but {', '.join(missing)} not set"]
    try:
        _store_for(settings)
    except ValueError as exc:
        return [f"the S3 client cannot be built from the LINCK_S3_* settings: {exc}"]
    return []


def stored_file_response(
    stored: StoredFile,
    *,
    media_type: str,
    filename: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> StreamingResponse:
    """Stream a stored file back to the browser, opened in place.

    nosniff, so the browser takes the type sniffed at upload and nothing else;
    private, so no shared cache on the way (Vercel's edge included) keeps a
    tenant's file.
    """
    out = {
        "Content-Length": str(stored.size),
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-cache",
        **(headers or {}),
    }
    if filename is not None:
        # As Starlette's FileResponse writes it: RFC 5987 only when the name needs it.
        quoted = quote(filename)
        out["Content-Disposition"] = (
            f"inline; filename*=utf-8''{quoted}" if quoted != filename else f'inline; filename="{filename}"'
        )
    return StreamingResponse(stored.chunks, media_type=media_type, headers=out)


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

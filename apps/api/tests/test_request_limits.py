"""Every route caps the body it takes, before anything reads it.

FastAPI parses a request's body before any dependency runs, the session check
included, so these requests are made signed out: what is tested is how much a
stranger can make the API read. The bill upload and Meta's webhook have caps of
their own, larger than the JSON one; the webhook's is tested with its
signature, in test_whatsapp.py.
"""

from __future__ import annotations

import hashlib
import re
import uuid
from collections.abc import Callable
from pathlib import Path

import pytest
from conftest import TOO_BIG, Feed, Person, Tenant

from app.core.limits import WHATSAPP_WEBHOOK_MAX_BYTES, body_cap
from app.core.settings import Settings, get_settings
from app.core.storage import MULTIPART_MARGIN, UploadSizeLimit

JSON = {"Content-Type": "application/json"}
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00 a phone photo of a bunk slip"


def json_of(size: int) -> bytes:
    """A JSON object of exactly `size` bytes."""
    body = b'{"p":"' + b"x" * (size - 8) + b'"}'
    assert len(body) == size
    return body


def test_the_cap_is_a_megabyte_unless_linck_max_body_bytes_says_otherwise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert Settings().max_body_bytes == 1024 * 1024
    monkeypatch.setenv("LINCK_MAX_BODY_BYTES", "4096")
    assert Settings().max_body_bytes == 4096


async def test_a_body_declared_over_the_cap_is_refused_before_a_byte_is_read(api) -> None:  # type: ignore[no-untyped-def]
    cap = get_settings().max_body_bytes
    feed = Feed(json_of(cap + 1))
    r = await api().post("/expenses", content=feed, headers={**JSON, "Content-Length": str(cap + 1)})
    assert r.status_code == 413 and r.json() == TOO_BIG
    assert feed.taken == 0
    # The server is told to hang up rather than read the rest to keep the connection.
    assert r.headers["connection"] == "close"
    # Inside the request-id middleware, so a refusal can be traced like any other answer.
    assert r.headers["x-request-id"]


async def test_a_body_that_declares_no_size_is_cut_off_at_the_cap(api) -> None:  # type: ignore[no-untyped-def]
    cap = get_settings().max_body_bytes
    feed = Feed(json_of(4 * cap))
    r = await api().post("/expenses", content=feed, headers=JSON)
    # The API's own 413, not the 400 FastAPI turns any other error met while reading a body into.
    assert r.status_code == 413 and r.json() == TOO_BIG
    # Read as far as the chunk that crossed the cap, and no further.
    assert cap < feed.taken <= cap + feed.chunk
    assert r.headers["connection"] == "close"


async def test_the_cap_holds_to_the_byte(api, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(get_settings(), "max_body_bytes", 64)
    at_cap, over = json_of(64), json_of(65)
    # At the cap: read and parsed, then refused for want of a session, as any signed-out request is.
    assert (await api().post("/expenses", content=at_cap, headers=JSON)).status_code == 401
    assert (await api().post("/expenses", content=Feed(at_cap, chunk=16), headers=JSON)).status_code == 401
    # A byte over: refused for its size, whether it said so or not.
    assert (await api().post("/expenses", content=over, headers=JSON)).status_code == 413
    assert (await api().post("/expenses", content=Feed(over, chunk=16), headers=JSON)).status_code == 413


async def test_every_route_refuses_a_body_over_its_cap_before_reading_it(api) -> None:  # type: ignore[no-untyped-def]
    from app.main import app

    settings = get_settings()
    caps = {
        "/expenses/attachments": settings.file_max_bytes + MULTIPART_MARGIN,
        "/webhooks/whatsapp": WHATSAPP_WEBHOOK_MAX_BYTES,
    }
    routes = app.openapi()["paths"]
    assert {"/expenses", "/auth/refresh", *caps} <= routes.keys(), "this is not the app's route table"

    bodies: dict[int, bytes] = {}
    let_through: list[str] = []
    for template, operations in routes.items():
        path = re.sub(r"\{[^}]+\}", str(uuid.uuid4()), template)
        cap = caps.get(template, settings.max_body_bytes)
        for method in operations:
            feed = Feed(bodies.setdefault(cap, b"x" * (cap + 1)))
            r = await api().request(
                method.upper(), path, content=feed, headers={"Content-Length": str(cap + 1)}
            )
            if r.status_code != 413 or feed.taken or r.json() != TOO_BIG:
                let_through.append(f"{method.upper()} {template}: {r.status_code}, read {feed.taken} bytes")
    assert let_through == []


async def test_a_bill_scan_bigger_than_any_json_body_still_uploads(  # type: ignore[no-untyped-def]
    api,
    make_tenant: Callable[..., Tenant],
    make_person: Callable[..., Person],
    file_dir: Path,
) -> None:
    tenant = make_tenant("body-limits")
    clerk = make_person(tenant, "Fleet Clerk", ["fleet.expense.upload"])
    scan = JPEG + b"\x00" * get_settings().max_body_bytes
    r = await api(clerk).post(
        "/expenses/attachments", files={"file": ("slip.jpg", scan, "image/jpeg")}, data={"desk": "fleet"}
    )
    assert r.status_code == 201, r.text
    assert (file_dir / str(tenant.org_id) / hashlib.sha256(scan).hexdigest()).read_bytes() == scan


def test_every_path_under_the_upload_cap_keeps_it() -> None:
    """UploadSizeLimit (app/core/storage.py) and BodySizeLimit both stand in front of the uploads.

    A path given to the first and not the second would be held to the JSON cap,
    so a scan over a megabyte would be refused there.
    """
    from app.main import app

    paths = [p for m in app.user_middleware if m.cls is UploadSizeLimit for p in m.kwargs["paths"]]
    assert paths, "UploadSizeLimit is not where this test looks for it"
    settings = get_settings()
    for path in paths:
        assert body_cap(path, settings) >= settings.file_max_bytes + MULTIPART_MARGIN, path

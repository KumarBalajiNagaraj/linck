"""Every route caps the body it takes, before anything reads it.

FastAPI parses a request's body before any dependency runs, the session check
included, so these requests are made signed out: what is tested is how much a
stranger can make the API read. One cap holds for every route but the two
uploads, which have a larger one of their own. A JSON body over the cap,
declared or not, is tested beside the bill upload's in test_expenses_api.py,
and Meta's webhook, with its signature, in test_whatsapp.py.
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from conftest import TOO_BIG, Feed, Person, Tenant

from app.core.limits import MULTIPART_MARGIN
from app.core.settings import Settings, get_settings

JSON = {"Content-Type": "application/json"}
JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00 a phone photo of a bunk slip"
MiB = 1024 * 1024

#: The two uploads, with the key each takes and the form fields sent beside the file.
UPLOADS = {
    "/expenses/attachments": ("fleet.expense.upload", {"desk": "fleet"}),
    "/vehicle-pl/attachments": ("fleet.trip_pl.write", {}),
}

#: A driver's diesel caption in Tamil, three bytes a letter as the browser sends it.
TAMIL_CAPTION = (
    "டீசல் போட்டாச்சு அண்ணா, வண்டி டிஎன் 29 ஏபி 1001, நானூற்று முப்பத்திரண்டு லிட்டர், "
    "நாற்பத்தோராயிரத்து இருநூற்று எழுபத்தேழு ரூபாய், சக்தி பியூல்ஸ் கரப்பாக்கம் பங்க். "
    "பில் போட்டோ அனுப்பியிருக்கேன், மீட்டர் ரீடிங் ஒரு லட்சத்து இருபதாயிரம், நாளைக்கு "
    "காலையில மறுபடியும் லோடு எடுக்கணும், டயர் கொஞ்சம் தேஞ்சு போச்சு, பார்த்துக்கோங்க. "
)


def json_of(size: int) -> bytes:
    """A JSON object of exactly `size` bytes."""
    body = b'{"p":"' + b"x" * (size - 8) + b'"}'
    assert len(body) == size
    return body


def test_the_cap_is_four_mib_unless_linck_max_body_bytes_says_otherwise(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    assert Settings().max_body_bytes == 4 * MiB
    monkeypatch.setenv("LINCK_MAX_BODY_BYTES", "4096")
    assert Settings().max_body_bytes == 4096


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
    caps = {path: settings.file_max_bytes + MULTIPART_MARGIN for path in UPLOADS}
    routes = app.openapi()["paths"]
    named = {"/expenses", "/auth/refresh", "/webhooks/whatsapp", "/whatsapp/imports", *caps}
    assert named <= routes.keys(), "this is not the app's route table"

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


@pytest.mark.parametrize("upload", UPLOADS)
async def test_a_scan_bigger_than_any_json_body_still_uploads(  # type: ignore[no-untyped-def]
    api,
    upload: str,
    make_tenant: Callable[..., Tenant],
    make_person: Callable[..., Person],
    file_dir: Path,
) -> None:
    key, form = UPLOADS[upload]
    tenant = make_tenant("body-limits")
    clerk = make_person(tenant, "Fleet Clerk", [key])
    scan = JPEG + b"\x00" * get_settings().max_body_bytes
    r = await api(clerk).post(upload, files={"file": ("slip.jpg", scan, "image/jpeg")}, data=form)
    assert r.status_code == 201, r.text
    assert (file_dir / str(tenant.org_id) / hashlib.sha256(scan).hexdigest()).read_bytes() == scan


def the_largest_import() -> dict[str, object]:
    """A WhatsApp import as big as a real one gets: 500 claims, the most one
    takes, each with its slip's capture record, and every caption in Tamil and
    as long as its claim key allows. The key carries the caption, and the API
    takes keys of up to 1000 letters."""
    sender = "முருகன் சுப்பிரமணியம் (டிப்பர் 12)"
    vendor = "ஸ்ரீ சக்தி பியூல்ஸ், கரப்பாக்கம், ஓஎம்ஆர் சாலை"
    site = str(uuid.uuid4())
    notices = [
        {"code": "rate-out-of-band", "rate": 125.4, "min": 80, "max": 120},
        {"code": "inferred", "litres": 432.125, "amount": None},
        {"code": "vehicle-unmatched", "text": "டிஎன் 29 ஏபி 1001"},
        {"code": "not-a-driver", "sender": sender},
        {"code": "slip-amount-differ", "message": 41277, "slip": 41277.6},
        {"code": "slip-names-other-vehicle", "slip": "TN 29 AB 1001"},
        {"code": "same-figures-as-line", "line": 4123},
        {"code": "media-omitted"},
    ]

    def field(key: str, label: str, captured: str, value: str) -> dict[str, object]:
        return {"key": key, "label": label, "captured": captured, "confidence": 2, "value": value}

    claims = []
    for i in range(500):
        posted = datetime(2026, 8, 7, 4, 15, tzinfo=UTC) + timedelta(minutes=i)
        # As packages/domain/src/whatsapp.ts makes a key: when, what was said, how many photos.
        when = f"{posted:%Y-%m-%dT%H:%M}"
        caption = (TAMIL_CAPTION * 4)[: 1000 - len(f"{when}||2")].strip()
        bill_number = f"BK/{48213 + i}"
        claims.append(
            {
                "claimKey": f"{when}|{caption}|2",
                "sender": sender,
                "postedAt": posted.isoformat(),
                "message": caption,
                "attachments": [f"IMG-20260807-WA{i:04d}.jpg", f"IMG-20260807-WA{i:04d}-1.jpg"],
                "bill": {
                    "siteId": site,
                    "vehicleId": "veh-001",
                    "driverId": "drv-001",
                    "billNumber": bill_number,
                    "billDate": "2026-08-06T18:30:00.000Z",
                    "vendor": vendor,
                    "litres": 432.125,
                    "amount": "41277.60",
                    "submittedBy": sender,
                    "submittedById": f"wa:{sender}",
                    "attachmentId": str(uuid.uuid4()),
                    "capture": {
                        "engine": "WhatsApp message + slip (tesseract.js 5)",
                        "capturedAt": posted.isoformat(),
                        "warnings": notices,
                        "fields": [
                            field("billNumber", "Bill number", bill_number, bill_number),
                            field("billDate", "Bill date", "07/08/2026", "2026-08-07"),
                            field("vendor", "Vendor", vendor, vendor),
                            field("vehicle", "Vehicle", "TN 29 AB 1001", "TN29AB1001"),
                            field("litres", "Litres", "432.125", "432.125"),
                            field("amount", "Amount", "41277.6", "41277.60"),
                        ],
                    },
                },
            }
        )
    # From the inbox, so it also names the messages behind its claims: a photo and its caption each.
    return {"source": "inbox", "inboxMessageIds": [str(uuid.uuid4()) for _ in range(1000)], "claims": claims}


async def test_the_largest_whatsapp_import_fits_under_the_cap(api) -> None:  # type: ignore[no-untyped-def]
    from app.schemas.whatsapp_imports import ImportIn

    largest = the_largest_import()
    ImportIn.model_validate(largest)  # One the route takes, not one it would refuse anyway.
    # As the browser's JSON.stringify writes it: no spaces, and Tamil as UTF-8 rather than \u escapes.
    body = json.dumps(largest, ensure_ascii=False, separators=(",", ":")).encode()
    assert 3.5 * MiB < len(body) < get_settings().max_body_bytes
    r = await api().post("/whatsapp/imports", content=body, headers=JSON)
    # Signed out, so it is refused, but for who is asking, not for its size.
    assert r.status_code == 401

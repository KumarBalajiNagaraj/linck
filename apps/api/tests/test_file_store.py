"""The file store seam, and the bucket behind it in production, with no network.

S3FileStore is exercised against FakeS3 (conftest.py), which answers the three
calls it makes with the error shapes boto3 raises for Spaces. The routes that
stream these files back are tested end to end in test_expenses_api.py and
test_whatsapp.py; this file holds the store's own promises: what goes in comes
out, the same bytes are written once, a key is one tenant's only, and missing
is missing.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path

import pytest
from botocore.exceptions import ClientError
from conftest import FakeS3

from app.core.security import session_secret_problems
from app.core.settings import Settings
from app.core.storage import (
    FileStore,
    LocalFileStore,
    S3FileStore,
    UploadRefused,
    file_store_problems,
    object_key,
)

JPEG = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00 a photo of a bunk slip"
PDF = b"%PDF-1.7\n a scanned repair invoice"
ORG_A = uuid.UUID("7f8a1c2e-0000-4000-8000-00000000000a")
ORG_B = uuid.UUID("7f8a1c2e-0000-4000-8000-00000000000b")


def s3_store(fake: FakeS3, max_bytes: int = 1024) -> S3FileStore:
    return S3FileStore(fake, "linck-test", max_bytes=max_bytes)


async def read_back(store: FileStore, organization_id: uuid.UUID, sha256: str) -> bytes | None:
    stored = await store.open(organization_id, sha256)
    if stored is None:
        return None
    content = b"".join([chunk async for chunk in stored.chunks])
    assert len(content) == stored.size
    return content


async def test_a_file_goes_into_the_bucket_under_its_tenant_and_hash_and_comes_back() -> None:
    fake = FakeS3()
    store = s3_store(fake)
    stored = await store.put(ORG_A, JPEG)
    digest = hashlib.sha256(JPEG).hexdigest()
    assert (stored.sha256, stored.size, stored.mime_type) == (digest, len(JPEG), "image/jpeg")
    # The type is the sniffed one, kept as the object's metadata too.
    assert fake.objects == {("linck-test", f"{ORG_A}/{digest}"): (JPEG, "image/jpeg")}
    assert await read_back(store, ORG_A, digest) == JPEG


async def test_the_same_bytes_are_written_once() -> None:
    fake = FakeS3()
    store = s3_store(fake)
    first = await store.put(ORG_A, PDF)
    again = await store.put(ORG_A, PDF)
    assert first == again
    key = f"{ORG_A}/{first.sha256}"
    assert fake.calls == [("HeadObject", key), ("PutObject", key), ("HeadObject", key)]


async def test_another_tenants_key_cannot_be_read() -> None:
    fake = FakeS3()
    store = s3_store(fake)
    stored = await store.put(ORG_A, JPEG)
    # The hash is no secret, and it is not enough: the key is the reader's own tenant's.
    assert await read_back(store, ORG_B, stored.sha256) is None
    assert fake.calls[-1] == ("GetObject", f"{ORG_B}/{stored.sha256}")
    # Nor can a tenant id be bent into another prefix.
    for crafted in (f"{ORG_B}/../{ORG_A}", f"{ORG_A}/x", "../" + str(ORG_A)):
        with pytest.raises(ValueError):
            await store.open(crafted, stored.sha256)
    for crafted_hash in (f"../{ORG_A}/{stored.sha256}", stored.sha256 + "\n", stored.sha256.upper(), ""):
        with pytest.raises(ValueError):
            await store.open(ORG_A, crafted_hash)


async def test_a_missing_object_is_none_and_a_refused_key_is_an_error() -> None:
    fake = FakeS3()
    store = s3_store(fake)
    assert await store.open(ORG_A, "0" * 64) is None
    # Bad credentials must not read as "the file was deleted".
    fake.refuse = True
    with pytest.raises(ClientError):
        await store.open(ORG_A, "0" * 64)
    with pytest.raises(ClientError):
        await store.put(ORG_A, JPEG)


async def test_only_a_photo_or_a_pdf_within_the_cap_is_written() -> None:
    fake = FakeS3()
    store = s3_store(fake, max_bytes=len(JPEG))
    refusals = ((b"<html>not a slip</html>", "wrong-file"), (JPEG + b"x", "too-big"), (b"", "empty"))
    for content, code in refusals:
        with pytest.raises(UploadRefused) as refused:
            await store.put(ORG_A, content)
        assert refused.value.code == code
    assert fake.calls == []


async def test_the_directory_store_keeps_the_same_layout(tmp_path: Path) -> None:
    store = LocalFileStore(tmp_path, max_bytes=1024)
    stored = await store.put(ORG_A, JPEG)
    assert store.path_for(ORG_A, stored.sha256) == tmp_path / object_key(ORG_A, stored.sha256)
    assert (tmp_path / str(ORG_A) / stored.sha256).read_bytes() == JPEG
    assert await read_back(store, ORG_A, stored.sha256) == JPEG
    assert await read_back(store, ORG_B, stored.sha256) is None


# ------------------------------------------------------------ the boot guards


def settings(**values: object) -> Settings:
    return Settings(_env_file=None, **values)  # type: ignore[call-arg]


SPACES = {
    "file_store": "s3",
    "s3_endpoint_url": "https://blr1.digitaloceanspaces.com",
    "s3_region": "blr1",
    "s3_bucket": "linck-files",
    "s3_access_key_id": "key",
    "s3_secret_access_key": "secret",
}


def test_a_deployed_api_will_not_keep_files_on_its_own_disk() -> None:
    assert file_store_problems(settings(environment="local")) == []
    [problem] = file_store_problems(settings(environment="production"))
    assert "LINCK_FILE_STORE is 'local'" in problem
    assert file_store_problems(settings(environment="production", **SPACES)) == []


def test_a_bucket_with_settings_missing_is_named_at_boot() -> None:
    [problem] = file_store_problems(
        settings(environment="production", **{**SPACES, "s3_bucket": "", "s3_secret_access_key": ""})
    )
    assert "LINCK_S3_BUCKET, LINCK_S3_SECRET_ACCESS_KEY not set" in problem
    [problem] = file_store_problems(
        settings(environment="production", **{**SPACES, "s3_endpoint_url": "not a url"})
    )
    assert "cannot be built" in problem


def test_a_deployed_api_will_not_sign_cookies_with_a_guessable_secret() -> None:
    assert session_secret_problems(settings(environment="local")) == []
    for weak in ("", "short", Settings.model_fields["session_secret"].default):
        [problem] = session_secret_problems(settings(environment="production", session_secret=weak))
        assert "LINCK_SESSION_SECRET" in problem
    assert session_secret_problems(settings(environment="production", session_secret="x" * 48)) == []


async def test_the_api_refuses_to_start_when_either_guard_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.core.settings import get_settings
    from app.main import app, lifespan

    live = get_settings()
    monkeypatch.setattr(live, "environment", "production")
    monkeypatch.setattr(live, "session_secret", "x" * 48)
    # The RLS posture passes against the test database; the disk store does not.
    with pytest.raises(RuntimeError, match="1 configuration problem"):
        async with lifespan(app):
            pass

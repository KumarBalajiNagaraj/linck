"""Harness for the security tests.

The suite opens TWO connections and the split between them is the whole point.

``admin`` is a privileged psycopg connection. Locally that is a superuser, so it
bypasses row level security entirely. It is used for exactly two things: planting
fixture rows, and reading ground truth ("is the row still there?"). No assertion
about what a tenant is *allowed to see* is ever made through it.

The async engine in ``app.core.db`` is pointed at ``linck_app`` — a role that
owns nothing and has neither SUPERUSER nor BYPASSRLS. That is the role the API
serves requests as, and it is the only role these tests make visibility claims
through. If the suite ever ran as an owner or a superuser every RLS assertion
below would pass vacuously, so ``test_app_role_has_no_rls_escape`` asserts the
harness itself is honest before anything else is believed.

Fixture rows are created and removed by this file. Nothing here depends on the
dev seed having been run.
"""

from __future__ import annotations

import os
import sys
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

import psycopg
import pytest
from psycopg import sql

# The `app` package lives one level up; pytest only puts tests/ on the path.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

ADMIN_URL = os.environ.get("LINCK_TEST_ADMIN_URL", "postgresql://localhost/linck_dev")
APP_ROLE = os.environ.get("LINCK_TEST_APP_ROLE", "linck_app")
APP_PASSWORD = os.environ.get("LINCK_TEST_APP_PASSWORD", "linck_app")

# Every fixture organization is slugged with this so a crashed run leaves
# nothing behind that the next run cannot identify and sweep.
SLUG_PREFIX = "zz-test-"

# The schemas migrations 0011, 0020 and 0030 created, and the tables the app
# role may only INSERT into and read, like core.audit_logs.
GRANTED_SCHEMAS = ("master", "sales", "fleet", "finance", "ai", "logistics", "procurement")
APPEND_ONLY_TABLES = ("finance.payments", "finance.expense_bill_events")


def _split(url: str) -> tuple[str, int, str]:
    parts = urlsplit(url)
    return parts.hostname or "localhost", parts.port or 5432, parts.path.lstrip("/") or "linck_dev"


HOST, PORT, DATABASE = _split(ADMIN_URL)
APP_URL = f"postgresql+asyncpg://{APP_ROLE}:{APP_PASSWORD}@{HOST}:{PORT}/{DATABASE}"


def _provision_app_role() -> None:
    """Make sure the unprivileged application role exists and can do DML.

    scripts/init-roles.sql is the real thing; it grants through ALTER DEFAULT
    PRIVILEGES on the migrator role. On a Homebrew Postgres where the schema was
    created by the developer's own superuser account those defaults never fire,
    so the grants are restated here explicitly. Idempotent, and local-only.
    """
    # CREATE ROLE and GRANT take no bind parameters, so the role name and password
    # go through psycopg's own quoting rather than an f-string.
    role = sql.Identifier(APP_ROLE)
    password = sql.Literal(APP_PASSWORD)
    database = sql.Identifier(DATABASE)

    with psycopg.connect(ADMIN_URL, autocommit=True) as conn, conn.cursor() as cur:
        cur.execute("SELECT 1 FROM pg_roles WHERE rolname = %s", (APP_ROLE,))
        if cur.fetchone() is None:
            cur.execute(sql.SQL("CREATE ROLE {} LOGIN PASSWORD {}").format(role, password))
        # NOSUPERUSER/NOBYPASSRLS restated every run: a role that acquired either
        # would turn this entire suite green while proving nothing.
        cur.execute(sql.SQL("ALTER ROLE {} NOSUPERUSER NOBYPASSRLS PASSWORD {}").format(role, password))
        cur.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(database, role))
        cur.execute(sql.SQL("GRANT USAGE ON SCHEMA core TO {}").format(role))
        cur.execute(
            sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO {}").format(role)
        )
        cur.execute(sql.SQL("GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA core TO {}").format(role))
        # The audit log is append-only for the application. Mirrors the REVOKE in
        # the migration, which targets PUBLIC rather than a named role.
        cur.execute(sql.SQL("REVOKE UPDATE, DELETE ON core.audit_logs FROM {}").format(role))

        # The business schemas migrations 0011, 0020 and 0030 created grant
        # linck_app what core does, from the migration itself. Only where the role
        # did not exist when the migration ran (so it skipped the grants) are they
        # restated here, append-only tables included; otherwise the suite tests
        # the migration's own grants rather than this file's.
        cur.execute(
            "SELECT nspname FROM pg_namespace"
            " WHERE nspname = ANY(%s) AND NOT has_schema_privilege(%s, oid, 'USAGE')",
            (list(GRANTED_SCHEMAS), APP_ROLE),
        )
        for (schema,) in cur.fetchall():
            name = sql.Identifier(schema)
            cur.execute(sql.SQL("GRANT USAGE ON SCHEMA {} TO {}").format(name, role))
            dml = sql.SQL("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA {} TO {}")
            cur.execute(dml.format(name, role))
            for table in APPEND_ONLY_TABLES:
                if table.startswith(f"{schema}."):
                    cur.execute(sql.SQL("REVOKE UPDATE, DELETE ON {} FROM {}").format(sql.SQL(table), role))


_provision_app_role()

# Must be set before app.core.db is imported: the engine is built at import time
# from the cached Settings object.
os.environ["LINCK_DATABASE_URL"] = APP_URL
os.environ.setdefault("LINCK_ENVIRONMENT", "local")

from app.core import db as core_db  # noqa: E402


@dataclass(frozen=True)
class Tenant:
    """One fixture organization with enough rows hung off it to be worth stealing."""

    org_id: uuid.UUID
    legal_entity_id: uuid.UUID
    site_id: uuid.UUID
    site_code: str
    site_name: str


# Child-first. organization_id carries ON DELETE RESTRICT, so nothing is cascaded
# for us and the order below is load-bearing. audit_logs comes LAST of the
# children: most of these tables carry the audit trigger, so deleting them
# writes fresh audit rows, and clearing the log any earlier would leave them.
_TEARDOWN_ORDER = [
    "finance.trip_payments",
    "sales.trip_closures",
    "sales.trip_sales",
    "procurement.trip_purchase_files",
    "procurement.trip_purchases",
    "logistics.enroute_expenses",
    "logistics.diesel_lines",
    "logistics.trips",
    "logistics.trip_sheets",
    "master.gst_rates",
    "master.party_locations",
    "master.items",
    "ai.industry_digests",
    "finance.expense_bill_events",
    "finance.expense_bill_fields",
    "finance.expense_bills",
    "finance.payments",
    "finance.whatsapp_import_claims",
    "finance.whatsapp_import_batches",
    "fleet.breakdowns",
    "sales.purchase_orders",
    "master.parties",
    "core.files",
    "core.whatsapp_messages",
    "core.sessions",
    "core.user_identities",
    "core.role_assignments",
    "core.role_permissions",
    "core.invitations",
    "core.roles",
    "core.sites",
    "core.gst_registrations",
    "core.legal_entities",
    "core.organization_modules",
    "core.users",
]

# Those trigger-written rows are stamped from app.current_org_id, which is unset
# on this privileged connection, so they land with a NULL organization_id and can
# only be found through the row image the trigger captured.
_DELETE_AUDIT = """
    DELETE FROM core.audit_logs
    WHERE organization_id = ANY(%(ids)s)
       OR (coalesce(after, before) ->> 'organization_id')::uuid = ANY(%(ids)s)
"""


def _delete_orgs(cur: psycopg.Cursor, org_ids: list[uuid.UUID]) -> None:
    if not org_ids:
        return
    for table in _TEARDOWN_ORDER:
        cur.execute(f"DELETE FROM {table} WHERE organization_id = ANY(%s)", (org_ids,))
    cur.execute(_DELETE_AUDIT, {"ids": org_ids})
    cur.execute("DELETE FROM core.organizations WHERE id = ANY(%s)", (org_ids,))


def _sweep_leftovers(cur: psycopg.Cursor) -> None:
    """Undo a crashed run before starting a new one."""
    cur.execute("SELECT id FROM core.organizations WHERE slug LIKE %s", (f"{SLUG_PREFIX}%",))
    _delete_orgs(cur, [row[0] for row in cur.fetchall()])

    # An audit row whose captured organization no longer exists is debris from a
    # teardown that did not finish. Real orgs cannot reach this state: their
    # organization_id is ON DELETE RESTRICT, so the org outlives its audit trail.
    cur.execute(
        """
        DELETE FROM core.audit_logs
        WHERE organization_id IS NULL
          AND coalesce(after, before) ? 'organization_id'
          AND NOT EXISTS (
                SELECT 1 FROM core.organizations o
                WHERE o.id = (coalesce(after, before) ->> 'organization_id')::uuid
          )
        """
    )


@pytest.fixture(scope="session")
def admin() -> Iterator[psycopg.Connection]:
    with psycopg.connect(ADMIN_URL, autocommit=True) as conn:
        with conn.cursor() as cur:
            _sweep_leftovers(cur)
        yield conn


@pytest.fixture(scope="session", autouse=True)
def _harness_is_honest(admin: psycopg.Connection) -> None:
    """Fail the whole run if the app role could bypass RLS.

    Without this, deleting every policy in the database would still leave the
    suite green as long as the tests happened to connect as an owner.
    """
    with admin.cursor() as cur:
        cur.execute("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = %s", (APP_ROLE,))
        row = cur.fetchone()
    assert row is not None, f"application role {APP_ROLE!r} does not exist"
    is_super, bypasses = row
    assert not is_super, f"{APP_ROLE} is a superuser — every RLS assertion in this suite would be vacuous"
    assert not bypasses, f"{APP_ROLE} has BYPASSRLS — every RLS assertion in this suite would be vacuous"


@pytest.fixture(autouse=True)
async def _dispose_pool_between_tests():
    """Return the pool empty after each test.

    asyncpg connections are bound to the event loop that opened them, and
    pytest-asyncio gives each test a fresh loop. A pooled connection surviving
    into the next test would fail in a way that has nothing to do with security.
    """
    yield
    await core_db.engine.dispose()


@pytest.fixture(scope="session")
def make_tenant(admin: psycopg.Connection) -> Iterator[Callable[..., Tenant]]:
    created: list[uuid.UUID] = []

    def _make(label: str, *, hosted_domains: tuple[str, ...] = (), org_status: str = "active") -> Tenant:
        org_id = uuid.uuid4()
        legal_entity_id = uuid.uuid4()
        site_id = uuid.uuid4()
        suffix = org_id.hex[:8]
        site_code = f"SITE-{suffix}"
        site_name = f"{label} crusher plant"

        with admin.cursor() as cur:
            cur.execute(
                """
                INSERT INTO core.organizations (id, display_name, slug, google_hosted_domains, status)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (org_id, f"Test {label}", f"{SLUG_PREFIX}{label}-{suffix}", list(hosted_domains), org_status),
            )
            cur.execute(
                """
                INSERT INTO core.legal_entities
                    (id, organization_id, code, legal_name, entity_type)
                VALUES (%s, %s, %s, %s, 'partnership')
                """,
                (legal_entity_id, org_id, f"LE-{suffix}", f"{label} Minerals"),
            )
            cur.execute(
                """
                INSERT INTO core.sites
                    (id, organization_id, legal_entity_id, code, name, site_type, state_code)
                VALUES (%s, %s, %s, %s, %s, 'crusher_plant', '33')
                """,
                (site_id, org_id, legal_entity_id, site_code, site_name),
            )
        created.append(org_id)
        return Tenant(org_id, legal_entity_id, site_id, site_code, site_name)

    yield _make

    with admin.cursor() as cur:
        _delete_orgs(cur, created)


@pytest.fixture(scope="session")
def make_user(admin: psycopg.Connection) -> Callable[..., uuid.UUID]:
    def _make(tenant: Tenant, email: str, full_name: str, *, status: str = "active") -> uuid.UUID:
        user_id = uuid.uuid4()
        with admin.cursor() as cur:
            cur.execute(
                """
                INSERT INTO core.users (id, organization_id, email, full_name, status)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (user_id, tenant.org_id, email, full_name, status),
            )
        return user_id

    return _make


@pytest.fixture(scope="session")
def make_identity(admin: psycopg.Connection) -> Callable[..., uuid.UUID]:
    def _make(tenant: Tenant, user_id: uuid.UUID, subject: str, email: str) -> uuid.UUID:
        identity_id = uuid.uuid4()
        with admin.cursor() as cur:
            cur.execute(
                """
                INSERT INTO core.user_identities
                    (id, organization_id, user_id, provider, subject, email, email_verified)
                VALUES (%s, %s, %s, 'google', %s, %s, true)
                """,
                (identity_id, tenant.org_id, user_id, subject, email),
            )
        return identity_id

    return _make


@pytest.fixture(scope="session")
def tenant_a(make_tenant: Callable[..., Tenant]) -> Tenant:
    return make_tenant("alpha")


@pytest.fixture(scope="session")
def tenant_b(make_tenant: Callable[..., Tenant]) -> Tenant:
    return make_tenant("bravo")


@dataclass(frozen=True)
class Person:
    """A signed-in user: a pre-registered row, a role with exactly these keys, and a live session."""

    user_id: uuid.UUID
    name: str
    headers: dict[str, str]

    @property
    def actor_id(self) -> str:
        return f"user:{self.user_id}"


@pytest.fixture(scope="session")
def make_site(admin: psycopg.Connection) -> Callable[..., uuid.UUID]:
    """A further site in a tenant, for the tests where scope is the point."""

    def _make(tenant: Tenant, name: str, site_type: str = "workshop") -> uuid.UUID:
        site_id = uuid.uuid4()
        with admin.cursor() as cur:
            cur.execute(
                """
                INSERT INTO core.sites
                    (id, organization_id, legal_entity_id, code, name, site_type, state_code)
                VALUES (%s, %s, %s, %s, %s, %s, '33')
                """,
                (site_id, tenant.org_id, tenant.legal_entity_id, f"SITE-{site_id.hex[:8]}", name, site_type),
            )
        return site_id

    return _make


@pytest.fixture(scope="session")
def make_person(admin: psycopg.Connection, make_user: Callable[..., uuid.UUID]) -> Callable[..., Person]:
    """Someone holding `permissions` org-wide, or only at `sites`, already signed in.

    The session row and the signed cookie are the real ones the API reads, so
    every request a test makes goes through the same authentication, RLS and
    grant checks as the browser's.
    """
    from app.api.deps import session_cookie_name, sign_session_cookie

    def _make(
        tenant: Tenant,
        name: str,
        permissions: tuple[str, ...] | list[str],
        *,
        sites: list[uuid.UUID] | None = None,
    ) -> Person:
        user_id = make_user(tenant, f"person-{uuid.uuid4().hex[:12]}@example.com", name)
        role_id = uuid.uuid4()
        session_id = uuid.uuid4()
        with admin.cursor() as cur:
            cur.execute(
                "INSERT INTO core.roles (id, organization_id, key, label) VALUES (%s, %s, %s, %s)",
                (role_id, tenant.org_id, f"test-{role_id.hex[:12]}", name),
            )
            for key in permissions:
                cur.execute(
                    "INSERT INTO core.role_permissions (organization_id, role_id, permission_key)"
                    " VALUES (%s, %s, %s)",
                    (tenant.org_id, role_id, key),
                )
            for site_id in sites if sites is not None else [None]:
                cur.execute(
                    "INSERT INTO core.role_assignments (organization_id, user_id, role_id, site_id)"
                    " VALUES (%s, %s, %s, %s)",
                    (tenant.org_id, user_id, role_id, site_id),
                )
            cur.execute(
                """
                INSERT INTO core.sessions (id, organization_id, user_id, refresh_token_hash, expires_at)
                VALUES (%s, %s, %s, 'test-only', now() + interval '1 hour')
                """,
                (session_id, tenant.org_id, user_id),
            )
        cookie = f"{session_cookie_name()}={sign_session_cookie(session_id, tenant.org_id)}"
        return Person(user_id=user_id, name=name, headers={"Cookie": cookie})

    return _make


@pytest.fixture
async def api():  # type: ignore[no-untyped-def]
    """`api(person)` is an HTTP client signed in as that person, against the real app in-process."""
    import httpx

    from app.main import app

    clients: list[httpx.AsyncClient] = []

    def _client(person: Person | None = None) -> httpx.AsyncClient:
        client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app),
            base_url="http://api",
            headers=person.headers if person else {},
        )
        clients.append(client)
        return client

    yield _client
    for client in clients:
        await client.aclose()


@pytest.fixture
def file_dir(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    """Uploaded scans go to a directory of this test's own."""
    from app.core.settings import get_settings

    root = tmp_path / "files"
    monkeypatch.setattr(get_settings(), "file_storage_dir", str(root))
    return root


class FakeS3:
    """The three calls app.core.storage.S3FileStore makes, answered from a dict,
    under boto3's own argument names.

    Errors are the ones boto3 raises, shaped as Spaces and S3 send them: HEAD
    has no body, so a missing key is the bare status "404"; GET says NoSuchKey.
    `refuse` makes every call fail as a key without access to the bucket would.
    """

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.calls: list[tuple[str, str]] = []
        self.refuse = False

    def _check(self, op: str, key: str) -> None:
        from botocore.exceptions import ClientError

        self.calls.append((op, key))
        if self.refuse:
            raise ClientError({"Error": {"Code": "AccessDenied", "Message": "Access Denied"}}, op)

    def head_object(self, *, Bucket: str, Key: str) -> dict:
        from botocore.exceptions import ClientError

        self._check("HeadObject", Key)
        if (Bucket, Key) not in self.objects:
            raise ClientError({"Error": {"Code": "404", "Message": "Not Found"}}, "HeadObject")
        body, content_type = self.objects[(Bucket, Key)]
        return {"ContentLength": len(body), "ContentType": content_type}

    def put_object(self, *, Bucket: str, Key: str, Body: bytes, ContentType: str) -> dict:
        self._check("PutObject", Key)
        self.objects[(Bucket, Key)] = (bytes(Body), ContentType)
        return {}

    def get_object(self, *, Bucket: str, Key: str) -> dict:
        import io

        from botocore.exceptions import ClientError
        from botocore.response import StreamingBody

        self._check("GetObject", Key)
        if (Bucket, Key) not in self.objects:
            raise ClientError(
                {"Error": {"Code": "NoSuchKey", "Message": "The specified key does not exist."}}, "GetObject"
            )
        body, content_type = self.objects[(Bucket, Key)]
        return {
            "Body": StreamingBody(io.BytesIO(body), len(body)),
            "ContentLength": len(body),
            "ContentType": content_type,
        }

    def keys(self, bucket: str = "linck-test") -> set[str]:
        return {key for (b, key) in self.objects if b == bucket}


@pytest.fixture
def bucket(monkeypatch: pytest.MonkeyPatch) -> FakeS3:
    """Files go to a stand-in for the Spaces bucket, through the seam the API
    uses in production (LINCK_FILE_STORE=s3), with no network."""
    from app.core import storage
    from app.core.settings import get_settings

    fake = FakeS3()
    settings = get_settings()
    for name, value in {
        "file_store": "s3",
        "s3_endpoint_url": "https://blr1.digitaloceanspaces.com",
        "s3_region": "blr1",
        "s3_bucket": "linck-test",
        "s3_access_key_id": "test-key",
        "s3_secret_access_key": "test-secret",
    }.items():
        monkeypatch.setattr(settings, name, value)
    monkeypatch.setattr(storage, "s3_client", lambda *config: fake)
    return fake

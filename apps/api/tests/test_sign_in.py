"""The sign-in flow as the web app drives it (apps/web/src/auth).

The web app boots from GET /me/session. On a 401 it renews the hour-long
session once with POST /auth/refresh, and failing that shows its sign-in
screen, which words why the last sign-in was refused from a code: the Google
callback sends the browser back to /sign-in?error=<code>, and dev-login answers
the same code in a refusal. These tests hold the API to each half of that.

And /me/session is held to apps/web/src/auth/session.ts field for field: that
file is where the web app says what it reads, and a field either side drops
silently is a screen that renders `undefined` for real users.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Callable
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import psycopg
import pytest
from conftest import Person, Tenant

from app.api import auth
from app.core import security
from app.core.settings import get_settings

SESSION_TS = Path(__file__).resolve().parents[3] / "apps" / "web" / "src" / "auth" / "session.ts"


def _refused(response) -> str:  # type: ignore[no-untyped-def]
    assert response.status_code == 403, response.text
    return response.json()["detail"]["problem"]["code"]


@pytest.fixture(scope="module")
def tenant(make_tenant: Callable[..., Tenant]) -> Tenant:
    return make_tenant("sign-in")


def _email(label: str) -> str:
    return f"{label}-{uuid.uuid4().hex[:10]}@example.com"


# ---------------------------------------------------------------------------
# Refusals, as codes
# ---------------------------------------------------------------------------


async def test_an_address_nobody_registered_is_not_registered(api) -> None:  # type: ignore[no-untyped-def]
    assert _refused(await api().post("/auth/dev-login", json={"email": _email("nobody")})) == "not_registered"


async def test_a_stopped_account_is_told_so_only_once_it_has_signed_in(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, make_user: Callable[..., uuid.UUID], admin: psycopg.Connection
) -> None:
    """Stood down before ever signing in, the person is simply not registered:
    nothing pins them yet. Stood down after, whoever signs in as the identity
    pinned to them is them, and is told why."""
    never = _email("never-signed-in")
    make_user(tenant, never, "Never Signed In", status="disabled")
    assert _refused(await api().post("/auth/dev-login", json={"email": never})) == "not_registered"

    returning = _email("returning")
    user_id = make_user(tenant, returning, "Returning Person", status="invited")
    assert (await api().post("/auth/dev-login", json={"email": returning})).status_code == 200
    with admin.cursor() as cur:
        cur.execute("UPDATE core.users SET status = 'suspended' WHERE id = %s", (user_id,))
    assert _refused(await api().post("/auth/dev-login", json={"email": returning})) == "account_stopped"


async def test_the_deployment_s_domain_gate_says_so(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, make_user: Callable[..., uuid.UUID], monkeypatch: pytest.MonkeyPatch
) -> None:
    email = _email("gated")
    make_user(tenant, email, "Gated Person")
    monkeypatch.setattr(get_settings(), "allowed_hosted_domains", ["company.example"])
    assert _refused(await api().post("/auth/dev-login", json={"email": email})) == "domain_not_allowed"


async def test_an_email_registered_in_two_companies_is_refused_plainly(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, tenant_b: Tenant, make_user: Callable[..., uuid.UUID]
) -> None:
    """core.resolve_pending_user will not choose between tenants (migration 0003).
    That used to surface as a 500; it is a refusal with its own code now."""
    email = _email("twice")
    make_user(tenant, email, "Twice Registered", status="invited")
    make_user(tenant_b, email, "Twice Registered", status="invited")
    assert _refused(await api().post("/auth/dev-login", json={"email": email})) == "registered_twice"


# ---------------------------------------------------------------------------
# Google: the browser comes back to the sign-in screen, never to JSON
# ---------------------------------------------------------------------------


class _FakeGoogle:
    """The token exchange, answered without the network."""

    async def __aenter__(self) -> _FakeGoogle:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def fetch_token(self, url: str, **kwargs: object) -> dict[str, str]:
        return {"id_token": "id-token", "access_token": "access-token"}


@pytest.fixture
def google(monkeypatch: pytest.MonkeyPatch) -> Callable[..., object]:
    """`google(claims)` makes the callback believe Google vouched for these claims."""

    async def metadata(*, force: bool = False) -> dict[str, str]:
        return {"token_endpoint": "https://oauth2.example/token"}

    def _claims(claims: dict[str, object]) -> None:
        async def verify(raw: str, *, access_token: str | None, nonce: str) -> dict[str, object]:
            assert nonce == "nonce-1", "the nonce parked at login is the one checked"
            return claims

        monkeypatch.setattr(auth, "verify_google_id_token", verify)

    monkeypatch.setattr(auth, "google_metadata", metadata)
    monkeypatch.setattr(auth, "_oauth_client", _FakeGoogle)
    return _claims


async def _callback(api, next_path: str = "/fleet/board"):  # type: ignore[no-untyped-def]
    flow = security._flow_signer.dumps({"s": "state-1", "v": "verifier", "n": "nonce-1", "r": next_path})
    client = api()
    client.cookies.set(security.FLOW_COOKIE, flow)
    return client, await client.get("/auth/google/callback", params={"code": "code-1", "state": "state-1"})


@pytest.mark.parametrize(
    ("claims", "code"),
    [
        (
            {"sub": "google-sub-nobody", "email": "nobody@example.com", "email_verified": True},
            "not_registered",
        ),
        (
            {"sub": "google-sub-unverified", "email": "x@example.com", "email_verified": False},
            "email_unverified",
        ),
    ],
)
async def test_a_refused_google_sign_in_lands_on_the_sign_in_screen(api, google, claims, code) -> None:  # type: ignore[no-untyped-def]
    google(claims)
    _, response = await _callback(api)
    assert response.status_code == 303
    location = urlsplit(response.headers["location"])
    assert f"{location.scheme}://{location.netloc}" == get_settings().web_app_url
    assert (location.path, parse_qs(location.query)) == ("/sign-in", {"error": [code]})


async def test_an_accepted_google_sign_in_lands_where_it_started(  # type: ignore[no-untyped-def]
    api, google, tenant: Tenant, make_user: Callable[..., uuid.UUID]
) -> None:
    email = _email("google-person")
    make_user(tenant, email, "Google Person", status="invited")
    google({"sub": f"google-sub-{uuid.uuid4().hex}", "email": email.upper(), "email_verified": True})
    client, response = await _callback(api, next_path="/fleet/board?view=all")
    assert response.status_code == 303
    assert response.headers["location"] == f"{get_settings().web_app_url}/fleet/board?view=all"
    me = await client.get("/me/session")
    assert me.status_code == 200, me.text
    assert me.json()["user"]["email"] == email


async def test_google_sign_in_with_no_client_set_up_says_so(api, monkeypatch: pytest.MonkeyPatch) -> None:  # type: ignore[no-untyped-def]
    monkeypatch.setattr(get_settings(), "google_client_id", "")
    response = await api().get("/auth/google/login", params={"next": "/overview"})
    assert response.status_code == 303
    assert response.headers["location"] == f"{get_settings().web_app_url}/sign-in?error=google_off"


# ---------------------------------------------------------------------------
# The session: renewed once, ended for good by sign-out
# ---------------------------------------------------------------------------


async def test_an_expired_session_is_renewed_and_a_replayed_renewal_ends_it(  # type: ignore[no-untyped-def]
    api, tenant: Tenant, make_user: Callable[..., uuid.UUID], admin: psycopg.Connection
) -> None:
    email = _email("renewing")
    user_id = make_user(tenant, email, "Renewing Person", status="invited")
    client = api()
    assert (await client.post("/auth/dev-login", json={"email": email})).status_code == 200
    spent = client.cookies.get(security.REFRESH_COOKIE)

    with admin.cursor() as cur:
        cur.execute(
            "UPDATE core.sessions SET expires_at = now() - interval '1 minute' WHERE user_id = %s", (user_id,)
        )
    assert (await client.get("/me/session")).status_code == 401
    assert (await client.post("/auth/refresh")).status_code == 200
    assert (await client.get("/me/session")).status_code == 200

    # The refresh token it replaced, presented again: someone holds a copy, so
    # the whole chain is revoked and the honest browser is signed out too.
    thief = api()
    thief.cookies.set(security.REFRESH_COOKIE, spent)
    assert (await thief.post("/auth/refresh")).status_code == 401
    assert (await client.get("/me/session")).status_code == 401
    assert (await client.post("/auth/refresh")).status_code == 401


async def test_sign_out_ends_the_session(api, tenant: Tenant, make_user: Callable[..., uuid.UUID]) -> None:  # type: ignore[no-untyped-def]
    email = _email("leaving")
    make_user(tenant, email, "Leaving Person", status="invited")
    client = api()
    assert (await client.post("/auth/dev-login", json={"email": email})).status_code == 200
    session_cookie = client.cookies.get(security.SESSION_COOKIE)
    assert (await client.get("/me/session")).status_code == 200

    assert (await client.post("/auth/logout")).status_code == 200
    assert (await client.get("/me/session")).status_code == 401
    # Not merely forgotten by this browser: a copy of the old cookie is dead too.
    copy = api()
    copy.cookies.set(security.SESSION_COOKIE, session_cookie)
    assert (await copy.get("/me/session")).status_code == 401


async def test_a_stopped_account_cannot_use_its_session(  # type: ignore[no-untyped-def]
    api, make_person: Callable[..., Person], tenant: Tenant, admin: psycopg.Connection
) -> None:
    """What the web app shows as 'account stopped' on boot: a 403 from /me/session."""
    person = make_person(tenant, "Stopped Midway", ["fleet.board.read"])
    assert (await api(person).get("/me/session")).status_code == 200
    with admin.cursor() as cur:
        cur.execute("UPDATE core.users SET status = 'disabled' WHERE id = %s", (person.user_id,))
    assert (await api(person).get("/me/session")).status_code == 403


# ---------------------------------------------------------------------------
# GET /me/session is shaped exactly like SessionPayload
# ---------------------------------------------------------------------------


def _interfaces() -> dict[str, set[str]]:
    """Each `export interface Session…` in session.ts, as its set of field names."""
    source = SESSION_TS.read_text(encoding="utf-8")
    found = {
        name: set(re.findall(r"^  (\w+)\??:", body, flags=re.MULTILINE))
        for name, body in re.findall(
            r"^export interface (Session\w*) \{\n(.*?)^\}", source, re.MULTILINE | re.DOTALL
        )
    }
    assert {"SessionPayload", "SessionUser", "SessionSite"} <= found.keys(), (
        "the pattern is reading the wrong thing"
    )
    return found


async def test_the_session_payload_is_shaped_like_session_ts(  # type: ignore[no-untyped-def]
    api, make_person: Callable[..., Person], make_tenant: Callable[..., Tenant], admin: psycopg.Connection
) -> None:
    tenant = make_tenant("contract")
    with admin.cursor() as cur:
        cur.execute(
            "INSERT INTO core.gst_registrations"
            " (organization_id, legal_entity_id, gstin, state_code, legal_name)"
            " VALUES (%s, %s, %s, '33', 'Contract Minerals')",
            (tenant.org_id, tenant.legal_entity_id, f"33AAFFC{uuid.uuid4().hex[:4].upper()}K1Z5"),
        )
    person = make_person(tenant, "Contract Person", ["fleet.board.read"], sites=[tenant.site_id])
    payload = (await api(person).get("/me/session")).json()

    entity = payload["legalEntities"][0]
    shapes = {
        "SessionPayload": payload,
        "SessionUser": payload["user"],
        "SessionOrganization": payload["organization"],
        "SessionLegalEntity": entity,
        "SessionGstRegistration": entity["gstRegistrations"][0],
        "SessionSite": payload["sites"][0],
        "SessionRole": payload["roles"][0],
    }
    interfaces = _interfaces()
    assert set(shapes) == set(interfaces), (
        "an interface in session.ts has no counterpart here, or the reverse"
    )
    for name, sent in shapes.items():
        assert set(sent) == interfaces[name], name

    assert payload["roles"] == [{"key": payload["roles"][0]["key"], "label": "Contract Person"}]
    assert payload["activeSiteScope"] == str(tenant.site_id)

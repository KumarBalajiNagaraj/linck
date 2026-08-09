"""Cookies, opaque session credentials, and Google ID-token verification.

Everything the sign-in flow needs that is not HTTP routing lives here, so
``app/api/auth.py`` stays a readable description of the flow.

Three decisions in this module are load-bearing:

1. **The browser never holds a token.** The session cookie carries an opaque
   session id and the refresh cookie carries a high-entropy random string; both
   are httpOnly, so no JavaScript in the SPA can read either. Authority lives in
   the ``core.sessions`` row, which means revocation is a single UPDATE rather
   than a wait for a JWT to expire.

2. **The cookies also carry the organization id.** Not as authority — as
   routing. ``core.sessions`` is under RLS, so a row cannot be read at all until
   ``app.current_org_id`` is set, and the refresh endpoint has to find the
   session *before* it knows the tenant. The alternative was a third
   SECURITY DEFINER function that reads sessions with no tenant context, which
   is a much wider hole than telling the server which tenant to scope to. The
   pair is signed, so it cannot be pointed at another tenant; and even if the
   signature were forged, the session id would not match a row over there.

3. **Refresh tokens are hashed with a bare SHA-256, not a KDF.** A slow KDF
   defends a low-entropy secret against offline guessing. These are 48 random
   bytes from ``secrets``; there is nothing to guess, and bcrypt on the refresh
   path would only buy latency on every rotation.
"""

from __future__ import annotations

import asyncio
import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import httpx
from authlib.oidc.core import CodeIDToken
from fastapi import Response
from itsdangerous import BadSignature, URLSafeTimedSerializer
from joserfc import jwt as jose_jwt
from joserfc.errors import InvalidKeyIdError
from joserfc.jwk import KeySet
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.settings import get_settings

settings = get_settings()


# ---------------------------------------------------------------------------
# Cookie names
# ---------------------------------------------------------------------------
# The __Host- prefix is a browser-enforced promise: the cookie must be Secure,
# must be Path=/, and must have no Domain attribute. That last part is the
# reason to want it — it makes the cookie unsettable by a sibling subdomain, so
# a compromised marketing site on the same registrable domain cannot plant a
# session cookie on the app. The prefix is *illegal* without Secure, and Secure
# means HTTPS, so local development over http:// has to drop it. Deriving all
# three names from one stem keeps the local and deployed cookie sets
# structurally identical instead of accidentally diverging.

_STEM = settings.session_cookie_name.removeprefix("__Host-")
_PREFIX = "__Host-" if settings.cookie_secure and settings.session_cookie_name.startswith("__Host-") else ""


def _cookie_name(suffix: str = "") -> str:
    return f"{_PREFIX}{_STEM}_{suffix}" if suffix else f"{_PREFIX}{_STEM}"


SESSION_COOKIE = _cookie_name()
REFRESH_COOKIE = _cookie_name("refresh")
FLOW_COOKIE = _cookie_name("flow")

# The OAuth round trip to Google and back. Ten minutes is generous for a person
# picking an account and short enough that a stolen verifier is worthless.
FLOW_TTL_SECONDS = 600

# CONTRACT: this salt and the {sid, oid} payload shape are shared with
# app/api/deps.py, which reads on every request what this module mints at
# sign-in. Changing either here without changing it there signs every user out.
SESSION_COOKIE_SALT = "linck.session.cookie"

_session_signer = URLSafeTimedSerializer(settings.session_secret, salt=SESSION_COOKIE_SALT)
_refresh_signer = URLSafeTimedSerializer(settings.session_secret, salt="linck.refresh")
_flow_signer = URLSafeTimedSerializer(settings.session_secret, salt="linck.oauth-flow")


def _cookie_kwargs() -> dict[str, Any]:
    return {
        "httponly": True,
        "secure": settings.cookie_secure,
        # Lax, not Strict: the sign-in redirect arrives from accounts.google.com
        # as a top-level GET, and Strict would withhold the cookie on exactly
        # that navigation. Lax still withholds it from cross-site POSTs, which
        # is what protects /auth/refresh and /auth/logout from CSRF.
        "samesite": "lax",
        # __Host- requires Path=/ and forbids Domain. Both are unconditional
        # here so the local cookie behaves the same way as the deployed one.
        "path": "/",
    }


# ---------------------------------------------------------------------------
# The short-lived OAuth flow cookie
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FlowState:
    """What /auth/google/login has to remember until Google redirects back."""

    state: str
    code_verifier: str
    nonce: str
    next_path: str


def issue_flow_cookie(
    response: Response, *, state: str, code_verifier: str, nonce: str, next_path: str
) -> None:
    """Park the PKCE verifier, the CSRF state and the nonce in the user agent.

    Server-side storage would work too, but it would mean a shared cache entry
    per in-flight sign-in for a value that is useless to anyone but this
    browser. Signed and time-limited, the cookie is the smaller thing.
    """
    payload = {"s": state, "v": code_verifier, "n": nonce, "r": next_path}
    response.set_cookie(
        FLOW_COOKIE, _flow_signer.dumps(payload), max_age=FLOW_TTL_SECONDS, **_cookie_kwargs()
    )


def read_flow_cookie(raw: str | None) -> FlowState | None:
    """Return the parked flow state, or None if it is missing, tampered with or
    older than FLOW_TTL_SECONDS. All three are the same thing to the caller:
    start the sign-in again."""
    if not raw:
        return None
    try:
        payload = _flow_signer.loads(raw, max_age=FLOW_TTL_SECONDS)
    except BadSignature:
        return None
    if not isinstance(payload, dict):
        return None
    try:
        return FlowState(
            state=str(payload["s"]),
            code_verifier=str(payload["v"]),
            nonce=str(payload["n"]),
            next_path=str(payload["r"]),
        )
    except KeyError:
        return None


def clear_flow_cookie(response: Response) -> None:
    response.delete_cookie(FLOW_COOKIE, **_cookie_kwargs())


# ---------------------------------------------------------------------------
# Session cookies
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class SessionCredential:
    """A freshly minted session row plus the one-time refresh secret for it.

    ``refresh_token`` exists only in this object and in the Set-Cookie header.
    What lands in the database is its SHA-256, so a database dump is not a
    pile of usable credentials.
    """

    session_id: uuid.UUID
    organization_id: uuid.UUID
    user_id: uuid.UUID
    refresh_token: str
    expires_at: datetime


def set_auth_cookies(response: Response, credential: SessionCredential) -> None:
    kwargs = _cookie_kwargs()
    max_age = settings.refresh_ttl_days * 24 * 60 * 60
    response.set_cookie(
        SESSION_COOKIE,
        # `oid`, not `org` — see SESSION_COOKIE_SALT above. app/api/deps.py
        # reads this key on every authenticated request.
        _session_signer.dumps(
            {"sid": str(credential.session_id), "oid": str(credential.organization_id)}
        ),
        max_age=max_age,
        **kwargs,
    )
    response.set_cookie(
        REFRESH_COOKIE,
        _refresh_signer.dumps(
            {"tok": credential.refresh_token, "org": str(credential.organization_id)}
        ),
        max_age=max_age,
        **kwargs,
    )


def clear_auth_cookies(response: Response) -> None:
    kwargs = _cookie_kwargs()
    response.delete_cookie(SESSION_COOKIE, **kwargs)
    response.delete_cookie(REFRESH_COOKIE, **kwargs)


def read_session_cookie(raw: str | None) -> tuple[uuid.UUID, uuid.UUID] | None:
    """(session_id, organization_id), or None if absent or unsigned by us."""
    payload = _unsign(_session_signer, raw)
    if payload is None:
        return None
    try:
        return uuid.UUID(str(payload["sid"])), uuid.UUID(str(payload["oid"]))
    except (KeyError, ValueError):
        return None


def read_refresh_cookie(raw: str | None) -> tuple[str, uuid.UUID] | None:
    """(refresh_token, organization_id), or None if absent or unsigned by us."""
    payload = _unsign(_refresh_signer, raw)
    if payload is None:
        return None
    try:
        return str(payload["tok"]), uuid.UUID(str(payload["org"]))
    except (KeyError, ValueError):
        return None


def _unsign(signer: URLSafeTimedSerializer, raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        payload = signer.loads(raw, max_age=settings.refresh_ttl_days * 24 * 60 * 60)
    except BadSignature:
        return None
    return payload if isinstance(payload, dict) else None


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_refresh_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Session rows
# ---------------------------------------------------------------------------
# Every function below expects a session already inside tenant_session(org, ...),
# because core.sessions is under RLS and reads nothing without the GUC set.


async def create_session(
    db: AsyncSession,
    *,
    organization_id: uuid.UUID,
    user_id: uuid.UUID,
    user_agent: str | None = None,
    ip: str | None = None,
    replaces_session_id: uuid.UUID | None = None,
) -> SessionCredential:
    token = new_refresh_token()
    row = (
        await db.execute(
            text(
                """
                insert into core.sessions
                    (organization_id, user_id, refresh_token_hash, replaces_session_id,
                     user_agent, ip, expires_at)
                values
                    (:org, :uid, :hash, :replaces, :ua, cast(:ip as inet),
                     now() + cast(:ttl as int) * interval '1 minute')
                returning id, expires_at
                """
            ),
            {
                "org": str(organization_id),
                "uid": str(user_id),
                "hash": hash_refresh_token(token),
                "replaces": str(replaces_session_id) if replaces_session_id else None,
                # Truncated because a user agent string is attacker-controlled
                # free text and this column is only ever read by a human
                # reviewing "where am I signed in".
                "ua": user_agent[:512] if user_agent else None,
                "ip": ip,
                "ttl": settings.session_ttl_minutes,
            },
        )
    ).one()
    return SessionCredential(
        session_id=row[0],
        organization_id=organization_id,
        user_id=user_id,
        refresh_token=token,
        expires_at=row[1],
    )


async def revoke_session_chain(db: AsyncSession, seed_session_id: uuid.UUID, reason: str) -> int:
    """Revoke every session descended from or ancestral to ``seed_session_id``.

    Rotation leaves a linked list: each new row points at the row it replaced.
    A replayed refresh token proves *one* row's secret leaked, but the attacker
    and the honest user are by then holding different links of the same list,
    so revoking the presented row alone leaves whichever of them rotated last
    still signed in. The whole family goes.

    Revoking by ``user_id`` instead would be simpler and wrong: a plant head
    with a phone and a desktop holds two unrelated chains, and one stolen
    laptop should not sign them out of the weighbridge.

    The recursive term walks both directions — up via ``replaces_session_id``
    and down via rows that point back at us — so the seed can be any link.
    UNION rather than UNION ALL is what terminates it.
    """
    result = await db.execute(
        text(
            """
            with recursive family as (
                select id, replaces_session_id
                from core.sessions
                where id = :seed
              union
                select s.id, s.replaces_session_id
                from core.sessions s
                join family f
                  on s.id = f.replaces_session_id
                  or s.replaces_session_id = f.id
            )
            update core.sessions
               set revoked_at = now(), revoked_reason = :reason
             where id in (select id from family)
               and revoked_at is null
            """
        ),
        {"seed": str(seed_session_id), "reason": reason},
    )
    return result.rowcount or 0


@dataclass(frozen=True, slots=True)
class RotationResult:
    """Why rotation is not allowed to raise.

    Detecting a replay means revoking the chain, and that revocation is a
    write. If this raised from inside the caller's ``tenant_session`` block the
    transaction would roll back and the revocation — the entire point of
    detecting the replay — would be silently discarded. So the outcome is
    returned, the transaction commits, and the caller turns ``failure`` into a
    401 afterwards.
    """

    credential: SessionCredential | None = None
    failure: str | None = None


async def rotate_session(
    db: AsyncSession,
    *,
    presented_token: str,
    user_agent: str | None = None,
    ip: str | None = None,
) -> RotationResult:
    """Exchange a refresh token for a new session row, or detect a replay."""
    row = (
        await db.execute(
            text(
                """
                select s.id,
                       s.organization_id,
                       s.user_id,
                       s.revoked_at is not null as revoked,
                       s.created_at < now() - cast(:days as int) * interval '1 day' as too_old,
                       exists (
                           select 1 from core.sessions c where c.replaces_session_id = s.id
                       ) as superseded
                from core.sessions s
                where s.refresh_token_hash = :hash
                limit 1
                """
            ),
            {"hash": hash_refresh_token(presented_token), "days": settings.refresh_ttl_days},
        )
    ).mappings().first()

    if row is None:
        # Either a forged token or one belonging to a chain that was revoked and
        # subsequently pruned. Nothing to revoke; nothing to tell the caller.
        return RotationResult(failure="unknown")

    if row["revoked"] or row["superseded"]:
        # This token has been spent already. Rotation is what makes that
        # observable: the honest client holds only the newest secret, so a
        # second presentation of an older one means a copy of the cookie is in
        # circulation. Both branches are checked rather than trusting the
        # revoked flag alone, so a crash between the INSERT and the UPDATE of a
        # previous rotation still reads as a replay rather than a free pass.
        await revoke_session_chain(db, row["id"], "refresh_replay_detected")
        return RotationResult(failure="replay")

    if row["too_old"]:
        await revoke_session_chain(db, row["id"], "refresh_window_elapsed")
        return RotationResult(failure="expired")

    credential = await create_session(
        db,
        organization_id=row["organization_id"],
        user_id=row["user_id"],
        user_agent=user_agent,
        ip=ip,
        replaces_session_id=row["id"],
    )
    # Retire the presented row in the same transaction that mints its
    # replacement, so there is never a moment where two live secrets open the
    # same session.
    await db.execute(
        text(
            """
            update core.sessions
               set revoked_at = now(), revoked_reason = 'rotated'
             where id = :id and revoked_at is null
            """
        ),
        {"id": str(row["id"])},
    )
    return RotationResult(credential=credential)


# ---------------------------------------------------------------------------
# Google ID token verification
# ---------------------------------------------------------------------------

GOOGLE_DISCOVERY_URL = "https://accounts.google.com/.well-known/openid-configuration"

# Google publishes cache lifetimes on both documents; an hour is inside them and
# the JWKS is force-refreshed on an unknown kid anyway, so key rotation never
# waits for the clock.
_DISCOVERY_TTL_SECONDS = 3600

# Google has minted tokens under both spellings for years and its own libraries
# accept either.
_GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"]

_metadata: dict[str, Any] | None = None
_metadata_at: float = 0.0
_key_set: KeySet | None = None
_key_set_at: float = 0.0
_discovery_lock = asyncio.Lock()


class IdTokenInvalid(Exception):
    """The ID token did not verify. Never surfaced to the browser verbatim."""


async def google_metadata(*, force: bool = False) -> dict[str, Any]:
    """The OIDC discovery document, cached.

    Discovered rather than hard-coded because Google's authorization, token and
    JWKS endpoints are theirs to move, and a stale constant in our source is a
    total sign-in outage that no test would catch.
    """
    global _metadata, _metadata_at
    if _metadata is not None and not force and time.monotonic() - _metadata_at < _DISCOVERY_TTL_SECONDS:
        return _metadata
    async with _discovery_lock:
        if (
            _metadata is not None
            and not force
            and time.monotonic() - _metadata_at < _DISCOVERY_TTL_SECONDS
        ):
            return _metadata
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(GOOGLE_DISCOVERY_URL)
            response.raise_for_status()
            _metadata = response.json()
            _metadata_at = time.monotonic()
    return _metadata


async def google_key_set(*, force: bool = False) -> KeySet:
    """Google's signing keys, cached, refetchable on demand."""
    global _key_set, _key_set_at
    if _key_set is not None and not force and time.monotonic() - _key_set_at < _DISCOVERY_TTL_SECONDS:
        return _key_set
    # Fetched before taking the lock, because google_metadata() takes the same
    # one and asyncio.Lock is not reentrant.
    metadata = await google_metadata()
    async with _discovery_lock:
        # Re-checked inside the lock so a burst of sign-ins after a restart
        # results in one fetch rather than one per concurrent request.
        if (
            _key_set is not None
            and not force
            and time.monotonic() - _key_set_at < _DISCOVERY_TTL_SECONDS
        ):
            return _key_set
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(metadata["jwks_uri"])
            response.raise_for_status()
            _key_set = KeySet.import_key_set(response.json())
            _key_set_at = time.monotonic()
    return _key_set


async def verify_google_id_token(
    raw_id_token: str, *, access_token: str | None, nonce: str
) -> dict[str, Any]:
    """Verify signature, issuer, audience, expiry and nonce; return the claims.

    The ID token — not the userinfo endpoint, and certainly not the access
    token — is the thing that carries an assertion about *who* signed in. An
    access token is a bearer credential for calling Google's APIs; it says
    nothing verifiable about the person, and treating it as proof of identity
    is how confused-deputy bugs get written.
    """
    metadata = await google_metadata()
    algorithms = metadata.get("id_token_signing_alg_values_supported") or ["RS256"]

    try:
        key_set = await google_key_set()
        try:
            decoded = jose_jwt.decode(raw_id_token, key_set, algorithms=algorithms)
        except InvalidKeyIdError:
            # Google rotates signing keys on its own schedule. An unrecognised
            # kid means our cache is behind, not that the token is forged — but
            # exactly one retry, so a genuinely unknown kid cannot be used to
            # hammer Google's JWKS endpoint through us.
            key_set = await google_key_set(force=True)
            decoded = jose_jwt.decode(raw_id_token, key_set, algorithms=algorithms)

        claims = CodeIDToken(
            decoded.claims,
            decoded.header,
            {"iss": {"essential": True, "values": _GOOGLE_ISSUERS}},
            {
                "nonce": nonce,
                "client_id": settings.google_client_id,
                "access_token": access_token,
            },
        )
        # Leeway for clock skew between us and Google; two minutes is what
        # Google's own libraries allow.
        claims.validate(leeway=120)
    except IdTokenInvalid:
        raise
    except Exception as exc:
        # A bad signature, an expired token, a mismatched nonce and a malformed
        # blob are one outcome to the caller: this token proves nothing.
        raise IdTokenInvalid(str(exc)) from exc

    # Checked here rather than through the claims registry because `aud` is a
    # list in the general case and the registry's value match is written for
    # scalars. A token minted for a different client is a token minted for a
    # different application.
    audience = claims.get("aud")
    audiences = audience if isinstance(audience, list) else [audience]
    if settings.google_client_id not in audiences:
        raise IdTokenInvalid("id_token audience is not this client")

    if not claims.get("sub"):
        raise IdTokenInvalid("id_token carries no subject")

    return dict(claims)

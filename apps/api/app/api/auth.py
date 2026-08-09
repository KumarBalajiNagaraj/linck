"""Google sign-in, session rotation, and sign-out.

The rule this router exists to enforce is that **signing in never creates a
user**. An admin registers the person first; Google is then only ever asked one
question — is the human at this keyboard the holder of that email address. A
Google account on its own can therefore never bootstrap access to a tenant,
which is the property that makes it safe to let drivers and weighbridge
operators use the same front door as the finance team.

The resolution order matters and is not interchangeable:

1. ``email_verified`` must be true. Google will happily issue an ID token for
   an unverified address, and an unverified address is a claim, not an identity
   — anyone can put ``ramesh@client.example`` on a fresh account.
2. ``core.resolve_identity('google', sub)`` — the returning user. ``sub`` is
   the only Google field that is stable; email is a Workspace admin away from
   changing and the display name is a settings screen away.
3. ``core.resolve_pending_user(email, hd)`` — the first sign-in, matching the
   verified email against a pre-registered row, then pinning ``sub`` so step 2
   answers ever after.
4. Otherwise 403. Not 404, not "unknown email" — the response is identical
   whether the address exists in some tenant or nowhere at all.

Both resolvers are SECURITY DEFINER functions because they run before any
tenant context exists: RLS cannot scope a query whose entire purpose is to find
out which tenant to scope to. Everything after that point goes through
``tenant_session``.
"""

from __future__ import annotations

import secrets
import uuid
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

from authlib.common.security import generate_token
from authlib.integrations.httpx_client import AsyncOAuth2Client
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import tenant_session
from app.core.security import (
    FLOW_COOKIE,
    REFRESH_COOKIE,
    SESSION_COOKIE,
    IdTokenInvalid,
    SessionCredential,
    clear_auth_cookies,
    clear_flow_cookie,
    create_session,
    google_metadata,
    issue_flow_cookie,
    read_flow_cookie,
    read_refresh_cookie,
    read_session_cookie,
    revoke_session_chain,
    rotate_session,
    set_auth_cookies,
    verify_google_id_token,
)
from app.core.settings import get_settings

router = APIRouter(prefix="/auth", tags=["auth"])

settings = get_settings()

# One message for every way sign-in can fail to find a person. It names the
# remedy — ask your team admin — because that is genuinely the only route back
# in, and it deliberately does not distinguish "no such account", "wrong
# tenant", "wrong Google Workspace domain" or "account stood down". Those
# distinctions are useful to exactly one audience.
NOT_REGISTERED = (
    "This account is not registered for Linck. Ask your team admin to register you, "
    "then sign in again with the same Google account."
)

SCOPE = "openid email profile"


def _oauth_client() -> AsyncOAuth2Client:
    """A client configured for Authorization Code + PKCE.

    PKCE on a confidential client looks redundant — we hold a client secret, so
    a stolen authorization code cannot be redeemed without it. It is here
    because the code arrives as a query parameter on a redirect, which means it
    lands in browser history, in any referrer header the sign-in page leaks,
    and in every proxy access log between Google and us. PKCE binds the code to
    the verifier that only this browser session ever held, so a code recovered
    from a log is inert.
    """
    return AsyncOAuth2Client(
        client_id=settings.google_client_id,
        client_secret=settings.google_client_secret,
        redirect_uri=settings.oauth_redirect_url,
        scope=SCOPE,
        code_challenge_method="S256",
        token_endpoint_auth_method="client_secret_post",
        timeout=15.0,
    )


def _safe_next(raw: str | None) -> str:
    """Reduce a caller-supplied post-login target to a same-site path.

    ``?next=`` is the classic open-redirect: a link to our own sign-in that
    lands the user on an attacker's replica of the app, post-authentication and
    fully trusting. Only a path is ever accepted, and ``//host`` is rejected
    too — the browser reads a protocol-relative URL as an absolute one.
    """
    if not raw or not raw.startswith("/") or raw.startswith("//") or raw.startswith("/\\"):
        return "/"
    return raw


def _client_ip(request: Request) -> str | None:
    return request.client.host if request.client else None


def _user_agent(request: Request) -> str | None:
    return request.headers.get("user-agent")


def _sign_in_error(reason: str) -> RedirectResponse:
    """Send a failed sign-in back to the web app rather than rendering JSON.

    A person who clicked "cancel" at Google, or whose sign-in link went stale
    in a tab overnight, is not debugging an API. They get the sign-in screen
    with something it can explain.
    """
    response = RedirectResponse(
        f"{settings.web_app_url}/sign-in?{urlencode({'error': reason})}",
        status_code=status.HTTP_303_SEE_OTHER,
    )
    clear_flow_cookie(response)
    return response


# ---------------------------------------------------------------------------
# Resolution — shared by the Google callback and the local dev fallback
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class ResolvedUser:
    user_id: uuid.UUID
    organization_id: uuid.UUID
    status: str
    identity_exists: bool


async def resolve_pre_registered_user(
    *, provider: str, subject: str, email: str, email_verified: bool, hosted_domain: str | None
) -> ResolvedUser:
    """Steps 1–4 of the docstring at the top of this file.

    Raises 403 with a single indistinguishable message for every failure that
    is not "your email is unverified", which is worth saying plainly because
    the user can fix it themselves.
    """
    if not email_verified:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "This Google account's email address is not verified, so it cannot prove "
                "who you are. Verify it with Google and sign in again."
            ),
        )

    # A second, coarser gate in front of the per-tenant one in
    # core.resolve_pending_user. Defence in depth: this one is deployment-wide
    # configuration, so a misconfigured tenant row cannot widen it.
    if settings.allowed_hosted_domains and (hosted_domain or "") not in settings.allowed_hosted_domains:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_REGISTERED)

    # No tenant context: that is the whole reason both of these are
    # SECURITY DEFINER. tenant_session(None) makes the absence explicit rather
    # than incidental — RLS is active and matching nothing.
    async with tenant_session(None) as db:
        row = (
            await db.execute(
                text("select user_id, organization_id, status from core.resolve_identity(:p, :s)"),
                {"p": provider, "s": subject},
            )
        ).mappings().first()
        identity_exists = row is not None

        if row is None:
            row = (
                await db.execute(
                    text(
                        "select user_id, organization_id, status "
                        "from core.resolve_pending_user(:email, :hd)"
                    ),
                    {"email": email, "hd": hosted_domain},
                )
            ).mappings().first()

    if row is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_REGISTERED)

    # resolve_pending_user filters on status itself; resolve_identity does not,
    # because a returning user whose account was stood down still has an
    # identity row. Checked here so both paths agree.
    if row["status"] not in ("invited", "active"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=NOT_REGISTERED)

    return ResolvedUser(
        user_id=row["user_id"],
        organization_id=row["organization_id"],
        status=row["status"],
        identity_exists=identity_exists,
    )


async def _link_identity(
    db: AsyncSession,
    resolved: ResolvedUser,
    *,
    provider: str,
    subject: str,
    email: str,
    hosted_domain: str | None,
    avatar_url: str | None,
) -> None:
    """Pin the subject on first sign-in; treat later changes as profile drift."""
    if resolved.identity_exists:
        # A changed email on a known subject is a rename, not a new person.
        # Overwriting it here is what keeps the record accurate after a
        # Workspace admin changes someone's address.
        await db.execute(
            text(
                """
                update core.user_identities
                   set email = coalesce(nullif(:email, ''), email),
                       email_verified = true,
                       hosted_domain = :hd,
                       last_login_at = now()
                 where provider = :provider and subject = :subject
                """
            ),
            {"email": email, "hd": hosted_domain, "provider": provider, "subject": subject},
        )
    else:
        await db.execute(
            text(
                """
                insert into core.user_identities
                    (organization_id, user_id, provider, subject, email, email_verified,
                     hosted_domain, last_login_at)
                values (:org, :uid, :provider, :subject, :email, true, :hd, now())
                """
            ),
            {
                "org": str(resolved.organization_id),
                "uid": str(resolved.user_id),
                "provider": provider,
                "subject": subject,
                "email": email,
                "hd": hosted_domain,
            },
        )

    # `full_name` is deliberately not touched. Google's display name is
    # user-editable and two drivers called "Murugan S" is an ordinary Tuesday;
    # the name an admin typed when registering the person is the one that
    # matches the payroll record. The avatar only fills a hole.
    await db.execute(
        text(
            """
            update core.users
               set status = case when status = 'invited' then 'active' else status end,
                   last_seen_at = now(),
                   avatar_url = coalesce(avatar_url, :avatar)
             where id = :uid
            """
        ),
        {"uid": str(resolved.user_id), "avatar": avatar_url},
    )

    # First successful sign-in consumes the invitation that authorised it.
    await db.execute(
        text(
            """
            update core.invitations
               set accepted_at = now()
             where lower(email) = lower(:email) and accepted_at is null
            """
        ),
        {"email": email},
    )


async def establish_session(
    request: Request,
    resolved: ResolvedUser,
    *,
    provider: str,
    subject: str,
    email: str,
    hosted_domain: str | None = None,
    avatar_url: str | None = None,
) -> SessionCredential:
    """Link the identity and open a session, in one transaction under RLS.

    One transaction because the identity link and the session row must either
    both exist or neither: a pinned subject with no session leaves the user
    staring at a sign-in page that will now take a different branch, and a
    session with no pinned subject makes the next sign-in look like a first one.
    """
    async with tenant_session(resolved.organization_id, resolved.user_id) as db:
        await _link_identity(
            db,
            resolved,
            provider=provider,
            subject=subject,
            email=email,
            hosted_domain=hosted_domain,
            avatar_url=avatar_url,
        )
        return await create_session(
            db,
            organization_id=resolved.organization_id,
            user_id=resolved.user_id,
            user_agent=_user_agent(request),
            ip=_client_ip(request),
        )


# ---------------------------------------------------------------------------
# GET /auth/google/login
# ---------------------------------------------------------------------------


@router.get("/google/login")
async def google_login(
    request: Request,
    next_path: str = Query("/", alias="next", description="Same-site path to land on after sign-in"),
) -> RedirectResponse:
    """Start the flow: mint state + PKCE verifier + nonce, park them, go to Google."""
    if not settings.google_client_id:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Google sign-in is not configured on this server "
                "(LINCK_GOOGLE_CLIENT_ID is empty)."
            ),
        )

    metadata = await google_metadata()
    code_verifier = generate_token(64)
    nonce = generate_token(32)

    extra: dict[str, Any] = {
        # No refresh token wanted. We are not calling Google's APIs on the
        # user's behalf later — the ID token answers the only question we ask —
        # and an offline refresh token is a long-lived credential to store,
        # protect and eventually leak for no benefit.
        "access_type": "online",
        # Someone with a personal and a work Google account signed in at once
        # otherwise gets silently authenticated as whichever Google prefers,
        # and then a 403 they cannot explain.
        "prompt": "select_account",
    }
    if len(settings.allowed_hosted_domains) == 1:
        # A hint, never a check: `hd` is enforced on the verified claim after
        # the token comes back, not by asking Google nicely on the way out.
        extra["hd"] = settings.allowed_hosted_domains[0]

    async with _oauth_client() as client:
        authorize_url, state = client.create_authorization_url(
            metadata["authorization_endpoint"],
            code_verifier=code_verifier,
            nonce=nonce,
            **extra,
        )

    response = RedirectResponse(authorize_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    issue_flow_cookie(
        response,
        state=state,
        code_verifier=code_verifier,
        nonce=nonce,
        next_path=_safe_next(next_path),
    )
    return response


# ---------------------------------------------------------------------------
# GET /auth/google/callback
# ---------------------------------------------------------------------------


@router.get("/google/callback")
async def google_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
) -> RedirectResponse:
    """Google's redirect back. Verify everything, then resolve the person."""
    if error:
        # access_denied is the ordinary case: the user pressed cancel.
        return _sign_in_error(error)

    flow = read_flow_cookie(request.cookies.get(FLOW_COOKIE))
    if flow is None:
        return _sign_in_error("expired")

    # compare_digest rather than `==`: the comparison is against a value an
    # attacker supplies and can retry freely.
    if not code or not state or not secrets.compare_digest(state, flow.state):
        return _sign_in_error("state_mismatch")

    metadata = await google_metadata()
    try:
        async with _oauth_client() as client:
            token = await client.fetch_token(
                metadata["token_endpoint"],
                code=code,
                code_verifier=flow.code_verifier,
                grant_type="authorization_code",
            )
    except Exception:
        # A network blip, a rejected code and a wrong client secret all reduce
        # to the same thing for the person waiting: start again.
        return _sign_in_error("exchange_failed")

    if "id_token" not in token:
        return _sign_in_error("no_id_token")

    try:
        claims = await verify_google_id_token(
            token["id_token"],
            access_token=token.get("access_token"),
            nonce=flow.nonce,
        )
    except IdTokenInvalid:
        # The detail is not echoed. A verification failure here is either a
        # clock problem or an attack, and neither is improved by telling the
        # browser which.
        return _sign_in_error("invalid_id_token")

    subject = str(claims["sub"])
    email = str(claims.get("email") or "").lower()
    hosted_domain = claims.get("hd")

    resolved = await resolve_pre_registered_user(
        provider="google",
        subject=subject,
        email=email,
        email_verified=bool(claims.get("email_verified")),
        hosted_domain=hosted_domain,
    )

    credential = await establish_session(
        request,
        resolved,
        provider="google",
        subject=subject,
        email=email,
        hosted_domain=hosted_domain,
        avatar_url=claims.get("picture"),
    )

    response = RedirectResponse(
        f"{settings.web_app_url}{flow.next_path}", status_code=status.HTTP_303_SEE_OTHER
    )
    set_auth_cookies(response, credential)
    clear_flow_cookie(response)
    return response


# ---------------------------------------------------------------------------
# POST /auth/refresh
# ---------------------------------------------------------------------------


@router.post("/refresh")
async def refresh(request: Request) -> JSONResponse:
    """Rotate the refresh token, and treat a reused one as theft.

    Rotation is not about shortening lifetimes; it is what makes a stolen
    cookie *observable*. The honest client always holds the newest secret, so a
    second presentation of an older one means two parties hold the same
    session. There is no way to tell which of the two is the thief, so both
    lose: the entire chain is revoked and everyone signs in again.

    CSRF is handled by SameSite=Lax, which withholds the cookie from
    cross-site POSTs. This endpoint reads nothing from the body for that reason.
    """
    parsed = read_refresh_cookie(request.cookies.get(REFRESH_COOKIE))
    if parsed is None:
        return _signed_out("No refresh cookie")

    presented_token, organization_id = parsed

    # The org id comes from the signed cookie purely to satisfy RLS. It grants
    # nothing: the token hash still has to match a row inside that tenant.
    async with tenant_session(organization_id) as db:
        result = await rotate_session(
            db,
            presented_token=presented_token,
            user_agent=_user_agent(request),
            ip=_client_ip(request),
        )

    # Deliberately outside the transaction above. A replay revokes the chain,
    # and raising before the commit would throw that revocation away — see
    # RotationResult in app/core/security.py.
    if result.credential is None:
        detail = {
            "replay": "This session was signed out for security. Please sign in again.",
            "expired": "This session has expired. Please sign in again.",
        }.get(result.failure or "", "Not signed in")
        return _signed_out(detail)

    response = JSONResponse(
        {
            "session_id": str(result.credential.session_id),
            "expires_at": result.credential.expires_at.isoformat(),
        }
    )
    set_auth_cookies(response, result.credential)
    return response


def _signed_out(detail: str) -> JSONResponse:
    """401 with the cookies cleared.

    HTTPException cannot carry Set-Cookie, and leaving a dead cookie in place
    means the SPA retries the same doomed refresh on every page load.
    """
    response = JSONResponse({"detail": detail}, status_code=status.HTTP_401_UNAUTHORIZED)
    clear_auth_cookies(response)
    return response


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------


@router.post("/logout")
async def logout(request: Request) -> JSONResponse:
    """Revoke the session chain and clear the cookies.

    The whole chain, not just the current link: every rotation left an older
    refresh secret behind, and signing out has to mean all of them are dead,
    not just the newest.

    Always returns 200. Sign-out is idempotent, and a 401 on "please forget me"
    is a worse answer than doing nothing.
    """
    parsed = read_session_cookie(request.cookies.get(SESSION_COOKIE))
    if parsed is not None:
        session_id, organization_id = parsed
        async with tenant_session(organization_id) as db:
            await revoke_session_chain(db, session_id, "logout")

    response = JSONResponse({"ok": True})
    clear_auth_cookies(response)
    return response


# ---------------------------------------------------------------------------
# POST /auth/dev-login — local only, and only without Google credentials
# ---------------------------------------------------------------------------


class DevLoginRequest(BaseModel):
    # Not EmailStr: that needs the `email-validator` package, which is not a
    # dependency of this service. The value is only ever a bind parameter to
    # core.resolve_pending_user, which is the thing that decides whether it
    # names anybody.
    email: str = Field(min_length=3, max_length=320, pattern=r"^[^@\s]+@[^@\s]+$")


DEV_LOGIN_ENABLED = settings.environment == "local" and not settings.google_client_id

if DEV_LOGIN_ENABLED:

    @router.post("/dev-login")
    async def dev_login(payload: DevLoginRequest, request: Request) -> JSONResponse:
        """Sign in as a pre-registered user without Google. LOCAL ONLY.

        **Why it exists.** A new developer, a CI run and an integration test all
        need a signed-in session, and none of them can get one without a Google
        OAuth client, a consent screen and a real Google account per persona.
        Making the API unrunnable until someone provisions all that means the
        first thing anyone does is hack the auth check out locally — and that
        hack is what eventually ships.

        **What it deliberately skips.** Everything Google was there to do:
        there is no ID token, no signature, no nonce, no PKCE, no proof of any
        kind that the caller is the person named in the body. It asserts an
        email and is believed.

        **What it deliberately does NOT skip.** The resolution path is the same
        one the real callback takes — ``core.resolve_identity`` first, then
        ``core.resolve_pending_user``, then a 403 — so it still cannot create a
        user, still cannot reach a user in a tenant that has not registered
        them, and still cannot reach a suspended one. That is the part worth
        exercising locally, because it is the part with the interesting bugs.

        **Why it cannot leak into a deployed environment.** The route is only
        registered when the environment is ``local`` *and* no Google client id
        is configured, so anywhere else the path simply does not exist and
        FastAPI answers 404. The runtime check below is belt and braces for the
        case where this module is imported by something that built its own app.

        The identity is pinned under provider ``dev``, never ``google``: a
        fabricated subject must never be able to collide with, or masquerade
        as, a real Google ``sub``.
        """
        if not (settings.environment == "local" and not settings.google_client_id):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")

        email = payload.email.lower()
        resolved = await resolve_pre_registered_user(
            provider="dev",
            subject=f"dev-local:{email}",
            email=email,
            # Asserted, not proven. The real callback gets this from a signed
            # claim; here there is nothing to get it from.
            email_verified=True,
            hosted_domain=email.split("@")[-1],
        )
        credential = await establish_session(
            request, resolved, provider="dev", subject=f"dev-local:{email}", email=email
        )

        response = JSONResponse(
            {
                "user_id": str(credential.user_id),
                "organization_id": str(credential.organization_id),
                "session_id": str(credential.session_id),
                "expires_at": credential.expires_at.isoformat(),
                "warning": "dev-login: no identity was proven",
            }
        )
        set_auth_cookies(response, credential)
        return response


__all__ = ["router", "DEV_LOGIN_ENABLED", "NOT_REGISTERED", "resolve_pre_registered_user"]

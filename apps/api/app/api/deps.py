"""Request-scoped authentication and authorisation.

Two things here are load-bearing.

**The cookie has to carry the organization id, not just the session id.**
`core.sessions` is under FORCE ROW LEVEL SECURITY like every other tenant
table, so a row is only visible once `app.current_org_id` is already set. A
cookie holding a bare session id would therefore be unreadable: to look up the
tenant you must first know the tenant. The two ways out are a SECURITY DEFINER
lookup (another hole in the RLS wall, for something used on every request) or
putting the tenant id in the cookie and signing it. This takes the second: the
cookie is an itsdangerous-signed payload of `{sid, oid}`, and the session row
is then loaded under that tenant with `id = :sid AND organization_id = :oid`.
A tampered `oid` fails the signature; a mismatched one finds no row. Neither
value is ever trusted for authorisation on its own — the session row is.

**Grants are resolved in one query.** `/me/session` is on the critical path of
every page load, and the obvious shape (fetch assignments, then fetch each
role's permissions) is an N+1 that grows with how carefully a tenant has
scoped its people — i.e. it punishes exactly the customers doing it right.
"""

import uuid
from collections.abc import AsyncIterator, Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from itsdangerous import BadSignature, URLSafeTimedSerializer
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import tenant_session
from app.core.settings import Settings, get_settings
from app.models.core import Session as SessionRow
from app.models.core import User

COOKIE_SALT = "linck.session.cookie"

# A person whose account was stood down keeps a valid cookie until it expires,
# so status is re-checked on every request rather than only at sign-in.
BLOCKED_USER_STATUSES = frozenset({"suspended", "disabled", "archived", "removed"})


# ---------------------------------------------------------------------------
# Cookie codec — shared with the auth router, which mints what this reads
# ---------------------------------------------------------------------------


def session_cookie_name(settings: Settings | None = None) -> str:
    """The `__Host-` prefix requires Secure, which requires HTTPS, so local
    development over http:// has to drop it or the browser refuses the cookie."""
    settings = settings or get_settings()
    name = settings.session_cookie_name
    if not settings.cookie_secure and name.startswith("__Host-"):
        return name.removeprefix("__Host-")
    return name


def _serializer(settings: Settings) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.session_secret, salt=COOKIE_SALT)


def sign_session_cookie(session_id: uuid.UUID | str, organization_id: uuid.UUID | str) -> str:
    """Mint the cookie value. The auth router calls this on sign-in and on
    every refresh rotation."""
    settings = get_settings()
    return _serializer(settings).dumps({"sid": str(session_id), "oid": str(organization_id)})


def _pick(payload: dict[str, object], *keys: str) -> str | None:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return None


def read_session_cookie(raw: str) -> tuple[uuid.UUID, uuid.UUID] | None:
    """Verify the signature and return `(session_id, organization_id)`.

    Returns None for anything unreadable — a bad signature, a payload of the
    wrong shape, an id that is not a UUID. The caller turns that into a plain
    401 without saying which, because the difference is only useful to someone
    probing the cookie.
    """
    settings = get_settings()
    try:
        payload = _serializer(settings).loads(raw)
    except BadSignature:
        return None
    if not isinstance(payload, dict):
        return None

    sid = _pick(payload, "sid", "session_id", "sessionId")
    oid = _pick(payload, "oid", "org_id", "organization_id", "organizationId")
    if not sid or not oid:
        return None
    try:
        return uuid.UUID(sid), uuid.UUID(oid)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# The current session
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CurrentSession:
    """Everything downstream needs about who is asking.

    `db` is the transaction the tenant GUC was set on. Handing it down rather
    than opening a second one is what keeps the tenant context and the query
    inseparable: there is no way to run a request query outside the
    transaction that scoped it.
    """

    user: User
    organization_id: uuid.UUID
    session_id: uuid.UUID
    db: AsyncSession

    def __iter__(self) -> Iterator[object]:
        # So `user, organization_id = current` reads naturally at call sites
        # that only want the pair.
        yield self.user
        yield self.organization_id


def _unauthorized(detail: str) -> HTTPException:
    return HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


async def current_session(request: Request) -> AsyncIterator[CurrentSession]:
    settings = get_settings()
    raw = request.cookies.get(session_cookie_name(settings)) or request.cookies.get(
        settings.session_cookie_name
    )
    if not raw:
        raise _unauthorized("Not signed in")

    identity = read_session_cookie(raw)
    if identity is None:
        raise _unauthorized("Not signed in")
    session_id, organization_id = identity

    async with tenant_session(organization_id) as db:
        row = (
            await db.execute(
                select(SessionRow, User)
                .join(User, User.id == SessionRow.user_id)
                .where(SessionRow.id == session_id, SessionRow.organization_id == organization_id)
            )
        ).first()
        if row is None:
            raise _unauthorized("Session not found")

        session_row: SessionRow = row[0]
        user: User = row[1]

        if session_row.revoked_at is not None:
            raise _unauthorized("Session revoked")
        if session_row.expires_at <= datetime.now(UTC):
            raise _unauthorized("Session expired")
        if user.status in BLOCKED_USER_STATUSES:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Account is not active")

        # Attribute anything this request writes to the person, not to the app
        # role. Set here rather than at open time because the actor comes from
        # the session row we just verified, never from the cookie payload.
        await db.execute(
            text("select set_config('app.current_user_id', :uid, true)"),
            {"uid": str(user.id)},
        )

        request.state.user_id = user.id
        request.state.organization_id = organization_id

        yield CurrentSession(
            user=user,
            organization_id=organization_id,
            session_id=session_row.id,
            db=db,
        )


#: What routes annotate with, so the dependency is declared in one place.
CurrentSessionDep = Annotated[CurrentSession, Depends(current_session)]


# ---------------------------------------------------------------------------
# Grants
# ---------------------------------------------------------------------------

# One pass over role_assignments joined through role_permissions, grouped by
# permission. RLS on both tables already confines this to the tenant, so the
# only predicate needed is the user. `bool_or(site_id is null)` is the org-wide
# test: one unscoped assignment anywhere grants the permission everywhere.
# When it is org-wide the site list is emptied — the client substitutes the
# full site list itself, and sending both invites the two to disagree.
GRANTS_SQL = text(
    """
    select rp.permission_key                                   as permission_key,
           bool_or(ra.site_id is null)                         as org_wide,
           case when bool_or(ra.site_id is null)
                then '{}'::uuid[]
                else array_remove(array_agg(distinct ra.site_id), null)
           end                                                 as site_ids
    from core.role_assignments ra
    join core.role_permissions rp on rp.role_id = ra.role_id
    where ra.user_id = :user_id
    group by rp.permission_key
    """
)


@dataclass(frozen=True)
class Grant:
    org_wide: bool
    site_ids: list[uuid.UUID]


async def load_grants(db: AsyncSession, user_id: uuid.UUID) -> dict[str, Grant]:
    rows = (await db.execute(GRANTS_SQL, {"user_id": str(user_id)})).all()
    return {
        key: Grant(org_wide=bool(org_wide), site_ids=list(site_ids or []))
        for key, org_wide, site_ids in rows
    }


SINGLE_GRANT_SQL = text(
    """
    select bool_or(ra.site_id is null)                         as org_wide,
           array_remove(array_agg(distinct ra.site_id), null)  as site_ids
    from core.role_assignments ra
    join core.role_permissions rp on rp.role_id = ra.role_id
    where ra.user_id = :user_id and rp.permission_key = :permission_key
    """
)


async def load_grant(db: AsyncSession, user_id: uuid.UUID, permission: str) -> Grant | None:
    row = (
        await db.execute(SINGLE_GRANT_SQL, {"user_id": str(user_id), "permission_key": permission})
    ).first()
    if row is None or row[0] is None:
        return None
    org_wide = bool(row[0])
    return Grant(org_wide=org_wide, site_ids=[] if org_wide else list(row[1] or []))


def require(permission: str) -> Callable[..., object]:
    """Dependency factory: 403 unless the caller holds `permission` somewhere.

    Deliberately only answers "at all", not "at this site". Site scoping is a
    property of the row being touched, so it belongs in the query that fetches
    it — a route-level check would have to guess which of its parameters names
    a site, and would be wrong the first time a route took two.
    """

    async def guard(current: Annotated[CurrentSession, Depends(current_session)]) -> CurrentSession:
        grant = await load_grant(current.db, current.user.id, permission)
        if grant is None or (not grant.org_wide and not grant.site_ids):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing permission: {permission}",
            )
        return current

    return guard

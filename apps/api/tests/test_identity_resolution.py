"""The two SECURITY DEFINER functions the sign-in path runs before any tenant
context exists.

They are the only holes in the RLS wall, so what they will and will not answer
is the security boundary for authentication. Three properties matter:

  * an unknown Google subject resolves to nothing — sign-in never creates a user;
  * a pre-registered user is matched on the verified email, case-insensitively,
    because Google returns whatever casing the person typed years ago;
  * a tenant that pins its Google Workspace domains is not matched by an account
    from outside them.

And one non-property, asserted explicitly because getting it wrong is quiet and
catastrophic: the display name is never a match key.
"""

from __future__ import annotations

from collections.abc import Callable

import pytest
from conftest import Tenant
from sqlalchemy import text

from app.core.db import tenant_session

RESOLVE_IDENTITY = text("SELECT user_id, organization_id, status FROM core.resolve_identity(:p, :s)")
RESOLVE_PENDING = text("SELECT user_id, organization_id, status FROM core.resolve_pending_user(:e, :hd)")

PINNED_DOMAIN = "sivagangai-crushers.example"


@pytest.fixture(scope="module")
def open_domain_tenant(make_tenant: Callable[..., Tenant]) -> Tenant:
    """A tenant that accepts any Google account that matches a registered user."""
    return make_tenant("open")


@pytest.fixture(scope="module")
def pinned_domain_tenant(make_tenant: Callable[..., Tenant]) -> Tenant:
    return make_tenant("pinned", hosted_domains=(PINNED_DOMAIN,))


@pytest.fixture(scope="module")
def linked_identity(
    open_domain_tenant: Tenant,
    make_user: Callable[..., object],
    make_identity: Callable[..., object],
) -> object:
    """One genuinely linked Google identity.

    The unknown-subject test needs this even though it never looks at it: a
    function that ignored ``p_subject`` entirely and returned the first row it
    found would still answer "nothing" on an empty table, and the test would pass
    while the sign-in path handed out the first account in the database.
    """
    user_id = make_user(open_domain_tenant, "weighbridge@example.com", "Murugan S")
    make_identity(open_domain_tenant, user_id, "google-sub-104857", "weighbridge@example.com")
    return user_id


async def test_unknown_subject_resolves_to_nothing(linked_identity: object) -> None:
    """Sign-in never bootstraps access. A Google account nobody registered is
    simply not a user, and the function says so by returning no row."""
    async with tenant_session(None) as session:
        rows = (
            await session.execute(RESOLVE_IDENTITY, {"p": "google", "s": "sub-nobody-ever-linked"})
        ).all()
    assert rows == []


async def test_pinned_subject_resolves_to_its_user(
    open_domain_tenant: Tenant, linked_identity: object
) -> None:
    """The control for the test above, and the steady-state path: after first
    sign-in the stable `sub` claim is what every later sign-in matches on."""
    async with tenant_session(None) as session:
        rows = (await session.execute(RESOLVE_IDENTITY, {"p": "google", "s": "google-sub-104857"})).all()

    assert len(rows) == 1
    assert rows[0][0] == linked_identity
    assert rows[0][1] == open_domain_tenant.org_id


async def test_pending_user_matches_email_case_insensitively(
    open_domain_tenant: Tenant, make_user: Callable[..., object]
) -> None:
    """First sign-in. Google hands back the address as the person typed it when
    the account was made; the admin typed it differently when registering them.
    Both are the same person and both must land on the same row."""
    user_id = make_user(open_domain_tenant, "driver.selvam@example.com", "Selvam R", status="invited")

    async with tenant_session(None) as session:
        rows = (
            await session.execute(RESOLVE_PENDING, {"e": "Driver.Selvam@Example.COM", "hd": None})
        ).all()

    assert len(rows) == 1
    assert rows[0][0] == user_id
    assert rows[0][2] == "invited"


async def test_pending_user_is_never_matched_by_display_name(
    open_domain_tenant: Tenant, make_user: Callable[..., object]
) -> None:
    """Two drivers called Murugan S is an ordinary Tuesday. Matching on a name
    would hand one of them the other's site grants."""
    make_user(open_domain_tenant, "murugan.two@example.com", "Murugan S")

    async with tenant_session(None) as session:
        rows = (await session.execute(RESOLVE_PENDING, {"e": "Murugan S", "hd": None})).all()

    assert rows == []


async def test_pinned_tenant_rejects_a_foreign_hosted_domain(
    pinned_domain_tenant: Tenant, make_user: Callable[..., object]
) -> None:
    """The tenant pinned its Workspace domain. A personal Gmail account carrying
    the same address string must not resolve into it."""
    make_user(pinned_domain_tenant, f"accounts@{PINNED_DOMAIN}", "Lakshmi P")

    async with tenant_session(None) as session:
        foreign = (
            await session.execute(
                RESOLVE_PENDING, {"e": f"accounts@{PINNED_DOMAIN}", "hd": "attacker.example"}
            )
        ).all()
        # A consumer Google account presents no hd claim at all. NULL must fail
        # closed rather than slip past the ANY() comparison.
        missing = (
            await session.execute(RESOLVE_PENDING, {"e": f"accounts@{PINNED_DOMAIN}", "hd": None})
        ).all()

    assert foreign == []
    assert missing == []


async def test_pinned_tenant_accepts_its_own_hosted_domain(
    pinned_domain_tenant: Tenant, make_user: Callable[..., object]
) -> None:
    """The control. Without it the test above would pass on a function that
    matches nobody."""
    user_id = make_user(pinned_domain_tenant, f"manager@{PINNED_DOMAIN}", "Anbu K")

    async with tenant_session(None) as session:
        rows = (
            await session.execute(RESOLVE_PENDING, {"e": f"manager@{PINNED_DOMAIN}", "hd": PINNED_DOMAIN})
        ).all()

    assert len(rows) == 1
    assert rows[0][0] == user_id
    assert rows[0][1] == pinned_domain_tenant.org_id


async def test_disabled_user_does_not_resolve(
    open_domain_tenant: Tenant, make_user: Callable[..., object]
) -> None:
    """Removing someone is a status change, so the status has to be part of the
    match — otherwise a sacked driver signs straight back in."""
    make_user(open_domain_tenant, "former.driver@example.com", "Former Driver", status="disabled")

    async with tenant_session(None) as session:
        rows = (await session.execute(RESOLVE_PENDING, {"e": "former.driver@example.com", "hd": None})).all()

    assert rows == []

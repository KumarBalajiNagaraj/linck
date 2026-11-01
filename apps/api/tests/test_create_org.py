"""scripts/create_org.py: the first company and its admin, so somebody can sign in.

It runs as the app role, through tenant_session, as the API does: here that is
the suite's own engine, and conftest fails the run if that role could bypass a
policy. Then what matters: running it twice writes nothing the second time;
every row it wrote is the company's own, visible under that tenant's context
and no other; the admin it registered can actually sign in and is handed the
director's desks; and an email another company holds is refused with nothing
kept, because sign-in could then find neither person.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Awaitable, Callable, Iterator

import psycopg
import pytest
from conftest import SLUG_PREFIX, Tenant, _delete_orgs
from sqlalchemy import text

from app.core.db import tenant_session
from app.domain.roles import ALL_MODULES, ROLES, role_grants
from scripts import create_org

#: Every table the script writes, and so every one that must hold only the company's own rows.
WRITTEN = (
    "core.organization_modules",
    "core.legal_entities",
    "core.sites",
    "core.roles",
    "core.role_permissions",
    "core.users",
    "core.invitations",
    "core.role_assignments",
)


@pytest.fixture(scope="module")
def created(admin: psycopg.Connection) -> Iterator[list[uuid.UUID]]:
    """Org ids the tests made, removed at the end (slugs carry the sweep prefix too)."""
    ids: list[uuid.UUID] = []
    yield ids
    with admin.cursor() as cur:
        _delete_orgs(cur, ids)


@pytest.fixture
def company(created: list[uuid.UUID], capsys: pytest.CaptureFixture[str]) -> Callable[..., Awaitable[dict]]:
    """`await company(*extra)` runs the script for a fresh company, and says what it printed."""

    async def _run(*extra: str, slug: str | None = None, email: str | None = None) -> dict:
        slug = slug or f"{SLUG_PREFIX}co-{uuid.uuid4().hex[:8]}"
        email = email or f"owner-{uuid.uuid4().hex[:8]}@Example.com"
        argv = [
            "--name",
            "Vaigai Blue Metals",
            "--slug",
            slug,
            "--entity-type",
            "partnership",
            "--site-code",
            "plt-vgi",
            "--site-name",
            "Vaigai crusher plant",
            "--site-type",
            "crusher_plant",
            "--admin-email",
            email,
            "--admin-name",
            "Selvi Raman",
            *extra,
        ]
        code = await create_org.main(argv)
        org_id = create_org.org_id_for(slug)
        if org_id not in created:
            created.append(org_id)
        out = capsys.readouterr()
        return {
            "code": code,
            "org_id": org_id,
            "slug": slug,
            "email": email.lower(),
            "out": out.out,
            "err": out.err,
        }

    return _run


def _counts(admin: psycopg.Connection, org_id: uuid.UUID) -> dict[str, int]:
    with admin.cursor() as cur:
        counts = {}
        for table in (*WRITTEN, "core.audit_logs"):
            cur.execute(f"SELECT count(*) FROM {table} WHERE organization_id = %s", (org_id,))
            counts[table] = cur.fetchone()[0]
    return counts


async def _add(slug: str, *add_user: str, name: str | None = None) -> int:
    argv = ["--org", slug, "--add-user", *add_user]
    return await create_org.main([*argv, "--name", name] if name else argv)


def _orgs(admin: psycopg.Connection, org_id: uuid.UUID) -> int:
    with admin.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.organizations WHERE id = %s", (org_id,))
        return cur.fetchone()[0]  # type: ignore[index]


async def test_a_new_company_gets_its_entity_site_roles_and_admin(company, admin: psycopg.Connection) -> None:
    run = await company()
    assert run["code"] == 0, run["err"]
    org = run["org_id"]

    with admin.cursor() as cur:
        cur.execute(
            "SELECT display_name, slug, status, google_hosted_domains FROM core.organizations WHERE id = %s",
            (org,),
        )
        assert cur.fetchone() == ("Vaigai Blue Metals", run["slug"], "active", [])
        cur.execute(
            "SELECT module FROM core.organization_modules WHERE organization_id = %s AND enabled", (org,)
        )
        assert sorted(m for (m,) in cur.fetchall()) == sorted(ALL_MODULES)
        cur.execute(
            "SELECT code, legal_name, entity_type FROM core.legal_entities WHERE organization_id = %s", (org,)
        )
        # The code is the slug's initials: the slug is the one name that never changes.
        assert cur.fetchall() == [
            (create_org.entity_code_for(run["slug"]), "Vaigai Blue Metals", "partnership")
        ]
        cur.execute(
            "SELECT code, name, site_type, state_code FROM core.sites WHERE organization_id = %s", (org,)
        )
        assert cur.fetchall() == [("PLT-VGI", "Vaigai crusher plant", "crusher_plant", "33")]

        # The roles seed_dev.py defines, each granting exactly what it grants for these modules.
        cur.execute("SELECT key, module FROM core.permissions")
        expected, _ = role_grants(ALL_MODULES, dict(cur.fetchall()))
        cur.execute(
            "SELECT r.key, r.label, r.is_system, array_agg(rp.permission_key ORDER BY rp.permission_key)"
            " FROM core.roles r JOIN core.role_permissions rp ON rp.role_id = r.id"
            " WHERE r.organization_id = %s GROUP BY r.key, r.label, r.is_system",
            (org,),
        )
        roles = {key: (label, system, perms) for key, label, system, perms in cur.fetchall()}
        assert roles == {key: (ROLES[key].label, True, sorted(keys)) for key, keys in expected.items()}

        # Pre-registered by email, lower-cased because that is what sign-in compares;
        # no identity yet: the Google `sub` is pinned at the first sign-in.
        cur.execute("SELECT id, email, full_name, status FROM core.users WHERE organization_id = %s", (org,))
        [(user_id, email, name, status)] = cur.fetchall()
        assert (email, name, status) == (run["email"], "Selvi Raman", "invited")
        cur.execute("SELECT count(*) FROM core.user_identities WHERE user_id = %s", (user_id,))
        assert cur.fetchone() == (0,)
        cur.execute("SELECT email, accepted_at FROM core.invitations WHERE organization_id = %s", (org,))
        assert cur.fetchall() == [(run["email"], None)]
        cur.execute(
            "SELECT r.key, ra.site_id FROM core.role_assignments ra JOIN core.roles r ON r.id = ra.role_id"
            " WHERE ra.user_id = %s ORDER BY r.key",
            (user_id,),
        )
        assert cur.fetchall() == [("executive", None), ("org_admin", None)]
    # Asked of the resolver sign-in itself calls, before the run committed.
    assert f"checked  Google sign-in as {run['email']} finds them here" in run["out"]


async def test_running_it_again_writes_nothing(company, admin: psycopg.Connection) -> None:
    first = await company()
    before = _counts(admin, first["org_id"])
    assert before["core.users"] == 1 and before["core.audit_logs"] > 0

    again = await company(slug=first["slug"], email=first["email"])
    assert again["code"] == 0, again["err"]
    # Not one audit row either: nothing was inserted, and nothing was updated to itself.
    assert _counts(admin, first["org_id"]) == before
    assert "added" not in again["out"]
    assert f"kept     user {first['email']}" in again["out"]


async def test_every_row_is_the_company_s_own_under_rls(
    company, admin: psycopg.Connection, tenant_b: Tenant
) -> None:
    run = await company()
    org = run["org_id"]
    assert await _add(run["slug"], "ravi.k@example.com", "fleet", "PLT-VGI", name="Ravi K") == 0
    written = {table: n for table, n in _counts(admin, org).items() if table in WRITTEN}
    assert all(n > 0 for n in written.values()), written

    # Through the role the API serves requests as: the company's own context sees
    # every row the script wrote, another tenant's sees none of them, and no
    # context at all sees nothing.
    for context, expected in ((org, written), (tenant_b.org_id, dict.fromkeys(written, 0))):
        async with tenant_session(context) as db:
            seen = {
                table: (
                    await db.execute(
                        text(f"SELECT count(*) FROM {table} WHERE organization_id = :org"), {"org": org}
                    )
                ).scalar_one()
                for table in written
            }
            visible_org = (
                await db.execute(
                    text("SELECT count(*) FROM core.organizations WHERE id = :org"), {"org": org}
                )
            ).scalar_one()
        assert seen == expected
        assert visible_org == (1 if context == org else 0)
    async with tenant_session(None) as db:
        for table in written:
            assert (await db.execute(text(f"SELECT count(*) FROM {table}"))).scalar_one() == 0, table


async def test_the_admin_signs_in_to_the_director_s_desks(company, api) -> None:  # type: ignore[no-untyped-def]
    run = await company()
    client = api()
    signed_in = await client.post("/auth/dev-login", json={"email": run["email"]})
    assert signed_in.status_code == 200, signed_in.text

    session = (await client.get("/me/session")).json()
    assert session["user"]["fullName"] == "Selvi Raman"
    assert session["organization"]["slug"] == run["slug"]
    assert [r["key"] for r in session["roles"]] == [
        "org_admin",
        "executive",
    ]  # by label: Administrator, Managing…
    assert sorted(session["modules"]) == sorted(ALL_MODULES)
    assert [s["code"] for s in session["sites"]] == ["PLT-VGI"]
    assert session["activeSiteScope"] is None
    for key in ("executive.dashboard.read", "finance.expense.approve", "admin.member.manage"):
        assert session["grants"][key] == {"orgWide": True, "siteIds": []}, key


async def test_someone_added_at_one_site_is_scoped_to_it(company, api) -> None:  # type: ignore[no-untyped-def]
    run = await company()
    assert await _add(run["slug"], "Anbu.Driver@Example.com", "driver", "plt-vgi", name="Anbu S") == 0
    # Again, unchanged: an assignment is found by its scope.
    assert await _add(run["slug"], "anbu.driver@example.com", "driver", "PLT-VGI") == 0

    client = api()
    assert (
        await client.post("/auth/dev-login", json={"email": "anbu.driver@example.com"})
    ).status_code == 200
    session = (await client.get("/me/session")).json()
    [site] = session["sites"]
    assert session["activeSiteScope"] == site["id"]
    assert session["roles"] == [{"key": "driver", "label": "Driver"}]
    assert session["grants"] == {
        "field.trip.read": {"orgWide": False, "siteIds": [site["id"]]},
        "fleet.fuel.create": {"orgWide": False, "siteIds": [site["id"]]},
    }


async def test_add_user_refuses_what_it_cannot_do(company, capsys: pytest.CaptureFixture[str]) -> None:
    run = await company()
    elsewhere = await company()
    refusals = [
        (("ravi@example.com", "plumber"), "Ravi K", "no role called 'plumber'"),
        (("ravi@example.com", "fleet", "NOPE"), "Ravi K", "no site NOPE here. The sites are: PLT-VGI"),
        (("ravi@example.com", "fleet"), None, "give their name with --name"),
        (("not-an-email", "fleet"), "Ravi K", "is not an email address"),
        (("ravi@gmail", "fleet"), "Ravi K", "is not an email address"),
        # Sign-in would match both companies, and refuses to choose between them.
        ((elsewhere["email"], "accounts"), "Ravi K", "already registered in another company"),
    ]
    capsys.readouterr()
    for args, name, says in refusals:
        assert await _add(run["slug"], *args, name=name) == 2, args
        assert says in capsys.readouterr().err, args
    nobody = f"{SLUG_PREFIX}nobody-{uuid.uuid4().hex[:6]}"
    assert await _add(nobody, "ravi@example.com", "fleet", name="Ravi K") == 2
    assert "there is no company" in capsys.readouterr().err


async def test_a_company_without_fleet_has_no_fleet_roles(company, admin: psycopg.Connection, capsys) -> None:  # type: ignore[no-untyped-def]
    run = await company("--modules", "production,sales,stores,finance")
    assert run["code"] == 0, run["err"]
    with admin.cursor() as cur:
        cur.execute("SELECT key FROM core.roles WHERE organization_id = %s", (run["org_id"],))
        keys = {k for (k,) in cur.fetchall()}
        cur.execute(
            "SELECT DISTINCT p.module FROM core.role_permissions rp"
            " JOIN core.permissions p ON p.key = rp.permission_key WHERE rp.organization_id = %s",
            (run["org_id"],),
        )
        modules = {m for (m,) in cur.fetchall()}
    assert "fleet_manager" not in keys and "driver" not in keys
    assert modules <= {"core", "production", "sales", "stores", "finance"}
    assert await _add(run["slug"], "d@example.com", "driver", name="D") == 2
    assert "its module (fleet) is not switched on" in capsys.readouterr().err


async def test_a_slug_another_company_holds_is_refused(
    company, make_tenant: Callable[..., Tenant], admin
) -> None:  # type: ignore[no-untyped-def]
    other = make_tenant("slug-holder")
    with admin.cursor() as cur:
        cur.execute("SELECT slug FROM core.organizations WHERE id = %s", (other.org_id,))
        (taken,) = cur.fetchone()
    run = await company(slug=taken)
    assert run["code"] == 2
    assert "is taken by another company" in run["err"]


async def test_a_pinned_company_warns_about_an_address_off_its_domain(company, capsys) -> None:  # type: ignore[no-untyped-def]
    """A company pinned to Workspace domains admits only their accounts; registering
    anyone else is allowed (their address may be an alias) but said out loud."""
    run = await company("--hosted-domain", "vaigai.example")
    assert run["code"] == 0, run["err"]
    assert "lets in only Google Workspace accounts on vaigai.example" in run["out"]
    assert await _add(run["slug"], "accounts@vaigai.example", "accounts", name="Lakshmi N") == 0
    assert "checked  Google sign-in as accounts@vaigai.example finds them here" in capsys.readouterr().out


async def test_an_admin_another_company_holds_is_refused_and_nothing_kept(  # type: ignore[no-untyped-def]
    company,
    admin: psycopg.Connection,
    make_tenant: Callable[..., Tenant],
    make_user: Callable[..., uuid.UUID],
) -> None:
    """core.resolve_pending_user refuses an email two companies have registered
    (migration 0003), so registering it again would lock out both people. Only the
    resolver sees across tenants; asked inside the transaction, its refusal takes
    the new company with it, not just the admin."""
    email = f"taken-{uuid.uuid4().hex[:8]}@example.com"
    make_user(make_tenant("holder"), email, "Someone Else", status="invited")

    run = await company(email=email)

    assert run["code"] == 2
    assert "already registered in another company" in run["err"]
    assert _orgs(admin, run["org_id"]) == 0


async def test_it_will_not_run_where_the_api_would_not_start(  # type: ignore[no-untyped-def]
    company, admin: psycopg.Connection, monkeypatch: pytest.MonkeyPatch
) -> None:
    """As a superuser or a BYPASSRLS role every policy is inert, so the writes would
    prove nothing and could go where the app's cannot. It asks the API's own boot
    check, so the two turn away the same databases."""

    async def superuser() -> list[str]:
        return ["connected as 'postgres', which is a superuser"]

    monkeypatch.setattr(create_org, "check_rls_posture", superuser)

    run = await company()

    assert run["code"] == 2
    assert "the API would not start against this database" in run["err"]
    assert _orgs(admin, run["org_id"]) == 0


@pytest.mark.parametrize(
    ("extra", "says"),
    [
        # Daman and Diu, merged into 26 in 2020: no new site is there.
        (("--state", "25"), "--state is the two-digit GST state code"),
        (("--state", "TN"), "--state is the two-digit GST state code"),
        # One mistyped domain would shut out everyone the company registers.
        (("--hosted-domain", "@vaigai.example"), "is not a domain"),
        (("--entity-code", "S M B M"), "the entity code"),
        (("--admin-name", "   "), "a new company needs --admin-name"),
    ],
)
async def test_plainly_wrong_input_is_refused_before_connecting(  # type: ignore[no-untyped-def]
    company, admin: psycopg.Connection, extra: tuple[str, ...], says: str
) -> None:
    run = await company(*extra)
    assert run["code"] == 2
    assert says in run["err"]
    assert _orgs(admin, run["org_id"]) == 0


def test_the_choices_it_offers_are_the_ones_the_database_takes(admin: psycopg.Connection) -> None:
    """The script lists modules, entity types and site types to refuse a typo before
    connecting; the check constraints decide. If the two drift, it refuses what the
    database takes, or offers what the database refuses."""
    with admin.cursor() as cur:
        for constraint, offered in (
            ("ck_organization_modules_module_known", ALL_MODULES),
            ("ck_legal_entities_entity_type_known", create_org.ENTITY_TYPES),
            ("ck_sites_site_type_known", create_org.SITE_TYPES),
        ):
            cur.execute(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = %s", (constraint,)
            )
            [(definition,)] = cur.fetchall()
            assert set(re.findall(r"'([a-z_]+)'", definition)) == set(offered), constraint

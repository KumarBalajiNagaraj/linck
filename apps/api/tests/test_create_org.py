"""scripts/create_org.py: the first company and its admin, so somebody can sign in.

It runs as the migration role, which owns the tables and is still held to row
level security because every core table FORCEs it. So these tests run it the
same way, and then check what matters: running it twice writes nothing the
second time; every row it wrote is the company's own, visible under that
tenant's context and no other; and the admin it registered can actually sign
in and is handed the director's desks. A superuser's URL works the same.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import Callable, Iterator

import psycopg
import pytest
from conftest import ADMIN_URL, DATABASE, HOST, PORT, SLUG_PREFIX, Tenant, _delete_orgs
from sqlalchemy import text

from app.core.db import tenant_session
from scripts import create_org
from scripts.seed_dev import ALL_MODULES, ROLES, role_grants

MIGRATOR_URL = os.environ.get(
    "LINCK_TEST_MIGRATOR_URL", f"postgresql+psycopg://linck_migrator:linck_migrator@{HOST}:{PORT}/{DATABASE}"
)

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
def company(created: list[uuid.UUID], capsys: pytest.CaptureFixture[str]) -> Callable[..., dict]:
    """`company(*extra, url=...)` runs the script for a fresh company, and says what it printed."""

    def _run(*extra: str, slug: str | None = None, email: str | None = None, url: str = MIGRATOR_URL) -> dict:
        slug = slug or f"{SLUG_PREFIX}co-{uuid.uuid4().hex[:8]}"
        email = email or f"owner-{uuid.uuid4().hex[:8]}@Example.com"
        argv = [
            "--database-url",
            url,
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
        code = create_org.main(argv)
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


def _add(slug: str, *add_user: str, name: str | None = None, url: str = MIGRATOR_URL) -> int:
    argv = ["--database-url", url, "--org", slug, "--add-user", *add_user]
    return create_org.main([*argv, "--name", name] if name else argv)


def test_a_new_company_gets_its_entity_site_roles_and_admin(company, admin: psycopg.Connection) -> None:
    run = company()
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


def test_running_it_again_writes_nothing(company, admin: psycopg.Connection) -> None:
    first = company()
    before = _counts(admin, first["org_id"])
    assert before["core.users"] == 1 and before["core.audit_logs"] > 0

    again = company(slug=first["slug"], email=first["email"])
    assert again["code"] == 0, again["err"]
    # Not one audit row either: nothing was inserted, and nothing was updated to itself.
    assert _counts(admin, first["org_id"]) == before
    assert "added" not in again["out"]
    assert f"kept   user {first['email']}" in again["out"]

    # The same through a superuser's URL, which RLS does not hold back.
    with_admin = company(slug=first["slug"], email=first["email"], url=ADMIN_URL)
    assert with_admin["code"] == 0, with_admin["err"]
    assert _counts(admin, first["org_id"]) == before


async def test_every_row_is_the_company_s_own_under_rls(
    company, admin: psycopg.Connection, tenant_b: Tenant
) -> None:
    run = company()
    org = run["org_id"]
    assert _add(run["slug"], "ravi.k@example.com", "fleet", "PLT-VGI", name="Ravi K") == 0
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
    run = company()
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
    run = company()
    assert _add(run["slug"], "Anbu.Driver@Example.com", "driver", "plt-vgi", name="Anbu S") == 0
    # Again, unchanged: an assignment is found by its scope.
    assert _add(run["slug"], "anbu.driver@example.com", "driver", "PLT-VGI") == 0

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


def test_add_user_refuses_what_it_cannot_do(company, capsys: pytest.CaptureFixture[str]) -> None:
    run = company()
    elsewhere = company()
    refusals = [
        (("ravi@example.com", "plumber"), "Ravi K", "no role called 'plumber'"),
        (("ravi@example.com", "fleet", "NOPE"), "Ravi K", "no site NOPE here. The sites are: PLT-VGI"),
        (("ravi@example.com", "fleet"), None, "give their name with --name"),
        (("not-an-email", "fleet"), "Ravi K", "is not an email address"),
        # Sign-in would match both companies, and refuses to choose between them.
        ((elsewhere["email"], "accounts"), "Ravi K", "already registered in another company"),
    ]
    capsys.readouterr()
    for args, name, says in refusals:
        assert _add(run["slug"], *args, name=name) == 2, args
        assert says in capsys.readouterr().err, args
    assert (
        _add(f"{SLUG_PREFIX}nobody-{uuid.uuid4().hex[:6]}", "ravi@example.com", "fleet", name="Ravi K") == 2
    )
    assert "there is no company" in capsys.readouterr().err


def test_a_company_without_fleet_has_no_fleet_roles(company, admin: psycopg.Connection, capsys) -> None:  # type: ignore[no-untyped-def]
    run = company("--modules", "production,sales,stores,finance")
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
    assert _add(run["slug"], "d@example.com", "driver", name="D") == 2
    assert "its module (fleet) is not switched on" in capsys.readouterr().err


def test_a_slug_another_company_holds_is_refused(company, make_tenant: Callable[..., Tenant], admin) -> None:  # type: ignore[no-untyped-def]
    other = make_tenant("slug-holder")
    with admin.cursor() as cur:
        cur.execute("SELECT slug FROM core.organizations WHERE id = %s", (other.org_id,))
        (taken,) = cur.fetchone()
    run = company(slug=taken)
    assert run["code"] == 2
    assert "is taken by another company" in run["err"]


def test_a_pinned_company_warns_about_an_address_off_its_domain(company) -> None:  # type: ignore[no-untyped-def]
    """A company pinned to Workspace domains admits only their accounts; registering
    anyone else is allowed (their address may be an alias) but said out loud."""
    run = company("--hosted-domain", "vaigai.example")
    assert run["code"] == 0, run["err"]
    assert "lets in only Google Workspace accounts on vaigai.example" in run["out"]
    assert _add(run["slug"], "accounts@vaigai.example", "accounts", name="Lakshmi N") == 0

"""The permission catalogue must know every key anything else relies on.

core.role_permissions.permission_key is a foreign key into core.permissions,
so a key missing from the catalogue can never be granted to anyone. The web
app runs on mock sessions today, and a screen gated on a key the catalogue has
never heard of works perfectly on mock data — then renders Forbidden for every
real user on the day GET /me/session replaces the mocks. Nothing errors; the
screen just disappears. These tests make that drift fail here instead.

And only a migration may change it: the app role reads it and nothing more.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import psycopg
import pytest
from conftest import APP_ROLE
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.db import engine, tenant_session

REPO = Path(__file__).resolve().parents[3]
WEB = REPO / "apps" / "web" / "src"

# Everywhere the web app names a permission: what personas are granted, what
# routes and nav items are gated on, and where people land.
WEB_SOURCES = [
    WEB / "auth" / "personas.ts",
    WEB / "router.tsx",
    WEB / "shell" / "nav-manifest.ts",
    REPO / "packages" / "domain" / "src" / "permissions.ts",
]
KEY = re.compile(r"'([a-z_]+(?:\.[a-z_]+){2,})'")


async def _catalogue() -> set[str]:
    async with tenant_session(None) as session:
        rows = (await session.execute(text("SELECT key FROM core.permissions"))).all()
    return {r[0] for r in rows}


@pytest.mark.parametrize("source", WEB_SOURCES, ids=lambda p: p.name)
async def test_every_permission_the_web_app_uses_is_in_the_catalogue(source: Path) -> None:
    used = set(KEY.findall(source.read_text(encoding="utf-8")))
    assert used, f"found no permission keys in {source} — the pattern is checking the wrong thing"
    missing = sorted(used - await _catalogue())
    assert missing == [], f"{source.relative_to(REPO)} uses keys no migration creates: {missing}"


async def test_every_seeded_role_grant_is_in_the_catalogue() -> None:
    sys.path.insert(0, str(REPO / "apps" / "api"))
    from scripts.seed_dev import ROLES  # noqa: PLC0415 — the seed is a script, imported only here

    granted = {key for spec in ROLES.values() for key in spec.permissions}
    missing = sorted(granted - await _catalogue())
    assert missing == [], f"seed_dev.py grants keys no migration creates: {missing}"


# Every way to change the catalogue's rows. The catalogue is every tenant's at
# once and has no row level security, so the role that serves requests may
# read it and nothing more (migration 0021); keys come from migrations, which
# run as the table's owner.
CATALOGUE_WRITES = {
    "INSERT": "INSERT INTO core.permissions (key, module, description) VALUES ('zz.test.key', 'core', 'x')",
    "UPDATE": "UPDATE core.permissions SET description = 'renamed' WHERE key = 'admin.member.manage'",
    "DELETE": "DELETE FROM core.permissions WHERE key = 'admin.member.manage'",
    "TRUNCATE": "TRUNCATE core.permissions",
}


@pytest.mark.parametrize("command", list(CATALOGUE_WRITES))
async def test_the_app_role_cannot_change_the_catalogue(command: str) -> None:
    assert "admin.member.manage" in await _catalogue(), "the control: the app role can still read it"
    async with engine.connect() as conn:
        # Rolled back whatever happens, so a failing run leaves the catalogue as it was.
        transaction = await conn.begin()
        try:
            with pytest.raises(DBAPIError, match="permission denied for table permissions"):
                await conn.execute(text(CATALOGUE_WRITES[command]))
        finally:
            await transaction.rollback()


def test_the_app_role_holds_only_select_on_the_catalogue(admin: psycopg.Connection) -> None:
    with admin.cursor() as cur:
        cur.execute(
            """
            SELECT r, array_agg(p ORDER BY p) FILTER (WHERE has_table_privilege(r, 'core.permissions', p))
            FROM unnest(ARRAY[%s, 'public']) r,
                 unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) p
            GROUP BY r
            """,
            (APP_ROLE,),
        )
        grants = dict(cur.fetchall())
    assert grants == {APP_ROLE: ["SELECT"], "public": None}

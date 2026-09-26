"""The permission catalogue must know every key anything else relies on.

core.role_permissions.permission_key is a foreign key into core.permissions,
so a key missing from the catalogue can never be granted to anyone. The web
app runs on mock sessions today, and a screen gated on a key the catalogue has
never heard of works perfectly on mock data — then renders Forbidden for every
real user on the day GET /me/session replaces the mocks. Nothing errors; the
screen just disappears. These tests make that drift fail here instead.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest
from sqlalchemy import text

from app.core.db import tenant_session

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

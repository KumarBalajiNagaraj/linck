"""Tenant A's rows must be invisible, unwritable and unforgeable from tenant B.

Every assertion here is made through the unprivileged ``linck_app`` role using
the real ``tenant_session`` helper. Ground truth — did the row actually change?
— is read back through the privileged connection, because an UPDATE blocked by
RLS does not raise: it silently matches zero rows, which is precisely the
failure mode that looks like success from inside the request.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

import psycopg
import pytest
from conftest import Tenant
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.db import tenant_session


async def test_tenant_a_can_see_its_own_site(tenant_a: Tenant) -> None:
    """The control. Without this, every assertion below could pass on an empty table."""
    async with tenant_session(str(tenant_a.org_id)) as session:
        names = (
            await session.execute(
                text("SELECT name FROM core.sites WHERE id = :id"), {"id": str(tenant_a.site_id)}
            )
        ).scalars().all()
    assert names == [tenant_a.site_name]


async def test_select_cannot_reach_another_tenants_site(tenant_a: Tenant, tenant_b: Tenant) -> None:
    async with tenant_session(str(tenant_b.org_id)) as session:
        rows = (
            await session.execute(
                text("SELECT id FROM core.sites WHERE id = :id"), {"id": str(tenant_a.site_id)}
            )
        ).all()
        # Not just the targeted row — B must not see A's site by any route.
        visible_orgs = (
            await session.execute(text("SELECT DISTINCT organization_id FROM core.sites"))
        ).scalars().all()

    assert rows == []
    assert tenant_a.org_id not in visible_orgs


async def test_update_cannot_reach_another_tenants_site(
    tenant_a: Tenant, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    async with tenant_session(str(tenant_b.org_id)) as session:
        result = await session.execute(
            text("UPDATE core.sites SET name = :name WHERE id = :id"),
            {"name": "renamed by another tenant", "id": str(tenant_a.site_id)},
        )
    assert result.rowcount == 0

    with admin.cursor() as cur:
        cur.execute("SELECT name FROM core.sites WHERE id = %s", (tenant_a.site_id,))
        row = cur.fetchone()
    assert row is not None, "the fixture site was destroyed by the update attempt"
    assert row[0] == tenant_a.site_name


async def test_delete_cannot_reach_another_tenants_site(
    tenant_a: Tenant, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    async with tenant_session(str(tenant_b.org_id)) as session:
        result = await session.execute(
            text("DELETE FROM core.sites WHERE id = :id"), {"id": str(tenant_a.site_id)}
        )
    assert result.rowcount == 0

    with admin.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.sites WHERE id = %s", (tenant_a.site_id,))
        assert cur.fetchone()[0] == 1


async def test_insert_carrying_another_tenants_org_id_is_rejected(
    tenant_a: Tenant, tenant_b: Tenant, admin: psycopg.Connection
) -> None:
    """The WITH CHECK half of the policy.

    USING protects reads and the rows an UPDATE can find; only WITH CHECK stops a
    request from writing a row stamped with someone else's organization_id. Drop
    the WITH CHECK clause and this is how tenant B plants a row inside tenant A.
    """
    forged_id = uuid.uuid4()

    with pytest.raises(DBAPIError) as caught:
        async with tenant_session(str(tenant_b.org_id)) as session:
            await session.execute(
                text(
                    """
                    INSERT INTO core.sites
                        (id, organization_id, legal_entity_id, code, name, site_type, state_code)
                    VALUES (:id, :org, :legal_entity, :code, 'planted', 'stockyard', '33')
                    """
                ),
                {
                    "id": str(forged_id),
                    "org": str(tenant_a.org_id),
                    "legal_entity": str(tenant_b.legal_entity_id),
                    "code": f"FORGED-{forged_id.hex[:8]}",
                },
            )

    assert "row-level security" in str(caught.value).lower()

    with admin.cursor() as cur:
        cur.execute("SELECT count(*) FROM core.sites WHERE id = %s", (forged_id,))
        assert cur.fetchone()[0] == 0


async def test_no_tenant_context_means_no_rows(
    tenant_a: Tenant, tenant_b: Tenant, make_user: Callable[..., object]
) -> None:
    """The default is deny.

    ``tenant_session(None)`` is the pre-authentication path — the request knows a
    Google subject and nothing else. If an unset GUC read as "no filter" instead
    of "no rows", the sign-in path would be a full table scan of the platform.

    A user is planted first so that "zero rows" means the policy denied them, not
    that the tables happened to be empty.
    """
    make_user(tenant_a, f"deny-by-default-{uuid.uuid4().hex[:8]}@example.com", "Planted Person")

    async with tenant_session(None) as session:
        sites = (await session.execute(text("SELECT count(*) FROM core.sites"))).scalar_one()
        users = (await session.execute(text("SELECT count(*) FROM core.users"))).scalar_one()
        orgs = (await session.execute(text("SELECT count(*) FROM core.organizations"))).scalar_one()

    assert sites == 0
    assert users == 0
    assert orgs == 0

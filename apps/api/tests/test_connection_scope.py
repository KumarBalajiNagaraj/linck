"""The tenant GUC must die at COMMIT, not at disconnect.

This is the pgbouncer-safety property and it is the one failure in the whole
model that leaves no trace. ``SET LOCAL``/``set_config(..., is_local => true)``
scopes the setting to the transaction; a session-level ``SET`` scopes it to the
physical connection. Behind a transaction-pooling connection pooler — or behind
SQLAlchemy's own pool, which is enough to reproduce it — the same physical
connection serves the next request. If the GUC survived, request two would run
under request one's tenant and return a different customer's rows with no error
anywhere.

So the test pins the pool to a single connection, checks the backend PID to
prove the connection really was recycled rather than replaced, and then asserts
the setting came back empty.
"""

from __future__ import annotations

import uuid

import pytest
from conftest import APP_URL, Tenant
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core import db as core_db
from app.core.db import tenant_session


@pytest.fixture
async def single_connection_pool(monkeypatch: pytest.MonkeyPatch):
    """One connection, no overflow — so a second checkout is provably the same one."""
    engine = create_async_engine(APP_URL, pool_size=1, max_overflow=0, pool_pre_ping=False)
    sessionmaker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    monkeypatch.setattr(core_db, "SessionLocal", sessionmaker)
    try:
        yield sessionmaker
    finally:
        await engine.dispose()


async def test_tenant_guc_does_not_survive_the_transaction(
    tenant_a: Tenant, single_connection_pool: async_sessionmaker[AsyncSession]
) -> None:
    actor_id = uuid.uuid4()
    async with tenant_session(str(tenant_a.org_id), user_id=str(actor_id)) as session:
        pid_inside = (await session.execute(text("SELECT pg_backend_pid()"))).scalar_one()
        org_inside = (
            await session.execute(text("SELECT current_setting('app.current_org_id', true)"))
        ).scalar_one()
        user_inside = (
            await session.execute(text("SELECT current_setting('app.current_user_id', true)"))
        ).scalar_one()

    assert org_inside == str(tenant_a.org_id), "the GUC was never set — the rest proves nothing"
    assert user_inside == str(actor_id)

    async with single_connection_pool() as fresh:
        pid_after = (await fresh.execute(text("SELECT pg_backend_pid()"))).scalar_one()
        org_after = (
            await fresh.execute(text("SELECT current_setting('app.current_org_id', true)"))
        ).scalar_one()
        user_after = (
            await fresh.execute(text("SELECT current_setting('app.current_user_id', true)"))
        ).scalar_one()

    assert pid_after == pid_inside, (
        "the pool handed out a different backend, so nothing was proved about leakage; "
        "the test needs a pool that recycles its single connection"
    )
    assert not org_after, f"app.current_org_id leaked across pooled requests as {org_after!r}"
    assert not user_after, f"app.current_user_id leaked across pooled requests as {user_after!r}"


async def test_recycled_connection_sees_no_rows(
    tenant_a: Tenant, single_connection_pool: async_sessionmaker[AsyncSession]
) -> None:
    """The consequence, stated in the terms that matter.

    A leaked GUC is only interesting because of what it lets the next request
    read. This asserts the observable end of it: the very next transaction on the
    recycled connection is back to deny-by-default.
    """
    async with tenant_session(str(tenant_a.org_id)) as session:
        assert (
            await session.execute(text("SELECT count(*) FROM core.sites WHERE id = :id"),
                                  {"id": str(tenant_a.site_id)})
        ).scalar_one() == 1

    async with tenant_session(None) as session:
        assert (await session.execute(text("SELECT count(*) FROM core.sites"))).scalar_one() == 0

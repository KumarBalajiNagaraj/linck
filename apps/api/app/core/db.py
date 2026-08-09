from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.settings import get_settings

settings = get_settings()

# pool_pre_ping because a laptop that sleeps mid-shift is the normal case here,
# not the exception.
engine = create_async_engine(
    settings.database_url,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    echo=False,
)

SessionLocal = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)


@asynccontextmanager
async def tenant_session(
    organization_id: str | None, user_id: str | None = None
) -> AsyncIterator[AsyncSession]:
    """Open a transaction with the tenant GUC set, so RLS can resolve it.

    Two things here are load-bearing and easy to get wrong:

    1. ``set_config(..., is_local => true)`` rather than a literal ``SET LOCAL``.
       ``SET`` cannot take a bind parameter, so the literal form would mean
       interpolating a value into SQL — and the value is an organization id that
       decides which tenant's rows are visible. That is the last string in the
       system you want to concatenate. ``set_config`` is a normal function call
       and takes a real bind parameter.

    2. ``is_local => true`` scopes the setting to the TRANSACTION, not the
       session. That is what makes this safe behind a transaction-pooling
       connection pooler such as pgbouncer: the GUC dies at COMMIT, so a pooled
       connection can never be handed to the next request still carrying the
       previous tenant's id. A session-level ``SET`` would leak across tenants
       the first time the pool reused a connection, and it would leak silently.

    Passing ``organization_id=None`` opens a transaction with no tenant context.
    RLS policies then match nothing, which is the correct default for the
    pre-authentication path (looking up a Google identity to find out who is
    signing in) and wrong for anything else.
    """
    async with SessionLocal() as session, session.begin():
        await session.execute(
            text("select set_config('app.current_org_id', :org, true)"),
            {"org": str(organization_id) if organization_id else ""},
        )
        if user_id:
            # Read by the audit trigger, so a background job or a data-fix
            # script is attributed to a person rather than to the app role.
            await session.execute(
                text("select set_config('app.current_user_id', :uid, true)"),
                {"uid": str(user_id)},
            )
        yield session


async def check_rls_posture() -> list[str]:
    """Refuse to serve traffic if the RLS posture is wrong.

    FORCE ROW LEVEL SECURITY is the check that matters. A table's OWNER bypasses
    RLS by default, so if the app ever connects as the role that owns the
    tables, every policy in the database quietly stops applying and every
    request returns every tenant's rows. Nothing else in the system would fail;
    the data would just be wrong. So it is asserted at boot.
    """
    problems: list[str] = []
    async with engine.connect() as conn:
        rows = (
            await conn.execute(
                text(
                    """
                    select c.relname,
                           c.relrowsecurity,
                           c.relforcerowsecurity,
                           (select count(*) from pg_policy p where p.polrelid = c.oid) as policies
                    from pg_class c
                    join pg_namespace n on n.oid = c.relnamespace
                    where c.relkind = 'r'
                      and n.nspname = 'core'
                      -- organizations: its own id IS the tenant key.
                      -- permissions: global reference data with no
                      -- organization_id, so there is nothing for a policy to
                      -- filter on. Both are exempted by migration 0002; this
                      -- list has to agree with it or the app refuses to start
                      -- against a correctly migrated database.
                      and c.relname not in ('organizations', 'permissions')
                    """
                )
            )
        ).all()

        for name, enabled, forced, policies in rows:
            if not enabled:
                problems.append(f"core.{name}: row level security is not enabled")
            elif not forced:
                problems.append(f"core.{name}: RLS is enabled but not FORCED — the owner bypasses it")
            elif policies == 0:
                problems.append(f"core.{name}: RLS is forced but no policy exists — the table is unreadable")

        # No local carve-out here, deliberately.
        #
        # A superuser — or any role with BYPASSRLS — is exempt from row level
        # security unconditionally. FORCE does not apply to it. So every policy
        # verified above becomes inert, every query silently returns every
        # tenant's rows, and nothing fails: not a test, not a log line, not a
        # request. It is the exact failure this whole design exists to prevent.
        #
        # It used to be tolerated when environment == "local", which made
        # inert RLS the DEFAULT path on a developer machine, where Postgres
        # hands you a superuser account by default. Local is also precisely
        # where the tenant-isolation tests run and where a developer forms
        # their belief about whether isolation works. Refusing to start is a
        # two-command fix; a quiet cross-tenant read is not fixable after the
        # fact.
        current_user = (await conn.execute(text("select current_user"))).scalar_one()
        row = (
            await conn.execute(
                text("select rolsuper, rolbypassrls from pg_roles where rolname = current_user")
            )
        ).first()
        if row and (row[0] or row[1]):
            why = "a superuser" if row[0] else "BYPASSRLS"
            problems.append(
                f"connected as {current_user!r}, which is {why} — row level security does not apply, "
                f"so every policy in this database is inert. Create the unprivileged application role "
                f"(psql -d linck_dev -f apps/api/scripts/init-roles.sql) and point LINCK_DATABASE_URL at "
                f"it (see apps/api/.env.example)."
            )

    return problems

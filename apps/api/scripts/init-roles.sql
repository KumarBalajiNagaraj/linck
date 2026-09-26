-- Two roles, and the split is the whole point.
--
-- linck_app owns NOTHING and has no BYPASSRLS. That is what makes row level
-- security actually apply: a table's owner bypasses RLS by default, so an
-- application connecting as the owner would silently see every tenant's rows
-- with no error and no failing test — just wrong data.
--
-- linck_migrator owns the schema and runs Alembic. It is never used to serve a
-- request.
--
-- Applied by docker-entrypoint-initdb.d on first boot. For a Homebrew Postgres
-- used in local development, run this by hand once:
--   psql -d linck_dev -f apps/api/scripts/init-roles.sql

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_migrator') THEN
        CREATE ROLE linck_migrator LOGIN PASSWORD 'linck_migrator';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_app') THEN
        CREATE ROLE linck_app LOGIN PASSWORD 'linck_app';
    END IF;
    -- Owns the two SECURITY DEFINER identity resolvers and nothing else.
    -- NOLOGIN: it is reachable only by calling those functions, never by
    -- connecting. It deliberately does NOT have BYPASSRLS — migration 0004
    -- grants it read access through explicit role-targeted policies on three
    -- named tables, so its reach is written down in pg_policy rather than
    -- being an invisible property of the role.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_identity') THEN
        CREATE ROLE linck_identity NOLOGIN;
    END IF;
    -- Owns the audit trigger. The audit log is the one table that must never
    -- refuse a write: if auditing fails closed it takes the underlying
    -- operation down with it, turning a missing session variable into an
    -- outage. This role may APPEND to core.audit_logs and may not read it.
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_audit') THEN
        CREATE ROLE linck_audit NOLOGIN;
    END IF;
END
$$;

-- Restated on every run: a role that gains either of these silently turns every
-- policy in the database into decoration.
ALTER ROLE linck_app NOSUPERUSER NOBYPASSRLS;
ALTER ROLE linck_migrator NOSUPERUSER NOBYPASSRLS;
ALTER ROLE linck_identity NOSUPERUSER NOBYPASSRLS;
ALTER ROLE linck_audit NOSUPERUSER NOBYPASSRLS;

-- Postgres only lets you hand ownership to a role you are a member of, and the
-- migrations have to transfer the resolver functions and the audit trigger to
-- these two. Membership does not let linck_migrator connect as either (both are
-- NOLOGIN); it only permits the ALTER FUNCTION ... OWNER TO.
GRANT linck_identity TO linck_migrator;
GRANT linck_audit TO linck_migrator;

-- linck_app gets CONNECT only. The migrator also needs CREATE,
-- because migrations create schemas: its own `alembic` schema for the version
-- table (see alembic/env.py), the business schemas Phase 2 adds, and `core` —
-- which exists by the time migration 1 runs, but CREATE SCHEMA IF NOT EXISTS
-- checks this privilege before it checks whether the schema is already there.
GRANT CONNECT ON DATABASE linck_dev TO linck_app;
GRANT CONNECT, CREATE ON DATABASE linck_dev TO linck_migrator;

-- Nothing of ours lives in public, so nobody may create there, the app role
-- least of all. Postgres 15+ ships this way; 14, and any cluster upgraded from
-- it, still grants CREATE on public to every role. The two login roles are
-- named as well, so a grant someone made by hand does not outlive a re-run.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, linck_app, linck_migrator;

CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION linck_migrator;

GRANT USAGE ON SCHEMA core TO linck_app;

-- The app gets DML on tables the migrator creates, now and in future.
ALTER DEFAULT PRIVILEGES FOR ROLE linck_migrator IN SCHEMA core
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO linck_app;
ALTER DEFAULT PRIVILEGES FOR ROLE linck_migrator IN SCHEMA core
    GRANT USAGE, SELECT ON SEQUENCES TO linck_app;

-- NOTE on the audit log: it is append-only for the application, but that revoke
-- CANNOT live here. ALTER DEFAULT PRIVILEGES applies to every table in the
-- schema, so revoking UPDATE/DELETE here would strip them from all tables and
-- silently break every write path in the product. The revoke is targeted at
-- core.audit_logs in the migration that creates it, where it can name one table.

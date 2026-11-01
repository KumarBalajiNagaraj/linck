"""Create Linck's four database roles on a managed PostgreSQL cluster. Run it once.

    cd apps/api
    export LINCK_ADMIN_URL='postgresql://doadmin:...@<host>:25060/defaultdb?sslmode=require'
    export LINCK_MIGRATOR_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    export LINCK_APP_PASSWORD="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
    uv run python scripts/bootstrap_roles.py --database linck --print-urls

scripts/init-roles.sql does this on a laptop, where you are a superuser. This
is the same four roles, the same grants and the same NOSUPERUSER NOBYPASSRLS
posture for a cluster whose admin is not a superuser: DigitalOcean's `doadmin`
has CREATEROLE and CREATEDB, and nothing here needs more. Run as such an admin
on PostgreSQL 16, three kinds of statement in init-roles.sql are refused, so
they are done differently here:

- `ALTER ROLE ... NOSUPERUSER` is refused to anyone but a superuser, even when
  it changes nothing, and `ALTER ROLE ... NOBYPASSRLS` to anyone without
  BYPASSRLS. So each role is created with both off, and a role that already
  exists is altered only if one of them is actually on.
- `CREATE SCHEMA core AUTHORIZATION linck_migrator` needs the admin to be able
  to SET ROLE linck_migrator, and `ALTER DEFAULT PRIVILEGES FOR ROLE
  linck_migrator` to act for it; a CREATEROLE admin may do neither by default.
  So the core schema and its default privileges are made by linck_migrator
  itself, over a second connection with the password just set.

Safe to run again: it creates what is missing, sets the two passwords to the
values given (which is also how to change them), and ends by checking the
result, exiting non-zero if anything is off. `--check` only checks.

Passwords go to the server as SCRAM verifiers, computed here as psql's
`\\password` does, so the plain text never reaches the server or its logs.
The migration role's password is used once more, to connect as it.
"""

from __future__ import annotations

import argparse
import os
import re
import sys
from collections.abc import Callable
from dataclasses import dataclass
from urllib.parse import quote

import psycopg
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict

MIGRATOR = "linck_migrator"
APP = "linck_app"
IDENTITY = "linck_identity"
AUDIT = "linck_audit"
#: The roles that connect, and the variable holding each one's password.
LOGIN_ROLES = {MIGRATOR: "LINCK_MIGRATOR_PASSWORD", APP: "LINCK_APP_PASSWORD"}
#: The roles that only own functions (migrations 0004 and 0005). Nothing connects as them.
OWNER_ROLES = (IDENTITY, AUDIT)
ROLES = (*LOGIN_ROLES, *OWNER_ROLES)

ADMIN_URL_VAR = "LINCK_ADMIN_URL"
MIN_PASSWORD_LENGTH = 24
GENERATE = "python3 -c 'import secrets; print(secrets.token_urlsafe(32))'"
_DATABASE_NAME = re.compile(r"[a-z_][a-z0-9_]{0,62}")


class Refused(Exception):
    """Something this script will not do, said as the fix."""


@dataclass(frozen=True)
class Admin:
    name: str
    superuser: bool
    createrole: bool
    createdb: bool


def who_is_connected(conn: psycopg.Connection) -> Admin:
    row = conn.execute(
        "SELECT rolname, rolsuper, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = current_user"
    ).fetchone()
    assert row is not None
    return Admin(*row)


def apply(
    admin_url: str, database: str, passwords: dict[str, str], say: Callable[[str], None] = print
) -> None:
    """Make the cluster look the way init-roles.sql makes a laptop's."""
    with psycopg.connect(admin_url, autocommit=True) as conn:
        admin = who_is_connected(conn)
        if not (admin.superuser or admin.createrole):
            raise Refused(
                f"{admin.name} has neither SUPERUSER nor CREATEROLE, so it cannot create roles. "
                f"Use the cluster's admin user (doadmin on DigitalOcean) in {ADMIN_URL_VAR}."
            )
        _ensure_database(conn, database, admin, say)
        for role in ROLES:
            _ensure_role(conn, role, passwords.get(role), admin, say)
        # Migrations hand the identity resolvers and the audit trigger to these
        # two roles, and only a member of a role may give it something.
        for role in OWNER_ROLES:
            conn.execute(sql.SQL("GRANT {} TO {}").format(sql.Identifier(role), sql.Identifier(MIGRATOR)))
        db = sql.Identifier(database)
        conn.execute(sql.SQL("GRANT CONNECT ON DATABASE {} TO {}").format(db, sql.Identifier(APP)))
        # CREATE: migrations make schemas, the `alembic` one for the version table included.
        conn.execute(
            sql.SQL("GRANT CONNECT, CREATE ON DATABASE {} TO {}").format(db, sql.Identifier(MIGRATOR))
        )
        say(f"granted: {MIGRATOR} in {', '.join(OWNER_ROLES)}; CONNECT on {database} to both login roles")

    with psycopg.connect(admin_url, dbname=database, autocommit=True) as conn:
        # Nothing of ours lives in public, so nobody may create there.
        conn.execute(
            sql.SQL("REVOKE CREATE ON SCHEMA public FROM PUBLIC, {}, {}").format(
                sql.Identifier(APP), sql.Identifier(MIGRATOR)
            )
        )

    # As linck_migrator itself, so that it owns `core` and the defaults are its
    # own: every table it creates there is then granted to the app on creation.
    with psycopg.connect(
        admin_url, dbname=database, user=MIGRATOR, password=passwords[MIGRATOR], autocommit=True
    ) as conn:
        app = sql.Identifier(APP)
        conn.execute("CREATE SCHEMA IF NOT EXISTS core")
        conn.execute(sql.SQL("GRANT USAGE ON SCHEMA core TO {}").format(app))
        conn.execute(
            sql.SQL(
                "ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {}"
            ).format(app)
        )
        conn.execute(
            sql.SQL("ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO {}").format(
                app
            )
        )
        say(f"schema core: owned by {MIGRATOR}, with {APP}'s default privileges")


def _ensure_database(
    conn: psycopg.Connection, database: str, admin: Admin, say: Callable[[str], None]
) -> None:
    if conn.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database,)).fetchone():
        return
    if not (admin.superuser or admin.createdb):
        raise Refused(
            f"database {database} does not exist, and {admin.name} may not create it. Create it first."
        )
    conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(database)))
    say(f"created database {database}")


def _ensure_role(
    conn: psycopg.Connection, role: str, password: str | None, admin: Admin, say: Callable[[str], None]
) -> None:
    name = sql.Identifier(role)
    if password is None:
        login = sql.SQL("NOLOGIN")
    else:
        verifier = conn.pgconn.encrypt_password(password.encode(), role.encode(), b"scram-sha-256")
        login = sql.SQL("LOGIN PASSWORD {}").format(sql.Literal(verifier.decode()))

    row = conn.execute(
        "SELECT rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = %s", (role,)
    ).fetchone()
    if row is None:
        conn.execute(
            sql.SQL("CREATE ROLE {} {} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION").format(
                name, login
            )
        )
        say(f"created {role}" + (" (password set)" if password else " (NOLOGIN)"))
        return

    superuser, bypassrls, can_login = row
    # Either attribute turns every row level security policy into decoration
    # for this role. Restated only when on: see the module docstring.
    if superuser:
        if not admin.superuser:
            raise Refused(
                f"{role} is a SUPERUSER, and only a superuser can take that away. "
                f"Ask the provider's support to run: ALTER ROLE {role} NOSUPERUSER"
            )
        conn.execute(sql.SQL("ALTER ROLE {} NOSUPERUSER").format(name))
    if bypassrls:
        conn.execute(sql.SQL("ALTER ROLE {} NOBYPASSRLS").format(name))
    if password is not None or can_login:
        conn.execute(sql.SQL("ALTER ROLE {} {}").format(name, login))
    say(f"{role} exists" + (": password set" if password else ""))


def verify(conn: psycopg.Connection) -> list[str]:
    """What is wrong with the roles and grants, for the database `conn` is in.
    Empty when everything is as init-roles.sql leaves it."""
    found = {
        name: (superuser, bypassrls, can_login)
        for name, superuser, bypassrls, can_login in conn.execute(
            "SELECT rolname, rolsuper, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = ANY(%s)",
            (list(ROLES),),
        )
    }
    problems = [f"{role} does not exist" for role in ROLES if role not in found]
    if problems:
        return problems
    for role, (superuser, bypassrls, can_login) in found.items():
        if superuser:
            problems.append(f"{role} is a SUPERUSER: row level security does not apply to it")
        if bypassrls:
            problems.append(f"{role} has BYPASSRLS: row level security does not apply to it")
        if role in LOGIN_ROLES and not can_login:
            problems.append(f"{role} cannot log in")
        if role in OWNER_ROLES and can_login:
            problems.append(f"{role} can log in, and should only own functions")

    musts = [
        *(
            (
                "SELECT pg_has_role(%s, %s, 'MEMBER')",
                (MIGRATOR, role),
                f"{MIGRATOR} is not a member of {role}, so migrations cannot give it its functions",
            )
            for role in OWNER_ROLES
        ),
        *(
            (
                "SELECT has_database_privilege(%s, current_database(), 'CONNECT')",
                (role,),
                f"{role} may not connect to this database",
            )
            for role in LOGIN_ROLES
        ),
        (
            "SELECT has_database_privilege(%s, current_database(), 'CREATE')",
            (MIGRATOR,),
            f"{MIGRATOR} may not create schemas in this database",
        ),
        *(
            (
                "SELECT NOT has_schema_privilege(%s, 'public', 'CREATE')",
                (role,),
                f"{role} may create objects in the public schema",
            )
            for role in LOGIN_ROLES
        ),
        (
            "SELECT coalesce((SELECT nspowner = to_regrole(%s) FROM pg_namespace"
            " WHERE nspname = 'core'), false)",
            (MIGRATOR,),
            f"the core schema is missing, or not owned by {MIGRATOR}",
        ),
        (
            "SELECT coalesce(has_schema_privilege(%s, to_regnamespace('core'), 'USAGE'), false)",
            (APP,),
            f"{APP} may not use the core schema",
        ),
    ]
    for query, params, problem in musts:
        row = conn.execute(query, params).fetchone()
        if not (row and row[0]):
            problems.append(problem)

    defaults = dict(
        conn.execute(
            """
            SELECT d.defaclobjtype::text, array_agg(DISTINCT a.privilege_type::text)
            FROM pg_default_acl d
            CROSS JOIN LATERAL aclexplode(d.defaclacl) a
            WHERE d.defaclrole = to_regrole(%s)
              AND d.defaclnamespace = to_regnamespace('core')
              AND a.grantee = to_regrole(%s)
            GROUP BY d.defaclobjtype
            """,
            (MIGRATOR, APP),
        ).fetchall()
    )
    for objtype, what, needed in (
        ("r", "tables", {"SELECT", "INSERT", "UPDATE", "DELETE"}),
        ("S", "sequences", {"USAGE", "SELECT"}),
    ):
        if not needed <= set(defaults.get(objtype) or ()):
            problems.append(f"{APP} would not be granted {', '.join(sorted(needed))} on new core {what}")
    return problems


def database_urls(admin_url: str, database: str, passwords: dict[str, str]) -> dict[str, str]:
    """LINCK_DATABASE_URL and LINCK_MIGRATION_DATABASE_URL on the admin URL's host.

    The two drivers spell TLS differently: asyncpg takes `ssl=` and refuses
    `sslmode=` outright; psycopg, like libpq, takes `sslmode=`.
    """
    params = conninfo_to_dict(admin_url)
    host, port, sslmode = (
        params.get("host") or "localhost",
        params.get("port") or "5432",
        params.get("sslmode"),
    )

    def url(driver: str, role: str, tls: str) -> str:
        query = f"?{tls}={sslmode}" if sslmode else ""
        return (
            f"postgresql+{driver}://{role}:{quote(passwords[role], safe='')}@{host}:{port}/{database}{query}"
        )

    return {
        "LINCK_DATABASE_URL": url("asyncpg", APP, "ssl"),
        "LINCK_MIGRATION_DATABASE_URL": url("psycopg", MIGRATOR, "sslmode"),
    }


def passwords_from_env() -> dict[str, str]:
    passwords: dict[str, str] = {}
    for role, var in LOGIN_ROLES.items():
        value = os.environ.get(var, "")
        if len(value) < MIN_PASSWORD_LENGTH:
            raise Refused(f"set {var} to a password of {MIN_PASSWORD_LENGTH} characters or more: {GENERATE}")
        passwords[role] = value
    if passwords[MIGRATOR] == passwords[APP]:
        raise Refused("the two passwords must differ: the roles have different powers")
    return passwords


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Create Linck's database roles on a managed PostgreSQL cluster.",
        epilog=f"Reads {ADMIN_URL_VAR} and, unless --check, {' and '.join(LOGIN_ROLES.values())}.",
    )
    parser.add_argument("--database", required=True, help="the database Linck lives in, for example linck")
    parser.add_argument("--check", action="store_true", help="change nothing; report what is wrong")
    parser.add_argument(
        "--print-urls",
        action="store_true",
        help="print the two database URLs App Platform needs; they contain the passwords",
    )
    args = parser.parse_args(argv)
    try:
        admin_url = os.environ.get(ADMIN_URL_VAR, "")
        if not admin_url:
            raise Refused(f"set {ADMIN_URL_VAR} to the cluster's admin connection string")
        if not _DATABASE_NAME.fullmatch(args.database):
            raise Refused("--database takes lower-case letters, digits and underscores, such as linck")
        passwords = passwords_from_env() if not args.check or args.print_urls else {}
        if not args.check:
            apply(admin_url, args.database, passwords)
        with psycopg.connect(admin_url, dbname=args.database, autocommit=True) as conn:
            problems = verify(conn)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"the database refused: {exc}", file=sys.stderr)
        return 2

    for problem in problems:
        print(f"PROBLEM: {problem}", file=sys.stderr)
    if problems:
        return 1
    print(f"ok: {', '.join(ROLES)} are in place for {args.database}, none SUPERUSER or BYPASSRLS")
    if args.print_urls:
        print("\nPaste these into App Platform as SECRET values:")
        for name, value in database_urls(admin_url, args.database, passwords).items():
            print(f"{name}={value}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Create a company in Linck and register its first admin. Safe to run again.

    cd apps/api
    export LINCK_MIGRATION_DATABASE_URL='<the migration role's URL: docs/DEPLOY.md, step 4.2>'
    uv run python -m scripts.create_org \\
        --name "Sri Murugan Blue Metals" --entity-type partnership \\
        --site-code PLT-VNG --site-name "Vangal crusher plant" --site-type crusher_plant \\
        --admin-email owner@example.com --admin-name "Meena Sundaram"

Then, for each person who will sign in (the site is left out for org-wide):

    uv run python -m scripts.create_org --org sri-murugan-blue-metals \\
        --add-user ravi@example.com fleet PLT-VNG --name "Ravi K"

Nobody can sign in to a database with no company in it: sign-in never creates
a user, it only matches a Google account to someone already registered
(app/api/auth.py). This registers the first someone. It writes:

- the organization, with the modules it has switched on (all, unless --modules);
- one legal entity and one site;
- the roles scripts/seed_dev.py defines, each granting what it grants there,
  for the modules this company has (``seed_dev.role_grants``);
- the first admin, pre-registered by the email of their Google account, as
  Managing Director and Administrator across the whole company.

It connects with a URL that may write the core tables: the migration role's
(LINCK_MIGRATION_DATABASE_URL, the default) or a superuser's (--database-url).
The migration role owns the tables and is still held to row level security,
because every core table FORCEs it; so, like the seed, every write here runs
in a transaction scoped to the company's own id (``app.current_org_id``), and a
company's rows are exactly the rows its tenant context can see. The id is
derived from the slug, because RLS checks an organization's own row against
that GUC: it must be known before the row exists.

Running it again changes nothing that is there: rows are found by their natural
keys and only missing ones are added. It never renames, removes or narrows
anything, so it cannot take a grant away from someone who is using it; a role
that is missing a key seed_dev.py now grants gets it.

One email signs in to one company: core.resolve_pending_user refuses to choose
between two (migration 0003), so a person already registered elsewhere is
refused here, before they could be locked out.
"""

from __future__ import annotations

import argparse
import re
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

if __package__ in (None, ""):  # run as `python scripts/create_org.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import psycopg  # noqa: E402
from psycopg import errors  # noqa: E402
from psycopg.conninfo import conninfo_to_dict  # noqa: E402

from app.core.settings import get_settings  # noqa: E402
from scripts.seed_dev import ALL_MODULES, ROLES, role_grants  # noqa: E402

#: Organization ids are uuid5(ORG_NS, slug). Not seed_dev's namespace: a real
#: company never shares an id with a development tenant.
ORG_NS = uuid.uuid5(uuid.NAMESPACE_DNS, "org.linck.app")

#: The first admin's roles, both org-wide: the director's desks and member admin.
ADMIN_ROLES = ("executive", "org_admin")

#: The words people use for a role, beside seed_dev.py's keys.
ROLE_ALIASES = {
    "admin": "org_admin",
    "director": "executive",
    "md": "executive",
    "fleet": "fleet_manager",
    "production": "production_incharge",
    "crusher": "production_incharge",
    "sales": "sales_coordinator",
    "stores": "stores_incharge",
    "weighbridge": "weighbridge_operator",
}

# What the core tables' check constraints accept (app/models/core.py).
ENTITY_TYPES = ("proprietorship", "partnership", "llp", "private_limited", "public_limited", "huf", "trust")
SITE_TYPES = (
    "head_office",
    "quarry",
    "crusher_plant",
    "stockyard",
    "depot",
    "workshop",
    "weighbridge_point",
    "fuel_point",
)

# The same test dev-login applies to an address: one @, no spaces.
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+$")
_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_SITE_CODE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,31}$")
#: A pre-registration nobody has used is still matched at sign-in; this is when
#: core.invitations says it lapses, as in seed_dev.py.
INVITATION_DAYS = 90


class Refused(Exception):
    """Something this script will not do, said as the fix."""


@dataclass(frozen=True)
class Company:
    name: str
    slug: str
    modules: tuple[str, ...]
    entity_code: str
    entity_name: str
    entity_type: str
    site_code: str
    site_name: str
    site_type: str
    state_code: str
    hosted_domains: tuple[str, ...] = ()


@dataclass(frozen=True)
class Member:
    email: str
    #: None leaves an existing person's name as it is; a new person needs one.
    name: str | None
    #: (role key, site code), the site None for the whole company.
    roles: tuple[tuple[str, str | None], ...]


@dataclass
class Report:
    org_id: uuid.UUID
    slug: str
    created: list[str] = field(default_factory=list)
    kept: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def org_id_for(slug: str) -> uuid.UUID:
    return uuid.uuid5(ORG_NS, slug)


def slug_for(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def entity_code_for(slug: str) -> str:
    """SMBM for sri-murugan-blue-metals: the slug's initials, which never change."""
    return "".join(word[0] for word in slug.split("-") if word)[:8].upper() or "MAIN"


def role_key(raw: str) -> str:
    key = raw.strip().lower().replace("-", "_")
    key = ROLE_ALIASES.get(key, key)
    if key not in ROLES:
        names = ", ".join([*ROLES, *ROLE_ALIASES])
        raise Refused(f"there is no role called {raw!r}. Use one of: {names}")
    return key


def clean_email(raw: str) -> str:
    email = raw.strip().lower()
    if not _EMAIL.fullmatch(email):
        raise Refused(
            f"{raw!r} is not an email address: it is the person's Google account, such as ravi@gmail.com"
        )
    return email


# ---------------------------------------------------------------------------
# Connecting
# ---------------------------------------------------------------------------


def conninfo(url: str) -> str:
    """A libpq URL: LINCK_MIGRATION_DATABASE_URL names its driver, SQLAlchemy-style."""
    if url.startswith("postgresql+asyncpg://"):
        raise Refused(
            "that is the API's own URL (linck_app). Use LINCK_MIGRATION_DATABASE_URL, the migration role's"
        )
    return re.sub(r"^postgres(?:ql)?\+psycopg2?://", "postgresql://", url)


def describe(url: str) -> str:
    """Where the writes go, without the password."""
    p = conninfo_to_dict(url)
    return f"{p.get('user', '?')}@{p.get('host', 'localhost')}:{p.get('port', '5432')}/{p.get('dbname', '?')}"


def _scope(conn: psycopg.Connection, org_id: uuid.UUID) -> None:
    """The tenant GUC, transaction-local exactly as app.core.db.tenant_session sets it."""
    conn.execute("SELECT set_config('app.current_org_id', %s, true)", (str(org_id),))


def _permission_modules(conn: psycopg.Connection) -> dict[str, str]:
    rows = conn.execute("SELECT key, module FROM core.permissions").fetchall()
    if not rows:
        raise Refused("core.permissions is empty: run `alembic upgrade head` on this database first")
    catalogue = dict(rows)
    missing = sorted({p for role in ROLES.values() for p in role.permissions} - catalogue.keys())
    if missing:
        raise Refused(
            f"this database is behind the code (no {', '.join(missing)}): run `alembic upgrade head`"
        )
    return catalogue


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


def _ensure_roles(conn: psycopg.Connection, org_id: uuid.UUID, report: Report) -> dict[str, uuid.UUID]:
    """Every role this company's modules call for, each with at least the keys it grants."""
    modules = [
        m
        for (m,) in conn.execute(
            "SELECT module FROM core.organization_modules WHERE organization_id = %s AND enabled", (org_id,)
        )
    ]
    granted, _ = role_grants(modules, _permission_modules(conn))
    for key in granted:
        row = conn.execute(
            "INSERT INTO core.roles (organization_id, key, label, is_system) VALUES (%s, %s, %s, true)"
            " ON CONFLICT (organization_id, key) DO NOTHING RETURNING id",
            (org_id, key, ROLES[key].label),
        ).fetchone()
        if row:
            report.created.append(f"role {key} ({ROLES[key].label})")
    role_ids = dict(
        conn.execute(
            "SELECT key, id FROM core.roles WHERE organization_id = %s AND key = ANY(%s)",
            (org_id, list(granted)),
        ).fetchall()
    )
    added = 0
    for key, keys in granted.items():
        for permission in keys:
            row = conn.execute(
                "INSERT INTO core.role_permissions (organization_id, role_id, permission_key)"
                " VALUES (%s, %s, %s) ON CONFLICT (role_id, permission_key) DO NOTHING RETURNING id",
                (org_id, role_ids[key], permission),
            ).fetchone()
            added += row is not None
    if added:
        report.created.append(f"{added} permission grants")
    return role_ids


def _not_elsewhere(conn: psycopg.Connection, org_id: uuid.UUID, email: str) -> None:
    """Refuse an email another company has registered: sign-in would then match two.

    core.resolve_pending_user is the sign-in path's own lookup, and the one
    query that may look across tenants, so it is asked exactly what sign-in will
    ask. The address's own domain stands in for the Google Workspace domain: a
    company pinned to another domain could never match this person anyway.
    """
    elsewhere = (
        f"{email} is already registered in another company in Linck, and one email signs in to one "
        "company. Register another Google account of theirs, or remove them there first"
    )
    try:
        # A savepoint, so the refusal below leaves the transaction usable.
        with conn.transaction():
            found = conn.execute(
                "SELECT organization_id FROM core.resolve_pending_user(%s, %s)", (email, email.split("@")[-1])
            ).fetchall()
    except errors.CardinalityViolation:
        raise Refused(elsewhere) from None
    if any(org != org_id for (org,) in found):
        raise Refused(elsewhere)


def _ensure_member(
    conn: psycopg.Connection,
    org_id: uuid.UUID,
    member: Member,
    role_ids: dict[str, uuid.UUID],
    report: Report,
) -> None:
    """The person, pre-registered, holding each of ``member.roles``."""
    for key, _ in member.roles:
        if key not in role_ids:
            module = ROLES[key].requires_module
            raise Refused(
                f"{key} does not exist in this company: its module ({module}) is not switched on"
                if module
                else f"{key} grants nothing this company's modules cover"
            )

    site_ids: dict[str, uuid.UUID] = {}
    for _, code in member.roles:
        if code is None or code in site_ids:
            continue
        row = conn.execute(
            "SELECT id FROM core.sites WHERE organization_id = %s AND code = %s", (org_id, code)
        ).fetchone()
        if row is None:
            codes = conn.execute(
                "SELECT code FROM core.sites WHERE organization_id = %s ORDER BY code", (org_id,)
            )
            raise Refused(f"there is no site {code} here. The sites are: {', '.join(c for (c,) in codes)}")
        site_ids[code] = row[0]

    row = conn.execute(
        "SELECT id, full_name, status FROM core.users WHERE organization_id = %s AND email = %s",
        (org_id, member.email),
    ).fetchone()
    if row is None:
        if not member.name:
            raise Refused(f"{member.email} is new here: give their name with --name, as on the payroll")
        _not_elsewhere(conn, org_id, member.email)
        # `invited` until their first sign-in, which makes them `active`. No
        # identity row: the Google `sub` is pinned at that first sign-in, and
        # one invented here would shadow the real one and lock them out.
        (user_id,) = conn.execute(
            "INSERT INTO core.users (organization_id, email, full_name, status)"
            " VALUES (%s, %s, %s, 'invited') RETURNING id",
            (org_id, member.email, member.name),
        ).fetchone()
        conn.execute(
            "INSERT INTO core.invitations (organization_id, email, full_name, expires_at)"
            " VALUES (%s, %s, %s, now() + make_interval(days => %s))"
            " ON CONFLICT (organization_id, email) DO NOTHING",
            (org_id, member.email, member.name, INVITATION_DAYS),
        )
        report.created.append(f"user {member.email} ({member.name})")
        (domains,) = conn.execute(
            "SELECT google_hosted_domains FROM core.organizations WHERE id = %s", (org_id,)
        ).fetchone()
        if domains and member.email.split("@")[-1] not in domains:
            report.notes.append(
                f"this company lets in only Google Workspace accounts on {', '.join(domains)}: "
                f"{member.email} may never be able to sign in"
            )
    else:
        user_id, full_name, user_status = row
        report.kept.append(f"user {member.email} ({full_name})")
        if user_status not in ("invited", "active"):
            report.notes.append(f"{member.email} is {user_status}: they cannot sign in until that changes")

    for key, code in member.roles:
        # The unique index is (user, role, coalesce(site, zero)), so an
        # org-wide assignment is found again like a site's.
        row = conn.execute(
            "INSERT INTO core.role_assignments (organization_id, user_id, role_id, site_id)"
            " VALUES (%s, %s, %s, %s) ON CONFLICT DO NOTHING RETURNING id",
            (org_id, user_id, role_ids[key], site_ids[code] if code else None),
        ).fetchone()
        held = f"{member.email} as {ROLES[key].label} at {code or 'the whole company'}"
        (report.created if row else report.kept).append(held)


def create_company(conn: psycopg.Connection, company: Company, admin: Member) -> Report:
    """The organization, its entity and site, its roles, and its first admin, in one transaction."""
    org_id = org_id_for(company.slug)
    report = Report(org_id=org_id, slug=company.slug)
    with conn.transaction():
        _scope(conn, org_id)
        row = conn.execute(
            """
            INSERT INTO core.organizations
                (id, display_name, slug, base_currency, timezone, fiscal_year_start_month,
                 google_hosted_domains, segregation_enforcement, status)
            VALUES (%s, %s, %s, 'INR', 'Asia/Kolkata', 4, %s, 'review_queue', 'active')
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            (org_id, company.name, company.slug, list(company.hosted_domains)),
        ).fetchone()
        existing = conn.execute(
            "SELECT display_name FROM core.organizations WHERE id = %s", (org_id,)
        ).fetchone()
        if existing is None:
            # The slug is unique across tenants, and another tenant's row is
            # invisible under this one's GUC: the insert met it and did nothing.
            raise Refused(
                f"the slug {company.slug!r} is taken by another company: choose another with --slug"
            )
        (report.created if row else report.kept).append(f"company {existing[0]} ({company.slug})")

        for module in company.modules:
            row = conn.execute(
                "INSERT INTO core.organization_modules (organization_id, module, enabled)"
                " VALUES (%s, %s, true) ON CONFLICT (organization_id, module) DO NOTHING RETURNING id",
                (org_id, module),
            ).fetchone()
            if row:
                report.created.append(f"module {module}")

        row = conn.execute(
            "INSERT INTO core.legal_entities (organization_id, code, legal_name, trade_name, entity_type)"
            " VALUES (%s, %s, %s, %s, %s) ON CONFLICT (organization_id, code) DO NOTHING RETURNING id",
            (org_id, company.entity_code, company.entity_name, company.name, company.entity_type),
        ).fetchone()
        entity_id = conn.execute(
            "SELECT id FROM core.legal_entities WHERE organization_id = %s AND code = %s",
            (org_id, company.entity_code),
        ).fetchone()[0]
        (report.created if row else report.kept).append(
            f"legal entity {company.entity_code} ({company.entity_name})"
        )

        row = conn.execute(
            "INSERT INTO core.sites (organization_id, legal_entity_id, code, name, site_type, state_code)"
            " VALUES (%s, %s, %s, %s, %s, %s) ON CONFLICT (organization_id, code) DO NOTHING RETURNING id",
            (org_id, entity_id, company.site_code, company.site_name, company.site_type, company.state_code),
        ).fetchone()
        (report.created if row else report.kept).append(f"site {company.site_code} ({company.site_name})")

        _ensure_member(conn, org_id, admin, _ensure_roles(conn, org_id, report), report)
    return report


def add_member(conn: psycopg.Connection, slug: str, member: Member) -> Report:
    org_id = org_id_for(slug)
    report = Report(org_id=org_id, slug=slug)
    with conn.transaction():
        _scope(conn, org_id)
        if conn.execute("SELECT 1 FROM core.organizations WHERE id = %s", (org_id,)).fetchone() is None:
            raise Refused(f"there is no company {slug!r}: create it first (see --help), or check the slug")
        _ensure_member(conn, org_id, member, _ensure_roles(conn, org_id, report), report)
    return report


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m scripts.create_org",
        description="Create a company in Linck and its first admin, or register someone in it.",
        epilog="Writes with LINCK_MIGRATION_DATABASE_URL unless --database-url is given.",
    )
    p.add_argument(
        "--database-url", help="a URL that may write the core tables (the migrator's, or an admin's)"
    )

    new = p.add_argument_group("a new company")
    new.add_argument("--name", help="the company's name, as people say it; with --add-user, the person's")
    new.add_argument(
        "--slug",
        help="a short id in lower-case words, such as sri-murugan-blue-metals (default: from --name)",
    )
    new.add_argument(
        "--modules",
        help=f"what it has switched on, comma separated (default: all of {','.join(ALL_MODULES)})",
    )
    new.add_argument("--entity-name", help="the legal entity's registered name (default: --name)")
    new.add_argument("--entity-code", help="a short code for it (default: the slug's initials)")
    new.add_argument("--entity-type", choices=ENTITY_TYPES)
    new.add_argument("--site-code", help="the first site's code, such as PLT-VNG")
    new.add_argument("--site-name", help="the first site's name, such as 'Vangal crusher plant'")
    new.add_argument("--site-type", choices=SITE_TYPES)
    new.add_argument(
        "--state", default="33", help="the site's two-digit GST state code (default: 33, Tamil Nadu)"
    )
    new.add_argument(
        "--hosted-domain",
        action="append",
        default=[],
        help="allow only Google Workspace accounts on this domain (repeatable). Leave it out if anyone "
        "signs in with a personal gmail account, as drivers do",
    )
    new.add_argument("--admin-email", help="the first admin's Google account")
    new.add_argument("--admin-name", help="the first admin's name, as on the payroll")

    later = p.add_argument_group("someone in a company that exists")
    later.add_argument("--org", help="the company's slug")
    later.add_argument(
        "--add-user",
        nargs="+",
        metavar=("EMAIL", "ROLE"),
        help="EMAIL ROLE [SITE]: register them, holding ROLE at SITE, or company-wide without one",
    )
    return p


def _company(args: argparse.Namespace) -> tuple[Company, Member]:
    needed = {
        "--name": args.name,
        "--entity-type": args.entity_type,
        "--site-code": args.site_code,
        "--site-name": args.site_name,
        "--site-type": args.site_type,
        "--admin-email": args.admin_email,
        "--admin-name": args.admin_name,
    }
    missing = [flag for flag, value in needed.items() if not value]
    if missing:
        raise Refused(f"a new company needs {', '.join(missing)} (see --help)")
    slug = args.slug or slug_for(args.name)
    if not _SLUG.fullmatch(slug):
        raise Refused(f"the slug {slug!r} must be lower-case letters and digits in words joined by '-'")
    modules = tuple(m.strip() for m in args.modules.split(",") if m.strip()) if args.modules else ALL_MODULES
    unknown = sorted(set(modules) - set(ALL_MODULES))
    if unknown or not modules:
        raise Refused(
            f"--modules takes some of {','.join(ALL_MODULES)}; not {','.join(unknown) or 'nothing'}"
        )
    site_code = args.site_code.strip().upper()
    if not _SITE_CODE.fullmatch(site_code):
        raise Refused(
            f"the site code {args.site_code!r} must be letters, digits, '-' or '_', such as PLT-VNG"
        )
    if not re.fullmatch(r"\d{2}", args.state):
        raise Refused(f"--state is the two-digit GST state code, such as 33; not {args.state!r}")
    company = Company(
        name=args.name.strip(),
        slug=slug,
        modules=modules,
        entity_code=(args.entity_code or entity_code_for(slug)).strip().upper(),
        entity_name=(args.entity_name or args.name).strip(),
        entity_type=args.entity_type,
        site_code=site_code,
        site_name=args.site_name.strip(),
        site_type=args.site_type,
        state_code=args.state,
        hosted_domains=tuple(d.strip().lower() for d in args.hosted_domain if d.strip()),
    )
    admin = Member(
        clean_email(args.admin_email), args.admin_name.strip(), tuple((k, None) for k in ADMIN_ROLES)
    )
    return company, admin


def _member(args: argparse.Namespace) -> Member:
    if not args.org:
        raise Refused("--add-user needs --org, the company's slug")
    if len(args.add_user) not in (2, 3):
        raise Refused("--add-user takes EMAIL ROLE, and a SITE code if they work at one site")
    email, role, *site = args.add_user
    name = args.name.strip() if args.name else None
    return Member(
        clean_email(email), name or None, ((role_key(role), site[0].strip().upper() if site else None),)
    )


def _print(report: Report, say: Callable[[str], None]) -> None:
    for line in report.created:
        say(f"  added  {line}")
    for line in report.kept:
        say(f"  kept   {line}")
    for line in report.notes:
        say(f"  note   {line}")
    say(
        f"\ncompany id: {report.org_id}"
        "  (LINCK_WHATSAPP_ORGANIZATION_ID, if this company takes WhatsApp slips)"
    )


def main(argv: list[str] | None = None, say: Callable[[str], None] = print) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.add_user:
            member, company = _member(args), None
        else:
            company, member = _company(args)
        url = conninfo(args.database_url or get_settings().migration_database_url)
        say(f"writing to {describe(url)}")
        with psycopg.connect(url) as conn:
            if company is None:
                report = add_member(conn, args.org, member)
            else:
                report = create_company(conn, company, member)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 2
    except psycopg.Error as exc:
        print(f"the database refused: {exc}", file=sys.stderr)
        return 2

    _print(report, say)
    if company is not None:
        say(f"\nNext: sign in to Linck with Google as {member.email}.")
        say(
            f"To register someone else: python -m scripts.create_org --org {report.slug} "
            "--add-user EMAIL ROLE [SITE] --name 'Their Name'"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Create a company in Linck and register its first admin. Safe to run again.

    cd apps/api
    uv run python -m scripts.create_org \\
        --name "Sri Murugan Blue Metals" --entity-type partnership \\
        --site-code PLT-VNG --site-name "Vangal crusher plant" --site-type crusher_plant \\
        --admin-email owner@example.com --admin-name "Meena Sundaram"

Then, for each person who will sign in (the site is left out for org-wide):

    uv run python -m scripts.create_org --org sri-murugan-blue-metals \\
        --add-user ravi@example.com fleet PLT-VNG --name "Ravi K"

On a deployment both run in the App Platform console, from /app and without
`uv run`: docs/DEPLOY.md, step 8.

Nobody can sign in to a database with no company in it: sign-in never creates
a user, it only matches a Google account to someone already registered
(app/api/auth.py). This registers the first someone. It writes:

- the organization, with the modules it has switched on (all, unless --modules);
- one legal entity and one site;
- the roles app/domain/roles.py defines, each granting what it grants there,
  for the modules this company has (``role_grants``);
- the first admin, pre-registered by the email of their Google account, as
  Managing Director and Administrator across the whole company.

It needs nothing stronger than the API. The engine is app.core.db's, on
LINCK_DATABASE_URL, which is linck_app wherever the API runs, and it refuses to
run where the API would refuse to start (check_rls_posture), so a superuser or
BYPASSRLS URL is turned away. Like the seed, every write goes through
tenant_session(org_id), so row level security checks each row as it checks a
request's, and a company's rows are exactly the rows its tenant context can
see. The id is derived from the slug, because RLS checks an organization's own
row against that GUC: it must be known before the row exists.

Running it again changes nothing that is there: rows are found by their natural
keys and only missing ones are added. It never renames, removes or narrows
anything, so it cannot take a grant away from someone who is using it; a role
that is missing a key app/domain/roles.py now grants gets it.

One email signs in to one company: core.resolve_pending_user refuses to choose
between two (migration 0003). So before it commits, the script asks that
function, sign-in's own lookup and the one query that may look across tenants,
whom each email it registered reaches, and keeps nothing if it is someone in
another company: that would lock both of them out.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
import uuid
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

if __package__ in (None, ""):  # run as `python scripts/create_org.py`
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import asyncpg  # noqa: E402
from sqlalchemy import text  # noqa: E402
from sqlalchemy.exc import DBAPIError  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: E402

from app.core.db import check_rls_posture, engine, tenant_session  # noqa: E402
from app.domain.roles import ALL_MODULES, ROLES, role_grants  # noqa: E402

#: Organization ids are uuid5(ORG_NS, slug). Not seed_dev's namespace: a real
#: company never shares an id with a development tenant.
ORG_NS = uuid.uuid5(uuid.NAMESPACE_DNS, "org.linck.app")

#: The first admin's roles, both org-wide: the director's desks and member admin.
ADMIN_ROLES = ("executive", "org_admin")

#: The words people use for a role, beside app/domain/roles.py's keys.
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

#: GST state codes, a GSTIN's first two digits. Not 25 (Daman and Diu, merged
#: into 26 in 2020) or 28 (Andhra Pradesh before it split): no new site is in either.
STATE_CODES = frozenset(f"{n:02d}" for n in range(1, 39)) - {"25", "28"}

# Stricter than dev-login's test: every Google account's address has a dotted
# domain, so "ravi@gmail" is a typo, not an account.
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s.]+$")
_SLUG = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
_CODE = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,31}$")
_DOMAIN = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$")
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
    checked: list[str] = field(default_factory=list)
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


def describe() -> str:
    """Where the writes go, and as whom, without the password."""
    url = engine.url
    return f"{url.username}@{url.host or 'localhost'}:{url.port or 5432}/{url.database}"


# ---------------------------------------------------------------------------
# Writing
# ---------------------------------------------------------------------------


async def _permission_modules(db: AsyncSession) -> dict[str, str]:
    rows = (await db.execute(text("SELECT key, module FROM core.permissions"))).all()
    if not rows:
        raise Refused("core.permissions is empty: run `alembic upgrade head` on this database first")
    catalogue = dict(rows)
    missing = sorted({p for role in ROLES.values() for p in role.permissions} - catalogue.keys())
    if missing:
        raise Refused(
            f"this database is behind the code (no {', '.join(missing)}): run `alembic upgrade head`"
        )
    return catalogue


async def _ensure_roles(db: AsyncSession, org_id: uuid.UUID, report: Report) -> dict[str, uuid.UUID]:
    """Every role this company's modules call for, each with at least the keys it grants."""
    modules = (
        await db.scalars(
            text("SELECT module FROM core.organization_modules WHERE organization_id = :org AND enabled"),
            {"org": org_id},
        )
    ).all()
    granted, _ = role_grants(modules, await _permission_modules(db))
    for key in granted:
        row = (
            await db.execute(
                text(
                    "INSERT INTO core.roles (organization_id, key, label, is_system)"
                    " VALUES (:org, :key, :label, true)"
                    " ON CONFLICT (organization_id, key) DO NOTHING RETURNING id"
                ),
                {"org": org_id, "key": key, "label": ROLES[key].label},
            )
        ).first()
        if row:
            report.created.append(f"role {key} ({ROLES[key].label})")
    role_ids = dict(
        (
            await db.execute(
                text("SELECT key, id FROM core.roles WHERE organization_id = :org AND key = ANY(:keys)"),
                {"org": org_id, "keys": list(granted)},
            )
        ).all()
    )
    added = 0
    for key, keys in granted.items():
        for permission in keys:
            row = (
                await db.execute(
                    text(
                        "INSERT INTO core.role_permissions (organization_id, role_id, permission_key)"
                        " VALUES (:org, :role, :key) ON CONFLICT (role_id, permission_key) DO NOTHING"
                        " RETURNING id"
                    ),
                    {"org": org_id, "role": role_ids[key], "key": permission},
                )
            ).first()
            added += row is not None
    if added:
        report.created.append(f"{added} permission grants")
    return role_ids


RESOLVE = text("SELECT user_id, organization_id FROM core.resolve_pending_user(:email, :hd)")


async def _check_sign_in(
    db: AsyncSession, org_id: uuid.UUID, user_id: uuid.UUID, email: str, report: Report
) -> None:
    """Ask sign-in's own lookup whom an email just registered reaches.

    Inside the transaction, so it sees the rows just written and a refusal
    keeps none of them. Asked twice, because the hosted domain is part of the
    match: a personal Google account presents none, and a Workspace account its
    domain, which the address's own stands in for.
    """
    elsewhere = (
        f"{email} is already registered in another company in Linck, and one email signs in to one "
        "company. Register another Google account of theirs, or remove them there first"
    )
    reached: set[tuple[uuid.UUID, uuid.UUID]] = set()
    for hosted_domain in (None, email.split("@")[-1]):
        try:
            rows = await db.execute(RESOLVE, {"email": email, "hd": hosted_domain})
        except DBAPIError as exc:
            # cardinality_violation: it will not choose between two companies.
            if getattr(exc.orig, "sqlstate", None) == "21000":
                raise Refused(elsewhere) from None
            raise
        reached.update((found_user, found_org) for found_user, found_org in rows)
    if any(found_org != org_id for _, found_org in reached):
        raise Refused(elsewhere)
    if (user_id, org_id) in reached:
        report.checked.append(f"Google sign-in as {email} finds them here")
        return

    # Not a refusal: registering them is still right, and they can sign in once
    # this changes. A Workspace address may be an alias on a pinned domain.
    org_status, domains = (
        await db.execute(
            text("SELECT status, google_hosted_domains FROM core.organizations WHERE id = :org"),
            {"org": org_id},
        )
    ).one()
    if org_status != "active":
        report.notes.append(f"this company is {org_status}: {email} cannot sign in until it is active")
    else:
        report.notes.append(
            f"this company lets in only Google Workspace accounts on {', '.join(domains)}: "
            f"{email} may never be able to sign in"
        )


async def _ensure_member(
    db: AsyncSession,
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
        site_id = (
            await db.execute(
                text("SELECT id FROM core.sites WHERE organization_id = :org AND code = :code"),
                {"org": org_id, "code": code},
            )
        ).scalar()
        if site_id is None:
            codes = await db.scalars(
                text("SELECT code FROM core.sites WHERE organization_id = :org ORDER BY code"),
                {"org": org_id},
            )
            raise Refused(f"there is no site {code} here. The sites are: {', '.join(codes)}")
        site_ids[code] = site_id

    row = (
        await db.execute(
            text(
                "SELECT id, full_name, status FROM core.users WHERE organization_id = :org AND email = :email"
            ),
            {"org": org_id, "email": member.email},
        )
    ).first()
    if row is None:
        if not member.name:
            raise Refused(f"{member.email} is new here: give their name with --name, as on the payroll")
        # `invited` until their first sign-in, which makes them `active`. No
        # identity row: the Google `sub` is pinned at that first sign-in, and
        # one invented here would shadow the real one and lock them out.
        user_id = (
            await db.execute(
                text(
                    "INSERT INTO core.users (organization_id, email, full_name, status)"
                    " VALUES (:org, :email, :name, 'invited') RETURNING id"
                ),
                {"org": org_id, "email": member.email, "name": member.name},
            )
        ).scalar_one()
        await db.execute(
            text(
                "INSERT INTO core.invitations (organization_id, email, full_name, expires_at)"
                " VALUES (:org, :email, :name, now() + make_interval(days => :days))"
                " ON CONFLICT (organization_id, email) DO NOTHING"
            ),
            {"org": org_id, "email": member.email, "name": member.name, "days": INVITATION_DAYS},
        )
        report.created.append(f"user {member.email} ({member.name})")
        await _check_sign_in(db, org_id, user_id, member.email, report)
    else:
        user_id, full_name, user_status = row
        report.kept.append(f"user {member.email} ({full_name})")
        if user_status not in ("invited", "active"):
            report.notes.append(f"{member.email} is {user_status}: they cannot sign in until that changes")

    for key, code in member.roles:
        # The unique index is (user, role, coalesce(site, zero)), so an
        # org-wide assignment is found again like a site's.
        row = (
            await db.execute(
                text(
                    "INSERT INTO core.role_assignments (organization_id, user_id, role_id, site_id)"
                    " VALUES (:org, :user, :role, :site) ON CONFLICT DO NOTHING RETURNING id"
                ),
                {
                    "org": org_id,
                    "user": user_id,
                    "role": role_ids[key],
                    "site": site_ids[code] if code else None,
                },
            )
        ).first()
        held = f"{member.email} as {ROLES[key].label} at {code or 'the whole company'}"
        (report.created if row else report.kept).append(held)


async def create_company(company: Company, admin: Member) -> Report:
    """The organization, its entity and site, its roles, and its first admin, in one transaction."""
    org_id = org_id_for(company.slug)
    report = Report(org_id=org_id, slug=company.slug)
    async with tenant_session(org_id) as db:
        created = (
            await db.execute(
                text(
                    """
                    INSERT INTO core.organizations
                        (id, display_name, slug, base_currency, timezone, fiscal_year_start_month,
                         google_hosted_domains, segregation_enforcement, status)
                    VALUES (:org, :name, :slug, 'INR', 'Asia/Kolkata', 4, :domains, 'review_queue', 'active')
                    ON CONFLICT DO NOTHING
                    RETURNING id
                    """
                ),
                {
                    "org": org_id,
                    "name": company.name,
                    "slug": company.slug,
                    "domains": list(company.hosted_domains),
                },
            )
        ).first()
        existing = (
            await db.execute(
                text("SELECT display_name FROM core.organizations WHERE id = :org"), {"org": org_id}
            )
        ).scalar()
        if existing is None:
            # The slug is unique across tenants, and another tenant's row is
            # invisible under this one's GUC: the insert met it and did nothing.
            raise Refused(
                f"the slug {company.slug!r} is taken by another company: choose another with --slug"
            )
        (report.created if created else report.kept).append(f"company {existing} ({company.slug})")

        for module in company.modules:
            row = (
                await db.execute(
                    text(
                        "INSERT INTO core.organization_modules (organization_id, module, enabled)"
                        " VALUES (:org, :module, true)"
                        " ON CONFLICT (organization_id, module) DO NOTHING RETURNING id"
                    ),
                    {"org": org_id, "module": module},
                )
            ).first()
            if row:
                report.created.append(f"module {module}")

        row = (
            await db.execute(
                text(
                    "INSERT INTO core.legal_entities"
                    " (organization_id, code, legal_name, trade_name, entity_type)"
                    " VALUES (:org, :code, :legal_name, :trade_name, :entity_type)"
                    " ON CONFLICT (organization_id, code) DO NOTHING RETURNING id"
                ),
                {
                    "org": org_id,
                    "code": company.entity_code,
                    "legal_name": company.entity_name,
                    "trade_name": company.name,
                    "entity_type": company.entity_type,
                },
            )
        ).first()
        entity_id = (
            await db.execute(
                text("SELECT id FROM core.legal_entities WHERE organization_id = :org AND code = :code"),
                {"org": org_id, "code": company.entity_code},
            )
        ).scalar_one()
        (report.created if row else report.kept).append(
            f"legal entity {company.entity_code} ({company.entity_name})"
        )

        row = (
            await db.execute(
                text(
                    "INSERT INTO core.sites"
                    " (organization_id, legal_entity_id, code, name, site_type, state_code)"
                    " VALUES (:org, :entity, :code, :name, :site_type, :state)"
                    " ON CONFLICT (organization_id, code) DO NOTHING RETURNING id"
                ),
                {
                    "org": org_id,
                    "entity": entity_id,
                    "code": company.site_code,
                    "name": company.site_name,
                    "site_type": company.site_type,
                    "state": company.state_code,
                },
            )
        ).first()
        (report.created if row else report.kept).append(f"site {company.site_code} ({company.site_name})")

        await _ensure_member(db, org_id, admin, await _ensure_roles(db, org_id, report), report)
    return report


async def add_member(slug: str, member: Member) -> Report:
    org_id = org_id_for(slug)
    report = Report(org_id=org_id, slug=slug)
    async with tenant_session(org_id) as db:
        found = (
            await db.execute(text("SELECT 1 FROM core.organizations WHERE id = :org"), {"org": org_id})
        ).first()
        if found is None:
            raise Refused(f"there is no company {slug!r}: create it first (see --help), or check the slug")
        await _ensure_member(db, org_id, member, await _ensure_roles(db, org_id, report), report)
    return report


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m scripts.create_org",
        description="Create a company in Linck and its first admin, or register someone in it.",
        epilog="Writes as the API does, with LINCK_DATABASE_URL, the app role's URL.",
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
    missing = [flag for flag, value in needed.items() if not (value or "").strip()]
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
    if not _CODE.fullmatch(site_code):
        raise Refused(
            f"the site code {args.site_code!r} must be letters, digits, '-' or '_', such as PLT-VNG"
        )
    entity_code = (args.entity_code or entity_code_for(slug)).strip().upper()
    if not _CODE.fullmatch(entity_code):
        raise Refused(f"the entity code {entity_code!r} must be letters, digits, '-' or '_', such as SMBM")
    if args.state not in STATE_CODES:
        raise Refused(f"--state is the two-digit GST state code, such as 33; not {args.state!r}")
    hosted_domains = tuple(d.strip().lower() for d in args.hosted_domain if d.strip())
    for domain in hosted_domains:
        # A wrong one is not harmless: it shuts out everyone the company registers.
        if not _DOMAIN.fullmatch(domain):
            raise Refused(f"--hosted-domain {domain!r} is not a domain: give it as vaigai.in, without '@'")
    company = Company(
        name=args.name.strip(),
        slug=slug,
        modules=modules,
        entity_code=entity_code,
        entity_name=(args.entity_name or args.name).strip(),
        entity_type=args.entity_type,
        site_code=site_code,
        site_name=args.site_name.strip(),
        site_type=args.site_type,
        state_code=args.state,
        hosted_domains=hosted_domains,
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
        say(f"  added    {line}")
    for line in report.kept:
        say(f"  kept     {line}")
    for line in report.checked:
        say(f"  checked  {line}")
    for line in report.notes:
        say(f"  note     {line}")
    say(
        f"\ncompany id: {report.org_id}"
        "  (LINCK_WHATSAPP_ORGANIZATION_ID, if this company takes WhatsApp slips)"
    )


async def main(argv: list[str] | None = None, say: Callable[[str], None] = print) -> int:
    parser = _parser()
    args = parser.parse_args(argv)
    try:
        if args.add_user:
            member, company = _member(args), None
        else:
            company, member = _company(args)
        say(f"writing to {describe()}")
        problems = await check_rls_posture()
        if problems:
            raise Refused(
                "the API would not start against this database, and nor will this:\n"
                + "\n".join(f"  {problem}" for problem in problems)
            )
        if company is None:
            report = await add_member(args.org, member)
        else:
            report = await create_company(company, member)
    except Refused as refused:
        print(f"refused: {refused}", file=sys.stderr)
        return 2
    except DBAPIError as exc:
        # insufficient_privilege: a role other than the app's, most likely the
        # cluster's admin, which is granted nothing of Linck's.
        if getattr(exc.orig, "sqlstate", None) == "42501":
            print(
                f"refused: {engine.url.username} may not use Linck's tables. "
                "Set LINCK_DATABASE_URL to the app role's URL, the one for linck_app",
                file=sys.stderr,
            )
        else:
            print(f"the database refused: {exc.orig.__cause__ or exc.orig}", file=sys.stderr)
        return 2
    except asyncpg.PostgresError as exc:
        # Refused while connecting, a wrong password say: SQLAlchemy passes those on as they are.
        print(f"the database refused: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"could not reach the database: {exc}", file=sys.stderr)
        return 2
    finally:
        await engine.dispose()

    _print(report, say)
    if company is not None:
        say(f"\nNext: sign in to Linck with Google as {member.email}.")
        say(
            f"To register someone else: python -m scripts.create_org --org {report.slug} "
            "--add-user EMAIL ROLE [SITE] --name 'Their Name'"
        )
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

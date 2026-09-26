"""Idempotent development seed.

    cd apps/api && .venv/bin/python -m scripts.seed_dev

THREE tenants, because one would hide the bug this data model exists to prevent.
Linck is a product sold to clients; "crusher" and "fleet" are verticals a client
switches on, not a fixed business. Seeding a single both-verticals tenant would
let a hard-coded Production tab, a freight line where an inter-company GTA
invoice belongs, or a single-legal-entity assumption sail through every screen:

  1. Sri Murugan Blue Metals  crusher + fleet, TWO legal entities (partnership
                              holds the crusher, proprietorship holds the
                              tippers) and a second GSTIN in Karnataka. This is
                              the inter-company GTA case AND the inter-state
                              e-way bill lane.
  2. Kaveri Aggregates        crusher ONLY, one private limited. No fleet
                              module, so no fleet roles exist to assign.
  3. Anbu Transports          fleet ONLY, one proprietorship. No production, no
                              stores.

Every write runs inside ``tenant_session(org_id)``, so the seed goes through RLS
exactly as a request does — including the insert into ``core.organizations``,
whose own policy is ``id = current_setting('app.current_org_id')``. That is why
ids are derived (uuid5) rather than server-generated: the tenant id has to be
known before the transaction that creates the tenant can be opened. If this
script ever needs a hole in a policy to run, the policy is wrong.

Idempotency: every id is a uuid5 of its natural key, so re-running upserts in
place. ``updated_at`` is deliberately NOT touched on conflict — the audit
trigger suppresses no-op updates, so a second run writes zero audit rows.
Assignments and modules are reconciled (stale ones deleted); legal entities,
sites and users are never deleted, since dropping one cascades real work away.
"""

from __future__ import annotations

import asyncio
import sys
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import engine, tenant_session
from app.core.settings import get_settings
from app.models.core import (
    GstRegistration,
    Invitation,
    LegalEntity,
    Organization,
    OrganizationModule,
    Permission,
    Role,
    RoleAssignment,
    RolePermission,
    Site,
    User,
)

t_org = Organization.__table__
t_module = OrganizationModule.__table__
t_entity = LegalEntity.__table__
t_gst = GstRegistration.__table__
t_site = Site.__table__
t_user = User.__table__
t_role = Role.__table__
t_role_perm = RolePermission.__table__
t_assign = RoleAssignment.__table__
t_invite = Invitation.__table__

# ---------------------------------------------------------------------------
# Derived ids
# ---------------------------------------------------------------------------

# A fixed namespace so every developer's linck_dev holds the SAME ids. Tests and
# the web app can hard-code a site id without first querying for it, and a
# re-run cannot fork the data.
SEED_NS = uuid.uuid5(uuid.NAMESPACE_DNS, "seed.linck.dev")


def sid(*parts: str) -> uuid.UUID:
    return uuid.uuid5(SEED_NS, "/".join(parts))


# ---------------------------------------------------------------------------
# GSTIN
# ---------------------------------------------------------------------------

_GST_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin(state_code: str, pan: str, registration_no: int = 1) -> str:
    """Build a checksum-valid GSTIN: state(2) + PAN(10) + entity no(1) + Z + check.

    The check digit is computed rather than invented because the e-way bill and
    e-invoice consoles will validate it, and a seed that fails the app's own
    validation is a seed that gets worked around.
    """
    body = f"{state_code}{pan}{registration_no}Z"
    total = 0
    for i, ch in enumerate(body):
        product = _GST_ALPHABET.index(ch) * (1 if i % 2 == 0 else 2)
        total += product // 36 + product % 36
    return body + _GST_ALPHABET[(36 - total % 36) % 36]


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------

ALL_MODULES = ("fleet", "production", "sales", "stores", "finance", "compliance", "ai")


@dataclass(frozen=True)
class RoleSpec:
    label: str
    # The vertical this role belongs to. If the tenant has not switched that
    # module on, the role is not created at all — which is why a Kaveri admin
    # cannot accidentally assign someone "Fleet manager" and why Anbu has no
    # weighbridge operator. Roles with no home vertical (admin, executive,
    # accounts) exist for every tenant.
    requires_module: str | None
    permissions: tuple[str, ...]


ROLES: dict[str, RoleSpec] = {
    "org_admin": RoleSpec(
        "Administrator",
        None,
        ("admin.member.manage", "admin.org.manage", "compliance.document.read"),
    ),
    "executive": RoleSpec(
        "Managing Director",
        None,
        (
            "executive.dashboard.read",
            "fleet.board.read",
            "fleet.vehicle.read",
            "production.stock.read",
            "production.run.read",
            "sales.dispatch.read",
            "sales.trip.read",
            "sales.invoice.read",
            "finance.receipt.read",
            "finance.receipt.verify",
            "compliance.document.read",
            "compliance.ewb.read",
            "stores.indent.read",
            "stores.indent.approve",
            "ai.extraction.review",
            "sales.board.read",
            "sales.customer.read",
            "sales.order.read",
            "sales.order.approve",
            "fleet.driver.read",
            "fleet.breakdown.read",
            "fleet.expense.read",
        ),
    ),
    "accounts": RoleSpec(
        "Accounts",
        None,
        (
            "sales.invoice.read",
            "sales.invoice.write",
            "sales.trip.read",
            "finance.receipt.read",
            "finance.receipt.verify",
            "compliance.document.read",
            "compliance.document.write",
            "compliance.ewb.read",
            "compliance.ewb.write",
            "fleet.vehicle.read",
            "ai.extraction.review",
        ),
    ),
    "fleet_manager": RoleSpec(
        "Fleet Manager",
        "fleet",
        (
            "fleet.board.read",
            "fleet.driver.read",
            "fleet.breakdown.read",
            "fleet.expense.read",
            "fleet.expense.validate",
            "fleet.vehicle.read",
            "fleet.vehicle.write",
            "fleet.fuel.create",
            "fleet.fuel.read",
            "compliance.document.read",
            "compliance.document.write",
            "compliance.ewb.read",
            "stores.indent.create",
            "stores.indent.read",
            "sales.dispatch.read",
            "sales.trip.read",
            "ai.extraction.review",
        ),
    ),
    "production_incharge": RoleSpec(
        "Production In-charge",
        "production",
        (
            "production.run.create",
            "production.run.read",
            "production.stock.read",
            "stores.indent.create",
            "stores.indent.read",
        ),
    ),
    "sales_coordinator": RoleSpec(
        "Sales Coordinator",
        "sales",
        (
            "sales.board.read",
            "sales.customer.read",
            "sales.order.read",
            "sales.order.approve",
            "sales.dispatch.read",
            "sales.dispatch.write",
            "sales.trip.read",
            "sales.invoice.read",
            "production.stock.read",
            "fleet.vehicle.read",
            "compliance.ewb.read",
            "compliance.ewb.write",
        ),
    ),
    "stores_incharge": RoleSpec(
        "Stores In-charge",
        "stores",
        (
            "stores.indent.read",
            "stores.indent.create",
            "stores.indent.approve",
            "production.stock.read",
            "ai.extraction.review",
        ),
    ),
    "weighbridge_operator": RoleSpec(
        "Weighbridge Operator",
        "production",
        (
            "production.run.create",
            "production.run.read",
            "production.stock.read",
            "sales.dispatch.read",
            "sales.trip.read",
        ),
    ),
    "driver": RoleSpec(
        "Driver",
        "fleet",
        ("field.trip.read", "fleet.fuel.create"),
    ),
}


# ---------------------------------------------------------------------------
# Tenant specifications
# ---------------------------------------------------------------------------

ORG_WIDE: tuple[str, ...] = ()


@dataclass(frozen=True)
class GstSpec:
    state_code: str
    e_invoicing: bool = False


@dataclass(frozen=True)
class EntitySpec:
    code: str
    legal_name: str
    trade_name: str
    entity_type: str
    pan: str
    registrations: tuple[GstSpec, ...]
    is_gta: bool = False


@dataclass(frozen=True)
class SiteSpec:
    code: str
    name: str
    site_type: str
    entity: str  # legal entity code
    state_code: str
    city: str
    district: str
    pincode: str
    line1: str


@dataclass(frozen=True)
class UserSpec:
    email: str
    full_name: str
    employee_code: str
    phone: str
    # (role key, site codes). An empty site tuple means org-wide.
    roles: tuple[tuple[str, tuple[str, ...]], ...]


@dataclass(frozen=True)
class TenantSpec:
    slug: str
    display_name: str
    modules: tuple[str, ...]
    entities: tuple[EntitySpec, ...]
    sites: tuple[SiteSpec, ...]
    users: tuple[UserSpec, ...]
    note: str
    # Empty means any Google account may attempt sign-in (it still has to match
    # a pre-registered user). It MUST be empty for a tenant whose drivers and
    # weighbridge operators sign in with personal gmail accounts: a consumer
    # Google account carries no `hd` claim, so a non-empty list would lock every
    # field user out while the office continued to work.
    hosted_domains: tuple[str, ...] = ()
    segregation_enforcement: str = "review_queue"


TENANTS: tuple[TenantSpec, ...] = (
    TenantSpec(
        slug="sri-murugan-blue-metals",
        display_name="Sri Murugan Blue Metals",
        note="Crusher + fleet, two legal entities, TN + KA registrations",
        modules=ALL_MODULES,
        hosted_domains=(),
        entities=(
            EntitySpec(
                code="SMBM",
                legal_name="Sri Murugan Blue Metals",
                trade_name="Sri Murugan Blue Metals",
                entity_type="partnership",
                pan="AAFFS4821K",
                # Two states: the Attibele stockyard is a place of business in
                # Karnataka, so the same PAN registers again there. A load from
                # the Vangal plant to that yard is a stock transfer between two
                # GSTINs — a taxable supply with an e-way bill, not an internal
                # move. This is the inter-state lane the EWB console needs.
                registrations=(GstSpec("33", e_invoicing=True), GstSpec("29", e_invoicing=True)),
            ),
            EntitySpec(
                code="MMT",
                legal_name="M. Murugan Transports",
                trade_name="Murugan Transports",
                entity_type="proprietorship",
                pan="AKQPM7364L",
                # The tippers sit here. When one carries SMBM's material, the
                # transport leg is an inter-company GTA supply under SAC 9965
                # with reverse charge — not a freight line on the customer's
                # invoice. Two entity ids in one tenant is what makes that
                # branch reachable at all.
                registrations=(GstSpec("33"),),
                is_gta=True,
            ),
        ),
        sites=(
            SiteSpec("HO-KRR", "Karur head office", "head_office", "SMBM", "33",
                     "Karur", "Karur", "639002", "12 Jawahar Bazaar"),
            SiteSpec("QRY-VNG", "Vangal quarry", "quarry", "SMBM", "33",
                     "Vangal", "Karur", "639117", "Survey 214/2, Vangal"),
            SiteSpec("PLT-VNG", "Vangal crusher plant", "crusher_plant", "SMBM", "33",
                     "Vangal", "Karur", "639117", "Survey 214/3, Vangal"),
            SiteSpec("WBR-VNG", "Vangal weighbridge", "weighbridge_point", "SMBM", "33",
                     "Vangal", "Karur", "639117", "Plant gate, Vangal"),
            SiteSpec("YRD-ATB", "Attibele stockyard", "stockyard", "SMBM", "29",
                     "Attibele", "Bengaluru Urban", "562107", "Hosur Road, Attibele"),
            SiteSpec("WSH-KRR", "Karur workshop", "workshop", "MMT", "33",
                     "Karur", "Karur", "639006", "Trichy Road, Pasupathipalayam"),
        ),
        users=(
            UserSpec(
                "balajinagarajkumar@gmail.com", "Balaji Nagarajan", "SMBM-001", "+919843001001",
                (("executive", ORG_WIDE), ("org_admin", ORG_WIDE)),
            ),
            UserSpec(
                "meenakshi.sundaram@srimuruganblue.in", "Meenakshi Sundaram R", "SMBM-004",
                "+919843001004", (("accounts", ORG_WIDE),),
            ),
            UserSpec(
                "anbuselvan.m@srimuruganblue.in", "Anbuselvan M", "SMBM-011", "+919843001011",
                (("fleet_manager", ("PLT-VNG", "WSH-KRR", "YRD-ATB")),),
            ),
            UserSpec(
                "kaliyaperumal.r@srimuruganblue.in", "Kaliyaperumal R", "SMBM-021", "+919843001021",
                (("production_incharge", ("PLT-VNG",)),),
            ),
            UserSpec(
                "vetrivel.s@srimuruganblue.in", "Vetrivel S", "SMBM-031", "+919843001031",
                (("sales_coordinator", ("PLT-VNG", "YRD-ATB")),),
            ),
            # Single-site holder: stores at the workshop only. If site scoping is
            # ever silently widened to org-wide, this user starts seeing indents
            # from the plant and the regression is visible on screen one.
            UserSpec(
                "ganesan.k@srimuruganblue.in", "Ganesan Kandasamy", "SMBM-041", "+919843001041",
                (("stores_incharge", ("WSH-KRR",)),),
            ),
            # Single-site holder on a personal gmail — the reason hosted_domains
            # is empty for this tenant.
            UserSpec(
                "saravanan.weighbridge@gmail.com", "Saravanan P", "SMBM-051", "+919843001051",
                (("weighbridge_operator", ("WBR-VNG",)),),
            ),
            UserSpec(
                "murugan.sekar.driver@gmail.com", "Murugan Sekar", "SMBM-061", "+919843001061",
                (("driver", ("PLT-VNG",)),),
            ),
            UserSpec(
                "karthikeyan.driver@gmail.com", "Karthikeyan Duraisamy", "SMBM-062", "+919843001062",
                (("driver", ("YRD-ATB",)),),
            ),
        ),
    ),
    TenantSpec(
        slug="kaveri-aggregates",
        display_name="Kaveri Aggregates",
        note="Crusher only — no fleet module, so no fleet roles exist",
        modules=("production", "sales", "stores", "finance", "compliance", "ai"),
        # Every person here has a Workspace account, so the domain gate is safe
        # to switch on. The contrast with tenant 1 is deliberate: both branches
        # of core.resolve_pending_user get exercised by the seed.
        hosted_domains=("kaveriaggregates.in",),
        segregation_enforcement="review_queue",
        entities=(
            EntitySpec(
                code="KAPL",
                legal_name="Kaveri Aggregates Private Limited",
                trade_name="Kaveri Aggregates",
                entity_type="private_limited",
                pan="AAGCK5192M",
                registrations=(GstSpec("33", e_invoicing=True),),
            ),
        ),
        sites=(
            SiteSpec("HO-NMK", "Namakkal head office", "head_office", "KAPL", "33",
                     "Namakkal", "Namakkal", "637001", "45 Salem Main Road"),
            SiteSpec("QRY-ELP", "Elachipalayam quarry", "quarry", "KAPL", "33",
                     "Elachipalayam", "Namakkal", "637202", "Survey 88/1, Elachipalayam"),
            SiteSpec("PLT-ELP", "Elachipalayam crusher plant", "crusher_plant", "KAPL", "33",
                     "Elachipalayam", "Namakkal", "637202", "Survey 88/4, Elachipalayam"),
            SiteSpec("WBR-ELP", "Elachipalayam weighbridge", "weighbridge_point", "KAPL", "33",
                     "Elachipalayam", "Namakkal", "637202", "Plant gate, Elachipalayam"),
        ),
        users=(
            UserSpec(
                "ramalingam.c@kaveriaggregates.in", "Ramalingam Chettiar", "KA-001", "+919842002001",
                (("executive", ORG_WIDE), ("org_admin", ORG_WIDE)),
            ),
            UserSpec(
                "bhuvaneswari.s@kaveriaggregates.in", "Bhuvaneswari Subramanian", "KA-004",
                "+919842002004", (("accounts", ORG_WIDE),),
            ),
            UserSpec(
                "senthilkumar.a@kaveriaggregates.in", "Senthilkumar Arumugam", "KA-021",
                "+919842002021", (("production_incharge", ("PLT-ELP",)),),
            ),
            UserSpec(
                "deivanai.m@kaveriaggregates.in", "Deivanai Manickam", "KA-031", "+919842002031",
                (("sales_coordinator", ("PLT-ELP",)),),
            ),
            UserSpec(
                "palanivel.r@kaveriaggregates.in", "Palanivel Ramasamy", "KA-041", "+919842002041",
                (("stores_incharge", ("PLT-ELP",)),),
            ),
            UserSpec(
                "chinnadurai.k@kaveriaggregates.in", "Chinnadurai Kandasamy", "KA-051",
                "+919842002051", (("weighbridge_operator", ("WBR-ELP",)),),
            ),
        ),
    ),
    TenantSpec(
        slug="anbu-transports",
        display_name="Anbu Transports",
        note="Fleet only — no production, no stores",
        modules=("fleet", "sales", "finance", "compliance", "ai"),
        hosted_domains=(),
        entities=(
            EntitySpec(
                code="ANBU",
                legal_name="Anbu Transports",
                trade_name="Anbu Transports",
                entity_type="proprietorship",
                pan="BXRPT2946Q",
                registrations=(GstSpec("33"),),
                # A GTA is exempt from e-invoicing entity-wide, so this single
                # flag changes what every invoice this tenant issues looks like.
                is_gta=True,
            ),
        ),
        sites=(
            SiteSpec("HO-SLM", "Salem head office", "head_office", "ANBU", "33",
                     "Salem", "Salem", "636005", "22 Cherry Road"),
            SiteSpec("DEP-SKG", "Sankagiri depot", "depot", "ANBU", "33",
                     "Sankagiri", "Salem", "637301", "Erode Main Road, Sankagiri"),
            SiteSpec("WSH-SLM", "Salem workshop", "workshop", "ANBU", "33",
                     "Salem", "Salem", "636007", "Kondalampatti Bypass"),
            SiteSpec("FUL-OML", "Omalur fuel point", "fuel_point", "ANBU", "33",
                     "Omalur", "Salem", "636455", "NH-44 Service Road, Omalur"),
        ),
        users=(
            UserSpec(
                "anbarasan.t@anbutransports.in", "Anbarasan Thangavel", "AT-001", "+919841003001",
                (("executive", ORG_WIDE), ("org_admin", ORG_WIDE)),
            ),
            UserSpec(
                "jeyanthi.a@anbutransports.in", "Jeyanthi Arunachalam", "AT-004", "+919841003004",
                (("accounts", ORG_WIDE),),
            ),
            UserSpec(
                "muthukumar.s@anbutransports.in", "Muthukumar Sivaraman", "AT-011", "+919841003011",
                (("fleet_manager", ORG_WIDE),),
            ),
            # Single-site holder: coordinates loads out of the depot only.
            UserSpec(
                "prakash.v@anbutransports.in", "Prakash Velayudham", "AT-031", "+919841003031",
                (("sales_coordinator", ("DEP-SKG",)),),
            ),
            UserSpec(
                "selvaraj.driver@gmail.com", "Selvaraj Duraipandi", "AT-061", "+919841003061",
                (("driver", ("DEP-SKG",)),),
            ),
            UserSpec(
                "rajendran.driver@gmail.com", "Rajendran Mariappan", "AT-062", "+919841003062",
                (("driver", ("DEP-SKG",)),),
            ),
        ),
    ),
)


# ---------------------------------------------------------------------------
# Upsert helper
# ---------------------------------------------------------------------------


async def upsert(session: AsyncSession, table: Any, rows: list[dict], update: tuple[str, ...]) -> None:
    """Insert or update on the derived primary key.

    ``updated_at`` is intentionally left out of the update set. The audit trigger
    compares to_jsonb(OLD) to to_jsonb(NEW) and skips no-op updates, so touching
    a timestamp on every run would turn a re-seed into a wall of audit rows that
    record nothing.
    """
    if not rows:
        return
    stmt = pg_insert(table).values(rows)
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["id"],
            set_={col: getattr(stmt.excluded, col) for col in update},
        )
    )


# ---------------------------------------------------------------------------
# Seed one tenant
# ---------------------------------------------------------------------------


@dataclass
class TenantReport:
    spec: TenantSpec
    org_id: uuid.UUID
    entities: int = 0
    registrations: int = 0
    sites: int = 0
    roles: list[str] = field(default_factory=list)
    skipped_roles: list[str] = field(default_factory=list)
    gstins: list[str] = field(default_factory=list)
    signins: list[tuple[str, str, str, str]] = field(default_factory=list)


async def seed_tenant(spec: TenantSpec, permission_modules: dict[str, str]) -> TenantReport:
    org_id = sid("org", spec.slug)
    report = TenantReport(spec=spec, org_id=org_id)
    now = datetime.now(UTC)

    async with tenant_session(org_id) as session:
        # -- organization ------------------------------------------------
        # This insert is the sharpest test in the file: core.organizations has
        # USING/WITH CHECK (id = app.current_org_id), so it only succeeds
        # because the id was derived before the transaction opened.
        await upsert(
            session,
            t_org,
            [
                {
                    "id": org_id,
                    "display_name": spec.display_name,
                    "slug": spec.slug,
                    "base_currency": "INR",
                    "timezone": "Asia/Kolkata",
                    "fiscal_year_start_month": 4,
                    "google_hosted_domains": list(spec.hosted_domains),
                    "segregation_enforcement": spec.segregation_enforcement,
                    "status": "active",
                }
            ],
            update=(
                "display_name",
                "google_hosted_domains",
                "segregation_enforcement",
                "status",
            ),
        )

        # -- modules -----------------------------------------------------
        await upsert(
            session,
            t_module,
            [
                {
                    "id": sid("org", spec.slug, "module", module),
                    "organization_id": org_id,
                    "module": module,
                    "enabled": True,
                }
                for module in spec.modules
            ],
            update=("enabled",),
        )
        # A module switched off is a module with no row. The web shell filters
        # its workspace rail on this set, so leaving a disabled row behind would
        # be the difference between "Production is hidden" and "Production is
        # there but empty" for a fleet-only client.
        await session.execute(
            delete(t_module).where(
                t_module.c.organization_id == org_id,
                t_module.c.module.notin_(spec.modules),
            )
        )

        # -- legal entities ----------------------------------------------
        entity_ids = {e.code: sid("org", spec.slug, "entity", e.code) for e in spec.entities}
        await upsert(
            session,
            t_entity,
            [
                {
                    "id": entity_ids[e.code],
                    "organization_id": org_id,
                    "code": e.code,
                    "legal_name": e.legal_name,
                    "trade_name": e.trade_name,
                    "entity_type": e.entity_type,
                    "pan": e.pan,
                    "is_goods_transport_agency": e.is_gta,
                }
                for e in spec.entities
            ],
            update=("legal_name", "trade_name", "entity_type", "pan", "is_goods_transport_agency"),
        )
        report.entities = len(spec.entities)

        # -- GST registrations -------------------------------------------
        gst_ids: dict[tuple[str, str], uuid.UUID] = {}
        gst_rows: list[dict] = []
        for e in spec.entities:
            for reg in e.registrations:
                number = gstin(reg.state_code, e.pan)
                key = (e.code, reg.state_code)
                gst_ids[key] = sid("org", spec.slug, "gst", number)
                report.gstins.append(f"{number} {e.code}/{reg.state_code}")
                gst_rows.append(
                    {
                        "id": gst_ids[key],
                        "organization_id": org_id,
                        "legal_entity_id": entity_ids[e.code],
                        "gstin": number,
                        "state_code": reg.state_code,
                        "legal_name": e.legal_name,
                        "e_invoicing_applicable": reg.e_invoicing,
                    }
                )
        await upsert(
            session, t_gst, gst_rows, update=("legal_name", "state_code", "e_invoicing_applicable")
        )
        report.registrations = len(gst_rows)

        # -- sites --------------------------------------------------------
        site_ids = {s.code: sid("org", spec.slug, "site", s.code) for s in spec.sites}
        await upsert(
            session,
            t_site,
            [
                {
                    "id": site_ids[s.code],
                    "organization_id": org_id,
                    "legal_entity_id": entity_ids[s.entity],
                    "gst_registration_id": gst_ids[(s.entity, s.state_code)],
                    "code": s.code,
                    "name": s.name,
                    "site_type": s.site_type,
                    "state_code": s.state_code,
                    "address": {
                        "line1": s.line1,
                        "city": s.city,
                        "district": s.district,
                        "state_code": s.state_code,
                        "pincode": s.pincode,
                    },
                    "is_active": True,
                }
                for s in spec.sites
            ],
            update=(
                "legal_entity_id",
                "gst_registration_id",
                "name",
                "site_type",
                "state_code",
                "address",
                "is_active",
            ),
        )
        report.sites = len(spec.sites)

        # -- roles --------------------------------------------------------
        role_ids: dict[str, uuid.UUID] = {}
        role_rows: list[dict] = []
        perm_rows: list[dict] = []
        for key, role in ROLES.items():
            if role.requires_module is not None and role.requires_module not in spec.modules:
                report.skipped_roles.append(key)
                continue
            # A surviving role must still not grant a permission belonging to a
            # module this tenant never bought — an accounts clerk at a crusher-
            # only client has no business holding fleet.vehicle.read.
            granted = tuple(
                p
                for p in role.permissions
                if permission_modules[p] == "core" or permission_modules[p] in spec.modules
            )
            if not granted:
                report.skipped_roles.append(key)
                continue
            role_id = sid("org", spec.slug, "role", key)
            role_ids[key] = role_id
            report.roles.append(key)
            role_rows.append(
                {
                    "id": role_id,
                    "organization_id": org_id,
                    "key": key,
                    "label": role.label,
                    "is_system": True,
                }
            )
            perm_rows.extend(
                {
                    "id": sid("org", spec.slug, "role", key, "perm", p),
                    "organization_id": org_id,
                    "role_id": role_id,
                    "permission_key": p,
                }
                for p in granted
            )

        await upsert(session, t_role, role_rows, update=("label", "is_system"))
        # Drop system roles that no longer apply — switching a module off must
        # take its roles with it, or the member screen keeps offering them.
        await session.execute(
            delete(t_role).where(
                t_role.c.organization_id == org_id,
                t_role.c.is_system.is_(True),
                t_role.c.key.notin_(list(role_ids)),
            )
        )
        await upsert(session, t_role_perm, perm_rows, update=("permission_key",))
        await session.execute(
            delete(t_role_perm).where(
                t_role_perm.c.organization_id == org_id,
                t_role_perm.c.id.notin_([r["id"] for r in perm_rows]),
            )
        )

        # -- users, invitations, scoped assignments -----------------------
        user_ids = {u.email: sid("org", spec.slug, "user", u.email) for u in spec.users}
        await upsert(
            session,
            t_user,
            [
                {
                    "id": user_ids[u.email],
                    "organization_id": org_id,
                    "email": u.email.lower(),
                    "full_name": u.full_name,
                    "phone": u.phone,
                    "employee_code": u.employee_code,
                    # Pre-registered, never signed in. No user_identity row is
                    # seeded on purpose: the Google `sub` is pinned at first
                    # real sign-in, and a fabricated sub here would shadow the
                    # genuine one and lock the person out.
                    "status": "invited",
                }
                for u in spec.users
            ],
            update=("email", "full_name", "phone", "employee_code"),
        )

        await upsert(
            session,
            t_invite,
            [
                {
                    "id": sid("org", spec.slug, "invite", u.email),
                    "organization_id": org_id,
                    "email": u.email.lower(),
                    "full_name": u.full_name,
                    "expires_at": now + timedelta(days=90),
                }
                for u in spec.users
            ],
            update=("full_name", "expires_at"),
        )

        assign_rows: list[dict] = []
        for u in spec.users:
            held: list[str] = []
            for role_key, site_codes in u.roles:
                if role_key not in role_ids:
                    # Not a data error: the role does not exist for this tenant
                    # because the vertical is off. Reported, not silently eaten.
                    report.skipped_roles.append(f"{role_key} (unassigned: {u.email})")
                    continue
                targets: list[str | None] = list(site_codes) if site_codes else [None]
                for site_code in targets:
                    assign_rows.append(
                        {
                            "id": sid("org", spec.slug, "assign", u.email, role_key, site_code or "*"),
                            "organization_id": org_id,
                            "user_id": user_ids[u.email],
                            "role_id": role_ids[role_key],
                            "site_id": site_ids[site_code] if site_code else None,
                        }
                    )
                held.append(
                    f"{ROLES[role_key].label} @ {', '.join(site_codes) if site_codes else 'org-wide'}"
                )
            report.signins.append((u.email, u.full_name, "; ".join(held) or "-", u.employee_code))

        await upsert(session, t_assign, assign_rows, update=("site_id",))
        # Reconcile: a scope change writes a new derived id, so the old
        # assignment has to go or the user keeps the wider grant forever.
        await session.execute(
            delete(t_assign).where(
                t_assign.c.user_id.in_(list(user_ids.values())),
                t_assign.c.id.notin_([r["id"] for r in assign_rows]),
            )
        )

    return report


# ---------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------


def validate_specs(permission_modules: dict[str, str]) -> list[str]:
    problems: list[str] = []

    for key, role in ROLES.items():
        for p in role.permissions:
            if p not in permission_modules:
                problems.append(f"role {key!r} grants unknown permission {p!r}")

    seen_emails: dict[str, str] = {}
    for spec in TENANTS:
        site_codes = {s.code for s in spec.sites}
        entity_codes = {e.code for e in spec.entities}
        registered = {(e.code, r.state_code) for e in spec.entities for r in e.registrations}

        for s in spec.sites:
            if s.entity not in entity_codes:
                problems.append(f"{spec.slug}: site {s.code} points at unknown entity {s.entity}")
            elif (s.entity, s.state_code) not in registered:
                problems.append(
                    f"{spec.slug}: site {s.code} is in state {s.state_code} but {s.entity} "
                    f"has no registration there"
                )

        for u in spec.users:
            # Globally unique, because core.resolve_pending_user matches on the
            # verified email across all tenants with LIMIT 1. Two tenants
            # sharing an address would make sign-in resolve to whichever row the
            # planner happened to reach first.
            if u.email in seen_emails:
                problems.append(f"email {u.email} used by both {seen_emails[u.email]} and {spec.slug}")
            seen_emails[u.email] = spec.slug
            for role_key, sites in u.roles:
                if role_key not in ROLES:
                    problems.append(f"{spec.slug}: {u.email} holds unknown role {role_key!r}")
                for code in sites:
                    if code not in site_codes:
                        problems.append(f"{spec.slug}: {u.email} scoped to unknown site {code!r}")

    return problems


async def rls_is_enforced(reports: list[TenantReport]) -> tuple[bool, str]:
    """Prove the seed was actually filtered, rather than assuming it.

    With one tenant's GUC set, the number of visible users must equal that
    tenant's own users. If it equals the total across all three, the connection
    is bypassing RLS — which on a laptop usually means connecting as a superuser
    or as the role that owns the tables.
    """
    first = reports[0]
    expected = len(first.spec.users)
    async with tenant_session(first.org_id) as session:
        visible = await session.scalar(select(func.count()).select_from(t_user))
        role = await session.scalar(select(func.current_user()))
        superuser = await session.scalar(select(func.current_setting("is_superuser", True)))
    if visible == expected:
        return True, f"connected as {role!r}"
    total = sum(len(r.spec.users) for r in reports)
    return False, (
        f"connected as {role!r} (is_superuser={superuser}); saw {visible} users under "
        f"{first.spec.slug}'s tenant context, expected {expected} of {total}"
    )


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


def render_table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(cell))
    rule = "-+-".join("-" * w for w in widths)
    lines = [" | ".join(h.ljust(widths[i]) for i, h in enumerate(headers)), rule]
    lines.extend(" | ".join(c.ljust(widths[i]) for i, c in enumerate(row)) for row in rows)
    return "\n".join(lines)


def print_summary(reports: list[TenantReport], rls_ok: bool, rls_detail: str) -> None:
    print()
    print("Tenants")
    print(
        render_table(
            ["Tenant", "Slug", "Modules", "Entities", "GSTINs", "Sites", "Roles", "Users"],
            [
                [
                    r.spec.display_name,
                    r.spec.slug,
                    ",".join(r.spec.modules),
                    str(r.entities),
                    str(r.registrations),
                    str(r.sites),
                    str(len(r.roles)),
                    str(len(r.spec.users)),
                ]
                for r in reports
            ],
        )
    )

    print()
    print("Registrations and sites")
    rows: list[list[str]] = []
    for r in reports:
        for line in r.gstins:
            number, tag = line.split(" ")
            entity_code, state = tag.split("/")
            sites = ", ".join(
                s.code for s in r.spec.sites if s.entity == entity_code and s.state_code == state
            )
            rows.append([r.spec.display_name, entity_code, state, number, sites])
    print(render_table(["Tenant", "Entity", "State", "GSTIN", "Sites"], rows))

    print()
    print("Roles not created (module off for that tenant)")
    for r in reports:
        missing = ", ".join(r.skipped_roles) if r.skipped_roles else "none — all nine roles exist"
        print(f"  {r.spec.display_name}: {missing}")

    for r in reports:
        print()
        print(f"Sign in as — {r.spec.display_name} ({r.spec.note})")
        domains = ", ".join(r.spec.hosted_domains) or "any Google account (field staff on gmail)"
        print(f"  hosted domains: {domains}")
        print(
            render_table(
                ["Email", "Name", "Code", "Roles and scope"],
                [[email, name, code, held] for email, name, held, code in r.signins],
            )
        )

    print()
    if rls_ok:
        print(f"RLS: enforced during seeding — {rls_detail}")
    else:
        print("RLS: NOT ENFORCED FOR THIS CONNECTION.")
        print(f"  {rls_detail}")
        print("  Every row above was written without a policy check, so this run proved nothing")
        print("  about tenant isolation. Postgres exempts superusers from RLS entirely and exempts")
        print("  table owners unless FORCE is set. Create a plain, non-owning role and point")
        print("  LINCK_DATABASE_URL at it:")
        print("    CREATE ROLE linck_app LOGIN PASSWORD '...';")
        print("    GRANT USAGE ON SCHEMA core TO linck_app;")
        print("    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core TO linck_app;")
        print("    REVOKE UPDATE, DELETE ON core.audit_logs FROM linck_app;")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


async def main() -> int:
    settings = get_settings()
    if settings.environment != "local":
        print(f"refusing to seed: LINCK_ENVIRONMENT is {settings.environment!r}, not 'local'")
        return 2

    async with tenant_session(None) as session:
        permission_modules = {
            key: module for key, module in (await session.execute(select(Permission.key, Permission.module)))
        }

    if not permission_modules:
        print("core.permissions is empty — run alembic upgrade head first")
        return 2

    problems = validate_specs(permission_modules)
    if problems:
        print("seed specification is inconsistent:")
        for p in problems:
            print(f"  - {p}")
        return 2

    reports: list[TenantReport] = []
    for spec in TENANTS:
        reports.append(await seed_tenant(spec, permission_modules))
        print(f"seeded {spec.display_name}")

    rls_ok, rls_detail = await rls_is_enforced(reports)
    print_summary(reports, rls_ok, rls_detail)
    await engine.dispose()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))

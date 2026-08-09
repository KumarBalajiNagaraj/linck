"""GET /me/session — the payload the SPA boots from.

The shell calls this once, then decides from it which workspaces exist (the
tenant's enabled modules), which of them this person may open (grants), and
which site the scope switcher starts on. So everything it needs arrives in one
round trip: five small queries against one transaction, none of them per-row.
"""

import uuid

from fastapi import APIRouter
from sqlalchemy import literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentSessionDep, load_grants
from app.models.core import LegalEntity, Organization, OrganizationModule, RoleAssignment, Site
from app.schemas.session import (
    SessionGrant,
    SessionLegalEntity,
    SessionOrganization,
    SessionResponse,
    SessionSite,
    SessionUser,
)

router = APIRouter(prefix="/me", tags=["session"])


async def _scoped_sites(db: AsyncSession, organization_id: uuid.UUID, user_id: uuid.UUID) -> list[Site]:
    """Only the sites this person is scoped to.

    An assignment with `site_id IS NULL` is organization-wide, so it scopes the
    holder to every active site; otherwise the sites named by their assignments
    are the whole of it. Inactive sites are excluded either way — a closed
    stockyard should not keep appearing in the scope switcher.
    """
    org_wide = (
        select(literal(1))
        .where(RoleAssignment.user_id == user_id, RoleAssignment.site_id.is_(None))
        .exists()
    )
    assigned = select(RoleAssignment.site_id).where(
        RoleAssignment.user_id == user_id, RoleAssignment.site_id.is_not(None)
    )
    stmt = (
        select(Site)
        .where(
            # RLS already confines this to the tenant. The predicate is
            # repeated anyway because this endpoint is what every other screen
            # trusts: if the policy ever failed open, a belt-and-braces filter
            # here is the difference between a bug and a cross-tenant leak.
            Site.organization_id == organization_id,
            Site.is_active.is_(True),
            or_(org_wide, Site.id.in_(assigned)),
        )
        .order_by(Site.code)
    )
    return list((await db.scalars(stmt)).all())


@router.get("/session", response_model=SessionResponse)
async def read_session(current: CurrentSessionDep) -> SessionResponse:
    db = current.db
    user = current.user

    organization = (
        await db.scalars(select(Organization).where(Organization.id == current.organization_id))
    ).one()

    modules = list(
        (
            await db.scalars(
                select(OrganizationModule.module)
                .where(
                    OrganizationModule.organization_id == current.organization_id,
                    OrganizationModule.enabled.is_(True),
                )
                .order_by(OrganizationModule.module)
            )
        ).all()
    )

    legal_entities = list(
        (
            await db.scalars(
                select(LegalEntity)
                .where(LegalEntity.organization_id == current.organization_id)
                .order_by(LegalEntity.code)
            )
        ).all()
    )
    sites = await _scoped_sites(db, current.organization_id, user.id)
    grants = await load_grants(db, user.id)

    # Org-wide holders land on "All sites"; a site-scoped person lands on their
    # first site, because "All sites" for them would be a view of one site
    # pretending to be a summary.
    has_org_wide = any(grant.org_wide for grant in grants.values())
    active_site_scope = None if has_org_wide else (sites[0].id if sites else None)

    return SessionResponse(
        user=SessionUser.model_validate(user),
        organization=SessionOrganization.model_validate(organization),
        modules=modules,
        legal_entities=[SessionLegalEntity.model_validate(entity) for entity in legal_entities],
        sites=[SessionSite.model_validate(site) for site in sites],
        active_site_scope=active_site_scope,
        grants={
            key: SessionGrant(org_wide=grant.org_wide, site_ids=grant.site_ids)
            for key, grant in grants.items()
        },
    )

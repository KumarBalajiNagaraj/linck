"""Response models for GET /me/session.

The web app's `apps/web/src/auth/session.ts` (`SessionPayload`) is the other
half of this file, and the two are kept field for field: the field names here
are a contract, not a preference. Python stays snake_case and pydantic emits
camelCase through the alias generator — FastAPI serialises by alias, so the SPA
reads the same shape its mock personas (`apps/web/src/auth/personas.ts`) have.
"""

import uuid

from pydantic import BaseModel, ConfigDict
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class SessionUser(CamelModel):
    id: uuid.UUID
    email: str
    full_name: str
    phone: str | None = None
    employee_code: str | None = None
    avatar_url: str | None = None
    # Overrides the persona-home resolver when the person has pinned a landing
    # screen. Null means the shell resolves the landing route from grants.
    default_route: str | None = None


class SessionOrganization(CamelModel):
    id: uuid.UUID
    display_name: str
    slug: str
    base_currency: str
    timezone: str
    fiscal_year_start_month: int
    # `review_queue` (the default: a second signature is allowed, with a reason,
    # and goes to review) or `hard_block` (refused). app/api/access.py reads it;
    # any other value behaves as `review_queue`.
    segregation_enforcement: str


class SessionGstRegistration(CamelModel):
    """One GSTIN: one per state the legal entity has a place of business in."""

    id: uuid.UUID
    gstin: str
    state_code: str
    e_invoicing_applicable: bool


class SessionLegalEntity(CamelModel):
    """One set of books. A tenant may hold several — the tippers in a
    proprietorship and the crusher in a partnership is the common shape — and
    the invoicing code decides inter-company GTA treatment by comparing these
    ids, so the SPA needs the full list even when there is only one."""

    id: uuid.UUID
    code: str
    legal_name: str
    trade_name: str | None = None
    entity_type: str
    pan: str | None = None
    is_goods_transport_agency: bool
    gst_registrations: list[SessionGstRegistration] = []


class SessionSite(CamelModel):
    id: uuid.UUID
    code: str
    name: str
    site_type: str
    state_code: str
    legal_entity_id: uuid.UUID


class SessionRole(CamelModel):
    """A role the person holds, at any scope: what the top bar prints under
    their name. Several is normal; a plant head is production, stores and fleet."""

    key: str
    label: str


class SessionGrant(CamelModel):
    """Mirrors `Grant` in packages/domain/src/permissions.ts.

    `siteIds` is empty when `orgWide` is true — the client's `sitesFor()`
    substitutes the full site list in that case, so sending the sites twice
    would only invite the two to disagree.
    """

    org_wide: bool
    site_ids: list[uuid.UUID]


class SessionResponse(CamelModel):
    user: SessionUser
    organization: SessionOrganization
    # Which verticals this tenant switched on. A fleet-only tenant must never
    # see Production in the navigation, and that is decided here rather than by
    # a build flag.
    modules: list[str]
    legal_entities: list[SessionLegalEntity]
    # Only the sites this person is scoped to. An org-wide assignment scopes
    # them to every active site.
    sites: list[SessionSite]
    active_site_scope: uuid.UUID | None
    roles: list[SessionRole]
    grants: dict[str, SessionGrant]

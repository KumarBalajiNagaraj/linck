"""Response models for GET /me/session.

The web app already consumes this shape from its mock persona fixtures
(`apps/web/src/auth/personas.ts`), so the field names here are a contract, not
a preference. Python stays snake_case and pydantic emits camelCase through the
alias generator — FastAPI serialises by alias, so the SPA sees exactly what it
sees today from the mocks, plus `modules` and `legalEntities`.
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
    avatar_url: str | None = None
    # Overrides the persona-home resolver when the person has pinned a landing
    # screen. Null means the shell resolves the landing route from grants.
    default_route: str | None = None


class SessionOrganization(CamelModel):
    id: uuid.UUID
    display_name: str
    slug: str
    timezone: str
    fiscal_year_start_month: int


class SessionLegalEntity(CamelModel):
    """One set of books. A tenant may hold several — the tippers in a
    proprietorship and the crusher in a partnership is the common shape — and
    the invoicing code decides inter-company GTA treatment by comparing these
    ids, so the SPA needs the full list even when there is only one."""

    id: uuid.UUID
    code: str
    legal_name: str
    entity_type: str
    is_goods_transport_agency: bool


class SessionSite(CamelModel):
    id: uuid.UUID
    code: str
    name: str
    site_type: str
    state_code: str
    legal_entity_id: uuid.UUID


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
    grants: dict[str, SessionGrant]

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, INET, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, org_fk, pk, updated_at

SCHEMA = "core"

# ---------------------------------------------------------------------------
# Tenancy
# ---------------------------------------------------------------------------


class Organization(Base):
    """The tenant root — the only table without an organization_id, because its
    own id IS the tenant key.

    A tenant is a CUSTOMER of Linck, not a legal entity. Linck sells to crusher
    operators, to transport fleets, and to businesses running both, so what a
    tenant contains varies: see OrganizationModule for which parts of the
    product are switched on, and LegalEntity for how many books they keep.
    """

    __tablename__ = "organizations"
    __table_args__ = ({"schema": SCHEMA},)

    id: Mapped[uuid.UUID] = pk()
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    slug: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    base_currency: Mapped[str] = mapped_column(String(3), nullable=False, server_default=text("'INR'"))
    timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'Asia/Kolkata'"))
    fiscal_year_start_month: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("4"))

    # Google Workspace domains allowed to sign in to this tenant. A match here
    # is necessary but never sufficient — the account must still map to a
    # pre-registered user row.
    google_hosted_domains: Mapped[list[str]] = mapped_column(
        ARRAY(Text), nullable=False, server_default=text("'{}'")
    )

    # Policy switches the adversarial review showed must be per-tenant
    # configuration rather than hard-coded constraints: a three-person accounts
    # office cannot run hard segregation-of-duties blocking without ending up
    # sharing one login.
    segregation_enforcement: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text("'review_queue'")
    )
    settings: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))

    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class OrganizationModule(Base):
    """Which verticals this tenant has switched on.

    Linck caters to crusher operators and transport fleets individually or
    together, depending on the client. That is a per-tenant fact, so it is a
    row rather than a build flag: a fleet-only tenant never sees Production in
    the navigation, and a crusher-only tenant never sees the tipper board.

    The API returns the enabled set on /me/session and the web shell filters
    its workspace rail on it, so switching a module on is a data change with no
    deploy.
    """

    __tablename__ = "organization_modules"
    __table_args__ = (
        UniqueConstraint("organization_id", "module", name="uq_organization_modules_organization_id_module"),
        CheckConstraint(
            "module in ('fleet','production','sales','stores','finance','compliance','ai')",
            name="module_known",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    module: Mapped[str] = mapped_column(Text, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = created_at()


class LegalEntity(Base):
    """A set of books with its own GSTIN and PAN. One tenant may hold several.

    In this trade the tippers are commonly held in a proprietorship and the
    crusher in a partnership or a private limited company, but plenty of
    clients run everything through one entity. Both shapes have to work, so the
    entity count is data.

    The consequence that makes this load-bearing: when a trip moves material
    belonging to entity A on a vehicle belonging to entity B, the transport leg
    is an inter-company GTA supply with its own invoice, its own reverse-charge
    treatment and SAC 9965 — not a freight line on the customer's invoice. The
    invoicing code decides which case it is by comparing these ids, so the
    single-entity client simply never trips the branch.
    """

    __tablename__ = "legal_entities"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_legal_entities_organization_id_id"),
        UniqueConstraint("organization_id", "code", name="uq_legal_entities_organization_id_code"),
        CheckConstraint(
            "entity_type in ('proprietorship','partnership','llp','private_limited',"
            "'public_limited','huf','trust')",
            name="entity_type_known",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    code: Mapped[str] = mapped_column(Text, nullable=False)
    legal_name: Mapped[str] = mapped_column(Text, nullable=False)
    trade_name: Mapped[str | None] = mapped_column(Text)
    entity_type: Mapped[str] = mapped_column(Text, nullable=False)
    pan: Mapped[str | None] = mapped_column(String(10))

    # A GTA (goods transport agency) is exempt from e-invoicing entity-wide, so
    # this flag changes invoicing behaviour for everything the entity issues.
    is_goods_transport_agency: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class GstRegistration(Base):
    """One row per GSTIN. A legal entity registers separately in every state it
    has a place of business in, and the statutory invoice series is unique per
    GSTIN per financial year — not per organization."""

    __tablename__ = "gst_registrations"
    __table_args__ = (
        UniqueConstraint("organization_id", "gstin", name="uq_gst_registrations_organization_id_gstin"),
        CheckConstraint("char_length(gstin) = 15", name="gstin_length"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    legal_entity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.legal_entities.id"), nullable=False
    )
    gstin: Mapped[str] = mapped_column(String(15), nullable=False)
    state_code: Mapped[str] = mapped_column(String(2), nullable=False)
    legal_name: Mapped[str] = mapped_column(Text, nullable=False)

    # Crossing ₹5 crore aggregate turnover in ANY year from 2017-18 onward makes
    # e-invoicing mandatory permanently, and it is tested at PAN level across
    # every GSTIN under the same PAN — hence stored here and evaluated per PAN.
    e_invoicing_applicable: Mapped[bool] = mapped_column(
        Boolean, nullable=False, server_default=text("false")
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class Site(Base):
    """Our physical locations only. Customer ship-to addresses are NOT rows here.

    This is the primary RBAC scope — the thing a team admin assigns a member to
    — and the GST place-of-business anchor.
    """

    __tablename__ = "sites"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_sites_organization_id_id"),
        UniqueConstraint("organization_id", "code", name="uq_sites_organization_id_code"),
        CheckConstraint(
            "site_type in ('head_office','quarry','crusher_plant','stockyard','depot',"
            "'workshop','weighbridge_point','fuel_point')",
            name="site_type_known",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    legal_entity_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.legal_entities.id"), nullable=False
    )
    gst_registration_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.gst_registrations.id")
    )
    code: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    site_type: Mapped[str] = mapped_column(Text, nullable=False)
    state_code: Mapped[str] = mapped_column(String(2), nullable=False)
    address: Mapped[dict] = mapped_column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


# ---------------------------------------------------------------------------
# Identity
# ---------------------------------------------------------------------------


class User(Base):
    """A person, pre-registered by an admin before they can ever sign in.

    Sign-in does not create users. An admin registers the person first, and
    Google is only ever used to prove that the human at the keyboard is that
    person. That ordering is deliberate: it means a Google account alone can
    never bootstrap access to a tenant.
    """

    __tablename__ = "users"
    __table_args__ = (
        UniqueConstraint("organization_id", "id", name="uq_users_organization_id_id"),
        UniqueConstraint("organization_id", "email", name="uq_users_organization_id_email"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()

    # The match key at sign-in. Lower-cased on write; Google's verified email is
    # compared against it. Display name is NOT a match key — two drivers named
    # Murugan S is a Tuesday, and matching on it would hand one person the
    # other's grants.
    email: Mapped[str] = mapped_column(Text, nullable=False)
    full_name: Mapped[str] = mapped_column(Text, nullable=False)
    phone: Mapped[str | None] = mapped_column(String(15))
    employee_code: Mapped[str | None] = mapped_column(Text)
    avatar_url: Mapped[str | None] = mapped_column(Text)

    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'invited'"))
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # Overrides the persona-home resolver when the user pins a landing screen.
    default_route: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class UserIdentity(Base):
    """A federated identity bound to a user.

    ``subject`` is Google's ``sub`` claim — stable for the lifetime of the
    account, and the only Google field that is. Email can be changed by a
    Workspace admin and display name can be changed by the user, so both are
    stored for display and audit but neither is trusted as the identity after
    first link.

    The flow: match the verified email to a pre-registered user, then pin the
    ``sub`` on first successful sign-in. Every later sign-in matches on the
    ``sub`` and treats a changed email as a profile update rather than a new
    identity.
    """

    __tablename__ = "user_identities"
    __table_args__ = (
        UniqueConstraint("provider", "subject", name="uq_user_identities_provider_subject"),
        Index("ix_user_identities_user_id", "user_id"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"), nullable=False
    )
    provider: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'google'"))
    subject: Mapped[str] = mapped_column(Text, nullable=False)
    email: Mapped[str] = mapped_column(Text, nullable=False)
    email_verified: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    hosted_domain: Mapped[str | None] = mapped_column(Text)
    linked_at: Mapped[datetime] = created_at()
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Session(Base):
    """A server-side session. The SPA never holds a token — it holds an httpOnly
    cookie carrying this row's opaque id, and the refresh token rotates.

    Rotation is what makes theft detectable: a refresh token presented twice
    means either a replay or a stolen cookie, and both revoke the whole family.
    """

    __tablename__ = "sessions"
    __table_args__ = (
        Index("ix_sessions_user_id", "user_id"),
        Index("ix_sessions_expires_at", "expires_at"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"), nullable=False
    )
    refresh_token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    # Every rotation writes a new row pointing at the one it replaced, so a
    # replayed token identifies the whole chain to revoke.
    replaces_session_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_reason: Mapped[str | None] = mapped_column(Text)
    user_agent: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(INET)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = created_at()


# ---------------------------------------------------------------------------
# Scoped RBAC
# ---------------------------------------------------------------------------


class Permission(Base):
    """Seeded reference data, migration-managed. `resource.action` keys."""

    __tablename__ = "permissions"
    __table_args__ = ({"schema": SCHEMA},)

    key: Mapped[str] = mapped_column(Text, primary_key=True)
    module: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = (
        UniqueConstraint("organization_id", "key", name="uq_roles_organization_id_key"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    key: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    # Seeded roles cannot be deleted, only extended — otherwise a tenant admin
    # can lock every user out of their own tenant.
    is_system: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    created_at: Mapped[datetime] = created_at()


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (
        UniqueConstraint("role_id", "permission_key", name="uq_role_permissions_role_id_permission_key"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.roles.id", ondelete="CASCADE"), nullable=False
    )
    permission_key: Mapped[str] = mapped_column(
        Text, ForeignKey(f"{SCHEMA}.permissions.key"), nullable=False
    )


class RoleAssignment(Base):
    """A role held by a user, SCOPED.

    Every team has its own admins who assign members to a site, plant or
    location — so a role is never a flat boolean. ``site_id IS NULL`` means the
    assignment is organization-wide; otherwise it applies only at that site.
    An executive holds org-wide roles; a stores clerk holds one site.
    """

    __tablename__ = "role_assignments"
    __table_args__ = (
        Index("ix_role_assignments_user_id", "user_id"),
        # A user may hold the same role at several sites, but not twice at one.
        # coalesce() gives NULL (org-wide) a comparable value, since NULL is
        # never equal to NULL in a unique index.
        Index(
            "uq_role_assignments_scope",
            "user_id",
            "role_id",
            text("coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid)"),
            unique=True,
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.users.id", ondelete="CASCADE"), nullable=False
    )
    role_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.roles.id", ondelete="CASCADE"), nullable=False
    )
    site_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey(f"{SCHEMA}.sites.id", ondelete="CASCADE")
    )
    granted_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()


class Invitation(Base):
    """Pre-registration. An admin creates this; the person's first Google
    sign-in with the matching verified email consumes it."""

    __tablename__ = "invitations"
    __table_args__ = (
        UniqueConstraint("organization_id", "email", name="uq_invitations_organization_id_email"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    email: Mapped[str] = mapped_column(Text, nullable=False)
    full_name: Mapped[str] = mapped_column(Text, nullable=False)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    created_at: Mapped[datetime] = created_at()


class AuditLog(Base):
    """Append-only. Written by a generic row trigger on every auditable table,
    NOT by application code — so a background job, a data-fix script and a
    stray psql session are all captured the same way.

    INSERT-only at the grant level; partitions are archived, never mutated.
    """

    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_entity", "entity_table", "entity_id"),
        Index("ix_audit_logs_at", "at"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk(nullable=True)
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    action: Mapped[str] = mapped_column(Text, nullable=False)
    entity_table: Mapped[str] = mapped_column(Text, nullable=False)
    entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    before: Mapped[dict | None] = mapped_column(JSONB)
    after: Mapped[dict | None] = mapped_column(JSONB)
    request_id: Mapped[str | None] = mapped_column(Text)
    ip: Mapped[str | None] = mapped_column(INET)
    at: Mapped[datetime] = created_at()


# ---------------------------------------------------------------------------
# WhatsApp intake (LIN-13)
# ---------------------------------------------------------------------------


class WhatsAppMessage(Base):
    """A message a driver sent to the fleet's WhatsApp Business number.

    Mostly a slip photo with no words: drivers who cannot read send the
    photo, and the import reads the slip. Kept until the fleet manager imports
    it; `imported_at` then says it has been taken into the expense ledger.
    """

    __tablename__ = "whatsapp_messages"
    __table_args__ = (
        UniqueConstraint("organization_id", "wamid"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    wamid: Mapped[str] = mapped_column(Text, nullable=False)
    phone_number_id: Mapped[str] = mapped_column(Text, nullable=False)
    from_phone: Mapped[str] = mapped_column(Text, nullable=False)
    sender_name: Mapped[str | None] = mapped_column(Text)
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    caption: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    media_id: Mapped[str | None] = mapped_column(Text)
    media_mime: Mapped[str | None] = mapped_column(Text)
    media_filename: Mapped[str | None] = mapped_column(Text)
    media_sha256: Mapped[str | None] = mapped_column(Text)
    media_bytes: Mapped[int | None] = mapped_column(Integer)
    media_error: Mapped[str | None] = mapped_column(Text)
    received_at: Mapped[datetime] = created_at()
    imported_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    imported_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), ForeignKey("core.users.id"))

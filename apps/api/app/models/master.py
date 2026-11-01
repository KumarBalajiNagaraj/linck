"""Reference data three or more modules would otherwise each invent.

The party master, with the columns the customer screens use plus the ones
docs/schema-core-tables.md makes load-bearing (roles, GSTIN, credit control);
vendors are parties too, with the `vendor` role (LIN-22). PAN, MSME,
withholding and the merge tooling arrive with payables.

The item master holds what nothing else does: a material's HSN code, its GST
rate and the unit it is traded in, so no screen or rule hard-codes either.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import Boolean, CheckConstraint, Index, Integer, Numeric, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import ARRAY, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, org_fk, pk, tenant_fk, updated_at

SCHEMA = "master"

PARTY_ROLES = (
    "customer",
    "vendor",
    "transporter",
    "lender",
    "statutory_authority",
    "broker",
    "employee_payee",
)

# Shape only; the check character is verified in the API (app/api/customers.py),
# where a failure can say which character is wrong.
GSTIN_SHAPE = "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"


class Party(Base):
    """One master for everyone the business deals with.

    Customers, vendors, transporters and lenders are one table with a role
    array, because the crusher-spares dealer is routinely also a material
    customer, and two masters for one firm is how ageing goes wrong. The
    customer database is the rows whose roles include `customer`.
    """

    __tablename__ = "parties"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        Index(
            "uq_parties_organization_id_gstin",
            "organization_id",
            "gstin",
            unique=True,
            postgresql_where=text("gstin IS NOT NULL"),
        ),
        tenant_fk("served_from_site_id", "core.sites"),
        CheckConstraint(
            "cardinality(party_roles) > 0 AND party_roles <@ ARRAY["
            + ", ".join(f"'{r}'" for r in PARTY_ROLES)
            + "]::text[]",
            name="party_roles_known",
        ),
        CheckConstraint(f"gstin IS NULL OR gstin ~ '{GSTIN_SHAPE}'", name="gstin_shape"),
        CheckConstraint("credit_limit >= 0", name="credit_limit_not_negative"),
        CheckConstraint(
            "credit_enforcement in ('warn','block','block_with_override')", name="credit_enforcement_known"
        ),
        CheckConstraint("payment_terms_days >= 0", name="payment_terms_not_negative"),
        CheckConstraint("status in ('active','inactive')", name="status_known"),
        # A customer is served from one of our sites; a firm that only sells
        # to us (a quarry, a crusher) is not served from anywhere.
        CheckConstraint(
            "NOT ('customer' = ANY (party_roles)) OR served_from_site_id IS NOT NULL",
            name="customer_has_site",
        ),
        CheckConstraint("char_length(address) <= 300", name="address_length"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    legal_name: Mapped[str] = mapped_column(Text, nullable=False)
    party_roles: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    # Null for a walk-in counter buyer, who is billed B2C.
    gstin: Mapped[str | None] = mapped_column(String(15))
    contact_name: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    phone: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    # The delivery site the coordinator names on the phone. A name, not an
    # address: ship-to addresses become sales.customer_sites when invoicing
    # needs them, and are never rows in core.sites.
    default_delivery_site: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    # The plant that usually serves them. A fact about the customer, not a
    # filter: the customer master is read org-wide. Null for a vendor that is
    # not also a customer.
    served_from_site_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # The billing address an invoice prints under the buyer's name (LIN-27), as written.
    address: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    credit_limit: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default=text("0"))
    # Warn by default (docs/DATABASE.md): a hard block at order time ends with
    # every limit set to 999999999 within a fortnight.
    credit_enforcement: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'warn'"))
    payment_terms_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


#: HSN codes are 4 to 8 digits; a unit is what the trade writes on the bill
#: (unit, tonne, cft, load...), typed once into the material master.
HSN_SHAPE = "^[0-9]{4,8}$"
UNIT_SHAPE = "char_length(unit) BETWEEN 1 AND 20"
#: A GST state code: two digits, 33 for Tamil Nadu.
STATE_CODE_SHAPE = "^[0-9]{2}$"


class Item(Base):
    """A material bought and sold: the workbook's Material DB (name, HSN, unit, default GST%).

    The design's one item master (docs/schema-core-tables.md), with only what
    the vehicle P&L reads so far. `code` is the product code the screens and
    customer orders already use (MSAND, AGG20), when there is one, so those
    can point here once they are migrated. A trip line keeps the HSN, unit and
    GST rate it was billed at, so changing them here never rewrites an old bill.
    """

    __tablename__ = "items"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "code"),
        CheckConstraint("code IS NULL OR code ~ '^[A-Z0-9_-]{1,32}$'", name="code_shape"),
        CheckConstraint("char_length(name) BETWEEN 1 AND 120", name="name_length"),
        CheckConstraint(f"hsn_code IS NULL OR hsn_code ~ '{HSN_SHAPE}'", name="hsn_shape"),
        CheckConstraint("gst_rate_pct >= 0 AND gst_rate_pct <= 100", name="gst_rate_range"),
        CheckConstraint(UNIT_SHAPE, name="unit_shape"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    code: Mapped[str | None] = mapped_column(Text)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    hsn_code: Mapped[str | None] = mapped_column(Text)
    #: The GST% a new line of this material starts at; the line may say otherwise.
    gst_rate_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False, server_default=text("0"))
    unit: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'unit'"))
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class PartyLocation(Base):
    """Where a vendor sells from (a quarry, a crusher yard) or a customer takes delivery (LIN-22).

    The workbook's purchase and delivery locations: picked from here on a
    trip line, or typed there and added here, by name. A customer's delivery
    location may also carry its address and its state (LIN-27): the state is
    the place of supply of an invoice for goods delivered there, and so
    decides between CGST + SGST and IGST.
    """

    __tablename__ = "party_locations"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "party_id", "name"),
        tenant_fk("party_id", "master.parties"),
        CheckConstraint("char_length(name) BETWEEN 1 AND 120", name="name_length"),
        CheckConstraint("char_length(address) <= 300", name="address_length"),
        CheckConstraint(f"state_code IS NULL OR state_code ~ '{STATE_CODE_SHAPE}'", name="state_code_shape"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    party_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    address: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: The two-digit GST state code; null until someone says.
    state_code: Mapped[str | None] = mapped_column(String(2))
    created_at: Mapped[datetime] = created_at()


class GstRate(Base):
    """A GST% a trip line may be billed at: the tenant's own list, never written in the code (LIN-22).

    Switched off rather than deleted, so a line billed at it still reads.
    """

    __tablename__ = "gst_rates"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "rate_pct"),
        CheckConstraint("rate_pct >= 0 AND rate_pct <= 100", name="rate_range"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    rate_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("true"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()

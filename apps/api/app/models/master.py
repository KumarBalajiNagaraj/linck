"""Reference data three or more modules would otherwise each invent.

Only the party master exists so far, and only the columns the customer screens
use plus the ones docs/schema-core-tables.md makes load-bearing (roles, GSTIN,
credit control). PAN, MSME, withholding and the merge tooling arrive with the
vendor side.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, Index, Integer, Numeric, String, Text, UniqueConstraint, text
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
    # filter: the customer master is read org-wide.
    served_from_site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    credit_limit: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default=text("0"))
    # Warn by default (docs/DATABASE.md): a hard block at order time ends with
    # every limit set to 999999999 within a fortnight.
    credit_enforcement: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'warn'"))
    payment_terms_days: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'active'"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()

"""Order to cash on the customer side: customer purchase orders, and what each trip sold (LIN-22)."""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    Index,
    Integer,
    Numeric,
    SmallInteger,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, org_fk, pk, tenant_fk, updated_at
from app.models.master import GSTIN_SHAPE, HSN_SHAPE, UNIT_SHAPE

SCHEMA = "sales"

PO_STATUSES = ("pending_approval", "approved", "part_dispatched", "fulfilled", "rejected")


class PurchaseOrder(Base):
    """The order a builder raises against us.

    Nothing loads against it until it is approved: rate and credit are checked
    once, at approval, so the loader is never where a price gets argued. The
    decision lives on the row (who, when, why) and the audit trigger keeps
    every change to it.
    """

    __tablename__ = "purchase_orders"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "number"),
        UniqueConstraint("organization_id", "financial_year", "serial"),
        tenant_fk("customer_party_id", "master.parties"),
        tenant_fk("site_id", "core.sites"),
        tenant_fk("taken_by", "core.users"),
        tenant_fk("decided_by", "core.users"),
        Index("ix_purchase_orders_status", "organization_id", "status"),
        CheckConstraint("status in (" + ", ".join(f"'{s}'" for s in PO_STATUSES) + ")", name="status_known"),
        CheckConstraint("serial > 0", name="serial_positive"),
        CheckConstraint("ordered_units > 0", name="ordered_units_positive"),
        CheckConstraint(
            "dispatched_units >= 0 AND dispatched_units <= ordered_units", name="dispatched_within_order"
        ),
        CheckConstraint("rate_per_unit > 0", name="rate_positive"),
        CheckConstraint("value = round(ordered_units * rate_per_unit, 2)", name="value_is_units_times_rate"),
        # Every status but the first is the consequence of a decision, so a
        # decision is on record exactly when the order has left the queue.
        CheckConstraint(
            "(status = 'pending_approval') = (decided_at IS NULL) "
            "AND (decided_at IS NULL) = (decided_by IS NULL)",
            name="decision_recorded",
        ),
        CheckConstraint("status <> 'rejected' OR decision_reason IS NOT NULL", name="rejection_has_reason"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    # SO/26-27/001: an internal series per financial year, not a statutory one.
    financial_year: Mapped[str] = mapped_column(Text, nullable=False)
    serial: Mapped[int] = mapped_column(Integer, nullable=False)
    number: Mapped[str] = mapped_column(Text, nullable=False)
    customer_po_ref: Mapped[str] = mapped_column(Text, nullable=False)
    customer_party_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    delivery_site: Mapped[str] = mapped_column(Text, nullable=False)
    # master.items is not migrated yet; the code is the product code the
    # screens use (MSAND, AGG20, ...).
    product_code: Mapped[str] = mapped_column(Text, nullable=False)
    ordered_units: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    dispatched_units: Mapped[Decimal] = mapped_column(
        Numeric(12, 3), nullable=False, server_default=text("0")
    )
    rate_per_unit: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    value: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    received_on: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    deliver_by: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'pending_approval'"))
    taken_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    taken_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    decided_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class TripSale(Base):
    """Material a trip delivered and sold (the workbook's AJ to AY): to whom, where, at what price.

    Transport (AR) is charged inside the taxable selling price, at the sale's
    own GST rate. The DC and invoice are references to papers raised
    elsewhere (party invoices are a ticket of their own, and will point at
    these lines); the selling price, GST and total are never stored but
    worked out by app/domain/vehicle_pl.py each time.
    """

    __tablename__ = "trip_sales"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        tenant_fk("trip_id", "logistics.trips"),
        tenant_fk("customer_party_id", "master.parties"),
        tenant_fk("purchase_order_id", "sales.purchase_orders"),
        tenant_fk("item_id", "master.items"),
        tenant_fk("po_file_id", "core.files"),
        tenant_fk("dc_file_id", "core.files"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("rate > 0", name="rate_positive"),
        CheckConstraint("gst_rate_pct >= 0 AND gst_rate_pct <= 100", name="gst_rate_range"),
        CheckConstraint("transport_amount >= 0", name="transport_not_negative"),
        CheckConstraint(f"hsn_code IS NULL OR hsn_code ~ '{HSN_SHAPE}'", name="hsn_shape"),
        CheckConstraint(UNIT_SHAPE, name="unit_shape"),
        CheckConstraint(f"party_gstin IS NULL OR party_gstin ~ '{GSTIN_SHAPE}'", name="party_gstin_shape"),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    customer_party_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: AL, one of the customer's locations (master.party_locations), as written.
    location: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: The order in Linck it was sold against, when there is one.
    purchase_order_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    #: AK, the customer's own PO reference. One PO may cover several trips.
    po_ref: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    hsn_code: Mapped[str | None] = mapped_column(Text)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    transport_amount: Mapped[Decimal] = mapped_column(
        Numeric(18, 2), nullable=False, server_default=text("0")
    )
    #: AS and AU.
    gst_billed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    gst_rate_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    #: AT, the customer's GSTIN as billed; a customer who has none is billed B2C.
    party_gstin: Mapped[str | None] = mapped_column(String(15))
    #: AY.
    challan_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    invoice_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: Photos of the customer's PO and of the DC they signed.
    po_file_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    dc_file_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class TripClosure(Base):
    """Accounts confirmed by hand that a customer paid a trip in full (the workbook's BC).

    Paid in full shows as paid until accounts close it. The closure keeps what
    the trip billed the customer then; if a line changes after, the trip is
    no longer closed (app/domain/vehicle_pl.py compares the two).
    """

    __tablename__ = "trip_closures"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "trip_id", "customer_party_id"),
        tenant_fk("trip_id", "logistics.trips"),
        tenant_fk("customer_party_id", "master.parties"),
        tenant_fk("closed_by", "core.users"),
        CheckConstraint("billed > 0", name="billed_positive"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    customer_party_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    billed: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    closed_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    closed_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    closed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=text("now()")
    )

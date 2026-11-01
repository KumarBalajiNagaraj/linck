"""Order to cash on the customer side: customer purchase orders, what each trip sold (LIN-22),
and the tax invoices made from those trips (LIN-27).

    invoice_series   one GSTIN's numbers in one financial year: the last one taken
    invoices         a draft, then issued with a number, perhaps cancelled; never deleted once issued
        └── invoice_lines   the trip sale lines it bills, as billed
            (finance.invoice_receipts: the trip payments matched to it)
"""

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKeyConstraint,
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

from app.domain.party_invoice import (
    INVOICE_NUMBER_SHAPE,
    INVOICE_RULES_VERSION,
    INVOICE_STATUSES,
    POS_BASES,
    SUPPLY_TYPES,
)
from app.models.base import Base, created_at, org_fk, pk, tenant_fk, updated_at
from app.models.master import GSTIN_SHAPE, HSN_SHAPE, STATE_CODE_SHAPE, UNIT_SHAPE

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


# --------------------------------------------------------------------------
# Tax invoices (LIN-27)
# --------------------------------------------------------------------------


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} in (" + ", ".join(f"'{v}'" for v in values) + ")"


#: The invoice columns that are null exactly while it is a draft: its number and what took it.
_NUMBERED = (
    "series_id",
    "financial_year",
    "serial",
    "invoice_date",
    "issued_at",
    "issued_by",
    "issued_by_name",
)


class InvoiceSeries(Base):
    """One GSTIN's invoice numbers in one financial year: the last serial taken.

    GST numbers invoices consecutively per GSTIN per financial year (Rule
    46(b)), not per company. A number is taken by adding one here inside the
    transaction that issues the invoice (app/api/access.py next_invoice_serial),
    so two people issuing at once wait on this row in turn, and an issue that
    fails gives its number back with everything else: no gap, no duplicate.
    The count only goes up, and a series is never deleted (the guard trigger
    in migration 0031), so a number is never taken twice.
    """

    __tablename__ = "invoice_series"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "gst_registration_id", "financial_year"),
        tenant_fk("gst_registration_id", "core.gst_registrations"),
        CheckConstraint("financial_year ~ '^[0-9]{2}(-[0-9]{2})?$'", name="financial_year_shape"),
        CheckConstraint("last_serial >= 0", name="last_serial_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    gst_registration_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: '26-27', as TenantCalendar.financial_year names April 2026 to March 2027.
    financial_year: Mapped[str] = mapped_column(Text, nullable=False)
    last_serial: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class Invoice(Base):
    """A GST tax invoice to one customer for the sale lines of one trip or several.

    A draft has no number. Issuing takes the next number of the seller GSTIN's
    series for the financial year of the day it is issued, and from then on
    nothing that is printed changes: not a line, not an amount, not a name
    (the guard trigger in migration 0031 refuses it). An issued invoice is
    never deleted, as GST requires; it may be cancelled, which keeps it on
    record with its number, and frees its trips to be invoiced again. A draft
    that was never issued may be deleted.

    The seller, buyer and delivery details are copied in as billed, so a GSTIN
    or an address corrected in a master later never rewrites an invoice. The
    seller is the GST registration of the site the trips' sheets are at; the
    place of supply decides the tax: CGST + SGST in the seller's own state,
    IGST otherwise (app/domain/party_invoice.py, which works out every figure
    stored here). The site is the invoice's scope, as a sheet's site is.

    e-invoicing (an IRN from the IRP, its QR code) and e-way bills are not
    built (LIN-27 leaves them out). The IRN and its acknowledgement have
    nullable columns waiting for them, so wiring the IRP in later adds no
    migration to a table full of issued invoices.
    """

    __tablename__ = "invoices"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        # What a line's and a receipt's status-carrying key points at.
        UniqueConstraint("organization_id", "id", "status"),
        # Unique per GSTIN, as GST has it; the number carries its year.
        UniqueConstraint("organization_id", "gst_registration_id", "invoice_number"),
        UniqueConstraint("organization_id", "series_id", "serial"),
        tenant_fk("site_id", "core.sites"),
        tenant_fk("gst_registration_id", "core.gst_registrations"),
        tenant_fk("customer_party_id", "master.parties"),
        tenant_fk("series_id", "sales.invoice_series"),
        tenant_fk("created_by", "core.users"),
        tenant_fk("issued_by", "core.users"),
        tenant_fk("cancelled_by", "core.users"),
        Index("ix_invoices_status", "organization_id", "status"),
        Index("ix_invoices_customer", "organization_id", "customer_party_id"),
        Index("ix_invoices_invoice_date", "organization_id", "invoice_date"),
        CheckConstraint(_in("status", INVOICE_STATUSES), name="status_known"),
        # A number, and who took it when, exactly when it is no longer a draft.
        CheckConstraint(
            " AND ".join(f"(status = 'draft') = ({c} IS NULL)" for c in ("invoice_number", *_NUMBERED)),
            name="numbered_once_issued",
        ),
        CheckConstraint(
            f"invoice_number IS NULL OR invoice_number ~ '{INVOICE_NUMBER_SHAPE}'",
            name="invoice_number_shape",
        ),
        CheckConstraint("serial IS NULL OR serial > 0", name="serial_positive"),
        CheckConstraint(
            "(status = 'cancelled') = (cancelled_at IS NOT NULL)"
            " AND (cancelled_at IS NULL) = (cancelled_by IS NULL)"
            " AND (cancelled_at IS NULL) = (cancelled_by_name IS NULL)"
            " AND (cancelled_at IS NULL) = (cancel_reason IS NULL)",
            name="cancel_recorded",
        ),
        CheckConstraint(
            "cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 1 AND 200",
            name="cancel_reason_said",
        ),
        CheckConstraint(f"seller_gstin ~ '{GSTIN_SHAPE}'", name="seller_gstin_shape"),
        CheckConstraint("seller_state_code = left(seller_gstin, 2)", name="seller_state_is_the_gstins"),
        CheckConstraint(f"buyer_gstin IS NULL OR buyer_gstin ~ '{GSTIN_SHAPE}'", name="buyer_gstin_shape"),
        CheckConstraint(f"place_of_supply ~ '{STATE_CODE_SHAPE}'", name="place_of_supply_shape"),
        CheckConstraint(_in("pos_basis", POS_BASES), name="pos_basis_known"),
        CheckConstraint(_in("supply_type", SUPPLY_TYPES), name="supply_type_known"),
        # IGST exactly when the goods go to another state than the seller's.
        CheckConstraint(
            "(supply_type = 'inter') = (place_of_supply <> seller_state_code)", name="supply_type_follows"
        ),
        CheckConstraint(
            "(supply_type = 'intra' AND igst_total = 0 AND cgst_total = sgst_total)"
            " OR (supply_type = 'inter' AND cgst_total = 0 AND sgst_total = 0)",
            name="tax_split",
        ),
        CheckConstraint(
            "taxable_total >= 0 AND cgst_total >= 0 AND sgst_total >= 0 AND igst_total >= 0",
            name="amounts_not_negative",
        ),
        CheckConstraint("round_off BETWEEN -0.50 AND 0.50", name="round_off_within_half_a_rupee"),
        CheckConstraint("total = round(total)", name="total_in_rupees"),
        CheckConstraint(
            "total = taxable_total + cgst_total + sgst_total + igst_total + round_off", name="total_adds_up"
        ),
        CheckConstraint("irn IS NULL OR status <> 'draft'", name="irn_once_issued"),
        CheckConstraint("irn_ack_number IS NULL OR irn IS NOT NULL", name="irn_ack_has_irn"),
        CheckConstraint("char_length(notes) <= 500", name="notes_length"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    #: The site the trips' sheets are at: the scope the invoice is read and written at.
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The seller: that site's GST registration.
    gst_registration_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    customer_party_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'draft'"))
    #: Null while a draft.
    series_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    financial_year: Mapped[str | None] = mapped_column(Text)
    serial: Mapped[int | None] = mapped_column(Integer)
    invoice_number: Mapped[str | None] = mapped_column(Text)
    #: The day it was issued, in the tenant's timezone.
    invoice_date: Mapped[date | None] = mapped_column(Date)
    seller_legal_name: Mapped[str] = mapped_column(Text, nullable=False)
    seller_trade_name: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    seller_gstin: Mapped[str] = mapped_column(String(15), nullable=False)
    seller_state_code: Mapped[str] = mapped_column(String(2), nullable=False)
    seller_address: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    buyer_name: Mapped[str] = mapped_column(Text, nullable=False)
    #: Printed on a B2B invoice; a buyer without one is billed B2C.
    buyer_gstin: Mapped[str | None] = mapped_column(String(15))
    buyer_address: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: The delivery location, when every line went to one.
    ship_to_name: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    ship_to_address: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    place_of_supply: Mapped[str] = mapped_column(String(2), nullable=False)
    #: Why the place of supply is what it is: the field a GST audit checks first.
    pos_basis: Mapped[str] = mapped_column(Text, nullable=False)
    supply_type: Mapped[str] = mapped_column(Text, nullable=False)
    taxable_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    cgst_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    sgst_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    igst_total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    round_off: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    rules_version: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text(f"'{INVOICE_RULES_VERSION}'")
    )
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: e-invoicing is not built (LIN-27): kept for the IRP's reference and acknowledgement.
    irn: Mapped[str | None] = mapped_column(Text)
    irn_ack_number: Mapped[str | None] = mapped_column(Text)
    irn_ack_date: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    issued_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    issued_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    issued_by_name: Mapped[str | None] = mapped_column(Text)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    cancelled_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    cancelled_by_name: Mapped[str | None] = mapped_column(Text)
    cancel_reason: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class InvoiceLine(Base):
    """A trip sale line on an invoice, as it was billed.

    The line carries its invoice's status, kept in step by the composite key's
    ON UPDATE CASCADE, so the database itself holds a sale line to one live
    invoice: the partial unique index counts drafts and issued invoices, and
    a cancelled invoice's lines drop out of it, which frees their trips to be
    invoiced again. A live line always names its sale; once its invoice is
    cancelled, a sale line deleted from its trip is let go (the line keeps
    everything it printed).
    """

    __tablename__ = "invoice_lines"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "invoice_id", "position"),
        ForeignKeyConstraint(
            ["organization_id", "invoice_id", "invoice_status"],
            ["sales.invoices.organization_id", "sales.invoices.id", "sales.invoices.status"],
            ondelete="RESTRICT",
            onupdate="CASCADE",
        ),
        tenant_fk("trip_sale_id", "sales.trip_sales"),
        Index(
            "uq_invoice_lines_live_trip_sale",
            "organization_id",
            "trip_sale_id",
            unique=True,
            postgresql_where=text("invoice_status <> 'cancelled'"),
        ),
        CheckConstraint(_in("invoice_status", INVOICE_STATUSES), name="invoice_status_known"),
        CheckConstraint(
            "invoice_status = 'cancelled' OR trip_sale_id IS NOT NULL", name="live_line_names_its_sale"
        ),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("rate > 0", name="rate_positive"),
        CheckConstraint("transport >= 0", name="transport_not_negative"),
        CheckConstraint("amount = round(quantity * rate, 2)", name="amount_is_quantity_times_rate"),
        CheckConstraint("taxable = amount + transport", name="taxable_adds_up"),
        CheckConstraint("gst_rate_pct >= 0 AND gst_rate_pct <= 100", name="gst_rate_range"),
        CheckConstraint("cgst >= 0 AND sgst >= 0 AND igst >= 0", name="tax_not_negative"),
        CheckConstraint("total = taxable + cgst + sgst + igst", name="total_adds_up"),
        CheckConstraint(f"hsn_code ~ '{HSN_SHAPE}'", name="hsn_shape"),
        CheckConstraint(UNIT_SHAPE, name="unit_shape"),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    invoice_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The invoice's own status, carried down by the key.
    invoice_status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'draft'"))
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    trip_sale_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    sheet_number: Mapped[str] = mapped_column(Text, nullable=False)
    trip_number: Mapped[str] = mapped_column(Text, nullable=False)
    trip_date: Mapped[date] = mapped_column(Date, nullable=False)
    registration_number: Mapped[str] = mapped_column(Text, nullable=False)
    #: The DC the customer signed, and where it was delivered.
    challan_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    location: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: The material, by its name when billed.
    description: Mapped[str] = mapped_column(Text, nullable=False)
    hsn_code: Mapped[str] = mapped_column(Text, nullable=False)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    transport: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False, server_default=text("0"))
    taxable: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    gst_rate_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    cgst: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    sgst: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    igst: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    total: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()

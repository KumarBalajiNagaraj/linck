"""Expense bills, the approval chain's history, payments, and WhatsApp imports.

    upload / keyed / WhatsApp claim ──▶ expense_bills ◀── expense_bill_fields (what capture read,
                                          │    │                                 what the ledger holds,
                                          │    │                                 who corrected it)
                                          │    └──── expense_bill_events  (append-only: every move)
                                          └───────── payments            (append-only: UTR unique)

The workflow rules themselves are in app/domain/expense_workflow.py, ported
from packages/domain/src/expense-workflow.ts; these tables only make the rules'
results permanent. Two of them are append-only at the grant level, like the
audit log: the app role may INSERT and SELECT the event history and the
payments, never UPDATE or DELETE them.
"""

from __future__ import annotations

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
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, created_at, org_fk, pk, tenant_fk, updated_at
from app.models.core import File

SCHEMA = "finance"

EXPENSE_DESKS = ("fleet", "stores")
EXPENSE_KINDS = ("diesel", "repair", "tyre", "spares", "toll", "other")
# The kinds the stores desk raises: no fuel, no tolls.
STORES_KINDS = ("spares", "tyre", "repair", "other")
EXPENSE_STATUSES = ("submitted", "validated", "approved", "passed", "paid", "rejected", "deleted")
BILL_ACTIONS = ("validate", "approve", "pass", "pay", "reject", "send_back", "delete", "restore")
PROVENANCES = ("human", "proposed", "confirmed", "overridden", "device")
BILL_FIELD_KEYS = ("kind", "billNumber", "billDate", "vendor", "gstin", "vehicle", "litres", "rate", "amount")
# The design's payment_method, lower-case; the API speaks the screen's casing.
PAYMENT_METHODS = ("neft", "rtgs", "imps", "upi", "cheque", "cash")
PAYMENT_STATUSES = (
    "draft",
    "pending_approval",
    "approved",
    "issued",
    "recorded",
    "pending_verification",
    "verified",
    "cleared",
    "bounced",
    "reversed",
    "cancelled",
)
IMPORT_SOURCES = ("inbox", "export")


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} in (" + ", ".join(f"'{v}'" for v in values) + ")"


class Payment(Base):
    """Money out (and, later, in). One table for both, as the design has it.

    A batch payment is one bank transfer: one row, one UTR, several bills.
    The same UTR is never claimed twice within a tenant.
    """

    __tablename__ = "payments"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        Index(
            "uq_payments_organization_id_reference_no",
            "organization_id",
            "reference_no",
            unique=True,
            postgresql_where=text("reference_no IS NOT NULL"),
        ),
        tenant_fk("recorded_by", "core.users"),
        CheckConstraint("direction in ('inbound','outbound')", name="direction_known"),
        CheckConstraint(_in("method", PAYMENT_METHODS), name="method_known"),
        CheckConstraint(_in("status", PAYMENT_STATUSES), name="status_known"),
        CheckConstraint("amount > 0", name="amount_positive"),
        # A bank reference unless it was cash, and then never one.
        CheckConstraint("(method = 'cash') = (reference_no IS NULL)", name="reference_unless_cash"),
        CheckConstraint(
            "reference_no IS NULL OR reference_no ~ '^[A-Z0-9]{6,22}$'", name="reference_no_shape"
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    direction: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'outbound'"))
    payment_date: Mapped[date] = mapped_column(Date, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    # UTR, cheque number or UPI reference.
    reference_no: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'recorded'"))
    recorded_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    recorded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class TripPayment(Base):
    """Money received from a customer (BA) or paid to a vendor (BE), on a trip or its sheet (LIN-22).

    Not a finance.payments row: that table is the append-only record of money
    whose UTR is claimed once for the life of the tenant, and a trip's money
    line must be correctable and removable by whoever enters the trip. These
    are the reported side of the owner's cross-verification rule
    (docs/DATABASE.md): the line a fleet desk records, which a verified
    payment confirms when receipts are matched to the bank. Part payments are
    several lines; a payment written on the sheet settles that party's trips
    oldest first (app/domain/vehicle_pl.py).
    """

    __tablename__ = "trip_payments"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        # The same transfer is not recorded twice on one sheet. A lump sum may
        # cover several sheets, so the reference is not unique across them.
        Index(
            "uq_trip_payments_organization_id_trip_sheet_id_reference_no",
            "organization_id",
            "trip_sheet_id",
            "reference_no",
            unique=True,
            postgresql_where=text("reference_no IS NOT NULL"),
        ),
        tenant_fk("trip_sheet_id", "logistics.trip_sheets"),
        ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.trip_sheet_id", "logistics.trips.id"],
            ondelete="RESTRICT",
        ),
        tenant_fk("party_id", "master.parties"),
        tenant_fk("recorded_by", "core.users"),
        CheckConstraint("direction in ('in', 'out')", name="direction_known"),
        CheckConstraint(_in("method", PAYMENT_METHODS), name="method_known"),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint(
            "reference_no IS NULL OR reference_no ~ '^[A-Z0-9/-]{3,40}$'", name="reference_shape"
        ),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_sheet_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: Null: written on the sheet.
    trip_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    #: In: received from a customer. Out: paid to a vendor.
    direction: Mapped[str] = mapped_column(Text, nullable=False)
    party_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    paid_on: Mapped[date] = mapped_column(Date, nullable=False)
    method: Mapped[str] = mapped_column(Text, nullable=False)
    #: UTR, cheque number, UPI reference or cash receipt number, if there is one.
    reference_no: Mapped[str | None] = mapped_column(Text)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    note: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    recorded_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class WhatsAppImportBatch(Base):
    """One import of driver slips, from the live inbox or a group's chat export."""

    __tablename__ = "whatsapp_import_batches"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        tenant_fk("imported_by", "core.users"),
        CheckConstraint(_in("source", IMPORT_SOURCES), name="source_known"),
        CheckConstraint(
            "claims_imported >= 0 AND claims_skipped >= 0 "
            "AND claims_received = claims_imported + claims_skipped",
            name="counts_add_up",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    source: Mapped[str] = mapped_column(Text, nullable=False)
    # The group an export came from; empty for the business number's inbox.
    via: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    claims_received: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    claims_imported: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    claims_skipped: Mapped[int] = mapped_column(Integer, nullable=False, server_default=text("0"))
    imported_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    imported_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class WhatsAppImportClaim(Base):
    """One driver's message taken into the ledger.

    `claim_key` is the claim's stable key from packages/domain/src/whatsapp.ts
    (time, words and photo count, never the phone-specific file names), and it
    is unique per tenant: the same message is never imported twice, whatever
    phone the export came from or however often it is re-imported.
    """

    __tablename__ = "whatsapp_import_claims"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "claim_key"),
        tenant_fk("batch_id", "finance.whatsapp_import_batches"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    batch_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    claim_key: Mapped[str] = mapped_column(Text, nullable=False)
    sender: Mapped[str] = mapped_column(Text, nullable=False)
    posted_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # What the driver wrote, often nothing: most send only the photo.
    message: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    attachments: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False, server_default=text("'{}'"))
    created_at: Mapped[datetime] = created_at()

    batch: Mapped[WhatsAppImportBatch] = relationship(viewonly=True, lazy="raise")


class ExpenseBill(Base):
    """A diesel, repair, tyre, spares, toll or other bill, and where it is in the chain.

    `status` is the chain's current position; every move that put it there is
    in expense_bill_events, which is never edited. The bill's own columns are
    correctable only while it is still `submitted`, before anyone has signed.
    """

    __tablename__ = "expense_bills"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        # One scan, one bill; one WhatsApp claim, one bill.
        UniqueConstraint("organization_id", "attachment_file_id"),
        UniqueConstraint("organization_id", "whatsapp_claim_id"),
        tenant_fk("site_id", "core.sites"),
        tenant_fk("created_by", "core.users"),
        tenant_fk("attachment_file_id", "core.files"),
        tenant_fk("whatsapp_claim_id", "finance.whatsapp_import_claims"),
        tenant_fk("payment_id", "finance.payments"),
        Index("ix_expense_bills_queue", "organization_id", "desk", "status"),
        Index("ix_expense_bills_vehicle", "organization_id", "vehicle_ref"),
        CheckConstraint(_in("desk", EXPENSE_DESKS), name="desk_known"),
        CheckConstraint(_in("kind", EXPENSE_KINDS), name="kind_known"),
        CheckConstraint("desk = 'fleet' OR " + _in("kind", STORES_KINDS), name="stores_kinds"),
        CheckConstraint(_in("status", EXPENSE_STATUSES), name="status_known"),
        CheckConstraint(_in("provenance", PROVENANCES), name="provenance_known"),
        CheckConstraint("amount > 0", name="amount_positive"),
        # Litres are counted on diesel bills only.
        CheckConstraint("litres IS NULL OR (litres > 0 AND kind = 'diesel')", name="litres_on_diesel"),
        # A stores bill is against no vehicle and no driver.
        CheckConstraint(
            "desk = 'fleet' OR (vehicle_ref IS NULL AND driver_ref IS NULL)", name="stores_has_no_vehicle"
        ),
        CheckConstraint("(capture_engine IS NULL) = (captured_at IS NULL)", name="capture_complete"),
        CheckConstraint("jsonb_typeof(capture_warnings) = 'array'", name="warnings_are_a_list"),
        CheckConstraint("(status = 'paid') = (payment_id IS NOT NULL)", name="paid_has_payment"),
        CheckConstraint(
            "whatsapp_claim_id IS NULL OR (desk = 'fleet' AND kind = 'diesel')",
            name="whatsapp_is_fleet_diesel",
        ),
        CheckConstraint("submitted_by_ref ~ '^(user|driver|wa):.+$'", name="submitter_is_an_actor"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    # Which desk raised it, the fleet manager's or the store manager's. It
    # decides which validate key the first step needs.
    desk: Mapped[str] = mapped_column(Text, nullable=False)
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    # Empty when a WhatsApp slip gave none; filled by a correction.
    bill_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    # The calendar date on the bill, in the tenant's timezone.
    bill_date: Mapped[date] = mapped_column(Date, nullable=False)
    vendor: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    # Ids the screens use; foreign keys once fleet.vehicles and the driver
    # roster are migrated.
    vehicle_ref: Mapped[str | None] = mapped_column(Text)
    driver_ref: Mapped[str | None] = mapped_column(Text)
    litres: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'submitted'"))
    provenance: Mapped[str] = mapped_column(Text, nullable=False)
    # Who raised it, as the four-eyes rule compares people: `user:<uuid>` for
    # someone who uploaded or keyed it, `driver:<id>` or `wa:<number>` for a
    # driver whose WhatsApp slip was imported. Never trusted from a client for
    # a bill a user raised.
    submitted_by_ref: Mapped[str] = mapped_column(Text, nullable=False)
    submitted_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    submitted_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # The signed-in person who put the row in: the uploader, or whoever ran
    # the WhatsApp import. Not a signer.
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    attachment_file_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    # The capture record's header; its fields are expense_bill_fields.
    capture_engine: Mapped[str | None] = mapped_column(Text)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # BillNotice[] as codes and their values; the screen words them.
    capture_warnings: Mapped[list[dict]] = mapped_column(
        JSONB, nullable=False, server_default=text("'[]'::jsonb")
    )
    whatsapp_claim_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    payment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()

    fields: Mapped[list[ExpenseBillField]] = relationship(
        viewonly=True, lazy="raise", order_by="ExpenseBillField.position"
    )
    events: Mapped[list[ExpenseBillEvent]] = relationship(
        viewonly=True, lazy="raise", order_by="ExpenseBillEvent.seq"
    )
    payment: Mapped[Payment | None] = relationship(viewonly=True, lazy="raise")
    attachment: Mapped[File | None] = relationship(viewonly=True, lazy="raise")
    claim: Mapped[WhatsAppImportClaim | None] = relationship(viewonly=True, lazy="raise")


class ExpenseBillField(Base):
    """One field of a bill's capture record: what capture read, what the ledger holds.

    The reading is never overwritten. A correction changes `value` and names
    who made it, so the corrections are the measure of how well capture reads
    each vendor's bills.
    """

    __tablename__ = "expense_bill_fields"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "bill_id", "key"),
        tenant_fk("bill_id", "finance.expense_bills"),
        tenant_fk("overridden_by", "core.users"),
        CheckConstraint(_in("key", BILL_FIELD_KEYS), name="key_known"),
        CheckConstraint("confidence IS NULL OR confidence BETWEEN 1 AND 3", name="confidence_range"),
        CheckConstraint(
            "captured_value IS NOT NULL OR confidence IS NULL", name="no_confidence_without_reading"
        ),
        # Only a reading can be overridden, and an override always names who.
        CheckConstraint(
            "overridden = (overridden_by IS NOT NULL) "
            "AND (overridden_by IS NULL) = (overridden_by_name IS NULL) "
            "AND (NOT overridden OR captured_value IS NOT NULL)",
            name="override_names_who",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    bill_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    key: Mapped[str] = mapped_column(Text, nullable=False)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    # Null when capture found nothing for this field.
    captured_value: Mapped[str | None] = mapped_column(Text)
    confidence: Mapped[int | None] = mapped_column(SmallInteger)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    overridden: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    overridden_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    overridden_by_name: Mapped[str | None] = mapped_column(Text)


class ExpenseBillEvent(Base):
    """One move along the approval chain. Append-only: INSERT and SELECT for the app role."""

    __tablename__ = "expense_bill_events"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        # The bill's history in order. Writers hold the bill row's lock, so
        # this only ever fires on a bug.
        UniqueConstraint("organization_id", "bill_id", "seq"),
        tenant_fk("bill_id", "finance.expense_bills"),
        tenant_fk("actor_user_id", "core.users"),
        tenant_fk("payment_id", "finance.payments"),
        CheckConstraint(_in("action", BILL_ACTIONS), name="action_known"),
        CheckConstraint(_in("from_status", EXPENSE_STATUSES), name="from_status_known"),
        CheckConstraint(_in("to_status", EXPENSE_STATUSES), name="to_status_known"),
        CheckConstraint("seq > 0", name="seq_positive"),
        CheckConstraint("(action = 'pay') = (payment_id IS NOT NULL)", name="payment_on_pay"),
        # The reasons the workflow demands, demanded again where nothing can skip them.
        CheckConstraint(
            "note IS NOT NULL OR (NOT exception AND action NOT IN ('reject', 'delete', 'send_back'))",
            name="reason_given",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    bill_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    seq: Mapped[int] = mapped_column(Integer, nullable=False)
    action: Mapped[str] = mapped_column(Text, nullable=False)
    from_status: Mapped[str] = mapped_column(Text, nullable=False)
    to_status: Mapped[str] = mapped_column(Text, nullable=False)
    actor_user_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # The name they signed under, kept as it was: history is never edited.
    actor_name: Mapped[str] = mapped_column(Text, nullable=False)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())
    note: Mapped[str | None] = mapped_column(Text)
    # A second signature by someone who already signed this bill.
    exception: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("false"))
    payment_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))

"""Demand to receipt. So far: material bought for a trip, with the vendor's bill (LIN-22).

A tipper buys a load at a quarry or a crusher and carries it straight to a
customer: the receipt and its issue to the trip are one event, so the line
belongs to the trip. The vendor is a master.parties row with the `vendor`
role, the material a master.items row. The cost (AB), GST (AF) and total (AG)
are never stored: app/domain/vehicle_pl.py works them out from the quantity,
rate and GST terms each time, so they cannot disagree with the rule.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
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

SCHEMA = "procurement"


class TripPurchase(Base):
    """Material bought for a trip (the workbook's U to AI): from whom, where, what, how much, GST or not."""

    __tablename__ = "trip_purchases"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        tenant_fk("trip_id", "logistics.trips"),
        tenant_fk("vendor_party_id", "master.parties"),
        tenant_fk("item_id", "master.items"),
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("rate > 0", name="rate_positive"),
        CheckConstraint("gst_rate_pct >= 0 AND gst_rate_pct <= 100", name="gst_rate_range"),
        CheckConstraint(f"hsn_code IS NULL OR hsn_code ~ '{HSN_SHAPE}'", name="hsn_shape"),
        CheckConstraint(UNIT_SHAPE, name="unit_shape"),
        # AD: a GST bill names the vendor's GSTIN, or there is no input credit to take.
        CheckConstraint(f"vendor_gstin IS NULL OR vendor_gstin ~ '{GSTIN_SHAPE}'", name="vendor_gstin_shape"),
        CheckConstraint("NOT gst_billed OR vendor_gstin IS NOT NULL", name="gst_bill_has_gstin"),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    vendor_party_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: V, one of the vendor's locations (master.party_locations), as written.
    location: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    item_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: X and Z as billed: the material's own, unless the bill said otherwise.
    hsn_code: Mapped[str | None] = mapped_column(Text)
    unit: Mapped[str] = mapped_column(Text, nullable=False)
    quantity: Mapped[Decimal] = mapped_column(Numeric(12, 3), nullable=False)
    rate: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    #: AC: a GST bill (its tax is input credit) or not (no GST at all).
    gst_billed: Mapped[bool] = mapped_column(Boolean, nullable=False)
    #: AE, one of the tenant's master.gst_rates.
    gst_rate_pct: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    vendor_gstin: Mapped[str | None] = mapped_column(String(15))
    #: AH. One invoice may cover several trips, so it is not unique.
    invoice_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    invoice_date: Mapped[date | None] = mapped_column(Date)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class TripPurchaseFile(Base):
    """A photo or PDF of the vendor's bill (AI), on one purchase line."""

    __tablename__ = "trip_purchase_files"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        # One upload, one purchase.
        UniqueConstraint("organization_id", "file_id"),
        tenant_fk("purchase_id", "procurement.trip_purchases"),
        tenant_fk("file_id", "core.files"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    purchase_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    file_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = created_at()

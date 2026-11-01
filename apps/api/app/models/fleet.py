"""Vehicles and machinery as physical assets. Only the breakdown register so far.

fleet.vehicles and the driver roster are not migrated yet, so a breakdown
names its vehicle and driver by the id the screens use (`vehicle_ref`,
`driver_ref`). They become composite foreign keys when those tables land.
"""

import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, Numeric, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, org_fk, pk, tenant_fk, updated_at

SCHEMA = "fleet"

BREAKDOWN_STATUSES = ("open", "in_workshop", "resolved")


class Breakdown(Base):
    """One breakdown, open or closed.

    Vehicle status says THAT a tipper is down; this says what failed, where,
    since when and what it cost. A vehicle has at most one breakdown that is
    not resolved, so the register and the board cannot disagree about who is
    on the hard shoulder.
    """

    __tablename__ = "breakdowns"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "number"),
        UniqueConstraint("organization_id", "financial_year", "serial"),
        tenant_fk("site_id", "core.sites"),
        tenant_fk("recorded_by", "core.users"),
        tenant_fk("resolved_by", "core.users"),
        Index(
            "uq_breakdowns_one_open_per_vehicle",
            "organization_id",
            "vehicle_ref",
            unique=True,
            postgresql_where=text("status <> 'resolved'"),
        ),
        CheckConstraint(
            "status in (" + ", ".join(f"'{s}'" for s in BREAKDOWN_STATUSES) + ")", name="status_known"
        ),
        CheckConstraint("serial > 0", name="serial_positive"),
        CheckConstraint(
            "(status = 'resolved') = (resolved_at IS NOT NULL) "
            "AND (resolved_at IS NULL) = (resolved_by IS NULL)",
            name="resolution_recorded",
        ),
        CheckConstraint("resolved_at IS NULL OR resolved_at >= reported_at", name="resolved_after_reported"),
        CheckConstraint("repair_cost IS NULL OR repair_cost >= 0", name="repair_cost_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    # BD/26-27/001: an internal series per financial year.
    financial_year: Mapped[str] = mapped_column(Text, nullable=False)
    serial: Mapped[int] = mapped_column(Integer, nullable=False)
    number: Mapped[str] = mapped_column(Text, nullable=False)
    # The vehicle's home site: the scope the register is read and written at.
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    vehicle_ref: Mapped[str] = mapped_column(Text, nullable=False)
    driver_ref: Mapped[str | None] = mapped_column(Text)
    reported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # Who reported it, as told: often a driver on the phone, who is not a user.
    # The person who typed it in is `recorded_by`.
    reported_by: Mapped[str] = mapped_column(Text, nullable=False)
    location: Mapped[str] = mapped_column(Text, nullable=False)
    cause: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("'open'"))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    repair_cost: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    recorded_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()

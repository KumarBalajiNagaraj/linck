"""Physical movement: the vehicle day, its trips, and what they cost on the road (LIN-22).

    vehicle_duty_logs  one vehicle, one day: the cost container (docs/DATABASE.md)
        │  ├── trips             legs of that day, each with its own km
        │  └── duty_fuel_links   a diesel fill posted to the day: an expense bill or a fuel entry
        └────── trip_diesel      a trip's diesel: typed for the trip, or its part of a fill
                trip_costs       batta, en-route and other costs of a trip

Diesel is filled once a day and a tipper runs several legs, so a fill is posted
to the vehicle day and split across the trips that link it, by km (the rule is
named on the day: allocation_rule_version). Two keys make that structural
rather than a service promise: a trip's vehicle and date are its day's (a
four-column foreign key), and a trip's part of a fill can only name a fill of
its own day (both of trip_diesel's three-column keys run through
duty_log_id). A fill is posted once per tenant, so it is never counted on two
days.

fleet.vehicles and the driver roster are not migrated yet, so a trip names its
vehicle and driver by the screens' ids, and keeps the registration number,
model, driver's name and phone as they were on the day.
"""

from __future__ import annotations

import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
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
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.domain.vehicle_pl import COST_KINDS, DIESEL_SOURCES, PL_RULES_VERSION
from app.models.base import Base, created_at, org_fk, pk, tenant_fk, updated_at

SCHEMA = "logistics"


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} in (" + ", ".join(f"'{v}'" for v in values) + ")"


class VehicleDutyLog(Base):
    """One vehicle's day. Trips are its legs; a diesel fill is posted here and
    split across the legs that link it, by the named rule."""

    __tablename__ = "vehicle_duty_logs"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "vehicle_ref", "duty_date"),
        # What a trip's four-column key points at.
        UniqueConstraint("organization_id", "id", "vehicle_ref", "duty_date"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    vehicle_ref: Mapped[str] = mapped_column(Text, nullable=False)
    #: The business date, in the tenant's timezone.
    duty_date: Mapped[date] = mapped_column(Date, nullable=False)
    allocation_rule_version: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text(f"'{PL_RULES_VERSION}'")
    )
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class Trip(Base):
    """One trip: the vehicle and driver as they were, the km, and its lines.

    Numbered TRP/26-27/0001 per financial year. Its profit is never stored:
    it is worked out from the lines by app/domain/vehicle_pl.py each time it
    is read, so a corrected line or a changed rule shows at once.
    """

    __tablename__ = "trips"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "trip_number"),
        UniqueConstraint("organization_id", "financial_year", "serial"),
        # What trip_diesel's three-column key points at.
        UniqueConstraint("organization_id", "duty_log_id", "id"),
        ForeignKeyConstraint(
            ["organization_id", "duty_log_id", "vehicle_ref", "trip_date"],
            [
                f"{SCHEMA}.vehicle_duty_logs.organization_id",
                f"{SCHEMA}.vehicle_duty_logs.id",
                f"{SCHEMA}.vehicle_duty_logs.vehicle_ref",
                f"{SCHEMA}.vehicle_duty_logs.duty_date",
            ],
            ondelete="RESTRICT",
        ),
        tenant_fk("site_id", "core.sites"),
        tenant_fk("created_by", "core.users"),
        Index("ix_trips_date", "organization_id", "trip_date"),
        Index("ix_trips_vehicle_date", "organization_id", "vehicle_ref", "trip_date"),
        CheckConstraint("serial > 0", name="serial_positive"),
        CheckConstraint(
            "(start_km IS NULL OR start_km >= 0) AND (end_km IS NULL OR end_km >= 0) "
            "AND (start_km IS NULL OR end_km IS NULL OR end_km >= start_km)",
            name="km_in_order",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    financial_year: Mapped[str] = mapped_column(Text, nullable=False)
    serial: Mapped[int] = mapped_column(Integer, nullable=False)
    trip_number: Mapped[str] = mapped_column(Text, nullable=False)
    duty_log_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: The vehicle's home site: the scope the trip is read and written at.
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    vehicle_ref: Mapped[str] = mapped_column(Text, nullable=False)
    registration_number: Mapped[str] = mapped_column(Text, nullable=False)
    vehicle_model: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    driver_ref: Mapped[str | None] = mapped_column(Text)
    driver_name: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    driver_phone: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    trip_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_km: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    end_km: Mapped[Decimal | None] = mapped_column(Numeric(12, 2))
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class DutyFuelLink(Base):
    """A diesel fill already in Linck, posted to one vehicle day.

    An expense bill's litres and amount are read from the bill every time, so
    a correction there shows here and nothing is copied. A fuel entry has no
    table of its own yet (it is still the screens' data), so what it said is
    kept here. Either way a fill is posted once per tenant.
    """

    __tablename__ = "duty_fuel_links"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "duty_log_id", "id"),
        UniqueConstraint("organization_id", "expense_bill_id"),
        UniqueConstraint("organization_id", "fuel_entry_ref"),
        tenant_fk("duty_log_id", "logistics.vehicle_duty_logs"),
        tenant_fk("expense_bill_id", "finance.expense_bills"),
        CheckConstraint("source in ('expense_bill', 'fuel_entry')", name="source_known"),
        CheckConstraint(
            "(source = 'expense_bill') = (expense_bill_id IS NOT NULL) "
            "AND (source = 'fuel_entry') = (fuel_entry_ref IS NOT NULL)",
            name="source_named",
        ),
        # A bill's figures are read from the bill, never copied; a fuel
        # entry's are all there is.
        CheckConstraint(
            "CASE WHEN source = 'expense_bill' THEN litres IS NULL AND rate IS NULL AND amount IS NULL "
            "ELSE litres > 0 AND amount > 0 AND (rate IS NULL OR rate > 0) END",
            name="figures_from_the_source",
        ),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    duty_log_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    expense_bill_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    #: The fuel entry's id on the screens, until fleet.fuel_issues is migrated.
    fuel_entry_ref: Mapped[str | None] = mapped_column(Text)
    litres: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    rate: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    bill_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    vendor: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    filled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = created_at()


class TripDiesel(Base):
    """One diesel line of a trip: typed as on the bunk's bill, or a link to a fill of its day."""

    __tablename__ = "trip_diesel"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        # A fill is linked to a trip once.
        UniqueConstraint("organization_id", "trip_id", "link_id"),
        tenant_fk("trip_id", "logistics.trips"),
        # Both run through duty_log_id: a link names a fill of the trip's own day.
        ForeignKeyConstraint(
            ["organization_id", "duty_log_id", "trip_id"],
            [f"{SCHEMA}.trips.organization_id", f"{SCHEMA}.trips.duty_log_id", f"{SCHEMA}.trips.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["organization_id", "duty_log_id", "link_id"],
            [
                f"{SCHEMA}.duty_fuel_links.organization_id",
                f"{SCHEMA}.duty_fuel_links.duty_log_id",
                f"{SCHEMA}.duty_fuel_links.id",
            ],
            ondelete="RESTRICT",
        ),
        CheckConstraint(_in("source", DIESEL_SOURCES), name="source_known"),
        CheckConstraint(
            "(source = 'typed') = (link_id IS NULL) AND (link_id IS NULL) = (duty_log_id IS NULL)",
            name="typed_or_linked",
        ),
        # A typed line has its own figures; a linked one never repeats its fill's.
        CheckConstraint(
            "CASE WHEN source = 'typed' THEN litres > 0 AND rate > 0 "
            "ELSE litres IS NULL AND rate IS NULL END",
            name="figures_typed_once",
        ),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    litres: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    rate: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    vendor: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    bill_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    link_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    #: The trip's day, set only on a link: it is what ties the link to a fill of that day.
    duty_log_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class TripCost(Base):
    """Batta, a cost on the road (toll, loading, police, food), or anything else the trip spent."""

    __tablename__ = "trip_costs"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        tenant_fk("trip_id", "logistics.trips"),
        CheckConstraint(_in("kind", COST_KINDS), name="kind_known"),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()

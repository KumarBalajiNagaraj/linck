"""Physical movement: trip sheets, their trips, and what they cost on the road (LIN-22).

    trip_sheets         one vehicle and driver, from a start date to an end date
        ├── trips             the loads it carried, each numbered as "Add trip" is pressed
        ├── diesel_lines      diesel: typed as on the bunk's bill, or an expense bill or fuel entry linked
        └── enroute_expenses  toll, police and minor maintenance

The owner's workbook ("Vehicle Trip Entry Form") lets diesel, km readings,
batta, en-route expenses and payments sit on the sheet or on one of its trips,
so diesel_lines and enroute_expenses (and finance.trip_payments) name the sheet
always and the trip when there is one. A three-column key runs through the
sheet, so a line can only name a trip of its own sheet. What sits on the sheet
is shared out to its trips by app/domain/vehicle_pl.py when it is read: no
share is stored.

A diesel bill or fuel entry already in Linck is linked, never typed again, and
a tenant can link it once: it counts on one sheet only.

fleet.vehicles and the driver roster are not migrated yet, so a sheet names its
vehicle and driver by the screens' ids, and keeps the registration number,
model, driver's name and phone as they were.
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

from app.domain.vehicle_pl import DIESEL_SOURCES, EN_ROUTE_KINDS, MAINTENANCE_KINDS, PL_RULES_VERSION
from app.models.base import Base, created_at, org_fk, pk, tenant_fk, updated_at

SCHEMA = "logistics"

KM_IN_ORDER = (
    "(start_km IS NULL OR start_km >= 0) AND (end_km IS NULL OR end_km >= 0) "
    "AND (start_km IS NULL OR end_km IS NULL OR end_km >= start_km)"
)


def _in(column: str, values: tuple[str, ...]) -> str:
    return f"{column} in (" + ", ".join(f"'{v}'" for v in values) + ")"


def _on_sheet_or_trip() -> tuple[ForeignKeyConstraint, ForeignKeyConstraint]:
    """A line of the sheet, or of one of its trips: the trip key runs through the sheet."""
    return (
        tenant_fk("trip_sheet_id", "logistics.trip_sheets"),
        ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id", "trip_id"],
            [f"{SCHEMA}.trips.organization_id", f"{SCHEMA}.trips.trip_sheet_id", f"{SCHEMA}.trips.id"],
            ondelete="RESTRICT",
        ),
    )


class TripSheet(Base):
    """One vehicle and its driver over a run of days: the workbook's parent row.

    Numbered TS/26-27/0001 per financial year. Its profit is never stored: it
    is its trips added up, worked out by app/domain/vehicle_pl.py each time it
    is read, so a corrected line or a changed rule shows at once.
    """

    __tablename__ = "trip_sheets"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "sheet_number"),
        UniqueConstraint("organization_id", "financial_year", "serial"),
        tenant_fk("site_id", "core.sites"),
        tenant_fk("created_by", "core.users"),
        Index("ix_trip_sheets_start_date", "organization_id", "start_date"),
        Index("ix_trip_sheets_vehicle_start_date", "organization_id", "vehicle_ref", "start_date"),
        CheckConstraint("serial > 0", name="serial_positive"),
        CheckConstraint("end_date IS NULL OR end_date >= start_date", name="dates_in_order"),
        CheckConstraint(KM_IN_ORDER, name="km_in_order"),
        CheckConstraint("batta IS NULL OR batta >= 0", name="batta_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    financial_year: Mapped[str] = mapped_column(Text, nullable=False)
    serial: Mapped[int] = mapped_column(Integer, nullable=False)
    sheet_number: Mapped[str] = mapped_column(Text, nullable=False)
    #: The vehicle's home site: the scope the sheet is read and written at.
    site_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    vehicle_ref: Mapped[str] = mapped_column(Text, nullable=False)
    registration_number: Mapped[str] = mapped_column(Text, nullable=False)
    vehicle_model: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    driver_ref: Mapped[str | None] = mapped_column(Text)
    driver_name: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    driver_phone: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: Business dates, in the tenant's timezone. No end date while the vehicle is still out.
    start_date: Mapped[date] = mapped_column(Date, nullable=False)
    end_date: Mapped[date | None] = mapped_column(Date)
    start_km: Mapped[Decimal | None] = mapped_column(Numeric(10, 1))
    end_km: Mapped[Decimal | None] = mapped_column(Numeric(10, 1))
    batta: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    rules_version: Mapped[str] = mapped_column(
        Text, nullable=False, server_default=text(f"'{PL_RULES_VERSION}'")
    )
    created_by: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    created_by_name: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class Trip(Base):
    """One load on a sheet: bought, carried, delivered. Numbered TRP/26-27/0001 when added."""

    __tablename__ = "trips"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "trip_number"),
        UniqueConstraint("organization_id", "financial_year", "serial"),
        # What a line's three-column key points at.
        UniqueConstraint("organization_id", "trip_sheet_id", "id"),
        tenant_fk("trip_sheet_id", "logistics.trip_sheets"),
        Index("ix_trips_date", "organization_id", "trip_date"),
        CheckConstraint("serial > 0", name="serial_positive"),
        CheckConstraint(KM_IN_ORDER, name="km_in_order"),
        CheckConstraint("batta IS NULL OR batta >= 0", name="batta_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_sheet_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    financial_year: Mapped[str] = mapped_column(Text, nullable=False)
    serial: Mapped[int] = mapped_column(Integer, nullable=False)
    trip_number: Mapped[str] = mapped_column(Text, nullable=False)
    trip_date: Mapped[date] = mapped_column(Date, nullable=False)
    start_km: Mapped[Decimal | None] = mapped_column(Numeric(10, 1))
    end_km: Mapped[Decimal | None] = mapped_column(Numeric(10, 1))
    batta: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    notes: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class DieselLine(Base):
    """Diesel on a sheet or one of its trips: typed (M litres × N rate), or a fill already in Linck.

    An expense bill's litres and amount are read from the bill every time, so
    a correction there shows here and nothing is copied. A fuel entry has no
    table of its own yet (it is still the screens' data), so what it said is
    kept here. Either way a fill is linked once per tenant.
    """

    __tablename__ = "diesel_lines"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        UniqueConstraint("organization_id", "expense_bill_id"),
        UniqueConstraint("organization_id", "fuel_entry_ref"),
        *_on_sheet_or_trip(),
        tenant_fk("vendor_party_id", "master.parties"),
        tenant_fk("expense_bill_id", "finance.expense_bills"),
        tenant_fk("file_id", "core.files"),
        CheckConstraint(_in("source", DIESEL_SOURCES), name="source_known"),
        CheckConstraint(
            "(source = 'expense_bill') = (expense_bill_id IS NOT NULL) "
            "AND (source = 'fuel_entry') = (fuel_entry_ref IS NOT NULL)",
            name="source_named",
        ),
        # Typed: its own litres and rate. A bill: read from the bill, never
        # copied. A fuel entry: what it said is all there is.
        CheckConstraint(
            "CASE source WHEN 'typed' THEN litres > 0 AND rate > 0 AND amount IS NULL "
            "WHEN 'expense_bill' THEN litres IS NULL AND rate IS NULL AND amount IS NULL "
            "ELSE litres > 0 AND amount > 0 AND rate IS NULL END",
            name="figures_typed_once",
        ),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_sheet_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: Null: written on the sheet, shared out to its trips.
    trip_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    source: Mapped[str] = mapped_column(Text, nullable=False)
    litres: Mapped[Decimal | None] = mapped_column(Numeric(12, 3))
    rate: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))
    #: Q, from the vendor master; `vendor` keeps a fuel entry's bunk as it was written.
    vendor_party_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    vendor: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: R.
    bill_number: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    expense_bill_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    #: The fuel entry's id on the screens, until fleet.fuel_issues is migrated.
    fuel_entry_ref: Mapped[str | None] = mapped_column(Text)
    filled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    #: A photo of the bunk's bill, for a typed line.
    file_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()


class EnRouteExpense(Base):
    """Toll, police, or minor maintenance on the road (the workbook's column G)."""

    __tablename__ = "enroute_expenses"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        *_on_sheet_or_trip(),
        tenant_fk("file_id", "core.files"),
        CheckConstraint(_in("kind", EN_ROUTE_KINDS), name="kind_known"),
        CheckConstraint(
            "(kind = 'maintenance') = (maintenance_kind IS NOT NULL) "
            "AND (maintenance_kind IS NULL OR " + _in("maintenance_kind", MAINTENANCE_KINDS) + ")",
            name="maintenance_kind_known",
        ),
        # Miscellaneous maintenance carries the type the user typed.
        CheckConstraint(
            "maintenance_kind IS DISTINCT FROM 'misc' OR description <> ''", name="misc_described"
        ),
        CheckConstraint("amount > 0", name="amount_positive"),
        CheckConstraint("position >= 0", name="position_not_negative"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    trip_sheet_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    #: Null: written on the sheet, shared out to its trips.
    trip_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    position: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    kind: Mapped[str] = mapped_column(Text, nullable=False)
    maintenance_kind: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    spent_on: Mapped[date | None] = mapped_column(Date)
    location: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    #: A toll's transaction id.
    reference: Mapped[str] = mapped_column(Text, nullable=False, server_default=text("''"))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), nullable=False)
    #: The bill's photo.
    file_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()
    updated_at: Mapped[datetime] = updated_at()

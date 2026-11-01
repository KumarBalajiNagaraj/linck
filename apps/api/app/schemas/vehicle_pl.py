"""The vehicle P&L on the wire (LIN-22): a trip with its lines, the masters it picks from, the reports.

The web app's mock store (packages/mock) is shaped exactly like these, field
for field, so LIN-21 swaps the store for these routes and nothing else. The
encodings are app/schemas/common.py's: money a two-place decimal string, litres,
km, quantities and GST rates JSON numbers, dates YYYY-MM-DD, instants ISO-8601.

Every computed figure (a line's value, GST and total, a trip's P&L, what is
due) comes from app/domain/vehicle_pl.py on the way out. A request carries only
what a person types or picks; anything else is refused, not ignored.
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints

from app.schemas.common import CamelIn, CamelModel, MoneyIn, QuantityIn

DieselSource = Literal["typed", "expense_bill", "fuel_entry"]
CostKind = Literal["batta", "en_route", "other"]
Direction = Literal["in", "out"]
Mode = Literal["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash"]
Unit = Literal["unit", "tonne", "cft", "cum", "load"]
Role = Literal["customer", "vendor"]

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Ref = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
PaperNo = Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)]
Hsn = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[0-9]{4,8}$")]
Gstin = Annotated[str, StringConstraints(strip_whitespace=True, to_upper=True, min_length=15, max_length=15)]
Registration = Annotated[
    str, StringConstraints(strip_whitespace=True, to_upper=True, min_length=4, max_length=20)
]
PaymentRef = Annotated[
    str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Z0-9/-]{3,40}$")
]
ItemCode = Annotated[
    str, StringConstraints(strip_whitespace=True, to_upper=True, pattern=r"^[A-Z0-9_-]{1,32}$")
]
Note = Annotated[str, StringConstraints(max_length=1000)]

#: Lines per section of one trip: far beyond any real trip, short of a runaway client.
MAX_LINES = 50


def _decimal(value: float | int, places: int) -> Decimal:
    try:
        number = Decimal(str(value))
    except InvalidOperation as exc:  # pragma: no cover - pydantic has already parsed a number
        raise ValueError("not a number") from exc
    if not number.is_finite():
        raise ValueError("not a number")
    if number != number.quantize(Decimal(1).scaleb(-places)):
        raise ValueError(f"at most {places} decimal places")
    return number


def _to_rate(value: float | int) -> Decimal:
    rate = _decimal(value, 2)
    if rate < 0 or rate > 100:
        raise ValueError("between 0 and 100")
    return rate


def _to_km(value: float | int) -> Decimal:
    km = _decimal(value, 2)
    if km < 0 or km >= Decimal("10000000000"):
        raise ValueError("not a km reading")
    return km


#: A GST rate in per cent: 0 to 100, at most two decimals (5, 18, 2.5).
GstRateIn = Annotated[float | int, AfterValidator(_to_rate)]
#: A km reading: zero or more, at most two decimals.
KmIn = Annotated[float | int, AfterValidator(_to_km)]

Number = float | int


# ------------------------------------------------------------------ requests


class DieselIn(CamelIn):
    """Typed: litres and rate as on the bunk's bill. Linked: the bill or fuel entry,
    whose figures are read from it, never typed again. A fuel entry has no table
    in the API yet, so its figures come from the fuel register on the screen."""

    id: uuid.UUID | None = None
    source: DieselSource
    litres: QuantityIn | None = None
    rate: MoneyIn | None = None
    amount: MoneyIn | None = None
    vendor: Short = ""
    bill_number: PaperNo = ""
    expense_bill_id: uuid.UUID | None = None
    fuel_entry_id: Ref | None = None
    filled_at: AwareDatetime | None = None


class PurchaseIn(CamelIn):
    id: uuid.UUID | None = None
    vendor_id: uuid.UUID
    material_id: uuid.UUID
    #: As billed; the material's own when left out.
    hsn_code: Hsn | None = None
    unit: Unit | None = None
    quantity: QuantityIn
    rate: MoneyIn
    gst_billed: bool
    #: The material's own when left out.
    gst_rate_pct: GstRateIn | None = None
    invoice_number: PaperNo = ""
    invoice_date: dt.date | None = None
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)


class SaleIn(CamelIn):
    id: uuid.UUID | None = None
    customer_id: uuid.UUID
    purchase_order_id: uuid.UUID | None = None
    po_ref: PaperNo = ""
    material_id: uuid.UUID
    hsn_code: Hsn | None = None
    unit: Unit | None = None
    quantity: QuantityIn
    rate: MoneyIn
    gst_billed: bool
    gst_rate_pct: GstRateIn | None = None
    #: Transport charged as its own line: income, with its own GST rate.
    transport: MoneyIn | None = None
    transport_gst_rate_pct: GstRateIn | None = None
    challan_number: PaperNo = ""
    invoice_number: PaperNo = ""


class CostIn(CamelIn):
    id: uuid.UUID | None = None
    kind: CostKind
    description: Short = ""
    amount: MoneyIn


class TripPaymentIn(CamelIn):
    id: uuid.UUID | None = None
    direction: Direction
    party_id: uuid.UUID
    paid_on: dt.date
    mode: Mode
    reference: PaymentRef | None = None
    amount: MoneyIn
    note: Short = ""


class TripIn(CamelIn):
    """A whole trip. On PUT every section is the full list: a line with an id is
    that line, corrected; one without is new; a line left out is deleted."""

    site_id: uuid.UUID
    date: dt.date
    vehicle_id: Ref
    registration_number: Registration
    vehicle_model: Short = ""
    driver_id: Ref | None = None
    driver_name: Short = ""
    driver_phone: Phone = ""
    start_km: KmIn | None = None
    end_km: KmIn | None = None
    notes: Note = ""
    diesel: list[DieselIn] = Field(default_factory=list, max_length=MAX_LINES)
    purchases: list[PurchaseIn] = Field(default_factory=list, max_length=MAX_LINES)
    sales: list[SaleIn] = Field(default_factory=list, max_length=MAX_LINES)
    costs: list[CostIn] = Field(default_factory=list, max_length=MAX_LINES)
    payments: list[TripPaymentIn] = Field(default_factory=list, max_length=MAX_LINES)


class PartyIn(CamelIn):
    """A customer or a vendor, added from the trip page. A firm already in the
    master under this GSTIN takes the role instead of becoming a second party."""

    role: Role
    name: Name
    gstin: Gstin | None = None
    phone: Phone = ""
    contact_name: Short = ""
    #: The site a new customer is served from. Not asked of a vendor.
    site_id: uuid.UUID | None = None


class MaterialIn(CamelIn):
    code: ItemCode
    name: Name
    hsn_code: Hsn
    gst_rate_pct: GstRateIn
    unit: Unit


class MaterialPatch(CamelIn):
    name: Name | None = None
    hsn_code: Hsn | None = None
    gst_rate_pct: GstRateIn | None = None
    unit: Unit | None = None
    active: bool | None = None


# ----------------------------------------------------------------- responses


class TripAttachmentOut(CamelModel):
    id: uuid.UUID
    file_name: str
    mime_type: str
    size_kb: int
    #: Where it can be opened, relative to the API.
    url: str


class DieselOut(CamelModel):
    id: uuid.UUID
    source: str
    #: Typed: what was filled for this trip. Linked: the whole fill.
    litres: Number | None
    rate: str | None
    #: Typed: litres × rate. Linked: the whole fill, as on its bill.
    amount: str
    vendor: str
    bill_number: str
    #: An expense bill's date.
    bill_date: dt.date | None
    #: When a fuel entry was filled.
    filled_at: dt.datetime | None
    expense_bill_id: uuid.UUID | None
    fuel_entry_id: str | None
    #: The expense bill's status; a rejected or deleted one counts nothing.
    bill_status: str | None
    counted: bool
    share_litres: Number
    share_amount: str
    shared_by: int
    #: The other trips of the day the fill is split with, by number.
    shared_with: list[str]


class PurchaseOut(CamelModel):
    id: uuid.UUID
    vendor_id: uuid.UUID
    vendor_name: str
    vendor_gstin: str | None
    material_id: uuid.UUID
    material_name: str
    hsn_code: str
    unit: str
    quantity: Number
    rate: str
    gst_billed: bool
    gst_rate_pct: Number
    amount: str
    gst_amount: str
    total: str
    cost: str
    input_credit: str
    invoice_number: str
    invoice_date: dt.date | None
    attachments: list[TripAttachmentOut]


class SaleOut(CamelModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    customer_name: str
    customer_gstin: str | None
    purchase_order_id: uuid.UUID | None
    po_ref: str
    material_id: uuid.UUID
    material_name: str
    hsn_code: str
    unit: str
    quantity: Number
    rate: str
    gst_billed: bool
    gst_rate_pct: Number
    transport: str
    transport_gst_rate_pct: Number
    amount: str
    gst_amount: str
    transport_gst: str
    taxable: str
    gst_total: str
    total: str
    challan_number: str
    invoice_number: str


class CostOut(CamelModel):
    id: uuid.UUID
    kind: str
    description: str
    amount: str


class TripPaymentOut(CamelModel):
    id: uuid.UUID
    direction: str
    party_id: uuid.UUID
    party_name: str
    paid_on: dt.date
    mode: str
    reference: str | None
    amount: str
    note: str


class PlOut(CamelModel):
    """TripPl from packages/domain/src/vehicle-pl.ts."""

    distance_km: Number | None
    diesel_litres: Number
    mileage_kmpl: Number | None
    sales: str
    material_cost: str
    gross: str
    diesel: str
    batta: str
    en_route: str
    other: str
    net: str
    profit_pct: Number | None
    output_gst: str
    input_gst: str
    gst_to_pay: str
    customer_billed: str
    received: str
    customer_due: str
    vendor_billed: str
    paid: str
    vendor_due: str


class PartyDueOut(CamelModel):
    party_id: uuid.UUID
    party_name: str
    role: str
    billed: str
    settled: str
    due: str


class TripRowOut(CamelModel):
    """A trip in the trip-wise list: the header, its P&L and who it was with."""

    id: uuid.UUID
    trip_number: str
    date: dt.date
    site_id: uuid.UUID
    vehicle_id: str
    registration_number: str
    vehicle_model: str
    driver_id: str | None
    driver_name: str
    driver_phone: str
    start_km: Number | None
    end_km: Number | None
    customers: list[str]
    vendors: list[str]
    materials: list[str]
    pl: PlOut
    created_by: str
    created_at: dt.datetime
    updated_at: dt.datetime


class TripOut(TripRowOut):
    notes: str
    diesel: list[DieselOut]
    purchases: list[PurchaseOut]
    sales: list[SaleOut]
    costs: list[CostOut]
    payments: list[TripPaymentOut]
    dues: list[PartyDueOut]


class PlTotalsOut(CamelModel):
    """PlTotals from packages/domain/src/vehicle-pl.ts."""

    trips: int
    distance_km: Number
    diesel_litres: Number
    mileage_kmpl: Number | None
    sales: str
    material_cost: str
    gross: str
    diesel: str
    batta: str
    en_route: str
    other: str
    net: str
    profit_pct: Number | None
    output_gst: str
    input_gst: str
    gst_to_pay: str
    customer_billed: str
    received: str
    customer_due: str
    vendor_billed: str
    paid: str
    vendor_due: str


class TripReportOut(CamelModel):
    rows: list[TripRowOut]
    total: PlTotalsOut


class VehiclePlOut(PlTotalsOut):
    vehicle_id: str
    registration_number: str
    vehicle_model: str


class VehicleReportOut(CamelModel):
    rows: list[VehiclePlOut]
    total: PlTotalsOut


class MonthPlOut(PlTotalsOut):
    #: YYYY-MM.
    month: str


class MonthReportOut(CamelModel):
    rows: list[MonthPlOut]
    total: PlTotalsOut


class OutstandingOut(CamelModel):
    party_id: uuid.UUID
    name: str
    gstin: str | None
    phone: str
    role: str
    trips: int
    billed: str
    settled: str
    due: str
    first_date: dt.date
    last_date: dt.date


class OutstandingTotalOut(CamelModel):
    parties: int
    billed: str
    settled: str
    due: str


class OutstandingReportOut(CamelModel):
    rows: list[OutstandingOut]
    total: OutstandingTotalOut


class PartyOut(CamelModel):
    id: uuid.UUID
    name: str
    gstin: str | None
    phone: str
    contact_name: str
    roles: list[str]


class MaterialOut(CamelModel):
    id: uuid.UUID
    code: str
    name: str
    hsn_code: str
    gst_rate_pct: Number
    unit: str
    active: bool


class MastersOut(CamelModel):
    customers: list[PartyOut]
    vendors: list[PartyOut]
    materials: list[MaterialOut]


class LinkedTripOut(CamelModel):
    trip_id: uuid.UUID
    trip_number: str
    date: dt.date


class DieselBillOut(CamelModel):
    """A fleet diesel bill a trip may link, and the trips that already do."""

    id: uuid.UUID
    bill_number: str
    bill_date: dt.date
    vendor: str
    vehicle_id: str | None
    litres: Number | None
    amount: str
    status: str
    linked_trips: list[LinkedTripOut]

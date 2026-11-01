"""The vehicle P&L on the wire (LIN-22): a trip sheet with its trips and lines, the masters, the reports.

Shaped on the owner's workbook ("Vehicle Trip Entry Form"): a trip sheet is one
vehicle and driver from a start date to an end date, and its trips are the
loads it carried. Diesel, km readings, batta, en-route expenses and payments
may sit on the sheet or on a trip; purchases and sales are a trip's.

The web app's mock store (packages/mock) is shaped exactly like these, field
for field, so LIN-21 swaps the store for these routes and nothing else. The
encodings are app/schemas/common.py's: money a two-place decimal string, litres,
km, quantities and GST rates JSON numbers, dates YYYY-MM-DD, instants ISO-8601.

Every computed figure (a line's cost, GST and total, a trip's share of its
sheet's costs, a P&L, what is due) comes from app/domain/vehicle_pl.py on the
way out. A request carries only what a person types or picks; anything else is
refused, not ignored.
"""

from __future__ import annotations

import datetime as dt
import uuid
from decimal import Decimal, InvalidOperation
from typing import Annotated, Literal

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints

from app.schemas.common import CamelIn, CamelModel, MoneyIn, QuantityIn

DieselSource = Literal["typed", "expense_bill", "fuel_entry"]
EnRouteKind = Literal["toll", "police", "maintenance"]
MaintenanceKind = Literal["tyre_rotation", "wheel_alignment", "greasing", "engine_oil", "coolant", "misc"]
Direction = Literal["in", "out"]
Mode = Literal["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash"]
Role = Literal["customer", "vendor"]

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Ref = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)]
PaperNo = Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)]
Phone = Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)]
Hsn = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[0-9]{4,8}$")]
UnitText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=20)]
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

#: Lines per section, and trips per sheet: far beyond any real sheet, short of a runaway client.
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
    km = _decimal(value, 1)
    if km < 0 or km >= Decimal("1000000000"):
        raise ValueError("not a km reading")
    return km


#: A GST rate in per cent: 0 to 100, at most two decimals (5, 18, 2.5).
GstRateIn = Annotated[float | int, AfterValidator(_to_rate)]
#: A km reading: zero or more, at most one decimal.
KmIn = Annotated[float | int, AfterValidator(_to_km)]

Number = float | int


# ------------------------------------------------------------------ requests


class DieselIn(CamelIn):
    """M litres and N rate as on the bunk's bill (typed), or a fill already in Linck
    (linked), whose figures are read from it and never typed again. A fuel entry
    has no table in the API yet, so its figures come from the fuel register."""

    id: uuid.UUID | None = None
    source: DieselSource
    litres: QuantityIn | None = None
    rate: MoneyIn | None = None
    amount: MoneyIn | None = None
    #: Q, from the vendor master.
    vendor_id: uuid.UUID | None = None
    #: A fuel entry's bunk, as it was written.
    vendor: Short = ""
    #: R.
    bill_number: PaperNo = ""
    expense_bill_id: uuid.UUID | None = None
    fuel_entry_id: Ref | None = None
    filled_at: AwareDatetime | None = None
    #: A photo of the bunk's bill.
    attachment_id: uuid.UUID | None = None


class EnRouteIn(CamelIn):
    """Toll (date, location, transaction id), police (date, location), or minor maintenance."""

    id: uuid.UUID | None = None
    kind: EnRouteKind
    maintenance_kind: MaintenanceKind | None = None
    #: What a miscellaneous maintenance was, as typed.
    description: Short = ""
    date: dt.date | None = None
    location: Short = ""
    reference: PaperNo = ""
    amount: MoneyIn
    attachment_id: uuid.UUID | None = None


class PurchaseIn(CamelIn):
    id: uuid.UUID | None = None
    vendor_id: uuid.UUID
    #: V, one of the vendor's locations, or typed.
    location: Short = ""
    material_id: uuid.UUID
    #: X and Z as billed; the material's own when left out.
    hsn_code: Hsn | None = None
    unit: UnitText | None = None
    quantity: QuantityIn
    rate: MoneyIn
    gst_billed: bool
    #: AE, one of the tenant's GST rates; the material's own when left out.
    gst_rate_pct: GstRateIn | None = None
    #: AD; the vendor's own when left out. A GST bill needs one.
    vendor_gstin: Gstin | None = None
    invoice_number: PaperNo = ""
    invoice_date: dt.date | None = None
    attachment_ids: list[uuid.UUID] = Field(default_factory=list, max_length=10)


class SaleIn(CamelIn):
    id: uuid.UUID | None = None
    customer_id: uuid.UUID
    #: AL, one of the customer's delivery locations, or typed.
    location: Short = ""
    purchase_order_id: uuid.UUID | None = None
    po_ref: PaperNo = ""
    material_id: uuid.UUID
    hsn_code: Hsn | None = None
    unit: UnitText | None = None
    quantity: QuantityIn
    rate: MoneyIn
    #: AR: inside the taxable selling price, at the sale's GST rate.
    transport: MoneyIn | None = None
    gst_billed: bool
    gst_rate_pct: GstRateIn | None = None
    #: AT; the customer's own when left out.
    party_gstin: Gstin | None = None
    challan_number: PaperNo = ""
    invoice_number: PaperNo = ""
    po_attachment_id: uuid.UUID | None = None
    dc_attachment_id: uuid.UUID | None = None


class PaymentIn(CamelIn):
    id: uuid.UUID | None = None
    direction: Direction
    party_id: uuid.UUID
    paid_on: dt.date
    mode: Mode
    reference: PaymentRef | None = None
    amount: MoneyIn
    note: Short = ""


class TripIn(CamelIn):
    """One trip of the sheet: its own date, and whatever was written on it."""

    id: uuid.UUID | None = None
    date: dt.date
    start_km: KmIn | None = None
    end_km: KmIn | None = None
    batta: MoneyIn | None = None
    notes: Note = ""
    diesel: list[DieselIn] = Field(default_factory=list, max_length=MAX_LINES)
    en_route: list[EnRouteIn] = Field(default_factory=list, max_length=MAX_LINES)
    purchases: list[PurchaseIn] = Field(default_factory=list, max_length=MAX_LINES)
    sales: list[SaleIn] = Field(default_factory=list, max_length=MAX_LINES)
    payments: list[PaymentIn] = Field(default_factory=list, max_length=MAX_LINES)


class SheetIn(CamelIn):
    """A whole trip sheet. On PUT every list is the full list: a trip or line with an
    id is that one, corrected; one without is new; one left out is deleted."""

    site_id: uuid.UUID
    vehicle_id: Ref
    registration_number: Registration
    vehicle_model: Short = ""
    driver_id: Ref | None = None
    driver_name: Short = ""
    driver_phone: Phone = ""
    start_date: dt.date
    end_date: dt.date | None = None
    start_km: KmIn | None = None
    end_km: KmIn | None = None
    batta: MoneyIn | None = None
    notes: Note = ""
    diesel: list[DieselIn] = Field(default_factory=list, max_length=MAX_LINES)
    en_route: list[EnRouteIn] = Field(default_factory=list, max_length=MAX_LINES)
    payments: list[PaymentIn] = Field(default_factory=list, max_length=MAX_LINES)
    trips: list[TripIn] = Field(default_factory=list, max_length=MAX_LINES)


class CloseIn(CamelIn):
    """Accounts confirming that this customer paid the trip in full."""

    party_id: uuid.UUID


class PartyIn(CamelIn):
    """A customer or a vendor, added from the trip sheet. A firm already in the
    master under this GSTIN takes the role instead of becoming a second party."""

    role: Role
    name: Name
    gstin: Gstin | None = None
    phone: Phone = ""
    contact_name: Short = ""
    #: The site a new customer is served from. Not asked of a vendor.
    site_id: uuid.UUID | None = None
    locations: list[Name] = Field(default_factory=list, max_length=20)


class PartyPatch(CamelIn):
    """A GSTIN or phone typed on a trip line, saved into the master."""

    gstin: Gstin | None = None
    phone: Phone | None = None


class LocationIn(CamelIn):
    name: Name


class MaterialIn(CamelIn):
    code: ItemCode | None = None
    name: Name
    hsn_code: Hsn | None = None
    gst_rate_pct: GstRateIn
    unit: UnitText


class MaterialPatch(CamelIn):
    name: Name | None = None
    hsn_code: Hsn | None = None
    gst_rate_pct: GstRateIn | None = None
    unit: UnitText | None = None
    active: bool | None = None


class GstRateBody(CamelIn):
    rate_pct: GstRateIn


class GstRatePatch(CamelIn):
    active: bool


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
    #: M. Typed: as on the bunk's bill. Linked: the whole fill.
    litres: Number | None
    #: N; for a linked fill, its amount ÷ litres.
    rate: str | None
    #: O = M × N, or the fill's own amount.
    amount: str
    #: False for a rejected or deleted bill: shown, never counted.
    counted: bool
    vendor_id: uuid.UUID | None
    vendor: str
    bill_number: str
    #: An expense bill's date and status.
    bill_date: dt.date | None
    bill_status: str | None
    #: When a fuel entry was filled.
    filled_at: dt.datetime | None
    expense_bill_id: uuid.UUID | None
    fuel_entry_id: str | None
    attachment: TripAttachmentOut | None


class EnRouteOut(CamelModel):
    id: uuid.UUID
    kind: str
    maintenance_kind: str | None
    description: str
    date: dt.date | None
    location: str
    reference: str
    amount: str
    attachment: TripAttachmentOut | None


class PurchaseOut(CamelModel):
    id: uuid.UUID
    vendor_id: uuid.UUID
    vendor_name: str
    location: str
    vendor_gstin: str | None
    material_id: uuid.UUID
    material_name: str
    hsn_code: str | None
    unit: str
    quantity: Number
    rate: str
    gst_billed: bool
    gst_rate_pct: Number
    #: AB, AF, AG.
    amount: str
    gst_amount: str
    total: str
    invoice_number: str
    invoice_date: dt.date | None
    attachments: list[TripAttachmentOut]


class SaleOut(CamelModel):
    id: uuid.UUID
    customer_id: uuid.UUID
    customer_name: str
    location: str
    party_gstin: str | None
    purchase_order_id: uuid.UUID | None
    po_ref: str
    material_id: uuid.UUID
    material_name: str
    hsn_code: str | None
    unit: str
    quantity: Number
    rate: str
    transport: str
    gst_billed: bool
    gst_rate_pct: Number
    #: AO × AQ, then AV, AW, AX.
    amount: str
    taxable: str
    gst_amount: str
    total: str
    challan_number: str
    invoice_number: str
    po_attachment: TripAttachmentOut | None
    dc_attachment: TripAttachmentOut | None


class PaymentOut(CamelModel):
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
    total_en_route: str
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


class LevelCostsOut(CamelModel):
    """What one level wrote down itself, or a trip's share of its sheet's."""

    distance_km: Number | None
    diesel_litres: Number
    diesel: str
    batta: str
    en_route: str


class PartyDueOut(CamelModel):
    party_id: uuid.UUID
    party_name: str
    role: str
    billed: str
    settled: str
    due: str
    #: BC for a customer (pending, paid, closed); BG for a vendor (pending, partial, completed).
    status: str
    closed_by: str | None = None
    closed_at: dt.datetime | None = None


class TripOut(CamelModel):
    id: uuid.UUID
    trip_number: str
    date: dt.date
    start_km: Number | None
    end_km: Number | None
    batta: str | None
    notes: str
    diesel: list[DieselOut]
    en_route: list[EnRouteOut]
    purchases: list[PurchaseOut]
    sales: list[SaleOut]
    payments: list[PaymentOut]
    pl: PlOut
    own: LevelCostsOut
    share: LevelCostsOut | None
    dues: list[PartyDueOut]
    customers: list[str]
    vendors: list[str]
    materials: list[str]


class SheetRowOut(CamelModel):
    """A trip sheet in the list: the header, its P&L and its trips by number."""

    id: uuid.UUID
    sheet_number: str
    site_id: uuid.UUID
    vehicle_id: str
    registration_number: str
    vehicle_model: str
    driver_id: str | None
    driver_name: str
    driver_phone: str
    start_date: dt.date
    end_date: dt.date | None
    start_km: Number | None
    end_km: Number | None
    trip_numbers: list[str]
    customers: list[str]
    vendors: list[str]
    materials: list[str]
    #: How the sheet's own costs were shared out to its trips (km or even); none with no trips.
    basis: str | None
    pl: PlOut
    created_by: str
    created_at: dt.datetime
    updated_at: dt.datetime


class SheetOut(SheetRowOut):
    batta: str | None
    notes: str
    diesel: list[DieselOut]
    en_route: list[EnRouteOut]
    payments: list[PaymentOut]
    own: LevelCostsOut
    dues: list[PartyDueOut]
    unsettled: list[PartyDueOut]
    trips: list[TripOut]


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
    total_en_route: str
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


class SheetListOut(CamelModel):
    rows: list[SheetRowOut]
    total: PlTotalsOut


class TripRowOut(CamelModel):
    """A row of the trip-wise report: a trip; a sheet with no trip yet (its costs only); or
    money paid on a sheet that no trip's bill took (no profit or loss, only the money)."""

    kind: Literal["trip", "sheet", "payment"]
    sheet_id: uuid.UUID
    sheet_number: str
    trip_id: uuid.UUID | None
    trip_number: str | None
    date: dt.date
    vehicle_id: str
    registration_number: str
    driver_name: str
    customers: list[str]
    vendors: list[str]
    materials: list[str]
    pl: PlOut


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
    status: str
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


class LocationOut(CamelModel):
    id: uuid.UUID
    name: str


class PartyOut(CamelModel):
    id: uuid.UUID
    name: str
    gstin: str | None
    phone: str
    contact_name: str
    roles: list[str]
    locations: list[LocationOut]


class MaterialOut(CamelModel):
    id: uuid.UUID
    code: str | None
    name: str
    hsn_code: str | None
    gst_rate_pct: Number
    unit: str
    active: bool


class GstRateOut(CamelModel):
    id: uuid.UUID
    rate_pct: Number
    active: bool


class MastersOut(CamelModel):
    customers: list[PartyOut]
    vendors: list[PartyOut]
    materials: list[MaterialOut]
    gst_rates: list[GstRateOut]


class LinkedSheetOut(CamelModel):
    sheet_id: uuid.UUID
    sheet_number: str


class DieselBillOut(CamelModel):
    """A fleet diesel bill a trip sheet may link, and the sheet that already does."""

    id: uuid.UUID
    bill_number: str
    bill_date: dt.date
    vendor: str
    vehicle_id: str | None
    litres: Number | None
    amount: str
    status: str
    linked_sheet: LinkedSheetOut | None

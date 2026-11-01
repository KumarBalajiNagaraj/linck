"""Trip sheets between the database, the P&L rules and the wire (LIN-22).

Everything here runs inside the request's tenant transaction, so RLS has
already confined every query to the caller's organization; site scoping is a
property of each sheet and is checked by the routes. A refusal raised half way
through a save rolls the whole save back, so a sheet is never stored half done.

Figures are never stored: each read rebuilds the sheet as
app/domain/vehicle_pl.py sees it, so a trip's share of its sheet's diesel,
batta and en-route costs, its P&L and what is due are worked out the same way
wherever they are shown.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, and_, delete, exists, false, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, Scope, TenantCalendar, next_serial
from app.api.customers import gstin_is_valid
from app.api.problems import invalid, needs_permission, refuse
from app.domain import vehicle_pl as pl
from app.models.core import File, Site
from app.models.finance import ExpenseBill, TripPayment
from app.models.logistics import DieselLine, EnRouteExpense, Trip, TripSheet
from app.models.master import GstRate, Item, Party
from app.models.procurement import TripPurchase, TripPurchaseFile
from app.models.sales import PurchaseOrder, TripClosure, TripSale
from app.schemas.common import money, number
from app.schemas.vehicle_pl import (
    DieselIn,
    DieselOut,
    EnRouteIn,
    EnRouteOut,
    LevelCostsOut,
    PartyDueOut,
    PaymentIn,
    PaymentOut,
    PlOut,
    PlTotalsOut,
    PurchaseOut,
    SaleOut,
    SheetIn,
    SheetOut,
    SheetRowOut,
    TripAttachmentOut,
    TripOut,
    TripRowOut,
)
from app.services.expense_bills import METHOD_OF_MODE, MODE_OF_METHOD, size_kb

READ = "fleet.trip_pl.read"
WRITE = "fleet.trip_pl.write"
REPORT = "finance.pl_report.read"
#: Closing a trip a customer paid in full is accounts' confirmation of money received.
CLOSE = "finance.receipt.verify"
#: Who may open a sheet: whoever enters trips there, or the director and accounts.
READ_KEYS = (READ, REPORT)

#: An expense bill in these statuses counts nothing on the sheet that links it.
VOID_BILL = ("rejected", "deleted")


def read_scope(access: Access) -> Scope:
    return access.scope(*READ_KEYS)


def may_read(access: Access, sheet: TripSheet) -> bool:
    return read_scope(access).covers(sheet.site_id)


def attachment_url(file_id: uuid.UUID) -> str:
    return f"/vehicle-pl/attachments/{file_id}"


def _norm_bill(column: ColumnElement[str]) -> ColumnElement[str]:
    """pl.bill_key in SQL: upper case, letters and digits only."""
    return func.upper(func.regexp_replace(column, "[^A-Za-z0-9]", "", "g"))


# ------------------------------------------------------------------ loading


@dataclass
class SheetBundle:
    sheet: TripSheet
    trips: list[Trip]
    diesel: list[DieselLine]
    en_route: list[EnRouteExpense]
    purchases: list[TripPurchase]
    purchase_files: list[TripPurchaseFile]
    sales: list[TripSale]
    payments: list[TripPayment]
    closures: list[TripClosure]

    def of_trip(self, rows: Sequence[Any], trip_id: uuid.UUID | None) -> list[Any]:
        return [r for r in rows if r.trip_id == trip_id]


async def load_bundles(db: AsyncSession, sheet_ids: Sequence[uuid.UUID]) -> list[SheetBundle]:
    """The sheets with every line, in the order asked for."""
    if not sheet_ids:
        return []
    sheets = {s.id: s for s in (await db.scalars(select(TripSheet).where(TripSheet.id.in_(sheet_ids)))).all()}
    trips = (
        await db.scalars(
            select(Trip).where(Trip.trip_sheet_id.in_(sheet_ids)).order_by(Trip.trip_date, Trip.trip_number)
        )
    ).all()
    trip_ids = [t.id for t in trips]

    async def by_sheet(model: Any) -> list[Any]:
        stmt = select(model).where(model.trip_sheet_id.in_(sheet_ids)).order_by(model.position, model.id)
        return list((await db.scalars(stmt)).all())

    async def by_trip(model: Any) -> list[Any]:
        if not trip_ids:
            return []
        order = (model.position, model.id) if hasattr(model, "position") else (model.id,)
        return list(
            (await db.scalars(select(model).where(model.trip_id.in_(trip_ids)).order_by(*order))).all()
        )

    diesel, en_route, payments = (
        await by_sheet(DieselLine),
        await by_sheet(EnRouteExpense),
        await by_sheet(TripPayment),
    )
    purchases, sales, closures = (
        await by_trip(TripPurchase),
        await by_trip(TripSale),
        await by_trip(TripClosure),
    )
    files: list[TripPurchaseFile] = []
    if purchases:
        files = list(
            (
                await db.scalars(
                    select(TripPurchaseFile)
                    .where(TripPurchaseFile.purchase_id.in_([p.id for p in purchases]))
                    .order_by(TripPurchaseFile.created_at, TripPurchaseFile.id)
                )
            ).all()
        )
    sheet_of_trip = {t.id: t.trip_sheet_id for t in trips}
    bundles = []
    for sheet_id in sheet_ids:
        sheet = sheets.get(sheet_id)
        if sheet is None:
            continue
        mine = {t.id for t in trips if t.trip_sheet_id == sheet_id}
        my_purchases = [p for p in purchases if p.trip_id in mine]
        bought = {p.id for p in my_purchases}
        bundles.append(
            SheetBundle(
                sheet=sheet,
                trips=[t for t in trips if t.trip_sheet_id == sheet_id],
                diesel=[d for d in diesel if d.trip_sheet_id == sheet_id],
                en_route=[e for e in en_route if e.trip_sheet_id == sheet_id],
                purchases=my_purchases,
                purchase_files=[f for f in files if f.purchase_id in bought],
                sales=[s for s in sales if sheet_of_trip.get(s.trip_id) == sheet_id],
                payments=[p for p in payments if p.trip_sheet_id == sheet_id],
                closures=[c for c in closures if sheet_of_trip.get(c.trip_id) == sheet_id],
            )
        )
    return bundles


@dataclass
class Context:
    parties: dict[uuid.UUID, Party]
    items: dict[uuid.UUID, Item]
    bills: dict[uuid.UUID, ExpenseBill]
    files: dict[uuid.UUID, File]
    #: Each sheet worked out, by sheet id.
    calcs: dict[str, pl.SheetCalc]


async def _by_id(db: AsyncSession, model: Any, ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, Any]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {r.id: r for r in (await db.scalars(select(model).where(model.id.in_(wanted)))).all()}


def _file_ids(b: SheetBundle) -> list[uuid.UUID | None]:
    return [
        *(f.file_id for f in b.purchase_files),
        *(d.file_id for d in b.diesel),
        *(e.file_id for e in b.en_route),
        *(s.po_file_id for s in b.sales),
        *(s.dc_file_id for s in b.sales),
    ]


async def build_context(db: AsyncSession, bundles: Sequence[SheetBundle]) -> Context:
    party_ids: list[uuid.UUID | None] = []
    item_ids: list[uuid.UUID | None] = []
    bill_ids: list[uuid.UUID | None] = []
    file_ids: list[uuid.UUID | None] = []
    for b in bundles:
        party_ids += [p.vendor_party_id for p in b.purchases] + [s.customer_party_id for s in b.sales]
        party_ids += [p.party_id for p in b.payments] + [d.vendor_party_id for d in b.diesel]
        item_ids += [p.item_id for p in b.purchases] + [s.item_id for s in b.sales]
        bill_ids += [d.expense_bill_id for d in b.diesel]
        file_ids += _file_ids(b)
    bills = await _by_id(db, ExpenseBill, bill_ids)
    return Context(
        parties=await _by_id(db, Party, party_ids),
        items=await _by_id(db, Item, item_ids),
        bills=bills,
        files=await _by_id(db, File, file_ids),
        calcs={str(b.sheet.id): pl.calculate_sheet(domain_sheet(b, bills)) for b in bundles},
    )


def _domain_diesel(d: DieselLine, bills: dict[uuid.UUID, ExpenseBill]) -> pl.DieselLine:
    if d.source == "expense_bill":
        bill = bills.get(d.expense_bill_id) if d.expense_bill_id else None
        return pl.DieselLine(
            id=str(d.id),
            source="expense_bill",
            litres=bill.litres if bill else None,
            amount=bill.amount if bill else None,
            expense_bill_id=str(d.expense_bill_id),
            bill_number=bill.bill_number if bill else None,
            void=bill is None or bill.status in VOID_BILL,
        )
    return pl.DieselLine(
        id=str(d.id),
        source=d.source,
        litres=d.litres,
        rate=d.rate,
        amount=d.amount,
        fuel_entry_id=d.fuel_entry_ref,
        bill_number=d.bill_number or None,
    )


def _domain_costs(
    b: SheetBundle, trip_id: uuid.UUID | None, bills: dict[uuid.UUID, ExpenseBill]
) -> dict[str, Any]:
    return {
        "diesel": tuple(_domain_diesel(d, bills) for d in b.of_trip(b.diesel, trip_id)),
        "en_route": tuple(pl.EnRoute(str(e.id), e.kind, e.amount) for e in b.of_trip(b.en_route, trip_id)),
        "payments": tuple(
            pl.Payment(str(p.id), p.direction, str(p.party_id), p.amount)
            for p in b.of_trip(b.payments, trip_id)
        ),
    }


def domain_sheet(b: SheetBundle, bills: dict[uuid.UUID, ExpenseBill]) -> pl.Sheet:
    """The sheet as the rules see it."""
    trips = tuple(
        pl.Trip(
            id=str(t.id),
            date=t.trip_date.isoformat(),
            trip_number=t.trip_number,
            start_km=t.start_km,
            end_km=t.end_km,
            batta=t.batta,
            purchases=tuple(
                pl.Purchase(
                    str(p.id), str(p.vendor_party_id), p.quantity, p.rate, p.gst_billed, p.gst_rate_pct
                )
                for p in b.purchases
                if p.trip_id == t.id
            ),
            sales=tuple(
                pl.Sale(
                    str(s.id),
                    str(s.customer_party_id),
                    s.quantity,
                    s.rate,
                    s.gst_billed,
                    s.gst_rate_pct,
                    s.transport_amount,
                )
                for s in b.sales
                if s.trip_id == t.id
            ),
            closures=tuple(
                pl.Closure(str(c.customer_party_id), c.billed) for c in b.closures if c.trip_id == t.id
            ),
            **_domain_costs(b, t.id, bills),
        )
        for t in b.trips
    )
    s = b.sheet
    return pl.Sheet(
        id=str(s.id),
        vehicle_id=s.vehicle_ref,
        start_date=s.start_date.isoformat(),
        end_date=s.end_date.isoformat() if s.end_date else None,
        sheet_number=s.sheet_number,
        start_km=s.start_km,
        end_km=s.end_km,
        batta=s.batta,
        trips=trips,
        **_domain_costs(b, None, bills),
    )


# ----------------------------------------------------------------- the wire


def _name(ctx: Context, party_id: uuid.UUID | None) -> str:
    party = ctx.parties.get(party_id) if party_id else None
    return party.display_name if party else ""


def _unique(names: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(n for n in names if n))


def _attachment(ctx: Context, file_id: uuid.UUID | None) -> TripAttachmentOut | None:
    f = ctx.files.get(file_id) if file_id else None
    if f is None:
        return None
    return TripAttachmentOut(
        id=f.id,
        file_name=f.original_name,
        mime_type=f.mime_type,
        size_kb=size_kb(f.size_bytes),
        url=attachment_url(f.id),
    )


def pl_out(p: pl.TripPl) -> PlOut:
    return PlOut.model_validate(p.wire())


def totals_out(t: pl.PlTotals) -> PlTotalsOut:
    return PlTotalsOut.model_validate(t.wire())


def _level_out(c: pl.LevelCosts | None) -> LevelCostsOut | None:
    return None if c is None else LevelCostsOut.model_validate(c.wire())


def _dues_out(
    dues: Sequence[pl.PartyDue], ctx: Context, closures: Sequence[TripClosure] = ()
) -> list[PartyDueOut]:
    closed = {str(c.customer_party_id): c for c in closures}
    out = []
    for d in dues:
        c = closed.get(d.party_id) if d.status == "closed" else None
        out.append(
            PartyDueOut(
                party_id=uuid.UUID(d.party_id),
                party_name=_name(ctx, uuid.UUID(d.party_id)),
                role=d.role,
                billed=money(d.billed),
                settled=money(d.settled),
                due=money(d.due),
                status=d.status,
                closed_by=c.closed_by_name if c else None,
                closed_at=c.closed_at if c else None,
            )
        )
    return out


def _diesel_out(d: DieselLine, ctx: Context, figures: pl.DieselFigures) -> DieselOut:
    bill = ctx.bills.get(d.expense_bill_id) if d.expense_bill_id else None
    f = figures.wire()
    return DieselOut(
        id=d.id,
        source=d.source,
        litres=f["litres"],
        rate=f["rate"],
        amount=f["amount"],
        counted=figures.counted,
        vendor_id=d.vendor_party_id,
        vendor=bill.vendor if bill is not None else (_name(ctx, d.vendor_party_id) or d.vendor),
        bill_number=bill.bill_number if bill is not None else d.bill_number,
        bill_date=bill.bill_date if bill is not None else None,
        bill_status=bill.status if bill is not None else None,
        filled_at=d.filled_at,
        expense_bill_id=d.expense_bill_id,
        fuel_entry_id=d.fuel_entry_ref,
        attachment=_attachment(ctx, d.file_id),
    )


def _en_route_out(e: EnRouteExpense, ctx: Context) -> EnRouteOut:
    return EnRouteOut(
        id=e.id,
        kind=e.kind,
        maintenance_kind=e.maintenance_kind,
        description=e.description,
        date=e.spent_on,
        location=e.location,
        reference=e.reference,
        amount=money(e.amount),
        attachment=_attachment(ctx, e.file_id),
    )


def _payment_out(p: TripPayment, ctx: Context) -> PaymentOut:
    return PaymentOut(
        id=p.id,
        direction=p.direction,
        party_id=p.party_id,
        party_name=_name(ctx, p.party_id),
        paid_on=p.paid_on,
        mode=MODE_OF_METHOD[p.method],
        reference=p.reference_no,
        amount=money(p.amount),
        note=p.note,
    )


def _item_name(ctx: Context, item_id: uuid.UUID) -> str:
    item = ctx.items.get(item_id)
    return item.name if item else ""


def trip_out(t: Trip, b: SheetBundle, ctx: Context, calc: pl.TripCalc) -> TripOut:
    purchases = [p for p in b.purchases if p.trip_id == t.id]
    sales = [s for s in b.sales if s.trip_id == t.id]
    files: dict[uuid.UUID, list[TripAttachmentOut]] = {}
    for pf in b.purchase_files:
        a = _attachment(ctx, pf.file_id)
        if a is not None:
            files.setdefault(pf.purchase_id, []).append(a)
    return TripOut(
        id=t.id,
        trip_number=t.trip_number,
        date=t.trip_date,
        start_km=number(t.start_km),
        end_km=number(t.end_km),
        batta=money(t.batta) if t.batta is not None else None,
        notes=t.notes,
        diesel=[_diesel_out(d, ctx, calc.diesel[str(d.id)]) for d in b.of_trip(b.diesel, t.id)],
        en_route=[_en_route_out(e, ctx) for e in b.of_trip(b.en_route, t.id)],
        purchases=[
            PurchaseOut(
                id=p.id,
                vendor_id=p.vendor_party_id,
                vendor_name=_name(ctx, p.vendor_party_id),
                location=p.location,
                vendor_gstin=p.vendor_gstin,
                material_id=p.item_id,
                material_name=_item_name(ctx, p.item_id),
                hsn_code=p.hsn_code,
                unit=p.unit,
                quantity=number(p.quantity) or 0,
                rate=money(p.rate),
                gst_billed=p.gst_billed,
                gst_rate_pct=number(p.gst_rate_pct) or 0,
                invoice_number=p.invoice_number,
                invoice_date=p.invoice_date,
                attachments=files.get(p.id, []),
                **calc.purchases[str(p.id)].wire(),
            )
            for p in purchases
        ],
        sales=[
            SaleOut(
                id=s.id,
                customer_id=s.customer_party_id,
                customer_name=_name(ctx, s.customer_party_id),
                location=s.location,
                party_gstin=s.party_gstin,
                purchase_order_id=s.purchase_order_id,
                po_ref=s.po_ref,
                material_id=s.item_id,
                material_name=_item_name(ctx, s.item_id),
                hsn_code=s.hsn_code,
                unit=s.unit,
                quantity=number(s.quantity) or 0,
                rate=money(s.rate),
                gst_billed=s.gst_billed,
                gst_rate_pct=number(s.gst_rate_pct) or 0,
                challan_number=s.challan_number,
                invoice_number=s.invoice_number,
                po_attachment=_attachment(ctx, s.po_file_id),
                dc_attachment=_attachment(ctx, s.dc_file_id),
                **calc.sales[str(s.id)].wire(),
            )
            for s in sales
        ],
        payments=[_payment_out(p, ctx) for p in b.of_trip(b.payments, t.id)],
        pl=pl_out(calc.pl),
        own=_level_out(calc.own),  # type: ignore[arg-type]
        share=_level_out(calc.share),
        dues=_dues_out(calc.dues, ctx, [c for c in b.closures if c.trip_id == t.id]),
        customers=_unique(_name(ctx, s.customer_party_id) for s in sales),
        vendors=_unique(_name(ctx, p.vendor_party_id) for p in purchases),
        materials=_unique(_item_name(ctx, i.item_id) for i in [*purchases, *sales]),
    )


def _row_fields(b: SheetBundle, ctx: Context) -> dict[str, Any]:
    s = b.sheet
    calc = ctx.calcs[str(s.id)]
    return {
        "id": s.id,
        "sheet_number": s.sheet_number,
        "site_id": s.site_id,
        "vehicle_id": s.vehicle_ref,
        "registration_number": s.registration_number,
        "vehicle_model": s.vehicle_model,
        "driver_id": s.driver_ref,
        "driver_name": s.driver_name,
        "driver_phone": s.driver_phone,
        "start_date": s.start_date,
        "end_date": s.end_date,
        "start_km": number(s.start_km),
        "end_km": number(s.end_km),
        "trip_numbers": [t.trip_number for t in b.trips],
        "customers": _unique(_name(ctx, x.customer_party_id) for x in b.sales),
        "vendors": _unique(_name(ctx, x.vendor_party_id) for x in b.purchases),
        "materials": _unique(_item_name(ctx, x.item_id) for x in [*b.purchases, *b.sales]),
        "basis": calc.basis,
        "pl": pl_out(calc.pl),
        "created_by": s.created_by_name,
        "created_at": s.created_at,
        "updated_at": s.updated_at,
    }


def sheet_row(b: SheetBundle, ctx: Context) -> SheetRowOut:
    return SheetRowOut(**_row_fields(b, ctx))


def sheet_out(b: SheetBundle, ctx: Context) -> SheetOut:
    calc = ctx.calcs[str(b.sheet.id)]
    return SheetOut(
        **_row_fields(b, ctx),
        batta=money(b.sheet.batta) if b.sheet.batta is not None else None,
        notes=b.sheet.notes,
        diesel=[_diesel_out(d, ctx, calc.diesel[str(d.id)]) for d in b.of_trip(b.diesel, None)],
        en_route=[_en_route_out(e, ctx) for e in b.of_trip(b.en_route, None)],
        payments=[_payment_out(p, ctx) for p in b.of_trip(b.payments, None)],
        own=_level_out(calc.own),  # type: ignore[arg-type]
        dues=_dues_out(calc.dues, ctx),
        unsettled=_dues_out(calc.unsettled, ctx),
        trips=[trip_out(t, b, ctx, calc.trips[str(t.id)]) for t in b.trips],
    )


# ------------------------------------------------------------------ reports


@dataclass
class SheetFilter:
    date_from: date | None = None
    date_to: date | None = None
    vehicle_id: str | None = None
    customer_id: uuid.UUID | None = None
    vendor_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    q: str | None = None
    limit: int = 500


def _like(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _search(q: str) -> ColumnElement[bool]:
    """A sheet by its number, a trip's number, the vehicle, the driver, or anyone or anything on its lines."""
    like = _like(q)
    plate = _like("".join(q.split()).upper())
    in_sheet = Trip.trip_sheet_id == TripSheet.id
    sold = (
        select(TripSale.id)
        .join(Trip, Trip.id == TripSale.trip_id)
        .join(Party, Party.id == TripSale.customer_party_id)
        .join(Item, Item.id == TripSale.item_id)
        .where(
            in_sheet,
            or_(
                Party.display_name.ilike(like, escape="\\"),
                Item.name.ilike(like, escape="\\"),
                TripSale.location.ilike(like, escape="\\"),
                TripSale.po_ref.ilike(like, escape="\\"),
                TripSale.challan_number.ilike(like, escape="\\"),
                TripSale.invoice_number.ilike(like, escape="\\"),
            ),
        )
    )
    bought = (
        select(TripPurchase.id)
        .join(Trip, Trip.id == TripPurchase.trip_id)
        .join(Party, Party.id == TripPurchase.vendor_party_id)
        .join(Item, Item.id == TripPurchase.item_id)
        .where(
            in_sheet,
            or_(
                Party.display_name.ilike(like, escape="\\"),
                Item.name.ilike(like, escape="\\"),
                TripPurchase.location.ilike(like, escape="\\"),
                TripPurchase.invoice_number.ilike(like, escape="\\"),
            ),
        )
    )
    numbered = select(Trip.id).where(in_sheet, Trip.trip_number.ilike(like, escape="\\"))
    return or_(
        TripSheet.sheet_number.ilike(like, escape="\\"),
        func.replace(TripSheet.registration_number, " ", "").ilike(plate, escape="\\"),
        TripSheet.vehicle_model.ilike(like, escape="\\"),
        TripSheet.driver_name.ilike(like, escape="\\"),
        TripSheet.notes.ilike(like, escape="\\"),
        exists(numbered),
        exists(sold),
        exists(bought),
    )


async def find_sheet_ids(db: AsyncSession, scope: Scope, f: SheetFilter) -> list[uuid.UUID]:
    """Sheets in scope that match, the latest first. A sheet is in a period when it
    starts in it or has a trip dated in it."""
    stmt = select(TripSheet.id).where(scope.clause(TripSheet.site_id))
    if f.date_from or f.date_to:
        trip_dated = select(Trip.id).where(Trip.trip_sheet_id == TripSheet.id)
        if f.date_from:
            trip_dated = trip_dated.where(Trip.trip_date >= f.date_from)
        if f.date_to:
            trip_dated = trip_dated.where(Trip.trip_date <= f.date_to)
        starts = []
        if f.date_from:
            starts.append(TripSheet.start_date >= f.date_from)
        if f.date_to:
            starts.append(TripSheet.start_date <= f.date_to)
        stmt = stmt.where(or_(exists(trip_dated), and_(*starts)))
    if f.vehicle_id:
        stmt = stmt.where(TripSheet.vehicle_ref == f.vehicle_id)
    if f.site_id:
        stmt = stmt.where(TripSheet.site_id == f.site_id)
    if f.customer_id:
        stmt = stmt.where(
            exists(
                select(TripSale.id)
                .join(Trip, Trip.id == TripSale.trip_id)
                .where(Trip.trip_sheet_id == TripSheet.id, TripSale.customer_party_id == f.customer_id)
            )
        )
    if f.vendor_id:
        stmt = stmt.where(
            exists(
                select(TripPurchase.id)
                .join(Trip, Trip.id == TripPurchase.trip_id)
                .where(Trip.trip_sheet_id == TripSheet.id, TripPurchase.vendor_party_id == f.vendor_id)
            )
        )
    if f.q and f.q.strip():
        stmt = stmt.where(_search(f.q.strip()))
    stmt = stmt.order_by(TripSheet.start_date.desc(), TripSheet.sheet_number.desc()).limit(f.limit)
    return list((await db.scalars(stmt)).all())


@dataclass
class Unit:
    """A pl.PlUnit with the rows it came from, for the reports."""

    unit: pl.PlUnit
    bundle: SheetBundle
    trip: Trip | None


def units_of(bundles: Sequence[SheetBundle], ctx: Context, f: SheetFilter) -> list[Unit]:
    """The trips (and trip-less sheets, and unsettled sheet payments) the reports add up, as filtered.

    A trip is in the period by its own date; a search or a customer or vendor
    filter keeps the trips that match it, not every trip of a matching sheet.
    """
    by_id = {str(b.sheet.id): b for b in bundles}
    sheets = [domain_sheet(b, ctx.bills) for b in bundles]
    out: list[Unit] = []
    needle = (f.q or "").strip().lower()
    for unit in pl.pl_units(sheets, ctx.calcs):
        b = by_id[unit.sheet_id]
        trip = next((t for t in b.trips if str(t.id) == unit.trip_id), None) if unit.trip_id else None
        day = date.fromisoformat(unit.date)
        if (f.date_from and day < f.date_from) or (f.date_to and day > f.date_to):
            continue
        sales = [s for s in b.sales if trip is not None and s.trip_id == trip.id]
        purchases = [p for p in b.purchases if trip is not None and p.trip_id == trip.id]
        if f.customer_id and not any(s.customer_party_id == f.customer_id for s in sales):
            continue
        if f.vendor_id and not any(p.vendor_party_id == f.vendor_id for p in purchases):
            continue
        if needle:
            words = [
                b.sheet.sheet_number,
                b.sheet.registration_number,
                b.sheet.registration_number.replace(" ", ""),
                b.sheet.vehicle_model,
                b.sheet.driver_name,
                trip.trip_number if trip else "",
                *(_name(ctx, s.customer_party_id) for s in sales),
                *(_name(ctx, p.vendor_party_id) for p in purchases),
                *(_item_name(ctx, x.item_id) for x in [*sales, *purchases]),
                *(x.location for x in [*sales, *purchases]),
                *(x.invoice_number for x in [*sales, *purchases]),
                *(s.po_ref for s in sales),
                *(s.challan_number for s in sales),
            ]
            if not any(needle in w.lower() for w in words if w):
                continue
        out.append(Unit(unit, b, trip))
    return out


def trip_row(u: Unit, ctx: Context) -> TripRowOut:
    b, t = u.bundle, u.trip
    sales = [s for s in b.sales if t is not None and s.trip_id == t.id]
    purchases = [p for p in b.purchases if t is not None and p.trip_id == t.id]
    return TripRowOut(
        kind="trip" if t is not None else ("sheet" if not b.trips else "payment"),
        sheet_id=b.sheet.id,
        sheet_number=b.sheet.sheet_number,
        trip_id=t.id if t else None,
        trip_number=t.trip_number if t else None,
        date=date.fromisoformat(u.unit.date),
        vehicle_id=b.sheet.vehicle_ref,
        registration_number=b.sheet.registration_number,
        driver_name=b.sheet.driver_name,
        customers=_unique(_name(ctx, s.customer_party_id) for s in sales),
        vendors=_unique(_name(ctx, p.vendor_party_id) for p in purchases),
        materials=_unique(_item_name(ctx, x.item_id) for x in [*purchases, *sales]),
        pl=pl_out(u.unit.pl),
    )


def latest_vehicle(bundles: Sequence[SheetBundle]) -> dict[str, TripSheet]:
    """Each vehicle's latest sheet, for its registration number and model as they are now."""
    latest: dict[str, TripSheet] = {}
    for b in bundles:
        current = latest.get(b.sheet.vehicle_ref)
        if current is None or (b.sheet.start_date, b.sheet.sheet_number) > (
            current.start_date,
            current.sheet_number,
        ):
            latest[b.sheet.vehicle_ref] = b.sheet
    return latest


# ------------------------------------------------------------------- saving


def _positive(value: Decimal | float | int | None, field_name: str) -> Decimal:
    if value is None or Decimal(str(value)) <= 0:
        raise invalid(field_name, "must be more than zero")
    return Decimal(str(value))


def _not_after_today(day: date | None, calendar: TenantCalendar, field_name: str) -> None:
    if day is not None and day > calendar.today():
        raise invalid(field_name, "after today")


def _km_in_order(start: Decimal | None, end: Decimal | None, where: str) -> None:
    if start is not None and end is not None and end < start:
        raise invalid(f"{where}endKm", "less than the start km")


@dataclass
class _Line:
    """A line of the request, where it sits, and the row it corrects."""

    where: str
    trip_index: int | None
    body: Any


def _lines(body: SheetIn, section: str) -> list[_Line]:
    """A section's lines on the sheet and on each trip, each named as the wire names it."""
    wire = {"en_route": "enRoute"}.get(section, section)
    out = [_Line(f"{wire}[{i}]", None, line) for i, line in enumerate(getattr(body, section))]
    for ti, trip in enumerate(body.trips):
        out += [_Line(f"trips[{ti}].{wire}[{i}]", ti, line) for i, line in enumerate(getattr(trip, section))]
    return out


def _match_ids(lines: Sequence[_Line], existing: dict[uuid.UUID, Any]) -> None:
    seen: set[uuid.UUID] = set()
    for line in lines:
        line_id = line.body.id
        if line_id is None:
            continue
        if line_id not in existing:
            raise invalid(f"{line.where}.id", "not a line of this sheet")
        if line_id in seen:
            raise invalid(f"{line.where}.id", "a line appears twice")
        seen.add(line_id)


async def _check_diesel(
    db: AsyncSession,
    body: SheetIn,
    sheet_id: uuid.UUID | None,
    lines: Sequence[_Line],
    old: dict[uuid.UUID, DieselLine],
) -> dict[str, ExpenseBill]:
    """Each diesel line as it may be stored; returns the expense bills linked, by line."""
    bills: dict[str, ExpenseBill] = {}
    already = {d.expense_bill_id for d in old.values() if d.expense_bill_id}
    for line in lines:
        d: DieselIn = line.body
        where = line.where
        if d.source == "typed":
            if (
                any(v is not None for v in (d.amount, d.expense_bill_id, d.fuel_entry_id, d.filled_at))
                or d.vendor
            ):
                raise invalid(
                    where, "a typed line has litres, a rate, a vendor and a bill number, nothing else"
                )
            _positive(d.litres, f"{where}.litres")
            _positive(d.rate, f"{where}.rate")
            continue
        if d.vendor_id is not None or d.attachment_id is not None:
            raise invalid(where, "a linked fill's vendor and photo are its own")
        if d.source == "expense_bill":
            if d.expense_bill_id is None:
                raise invalid(f"{where}.expenseBillId", "required")
            # Never typed again: the bill's own figures are the only ones.
            if any(v is not None for v in (d.litres, d.rate, d.amount, d.fuel_entry_id, d.filled_at)) or (
                d.vendor or d.bill_number
            ):
                raise invalid(where, "a linked bill's figures come from the bill")
            bill = await db.get(ExpenseBill, d.expense_bill_id, populate_existing=True)
            if bill is None:
                raise invalid(f"{where}.expenseBillId", "no such bill")
            if bill.desk != "fleet" or bill.kind != "diesel":
                raise invalid(f"{where}.expenseBillId", "not a diesel bill")
            if bill.vehicle_ref is not None and bill.vehicle_ref != body.vehicle_id:
                raise refuse(
                    {
                        "code": "diesel-other-vehicle",
                        "field": where,
                        "billNumber": bill.bill_number,
                        "vehicleId": bill.vehicle_ref,
                    }
                )
            # A rejected or deleted bill stays on a sheet that already links it,
            # counting nothing; it cannot be linked anew.
            if bill.status in VOID_BILL and bill.id not in already:
                raise refuse(
                    {
                        "code": "diesel-bill-void",
                        "field": where,
                        "billNumber": bill.bill_number,
                        "status": bill.status,
                    }
                )
            bills[where] = bill
            continue
        if not d.fuel_entry_id:
            raise invalid(f"{where}.fuelEntryId", "required")
        if d.expense_bill_id is not None or d.rate is not None:
            raise invalid(where, "a fuel entry has its litres and amount, nothing else")
        _positive(d.litres, f"{where}.litres")
        _positive(d.amount, f"{where}.amount")

    # A fill is linked once per tenant: on another sheet, it is that sheet's.
    bill_ids = [b.id for b in bills.values()]
    fuel_refs = [ln.body.fuel_entry_id for ln in lines if ln.body.source == "fuel_entry"]
    if bill_ids or fuel_refs:
        stmt = (
            select(
                DieselLine.expense_bill_id, DieselLine.fuel_entry_ref, TripSheet.id, TripSheet.sheet_number
            )
            .join(TripSheet, TripSheet.id == DieselLine.trip_sheet_id)
            .where(
                or_(
                    DieselLine.expense_bill_id.in_(bill_ids) if bill_ids else false(),
                    DieselLine.fuel_entry_ref.in_(fuel_refs) if fuel_refs else false(),
                )
            )
        )
        if sheet_id is not None:
            stmt = stmt.where(DieselLine.trip_sheet_id != sheet_id)
        for bill_id, fuel_ref, other_id, other_number in (await db.execute(stmt)).all():
            line = next(
                ln
                for ln in lines
                if (bill_id is not None and ln.where in bills and bills[ln.where].id == bill_id)
                or (fuel_ref is not None and ln.body.fuel_entry_id == fuel_ref)
            )
            raise refuse(
                {
                    "code": "diesel-linked-elsewhere",
                    "field": line.where,
                    "sheetId": str(other_id),
                    "sheetNumber": other_number,
                }
            )
    return bills


def _wire_diesel(where: str, d: DieselIn, bills: dict[str, ExpenseBill]) -> pl.DieselLine:
    bill = bills.get(where)
    if bill is not None:
        return pl.DieselLine(
            id=where,
            source="expense_bill",
            litres=bill.litres,
            amount=bill.amount,
            expense_bill_id=str(bill.id),
            bill_number=bill.bill_number,
        )
    return pl.DieselLine(
        id=where,
        source=d.source,
        litres=d.litres,
        rate=d.rate,
        amount=d.amount,
        fuel_entry_id=d.fuel_entry_id,
        bill_number=d.bill_number or None,
    )


async def _check_double_counts(
    db: AsyncSession,
    body: SheetIn,
    sheet_id: uuid.UUID | None,
    lines: Sequence[_Line],
    bills: dict[str, ExpenseBill],
) -> None:
    """findDoubleCounts over the sheet as it would be stored, against the bills in
    Linck and the vehicle's other sheets: the first problem refuses the save."""
    by_trip: dict[int | None, list[pl.DieselLine]] = {}
    for line in lines:
        by_trip.setdefault(line.trip_index, []).append(_wire_diesel(line.where, line.body, bills))
    candidate = pl.Sheet(
        id=str(sheet_id or "new"),
        vehicle_id=body.vehicle_id,
        start_date=body.start_date.isoformat(),
        diesel=tuple(by_trip.get(None, [])),
        trips=tuple(
            pl.Trip(
                id=f"trip-{i}",
                date=t.date.isoformat(),
                trip_number=f"{i:04d}",
                diesel=tuple(by_trip.get(i, [])),
            )
            for i, t in enumerate(body.trips)
        ),
    )
    typed_keys = {pl.bill_key(ln.body.bill_number) for ln in lines if ln.body.source == "typed"} - {""}
    known: list[pl.KnownDieselBill] = []
    others: list[pl.OtherSheetDiesel] = []
    if typed_keys:
        rows = await db.execute(
            select(ExpenseBill.id, ExpenseBill.bill_number, ExpenseBill.vehicle_ref).where(
                ExpenseBill.desk == "fleet",
                ExpenseBill.kind == "diesel",
                ExpenseBill.status.notin_(VOID_BILL),
                _norm_bill(ExpenseBill.bill_number).in_(typed_keys),
            )
        )
        known = [pl.KnownDieselBill(str(i), n, v) for i, n, v in rows.all()]
        stmt = (
            select(TripSheet.id, TripSheet.sheet_number, DieselLine.bill_number)
            .join(DieselLine, DieselLine.trip_sheet_id == TripSheet.id)
            .where(
                TripSheet.vehicle_ref == body.vehicle_id,
                DieselLine.source == "typed",
                _norm_bill(DieselLine.bill_number).in_(typed_keys),
            )
        )
        if sheet_id is not None:
            stmt = stmt.where(TripSheet.id != sheet_id)
        grouped: dict[tuple[str, str], list[str]] = {}
        for other_id, number_, bill_number in (await db.execute(stmt)).all():
            grouped.setdefault((str(other_id), number_), []).append(bill_number)
        others = [
            pl.OtherSheetDiesel(i, n, body.vehicle_id, tuple(numbers))
            for (i, n), numbers in sorted(grouped.items())
        ]
    problems = pl.find_double_counts(candidate, known, others)
    if problems:
        located = [{**{k: v for k, v in p.items() if k != "lineId"}, "field": p["lineId"]} for p in problems]
        raise refuse({**located[0], "problems": located})


async def _check_attachments(
    db: AsyncSession, access: Access, wanted: dict[str, list[tuple[uuid.UUID, set[uuid.UUID]]]]
) -> None:
    """Every photo named is a trip paper; one not already on that line is the caller's own,
    and on no other line yet. `wanted` is field → [(file id, the ids already on that line)]."""
    named = [(field, file_id, mine) for field, pairs in wanted.items() for file_id, mine in pairs]
    ids = [file_id for _, file_id, _ in named]
    if len(ids) != len(set(ids)):
        raise invalid(next(f for f, i, _ in named if ids.count(i) > 1), "a photo appears twice")
    if not ids:
        return
    files = await _by_id(db, File, ids)
    used: set[uuid.UUID] = set()
    for column in (
        TripPurchaseFile.file_id,
        DieselLine.file_id,
        EnRouteExpense.file_id,
        TripSale.po_file_id,
        TripSale.dc_file_id,
    ):
        used |= {r for r in (await db.scalars(select(column).where(column.in_(ids)))).all() if r is not None}
    for field, file_id, mine in named:
        f = files.get(file_id)
        if f is None or f.purpose != "trip_document":
            raise invalid(field, "no such upload")
        if file_id in mine:
            continue
        if f.uploaded_by != access.user_id or file_id in used:
            raise invalid(field, "no such upload of yours")


def _check_en_route(lines: Sequence[_Line]) -> None:
    for line in lines:
        e: EnRouteIn = line.body
        if (e.kind == "maintenance") != (e.maintenance_kind is not None):
            raise invalid(f"{line.where}.maintenanceKind", "required for maintenance, and only there")
        if e.maintenance_kind == "misc" and not e.description:
            raise invalid(f"{line.where}.description", "say what the maintenance was")
        _positive(e.amount, f"{line.where}.amount")


async def save_sheet(
    db: AsyncSession, access: Access, calendar: TenantCalendar, body: SheetIn, existing: SheetBundle | None
) -> uuid.UUID:
    """Store the sheet as the page holds it: header, trips, every line."""
    organization_id = access.organization_id
    if not access.can(WRITE, body.site_id) or (
        existing is not None and not access.can(WRITE, existing.sheet.site_id)
    ):
        raise needs_permission(WRITE)
    if await db.get(Site, body.site_id) is None:
        raise invalid("siteId", "no such site")
    _not_after_today(body.start_date, calendar, "startDate")
    _not_after_today(body.end_date, calendar, "endDate")
    if body.end_date is not None and body.end_date < body.start_date:
        raise invalid("endDate", "before the start date")
    _km_in_order(body.start_km, body.end_km, "")
    last_day = body.end_date or calendar.today()
    sheet_id = existing.sheet.id if existing else None

    # ----- trips and line ids
    old_trips = {t.id: t for t in existing.trips} if existing else {}
    seen_trips: set[uuid.UUID] = set()
    for i, t in enumerate(body.trips):
        if t.id is not None and (t.id not in old_trips or t.id in seen_trips):
            raise invalid(f"trips[{i}].id", "not a trip of this sheet")
        if t.id is not None:
            seen_trips.add(t.id)
        if t.date < body.start_date or t.date > last_day:
            raise invalid(f"trips[{i}].date", "outside the sheet's dates")
        _km_in_order(t.start_km, t.end_km, f"trips[{i}].")

    diesel_lines, en_route_lines, payment_lines = (
        _lines(body, "diesel"),
        _lines(body, "en_route"),
        _lines(body, "payments"),
    )
    purchase_lines = [
        _Line(f"trips[{ti}].purchases[{i}]", ti, p)
        for ti, t in enumerate(body.trips)
        for i, p in enumerate(t.purchases)
    ]
    sale_lines = [
        _Line(f"trips[{ti}].sales[{i}]", ti, s)
        for ti, t in enumerate(body.trips)
        for i, s in enumerate(t.sales)
    ]
    old_diesel = {d.id: d for d in existing.diesel} if existing else {}
    old_en_route = {e.id: e for e in existing.en_route} if existing else {}
    old_payments = {p.id: p for p in existing.payments} if existing else {}
    old_purchases = {p.id: p for p in existing.purchases} if existing else {}
    old_sales = {s.id: s for s in existing.sales} if existing else {}
    _match_ids(diesel_lines, old_diesel)
    _match_ids(en_route_lines, old_en_route)
    _match_ids(payment_lines, old_payments)
    _match_ids(purchase_lines, old_purchases)
    _match_ids(sale_lines, old_sales)

    # ----- masters
    parties = await _by_id(
        db,
        Party,
        [ln.body.vendor_id for ln in purchase_lines]
        + [ln.body.customer_id for ln in sale_lines]
        + [ln.body.party_id for ln in payment_lines]
        + [ln.body.vendor_id for ln in diesel_lines],
    )
    items = await _by_id(db, Item, [ln.body.material_id for ln in [*purchase_lines, *sale_lines]])
    rates = {r.rate_pct: r.is_active for r in (await db.scalars(select(GstRate))).all()}

    def party(party_id: uuid.UUID, role: str, field: str) -> Party:
        p = parties.get(party_id)
        if p is None or role not in p.party_roles:
            raise invalid(field, f"not a {role}")
        return p

    def material(line: _Line, old: dict[uuid.UUID, Any]) -> Item:
        item = items.get(line.body.material_id)
        if item is None:
            raise invalid(f"{line.where}.materialId", "no such material")
        prior = old.get(line.body.id) if line.body.id else None
        if not item.is_active and (prior is None or prior.item_id != item.id):
            raise invalid(f"{line.where}.materialId", "no longer in use")
        return item

    def gst_rate(line: _Line, item: Item, old: dict[uuid.UUID, Any]) -> Decimal:
        """AE / AU: one of the tenant's rates. A rate switched off stays on a line already billed at it."""
        if not line.body.gst_billed:
            return Decimal(0)
        rate = line.body.gst_rate_pct if line.body.gst_rate_pct is not None else item.gst_rate_pct
        prior = old.get(line.body.id) if line.body.id else None
        if rate not in rates:
            raise invalid(f"{line.where}.gstRatePct", "not one of your GST rates")
        if not rates[rate] and (prior is None or not prior.gst_billed or prior.gst_rate_pct != rate):
            raise invalid(f"{line.where}.gstRatePct", "that GST rate is switched off")
        return rate

    def gstin(value: str | None, field: str) -> str | None:
        if value is not None and not gstin_is_valid(value):
            raise invalid(field, "not a valid GSTIN")
        return value

    purchase_values: list[dict[str, Any]] = []
    for line in purchase_lines:
        p = line.body
        vendor = party(p.vendor_id, "vendor", f"{line.where}.vendorId")
        item = material(line, old_purchases)
        vendor_gstin = gstin(p.vendor_gstin or vendor.gstin, f"{line.where}.vendorGstin")
        if p.gst_billed and vendor_gstin is None:
            raise invalid(f"{line.where}.vendorGstin", "required on a GST bill")
        _positive(p.quantity, f"{line.where}.quantity")
        _positive(p.rate, f"{line.where}.rate")
        _not_after_today(p.invoice_date, calendar, f"{line.where}.invoiceDate")
        purchase_values.append(
            {
                "vendor_party_id": vendor.id,
                "location": p.location,
                "item_id": item.id,
                "hsn_code": p.hsn_code or item.hsn_code,
                "unit": p.unit or item.unit,
                "quantity": Decimal(str(p.quantity)),
                "rate": p.rate,
                "gst_billed": p.gst_billed,
                "gst_rate_pct": gst_rate(line, item, old_purchases),
                "vendor_gstin": vendor_gstin if p.gst_billed or p.vendor_gstin else None,
                "invoice_number": p.invoice_number,
                "invoice_date": p.invoice_date,
            }
        )

    order_ids = [ln.body.purchase_order_id for ln in sale_lines if ln.body.purchase_order_id]
    orders = await _by_id(db, PurchaseOrder, order_ids)
    sale_values: list[dict[str, Any]] = []
    for line in sale_lines:
        s = line.body
        customer = party(s.customer_id, "customer", f"{line.where}.customerId")
        item = material(line, old_sales)
        if s.purchase_order_id is not None:
            order = orders.get(s.purchase_order_id)
            if order is None or order.customer_party_id != customer.id:
                raise invalid(f"{line.where}.purchaseOrderId", "not an order of this customer")
        _positive(s.quantity, f"{line.where}.quantity")
        _positive(s.rate, f"{line.where}.rate")
        sale_values.append(
            {
                "customer_party_id": customer.id,
                "location": s.location,
                "purchase_order_id": s.purchase_order_id,
                "po_ref": s.po_ref,
                "item_id": item.id,
                "hsn_code": s.hsn_code or item.hsn_code,
                "unit": s.unit or item.unit,
                "quantity": Decimal(str(s.quantity)),
                "rate": s.rate,
                "transport_amount": s.transport or Decimal(0),
                "gst_billed": s.gst_billed,
                "gst_rate_pct": gst_rate(line, item, old_sales),
                "party_gstin": gstin(s.party_gstin or customer.gstin, f"{line.where}.partyGstin"),
                "challan_number": s.challan_number,
                "invoice_number": s.invoice_number,
                "po_file_id": s.po_attachment_id,
                "dc_file_id": s.dc_attachment_id,
            }
        )

    # Who a trip's money can be with: its own customers and vendors; on the sheet, any.
    references: set[str] = set()
    for line in payment_lines:
        m: PaymentIn = line.body
        role = "customer" if m.direction == "in" else "vendor"
        party(m.party_id, role, f"{line.where}.partyId")
        if line.trip_index is not None:
            trip = body.trips[line.trip_index]
            on_trip = (
                {s.customer_id for s in trip.sales}
                if role == "customer"
                else {p.vendor_id for p in trip.purchases}
            )
            if m.party_id not in on_trip:
                raise invalid(f"{line.where}.partyId", f"not a {role} of this trip")
        _not_after_today(m.paid_on, calendar, f"{line.where}.paidOn")
        if m.reference is not None:
            if m.reference in references:
                raise refuse({"code": "reference-used", "field": line.where, "reference": m.reference})
            references.add(m.reference)
    _check_en_route(en_route_lines)
    for line in en_route_lines:
        _not_after_today(line.body.date, calendar, f"{line.where}.date")
    for line in diesel_lines:
        if line.body.source == "typed" and line.body.vendor_id is not None:
            party(line.body.vendor_id, "vendor", f"{line.where}.vendorId")

    # ----- photos
    old_files: dict[uuid.UUID, set[uuid.UUID]] = {}
    if existing:
        for pf in existing.purchase_files:
            old_files.setdefault(pf.purchase_id, set()).add(pf.file_id)
    wanted: dict[str, list[tuple[uuid.UUID, set[uuid.UUID]]]] = {}

    def on_line(row: Any, *columns: str) -> set[uuid.UUID]:
        return {getattr(row, c) for c in columns if row is not None and getattr(row, c) is not None}

    for line in purchase_lines:
        wanted[f"{line.where}.attachmentIds"] = [
            (f, old_files.get(line.body.id, set())) for f in line.body.attachment_ids
        ]
    for line in sale_lines:
        prior = old_sales.get(line.body.id) if line.body.id else None
        for key, wire in (("po_attachment_id", "poAttachmentId"), ("dc_attachment_id", "dcAttachmentId")):
            if getattr(line.body, key) is not None:
                wanted[f"{line.where}.{wire}"] = [
                    (getattr(line.body, key), on_line(prior, "po_file_id", "dc_file_id"))
                ]
    for lines_, olds in ((diesel_lines, old_diesel), (en_route_lines, old_en_route)):
        for line in lines_:
            if line.body.attachment_id is not None:
                prior = olds.get(line.body.id) if line.body.id else None
                wanted[f"{line.where}.attachmentId"] = [(line.body.attachment_id, on_line(prior, "file_id"))]
    await _check_attachments(db, access, wanted)

    # ----- diesel, never counted twice
    bills = await _check_diesel(db, body, sheet_id, diesel_lines, old_diesel)
    await _check_double_counts(db, body, sheet_id, diesel_lines, bills)

    # ----- writes
    header = {
        "site_id": body.site_id,
        "vehicle_ref": body.vehicle_id,
        "registration_number": body.registration_number,
        "vehicle_model": body.vehicle_model,
        "driver_ref": body.driver_id,
        "driver_name": body.driver_name,
        "driver_phone": body.driver_phone,
        "start_date": body.start_date,
        "end_date": body.end_date,
        "start_km": body.start_km,
        "end_km": body.end_km,
        "batta": body.batta,
        "notes": body.notes,
        "rules_version": pl.PL_RULES_VERSION,
    }
    if existing is None:
        year = calendar.financial_year(body.start_date)
        serial = await next_serial(db, "logistics.trip_sheets", organization_id, year)
        sheet = TripSheet(
            id=uuid.uuid4(),
            organization_id=organization_id,
            financial_year=year,
            serial=serial,
            sheet_number=f"TS/{year}/{serial:04d}",
            created_by=access.user_id,
            created_by_name=access.name,
            **header,
        )
        db.add(sheet)
    else:
        sheet = existing.sheet
        for key, value in header.items():
            setattr(sheet, key, value)
    await db.flush()

    trip_rows: list[Trip] = []
    for t in body.trips:
        values = {
            "trip_date": t.date,
            "start_km": t.start_km,
            "end_km": t.end_km,
            "batta": t.batta,
            "notes": t.notes,
        }
        if t.id is not None:
            row = old_trips[t.id]
            for key, value in values.items():
                setattr(row, key, value)
        else:
            year = calendar.financial_year(t.date)
            serial = await next_serial(db, "logistics.trips", organization_id, year)
            row = Trip(
                id=uuid.uuid4(),
                organization_id=organization_id,
                trip_sheet_id=sheet.id,
                financial_year=year,
                serial=serial,
                trip_number=f"TRP/{year}/{serial:04d}",
                **values,
            )
            db.add(row)
        await db.flush()
        trip_rows.append(row)

    def trip_id_of(line: _Line) -> uuid.UUID | None:
        return None if line.trip_index is None else trip_rows[line.trip_index].id

    base = {"organization_id": organization_id}
    gone_purchases = [i for i in old_purchases if i not in {ln.body.id for ln in purchase_lines}]
    if gone_purchases:
        await db.execute(delete(TripPurchaseFile).where(TripPurchaseFile.purchase_id.in_(gone_purchases)))
    purchases = await _sync(
        db,
        TripPurchase,
        old_purchases,
        [
            (ln.body.id, {"trip_id": trip_id_of(ln), "position": i, **v})
            for i, (ln, v) in enumerate(zip(purchase_lines, purchase_values, strict=True))
        ],
        base,
    )
    await _sync(
        db,
        TripSale,
        old_sales,
        [
            (ln.body.id, {"trip_id": trip_id_of(ln), "position": i, **v})
            for i, (ln, v) in enumerate(zip(sale_lines, sale_values, strict=True))
        ],
        base,
    )
    await _sync(
        db,
        DieselLine,
        old_diesel,
        [
            (
                ln.body.id,
                {
                    "trip_sheet_id": sheet.id,
                    "trip_id": trip_id_of(ln),
                    "position": i,
                    "source": ln.body.source,
                    "litres": None if ln.body.source == "expense_bill" else Decimal(str(ln.body.litres)),
                    "rate": ln.body.rate if ln.body.source == "typed" else None,
                    "amount": ln.body.amount if ln.body.source == "fuel_entry" else None,
                    "vendor_party_id": ln.body.vendor_id,
                    "vendor": ln.body.vendor,
                    "bill_number": ln.body.bill_number,
                    "expense_bill_id": bills[ln.where].id if ln.where in bills else None,
                    "fuel_entry_ref": ln.body.fuel_entry_id if ln.body.source == "fuel_entry" else None,
                    "filled_at": ln.body.filled_at,
                    "file_id": ln.body.attachment_id,
                },
            )
            for i, ln in enumerate(diesel_lines)
        ],
        base,
    )
    await _sync(
        db,
        EnRouteExpense,
        old_en_route,
        [
            (
                ln.body.id,
                {
                    "trip_sheet_id": sheet.id,
                    "trip_id": trip_id_of(ln),
                    "position": i,
                    "kind": ln.body.kind,
                    "maintenance_kind": ln.body.maintenance_kind,
                    "description": ln.body.description,
                    "spent_on": ln.body.date,
                    "location": ln.body.location,
                    "reference": ln.body.reference,
                    "amount": ln.body.amount,
                    "file_id": ln.body.attachment_id,
                },
            )
            for i, ln in enumerate(en_route_lines)
        ],
        base,
    )
    await _sync(
        db,
        TripPayment,
        old_payments,
        [
            (
                ln.body.id,
                {
                    "trip_sheet_id": sheet.id,
                    "trip_id": trip_id_of(ln),
                    "position": i,
                    "direction": ln.body.direction,
                    "party_id": ln.body.party_id,
                    "paid_on": ln.body.paid_on,
                    "method": METHOD_OF_MODE[ln.body.mode],
                    "reference_no": ln.body.reference,
                    "amount": ln.body.amount,
                    "note": ln.body.note,
                },
            )
            for i, ln in enumerate(payment_lines)
        ],
        base,
        on_insert={"recorded_by": access.user_id},
    )

    # Photos of the purchases: as the page lists them.
    for row, line in zip(purchases, purchase_lines, strict=True):
        keep = set(line.body.attachment_ids)
        have = old_files.get(row.id, set())
        if have - keep:
            await db.execute(
                delete(TripPurchaseFile).where(
                    TripPurchaseFile.purchase_id == row.id, TripPurchaseFile.file_id.in_(have - keep)
                )
            )
        for file_id in line.body.attachment_ids:
            if file_id not in have:
                db.add(TripPurchaseFile(organization_id=organization_id, purchase_id=row.id, file_id=file_id))
    await db.flush()

    # Trips taken off the sheet go last, once nothing points at them.
    gone_trips = [i for i in old_trips if i not in seen_trips]
    if gone_trips:
        await db.execute(delete(TripClosure).where(TripClosure.trip_id.in_(gone_trips)))
        await db.execute(delete(Trip).where(Trip.id.in_(gone_trips)))
    await db.flush()
    return sheet.id


async def _sync(
    db: AsyncSession,
    model: Any,
    old: dict[uuid.UUID, Any],
    incoming: Sequence[tuple[uuid.UUID | None, dict[str, Any]]],
    base: dict[str, Any],
    on_insert: dict[str, Any] | None = None,
) -> list[Any]:
    """Make one table's rows what the page holds: update by id, add the new, drop the rest.
    Returns the rows in the page's order."""
    keep = {line_id for line_id, _ in incoming if line_id is not None}
    gone_ids = [row_id for row_id in old if row_id not in keep]
    if gone_ids:
        await db.execute(delete(model).where(model.id.in_(gone_ids)))
    rows = []
    for line_id, values in incoming:
        row = old.get(line_id) if line_id is not None else None
        if row is None:
            row = model(id=uuid.uuid4(), **base, **values, **(on_insert or {}))
            db.add(row)
        else:
            for key, value in values.items():
                setattr(row, key, value)
        rows.append(row)
    await db.flush()
    return rows


async def delete_sheet(db: AsyncSession, bundle: SheetBundle) -> None:
    """A sheet, its trips and every line. The audit log keeps what was there."""
    trip_ids = [t.id for t in bundle.trips]
    purchase_ids = [p.id for p in bundle.purchases]
    if purchase_ids:
        await db.execute(delete(TripPurchaseFile).where(TripPurchaseFile.purchase_id.in_(purchase_ids)))
    if trip_ids:
        for model in (TripClosure, TripSale, TripPurchase):
            await db.execute(delete(model).where(model.trip_id.in_(trip_ids)))
    for model in (TripPayment, EnRouteExpense, DieselLine):
        await db.execute(delete(model).where(model.trip_sheet_id == bundle.sheet.id))
    if trip_ids:
        await db.execute(delete(Trip).where(Trip.id.in_(trip_ids)))
    await db.execute(delete(TripSheet).where(TripSheet.id == bundle.sheet.id))


async def close_trip(
    db: AsyncSession,
    access: Access,
    bundle: SheetBundle,
    trip_id: uuid.UUID,
    party_id: uuid.UUID,
    close: bool,
) -> None:
    """Accounts confirming by hand that a customer paid a trip in full (BC), or taking it back."""
    if not access.can(CLOSE, bundle.sheet.site_id):
        raise needs_permission(CLOSE)
    if not any(t.id == trip_id for t in bundle.trips):
        raise invalid("tripId", "not a trip of this sheet")
    existing = next(
        (c for c in bundle.closures if c.trip_id == trip_id and c.customer_party_id == party_id), None
    )
    if not close:
        if existing is not None:
            await db.delete(existing)
            await db.flush()
        return
    ctx = await build_context(db, [bundle])
    calc = ctx.calcs[str(bundle.sheet.id)].trips[str(trip_id)]
    due = next((d for d in calc.dues if d.role == "customer" and d.party_id == str(party_id)), None)
    if due is None or due.billed <= 0:
        raise invalid("partyId", "not a customer billed on this trip")
    if due.due > 0:
        raise refuse({"code": "not-paid-in-full", "due": money(due.due)})
    if existing is None:
        db.add(
            TripClosure(
                organization_id=access.organization_id,
                trip_id=trip_id,
                customer_party_id=party_id,
                billed=due.billed,
                closed_by=access.user_id,
                closed_by_name=access.name,
            )
        )
    else:
        existing.billed = due.billed
        existing.closed_by = access.user_id
        existing.closed_by_name = access.name
        existing.closed_at = datetime.now().astimezone()
    await db.flush()

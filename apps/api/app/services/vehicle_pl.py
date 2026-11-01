"""Trips between the database, the P&L rules and the wire (LIN-22).

Everything here runs inside the request's tenant transaction, so RLS has
already confined every query to the caller's organization; site scoping is a
property of each trip and is checked by the routes. A refusal raised half way
through a save rolls the whole save back, so a trip is never stored half done.

Figures are never stored: each read rebuilds the trips as
app/domain/vehicle_pl.py sees them — every trip that shares one of their diesel
fills included, so a fill is split the same way whichever trip is opened.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

from sqlalchemy import ColumnElement, delete, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, Scope, TenantCalendar, next_serial
from app.api.problems import invalid, needs_permission, refuse
from app.domain import vehicle_pl as pl
from app.models.core import File, Site
from app.models.finance import ExpenseBill, TripPayment
from app.models.logistics import DutyFuelLink, Trip, TripCost, TripDiesel, VehicleDutyLog
from app.models.master import Item, Party
from app.models.procurement import TripPurchase, TripPurchaseFile
from app.models.sales import PurchaseOrder, TripSale
from app.schemas.common import money, number
from app.schemas.vehicle_pl import (
    CostOut,
    DieselIn,
    DieselOut,
    PartyDueOut,
    PlOut,
    PlTotalsOut,
    PurchaseIn,
    PurchaseOut,
    SaleIn,
    SaleOut,
    TripAttachmentOut,
    TripIn,
    TripOut,
    TripPaymentOut,
    TripRowOut,
)
from app.services.expense_bills import METHOD_OF_MODE, MODE_OF_METHOD, size_kb

READ = "fleet.trip_pl.read"
WRITE = "fleet.trip_pl.write"
REPORT = "finance.pl_report.read"
#: Who may open a trip: whoever enters trips there, or the director and accounts.
READ_KEYS = (READ, REPORT)

#: An expense bill in these statuses counts nothing on the trips that link it.
VOID_BILL = ("rejected", "deleted")


def read_scope(access: Access) -> Scope:
    return access.scope(*READ_KEYS)


def may_read(access: Access, trip: Trip) -> bool:
    return read_scope(access).covers(trip.site_id)


def attachment_url(file_id: uuid.UUID) -> str:
    return f"/vehicle-pl/attachments/{file_id}"


def _norm_bill(column: ColumnElement[str]) -> ColumnElement[str]:
    """pl.bill_key in SQL: upper case, letters and digits only."""
    return func.upper(func.regexp_replace(column, "[^A-Za-z0-9]", "", "g"))


# ----------------------------------------------------------------- loading


@dataclass
class TripBundle:
    trip: Trip
    diesel: list[TripDiesel] = field(default_factory=list)
    purchases: list[TripPurchase] = field(default_factory=list)
    sales: list[TripSale] = field(default_factory=list)
    costs: list[TripCost] = field(default_factory=list)
    payments: list[TripPayment] = field(default_factory=list)
    #: Purchase id → its invoice photos, oldest first.
    files: dict[uuid.UUID, list[File]] = field(default_factory=dict)


async def _rows(db: AsyncSession, model, trip_ids: Sequence[uuid.UUID]):  # type: ignore[no-untyped-def]
    stmt = (
        select(model)
        .where(model.trip_id.in_(list(trip_ids)))
        .order_by(model.trip_id, model.position, model.id)
        .execution_options(populate_existing=True)
    )
    return (await db.scalars(stmt)).all()


async def load_bundles(db: AsyncSession, trip_ids: Sequence[uuid.UUID]) -> list[TripBundle]:
    """These trips with every line, in the order asked, one query per table."""
    if not trip_ids:
        return []
    trips = (
        await db.scalars(
            select(Trip).where(Trip.id.in_(list(trip_ids))).execution_options(populate_existing=True)
        )
    ).all()
    bundles = {t.id: TripBundle(trip=t) for t in trips}
    for attr, model in (
        ("diesel", TripDiesel),
        ("purchases", TripPurchase),
        ("sales", TripSale),
        ("costs", TripCost),
        ("payments", TripPayment),
    ):
        for row in await _rows(db, model, list(bundles)):
            getattr(bundles[row.trip_id], attr).append(row)
    purchase_trip = {p.id: b.trip.id for b in bundles.values() for p in b.purchases}
    if purchase_trip:
        files = (
            await db.execute(
                select(TripPurchaseFile.purchase_id, File)
                .join(File, File.id == TripPurchaseFile.file_id)
                .where(TripPurchaseFile.purchase_id.in_(list(purchase_trip)))
                .order_by(TripPurchaseFile.created_at, File.id)
            )
        ).all()
        for purchase_id, file in files:
            bundles[purchase_trip[purchase_id]].files.setdefault(purchase_id, []).append(file)
    return [bundles[i] for i in trip_ids if i in bundles]


@dataclass
class Context:
    """What the responses need besides the trips' own rows."""

    parties: dict[uuid.UUID, Party]
    items: dict[uuid.UUID, Item]
    links: dict[uuid.UUID, DutyFuelLink]
    bills: dict[uuid.UUID, ExpenseBill]
    calcs: dict[str, pl.TripCalc]
    #: Link id → (trip id, trip number) of every trip that links it.
    sharers: dict[uuid.UUID, list[tuple[uuid.UUID, str]]]


def _diesel_line(d: TripDiesel, links: dict[uuid.UUID, DutyFuelLink], bills: dict[uuid.UUID, ExpenseBill]):  # type: ignore[no-untyped-def]
    """A stored diesel line as the rules see it: a link carries its fill's figures, read from the source."""
    if d.source == "typed":
        return pl.DieselLine(
            id=str(d.id), source="typed", litres=d.litres, rate=d.rate, bill_number=d.bill_number
        )
    link = links[d.link_id] if d.link_id else None
    if link is not None and link.source == "expense_bill" and link.expense_bill_id in bills:
        bill = bills[link.expense_bill_id]
        return pl.DieselLine(
            id=str(d.id),
            source="expense_bill",
            litres=bill.litres,
            amount=bill.amount,
            expense_bill_id=str(bill.id),
            bill_number=bill.bill_number,
            void=bill.status in VOID_BILL,
        )
    if link is not None and link.source == "fuel_entry":
        return pl.DieselLine(
            id=str(d.id),
            source="fuel_entry",
            litres=link.litres,
            amount=link.amount,
            fuel_entry_id=link.fuel_entry_ref,
            bill_number=link.bill_number,
        )
    return pl.DieselLine(id=str(d.id), source=d.source, void=True)  # pragma: no cover - keys forbid it


def domain_trip(
    b: TripBundle, links: dict[uuid.UUID, DutyFuelLink], bills: dict[uuid.UUID, ExpenseBill]
) -> pl.Trip:
    t = b.trip
    return pl.Trip(
        id=str(t.id),
        trip_number=t.trip_number,
        vehicle_id=t.vehicle_ref,
        date=t.trip_date.isoformat(),
        start_km=t.start_km,
        end_km=t.end_km,
        diesel=tuple(_diesel_line(d, links, bills) for d in b.diesel),
        purchases=tuple(
            pl.Purchase(
                id=str(p.id),
                vendor_id=str(p.vendor_party_id),
                quantity=p.quantity,
                rate=p.rate,
                gst_billed=p.gst_billed,
                gst_rate_pct=p.gst_rate_pct,
            )
            for p in b.purchases
        ),
        sales=tuple(
            pl.Sale(
                id=str(s.id),
                customer_id=str(s.customer_party_id),
                quantity=s.quantity,
                rate=s.rate,
                gst_billed=s.gst_billed,
                gst_rate_pct=s.gst_rate_pct,
                transport=s.transport_amount,
                transport_gst_rate_pct=s.transport_gst_rate_pct,
            )
            for s in b.sales
        ),
        costs=tuple(pl.Cost(id=str(c.id), kind=c.kind, amount=c.amount) for c in b.costs),
        payments=tuple(
            pl.Payment(id=str(m.id), direction=m.direction, party_id=str(m.party_id), amount=m.amount)
            for m in b.payments
        ),
    )


async def build_context(db: AsyncSession, bundles: Sequence[TripBundle]) -> Context:
    """Masters, fills and P&L for these trips, every trip sharing one of their fills included."""
    party_ids = {p.vendor_party_id for b in bundles for p in b.purchases}
    party_ids |= {s.customer_party_id for b in bundles for s in b.sales}
    party_ids |= {m.party_id for b in bundles for m in b.payments}
    item_ids = {p.item_id for b in bundles for p in b.purchases} | {
        s.item_id for b in bundles for s in b.sales
    }
    link_ids = {d.link_id for b in bundles for d in b.diesel if d.link_id}

    parties = (
        {p.id: p for p in (await db.scalars(select(Party).where(Party.id.in_(party_ids)))).all()}
        if party_ids
        else {}
    )
    items = (
        {i.id: i for i in (await db.scalars(select(Item).where(Item.id.in_(item_ids)))).all()}
        if item_ids
        else {}
    )
    links: dict[uuid.UUID, DutyFuelLink] = {}
    bills: dict[uuid.UUID, ExpenseBill] = {}
    sharers: dict[uuid.UUID, list[tuple[uuid.UUID, str]]] = {}
    others: list[pl.Trip] = []
    if link_ids:
        links = {
            link.id: link
            for link in (
                await db.scalars(
                    select(DutyFuelLink)
                    .where(DutyFuelLink.id.in_(link_ids))
                    .execution_options(populate_existing=True)
                )
            ).all()
        }
        bill_ids = {link.expense_bill_id for link in links.values() if link.expense_bill_id}
        if bill_ids:
            bills = {
                b.id: b
                for b in (
                    await db.scalars(
                        select(ExpenseBill)
                        .where(ExpenseBill.id.in_(bill_ids))
                        .execution_options(populate_existing=True)
                    )
                ).all()
            }
        shared = (
            await db.execute(
                select(
                    TripDiesel, Trip.trip_number, Trip.start_km, Trip.end_km, Trip.vehicle_ref, Trip.trip_date
                )
                .join(Trip, Trip.id == TripDiesel.trip_id)
                .where(TripDiesel.link_id.in_(link_ids))
                .order_by(Trip.trip_number)
            )
        ).all()
        mine = {b.trip.id for b in bundles}
        extra: dict[uuid.UUID, tuple[tuple[str, object, object, str, date], list[TripDiesel]]] = {}
        for row, trip_number, start_km, end_km, vehicle_ref, trip_date in shared:
            assert row.link_id is not None
            sharers.setdefault(row.link_id, []).append((row.trip_id, trip_number))
            if row.trip_id not in mine:
                head = (trip_number, start_km, end_km, vehicle_ref, trip_date)
                extra.setdefault(row.trip_id, (head, []))[1].append(row)
        # Another trip's part of a shared fill only needs its km and its links.
        for trip_id, ((trip_number, start_km, end_km, vehicle_ref, trip_date), lines) in extra.items():
            others.append(
                pl.Trip(
                    id=str(trip_id),
                    trip_number=trip_number,
                    vehicle_id=vehicle_ref,
                    date=trip_date.isoformat(),
                    start_km=start_km,
                    end_km=end_km,
                    diesel=tuple(_diesel_line(d, links, bills) for d in lines),
                )
            )
    calcs = pl.calculate_trips([domain_trip(b, links, bills) for b in bundles] + others)
    return Context(parties=parties, items=items, links=links, bills=bills, calcs=calcs, sharers=sharers)


# ---------------------------------------------------------------- the wire


def _name(ctx: Context, party_id: uuid.UUID) -> str:
    party = ctx.parties.get(party_id)
    return party.display_name if party else ""


def _unique(names: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(n for n in names if n))


def pl_out(p: pl.TripPl) -> PlOut:
    return PlOut.model_validate(p.wire())


def totals_out(t: pl.PlTotals) -> PlTotalsOut:
    return PlTotalsOut.model_validate(t.wire())


def row_out(b: TripBundle, ctx: Context) -> TripRowOut:
    return TripRowOut(**_row_fields(b, ctx))


def _row_fields(b: TripBundle, ctx: Context) -> dict[str, object]:
    t = b.trip
    return {
        "id": t.id,
        "trip_number": t.trip_number,
        "date": t.trip_date,
        "site_id": t.site_id,
        "vehicle_id": t.vehicle_ref,
        "registration_number": t.registration_number,
        "vehicle_model": t.vehicle_model,
        "driver_id": t.driver_ref,
        "driver_name": t.driver_name,
        "driver_phone": t.driver_phone,
        "start_km": number(t.start_km),
        "end_km": number(t.end_km),
        "customers": _unique(_name(ctx, s.customer_party_id) for s in b.sales),
        "vendors": _unique(_name(ctx, p.vendor_party_id) for p in b.purchases),
        "materials": _unique(
            ctx.items[i].name if i in ctx.items else ""
            for i in [p.item_id for p in b.purchases] + [s.item_id for s in b.sales]
        ),
        "pl": pl_out(ctx.calcs[str(t.id)].pl),
        "created_by": t.created_by_name,
        "created_at": t.created_at,
        "updated_at": t.updated_at,
    }


def _diesel_out(d: TripDiesel, b: TripBundle, ctx: Context) -> DieselOut:
    figures = ctx.calcs[str(b.trip.id)].diesel[str(d.id)]
    shared_with = (
        [n for trip_id, n in ctx.sharers.get(d.link_id, []) if trip_id != b.trip.id] if d.link_id else []
    )
    base = {
        "id": d.id,
        "source": d.source,
        "amount": money(figures.amount),
        "share_litres": pl.to_number(figures.share_litres),
        "share_amount": money(figures.share_amount),
        "shared_by": figures.shared_by,
        "shared_with": shared_with,
        "expense_bill_id": None,
        "fuel_entry_id": None,
        "bill_status": None,
        "counted": True,
        "bill_date": None,
        "filled_at": None,
    }
    if d.source == "typed":
        return DieselOut(
            **base,
            litres=number(d.litres),
            rate=money(d.rate) if d.rate is not None else None,
            vendor=d.vendor,
            bill_number=d.bill_number,
        )
    link = ctx.links[d.link_id] if d.link_id else None
    if link is not None and link.source == "expense_bill" and link.expense_bill_id in ctx.bills:
        bill = ctx.bills[link.expense_bill_id]
        return DieselOut(
            **{
                **base,
                "expense_bill_id": bill.id,
                "bill_status": bill.status,
                "counted": bill.status not in VOID_BILL,
                "bill_date": bill.bill_date,
            },
            litres=number(bill.litres),
            rate=None,
            vendor=bill.vendor,
            bill_number=bill.bill_number,
        )
    assert link is not None
    return DieselOut(
        **{
            **base,
            "fuel_entry_id": link.fuel_entry_ref,
            "filled_at": link.filled_at,
        },
        litres=number(link.litres),
        rate=money(link.rate) if link.rate is not None else None,
        vendor=link.vendor,
        bill_number=link.bill_number,
    )


def trip_out(b: TripBundle, ctx: Context) -> TripOut:
    calc = ctx.calcs[str(b.trip.id)]
    purchases = []
    for p in b.purchases:
        f = calc.purchases[str(p.id)]
        vendor = ctx.parties.get(p.vendor_party_id)
        item = ctx.items.get(p.item_id)
        purchases.append(
            PurchaseOut(
                id=p.id,
                vendor_id=p.vendor_party_id,
                vendor_name=vendor.display_name if vendor else "",
                vendor_gstin=vendor.gstin if vendor else None,
                material_id=p.item_id,
                material_name=item.name if item else "",
                hsn_code=p.hsn_code,
                unit=p.unit,
                quantity=number(p.quantity) or 0,
                rate=money(p.rate),
                gst_billed=p.gst_billed,
                gst_rate_pct=number(p.gst_rate_pct) or 0,
                amount=money(f.amount),
                gst_amount=money(f.gst_amount),
                total=money(f.total),
                cost=money(f.cost),
                input_credit=money(f.input_credit),
                invoice_number=p.invoice_number,
                invoice_date=p.invoice_date,
                attachments=[
                    TripAttachmentOut(
                        id=file.id,
                        file_name=file.original_name,
                        mime_type=file.mime_type,
                        size_kb=size_kb(file.size_bytes),
                        url=attachment_url(file.id),
                    )
                    for file in b.files.get(p.id, [])
                ],
            )
        )
    sales = []
    for s in b.sales:
        f = calc.sales[str(s.id)]
        customer = ctx.parties.get(s.customer_party_id)
        item = ctx.items.get(s.item_id)
        sales.append(
            SaleOut(
                id=s.id,
                customer_id=s.customer_party_id,
                customer_name=customer.display_name if customer else "",
                customer_gstin=customer.gstin if customer else None,
                purchase_order_id=s.purchase_order_id,
                po_ref=s.po_ref,
                material_id=s.item_id,
                material_name=item.name if item else "",
                hsn_code=s.hsn_code,
                unit=s.unit,
                quantity=number(s.quantity) or 0,
                rate=money(s.rate),
                gst_billed=s.gst_billed,
                gst_rate_pct=number(s.gst_rate_pct) or 0,
                transport=money(f.transport),
                transport_gst_rate_pct=number(s.transport_gst_rate_pct) or 0,
                amount=money(f.amount),
                gst_amount=money(f.gst_amount),
                transport_gst=money(f.transport_gst),
                taxable=money(f.taxable),
                gst_total=money(f.gst_total),
                total=money(f.total),
                challan_number=s.challan_number,
                invoice_number=s.invoice_number,
            )
        )
    return TripOut(
        **_row_fields(b, ctx),
        notes=b.trip.notes,
        diesel=[_diesel_out(d, b, ctx) for d in b.diesel],
        purchases=purchases,
        sales=sales,
        costs=[
            CostOut(id=c.id, kind=c.kind, description=c.description, amount=money(c.amount)) for c in b.costs
        ],
        payments=[
            TripPaymentOut(
                id=m.id,
                direction=m.direction,
                party_id=m.party_id,
                party_name=_name(ctx, m.party_id),
                paid_on=m.paid_on,
                mode=MODE_OF_METHOD[m.method],
                reference=m.reference_no,
                amount=money(m.amount),
                note=m.note,
            )
            for m in b.payments
        ],
        dues=[
            PartyDueOut(
                party_id=uuid.UUID(d.party_id),
                party_name=_name(ctx, uuid.UUID(d.party_id)),
                role=d.role,
                billed=money(d.billed),
                settled=money(d.settled),
                due=money(d.due),
            )
            for d in calc.dues
        ],
    )


# ------------------------------------------------------------------ search


@dataclass(frozen=True)
class TripFilter:
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
    """A trip by its number, vehicle, driver, notes, or anyone or anything on its lines."""
    like = _like(q)
    plate = _like("".join(q.split()).upper())
    sold = (
        select(TripSale.id)
        .join(Party, Party.id == TripSale.customer_party_id)
        .join(Item, Item.id == TripSale.item_id)
        .where(
            TripSale.trip_id == Trip.id,
            or_(
                Party.display_name.ilike(like, escape="\\"),
                Item.name.ilike(like, escape="\\"),
                TripSale.po_ref.ilike(like, escape="\\"),
                TripSale.challan_number.ilike(like, escape="\\"),
                TripSale.invoice_number.ilike(like, escape="\\"),
            ),
        )
    )
    bought = (
        select(TripPurchase.id)
        .join(Party, Party.id == TripPurchase.vendor_party_id)
        .join(Item, Item.id == TripPurchase.item_id)
        .where(
            TripPurchase.trip_id == Trip.id,
            or_(
                Party.display_name.ilike(like, escape="\\"),
                Item.name.ilike(like, escape="\\"),
                TripPurchase.invoice_number.ilike(like, escape="\\"),
            ),
        )
    )
    return or_(
        Trip.trip_number.ilike(like, escape="\\"),
        func.replace(Trip.registration_number, " ", "").ilike(plate, escape="\\"),
        Trip.vehicle_model.ilike(like, escape="\\"),
        Trip.driver_name.ilike(like, escape="\\"),
        Trip.notes.ilike(like, escape="\\"),
        exists(sold),
        exists(bought),
    )


async def find_trip_ids(db: AsyncSession, scope: Scope, f: TripFilter) -> list[uuid.UUID]:
    """Trips in scope that match, newest first."""
    stmt = select(Trip.id).where(scope.clause(Trip.site_id))
    if f.date_from:
        stmt = stmt.where(Trip.trip_date >= f.date_from)
    if f.date_to:
        stmt = stmt.where(Trip.trip_date <= f.date_to)
    if f.vehicle_id:
        stmt = stmt.where(Trip.vehicle_ref == f.vehicle_id)
    if f.site_id:
        stmt = stmt.where(Trip.site_id == f.site_id)
    if f.customer_id:
        stmt = stmt.where(
            exists(
                select(TripSale.id).where(
                    TripSale.trip_id == Trip.id, TripSale.customer_party_id == f.customer_id
                )
            )
        )
    if f.vendor_id:
        stmt = stmt.where(
            exists(
                select(TripPurchase.id).where(
                    TripPurchase.trip_id == Trip.id, TripPurchase.vendor_party_id == f.vendor_id
                )
            )
        )
    if f.q and f.q.strip():
        stmt = stmt.where(_search(f.q.strip()))
    stmt = stmt.order_by(Trip.trip_date.desc(), Trip.trip_number.desc()).limit(f.limit)
    return list((await db.scalars(stmt)).all())


# ------------------------------------------------------------------ saving


def _check_site_key(access: Access, site_id: uuid.UUID) -> None:
    if not access.can(WRITE, site_id):
        raise needs_permission(WRITE)


async def _duty_log(db: AsyncSession, organization_id: uuid.UUID, vehicle_ref: str, day: date) -> uuid.UUID:
    """The vehicle day, made the first time a trip of it is saved."""
    await db.execute(
        pg_insert(VehicleDutyLog)
        .values(organization_id=organization_id, vehicle_ref=vehicle_ref, duty_date=day)
        .on_conflict_do_nothing(index_elements=["organization_id", "vehicle_ref", "duty_date"])
    )
    found = await db.scalar(
        select(VehicleDutyLog.id).where(
            VehicleDutyLog.vehicle_ref == vehicle_ref, VehicleDutyLog.duty_date == day
        )
    )
    assert found is not None
    return found


async def _parties(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, Party]:
    if not ids:
        return {}
    return {p.id: p for p in (await db.scalars(select(Party).where(Party.id.in_(ids)))).all()}


async def _items(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, Item]:
    if not ids:
        return {}
    return {i.id: i for i in (await db.scalars(select(Item).where(Item.id.in_(ids)))).all()}


def _positive(value: Decimal | None, field_name: str) -> Decimal:
    if value is None or value <= 0:
        raise invalid(field_name, "must be more than zero")
    return value


def _not_after_today(day: date | None, calendar: TenantCalendar, field_name: str) -> None:
    if day is not None and day > calendar.today():
        raise invalid(field_name, "after today")


@dataclass
class _Fill:
    """A linked diesel line, resolved: which fill, and what it says."""

    index: int
    line_id: uuid.UUID | None
    source: str
    expense_bill: ExpenseBill | None = None
    fuel_entry_ref: str | None = None
    snapshot: dict[str, object] = field(default_factory=dict)

    @property
    def key(self) -> str:
        if self.expense_bill is not None:
            return f"expense_bill:{self.expense_bill.id}"
        return f"fuel_entry:{self.fuel_entry_ref}"


async def _old_fills(db: AsyncSession, old_diesel: dict[uuid.UUID, TripDiesel]) -> dict[uuid.UUID, str]:
    """Each stored linked line's fill, as _Fill.key names it."""
    link_ids = {d.link_id for d in old_diesel.values() if d.link_id}
    if not link_ids:
        return {}
    links = {
        link.id: link
        for link in (await db.scalars(select(DutyFuelLink).where(DutyFuelLink.id.in_(link_ids)))).all()
    }
    out: dict[uuid.UUID, str] = {}
    for row_id, d in old_diesel.items():
        link = links.get(d.link_id) if d.link_id else None
        if link is not None:
            out[row_id] = (
                f"expense_bill:{link.expense_bill_id}"
                if link.expense_bill_id
                else f"fuel_entry:{link.fuel_entry_ref}"
            )
    return out


async def _resolve_fills(db: AsyncSession, body: TripIn, already: set[str]) -> list[_Fill]:
    fills: list[_Fill] = []
    for i, d in enumerate(body.diesel):
        where = f"diesel[{i}]"
        if d.source == "typed":
            if any(v is not None for v in (d.amount, d.expense_bill_id, d.fuel_entry_id, d.filled_at)):
                raise invalid(where, "a typed line has litres and a rate, nothing else")
            _positive(d.litres, f"{where}.litres")
            _positive(d.rate, f"{where}.rate")
            continue
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
                        "line": i,
                        "billNumber": bill.bill_number,
                        "vehicleId": bill.vehicle_ref,
                    }
                )
            fill = _Fill(index=i, line_id=d.id, source="expense_bill", expense_bill=bill)
            # A rejected or deleted bill stays on a trip that already links it,
            # counting nothing; it cannot be linked anew.
            if bill.status in VOID_BILL and fill.key not in already:
                raise refuse(
                    {
                        "code": "diesel-bill-void",
                        "line": i,
                        "billNumber": bill.bill_number,
                        "status": bill.status,
                    }
                )
            fills.append(fill)
            continue
        # A fuel entry: no table in the API yet, so its figures come with it.
        if not d.fuel_entry_id:
            raise invalid(f"{where}.fuelEntryId", "required")
        if d.expense_bill_id is not None:
            raise invalid(where, "a fuel entry is not an expense bill")
        litres = _positive(d.litres, f"{where}.litres")
        amount = _positive(d.amount, f"{where}.amount")
        if d.rate is not None:
            _positive(d.rate, f"{where}.rate")
        fills.append(
            _Fill(
                index=i,
                line_id=d.id,
                source="fuel_entry",
                fuel_entry_ref=d.fuel_entry_id,
                snapshot={
                    "litres": litres,
                    "amount": amount,
                    "rate": d.rate,
                    "bill_number": d.bill_number,
                    "vendor": d.vendor,
                    "filled_at": d.filled_at,
                },
            )
        )
    return fills


def _line_number(problem: dict[str, str]) -> dict[str, object]:
    out: dict[str, object] = dict(problem)
    out["line"] = int(out.pop("lineId"))
    return out


async def _check_double_counts(
    db: AsyncSession, body: TripIn, fills: list[_Fill], trip_id: uuid.UUID | None
) -> None:
    """pl.find_double_counts, with what is already in Linck for this vehicle as its context."""
    by_index = {f.index: f for f in fills}
    lines = []
    for i, d in enumerate(body.diesel):
        fill = by_index.get(i)
        if d.source == "typed":
            lines.append(
                pl.DieselLine(
                    id=str(i), source="typed", litres=d.litres, rate=d.rate, bill_number=d.bill_number
                )
            )
        elif fill is not None and fill.expense_bill is not None:
            lines.append(
                pl.DieselLine(
                    id=str(i),
                    source="expense_bill",
                    expense_bill_id=str(fill.expense_bill.id),
                    bill_number=fill.expense_bill.bill_number,
                )
            )
        else:
            lines.append(
                pl.DieselLine(
                    id=str(i), source="fuel_entry", fuel_entry_id=d.fuel_entry_id, bill_number=d.bill_number
                )
            )
    trip = pl.Trip(
        id=str(trip_id) if trip_id else "new",
        vehicle_id=body.vehicle_id,
        date=body.date.isoformat(),
        start_km=None,
        end_km=None,
        diesel=tuple(lines),
    )
    keys = {pl.bill_key(d.bill_number) for d in body.diesel if d.source == "typed"} - {""}
    known: list[pl.KnownDieselBill] = []
    others: dict[uuid.UUID, tuple[str, list[str]]] = {}
    if keys:
        bills = (
            await db.scalars(
                select(ExpenseBill).where(
                    ExpenseBill.desk == "fleet",
                    ExpenseBill.kind == "diesel",
                    ExpenseBill.status.notin_(VOID_BILL),
                    or_(ExpenseBill.vehicle_ref == body.vehicle_id, ExpenseBill.vehicle_ref.is_(None)),
                    _norm_bill(ExpenseBill.bill_number).in_(keys),
                )
            )
        ).all()
        known = [pl.KnownDieselBill(str(b.id), b.bill_number, b.vehicle_ref) for b in bills]
        not_this = Trip.id != trip_id if trip_id else Trip.id.is_not(None)
        typed = (
            await db.execute(
                select(Trip.id, Trip.trip_number, TripDiesel.bill_number)
                .join(TripDiesel, TripDiesel.trip_id == Trip.id)
                .where(
                    Trip.vehicle_ref == body.vehicle_id,
                    not_this,
                    TripDiesel.source == "typed",
                    _norm_bill(TripDiesel.bill_number).in_(keys),
                )
            )
        ).all()
        entries = (
            await db.execute(
                select(Trip.id, Trip.trip_number, DutyFuelLink.bill_number)
                .join(TripDiesel, TripDiesel.trip_id == Trip.id)
                .join(DutyFuelLink, DutyFuelLink.id == TripDiesel.link_id)
                .where(
                    Trip.vehicle_ref == body.vehicle_id,
                    not_this,
                    DutyFuelLink.source == "fuel_entry",
                    _norm_bill(DutyFuelLink.bill_number).in_(keys),
                )
            )
        ).all()
        for other_id, trip_number, bill_number in [*typed, *entries]:
            others.setdefault(other_id, (trip_number, []))[1].append(bill_number)
    problems = pl.find_double_counts(
        trip,
        known,
        [
            pl.OtherTripDiesel(str(i), n, body.vehicle_id, tuple(numbers))
            for i, (n, numbers) in others.items()
        ],
    )
    if problems:
        first = _line_number(problems[0])
        raise refuse({**first, "problems": [_line_number(p) for p in problems]})


async def _link_for(
    db: AsyncSession, organization_id: uuid.UUID, duty_log_id: uuid.UUID, fill: _Fill, trip_id: uuid.UUID
) -> uuid.UUID:
    """The fill posted to this vehicle day: found, made, or moved here if no other trip links it."""
    if fill.expense_bill is not None:
        match = DutyFuelLink.expense_bill_id == fill.expense_bill.id
        values: dict[str, object] = {"source": "expense_bill", "expense_bill_id": fill.expense_bill.id}
        label = fill.expense_bill.bill_number
    else:
        match = DutyFuelLink.fuel_entry_ref == fill.fuel_entry_ref
        values = {"source": "fuel_entry", "fuel_entry_ref": fill.fuel_entry_ref, **fill.snapshot}
        label = str(fill.snapshot.get("bill_number") or fill.fuel_entry_ref)
    link = await db.scalar(select(DutyFuelLink).where(match).with_for_update())
    if link is None:
        link = DutyFuelLink(organization_id=organization_id, duty_log_id=duty_log_id, **values)
        db.add(link)
        try:
            await db.flush()
        except IntegrityError as exc:  # pragma: no cover - two saves posting one fill at once
            raise refuse(
                {"code": "diesel-linked-elsewhere", "line": fill.index, "billNumber": label}
            ) from exc
        return link.id
    if link.duty_log_id != duty_log_id:
        elsewhere = (
            (
                await db.execute(
                    select(Trip.trip_number)
                    .join(TripDiesel, TripDiesel.trip_id == Trip.id)
                    .where(TripDiesel.link_id == link.id, Trip.id != trip_id)
                    .order_by(Trip.trip_number)
                )
            )
            .scalars()
            .all()
        )
        if elsewhere:
            raise refuse(
                {
                    "code": "diesel-linked-elsewhere",
                    "line": fill.index,
                    "billNumber": label,
                    "trips": list(elsewhere),
                }
            )
        link.duty_log_id = duty_log_id
    if fill.fuel_entry_ref is not None:
        for key, value in fill.snapshot.items():
            setattr(link, key, value)
    await db.flush()
    return link.id


async def _tidy(db: AsyncSession, duty_log_ids: Iterable[uuid.UUID]) -> None:
    """Fills no trip links any more are unposted; a day with no trips left goes."""
    ids = [i for i in set(duty_log_ids) if i is not None]
    if not ids:
        return
    await db.execute(
        delete(DutyFuelLink).where(
            DutyFuelLink.duty_log_id.in_(ids),
            ~exists(select(TripDiesel.id).where(TripDiesel.link_id == DutyFuelLink.id)),
        )
    )
    await db.execute(
        delete(VehicleDutyLog).where(
            VehicleDutyLog.id.in_(ids),
            ~exists(select(Trip.id).where(Trip.duty_log_id == VehicleDutyLog.id)),
            ~exists(select(DutyFuelLink.id).where(DutyFuelLink.duty_log_id == VehicleDutyLog.id)),
        )
    )


def _match_ids(section: str, incoming: Sequence[object], existing: dict[uuid.UUID, object]) -> None:
    for i, line in enumerate(incoming):
        line_id = getattr(line, "id", None)
        if line_id is not None and line_id not in existing:
            raise invalid(f"{section}[{i}].id", "not a line of this trip")
    seen = [getattr(line, "id", None) for line in incoming if getattr(line, "id", None) is not None]
    if len(seen) != len(set(seen)):
        raise invalid(section, "a line appears twice")


async def save_trip(
    db: AsyncSession,
    access: Access,
    calendar: TenantCalendar,
    body: TripIn,
    existing: TripBundle | None,
) -> uuid.UUID:
    """Create a trip, or replace one with what the trip page holds now.

    Every check runs before anything is written. A line kept by id is updated
    in place; a new line, or one whose kind changed, gets a new id.
    """
    organization_id = access.organization_id
    _check_site_key(access, body.site_id)
    if existing is not None:
        _check_site_key(access, existing.trip.site_id)
    if await db.get(Site, body.site_id) is None:
        raise invalid("siteId", "no such site")
    _not_after_today(body.date, calendar, "date")
    if body.start_km is not None and body.end_km is not None and body.end_km < body.start_km:
        raise invalid("endKm", "less than the start km")

    old_diesel = {d.id: d for d in existing.diesel} if existing else {}
    old_purchases = {p.id: p for p in existing.purchases} if existing else {}
    old_sales = {s.id: s for s in existing.sales} if existing else {}
    old_costs = {c.id: c for c in existing.costs} if existing else {}
    old_payments = {m.id: m for m in existing.payments} if existing else {}
    _match_ids("diesel", body.diesel, old_diesel)
    _match_ids("purchases", body.purchases, old_purchases)
    _match_ids("sales", body.sales, old_sales)
    _match_ids("costs", body.costs, old_costs)
    _match_ids("payments", body.payments, old_payments)

    # ---- the masters every line names
    parties = await _parties(
        db,
        {p.vendor_id for p in body.purchases}
        | {s.customer_id for s in body.sales}
        | {m.party_id for m in body.payments},
    )
    items = await _items(db, {p.material_id for p in body.purchases} | {s.material_id for s in body.sales})
    old_items = {i: p.item_id for i, p in old_purchases.items()} | {
        i: s.item_id for i, s in old_sales.items()
    }

    def check_line(section: str, i: int, line: PurchaseIn | SaleIn, party_id: uuid.UUID, role: str) -> None:
        party = parties.get(party_id)
        if party is None or role not in party.party_roles:
            raise invalid(f"{section}[{i}].{role}Id", f"not a {role}")
        item = items.get(line.material_id)
        if item is None:
            raise invalid(f"{section}[{i}].materialId", "no such material")
        if not item.is_active and (line.id is None or old_items.get(line.id) != item.id):
            raise invalid(f"{section}[{i}].materialId", "no longer in use")
        _positive(line.rate, f"{section}[{i}].rate")

    for i, p in enumerate(body.purchases):
        check_line("purchases", i, p, p.vendor_id, "vendor")
        _not_after_today(p.invoice_date, calendar, f"purchases[{i}].invoiceDate")
    orders: dict[uuid.UUID, PurchaseOrder] = {}
    for i, s in enumerate(body.sales):
        check_line("sales", i, s, s.customer_id, "customer")
        if s.gst_billed and s.transport and s.transport_gst_rate_pct is None:
            raise invalid(f"sales[{i}].transportGstRatePct", "required with transport on a GST bill")
        if s.purchase_order_id is not None:
            order = await db.get(PurchaseOrder, s.purchase_order_id)
            if order is None or order.customer_party_id != s.customer_id:
                raise invalid(f"sales[{i}].purchaseOrderId", "not an order of this customer")
            orders[order.id] = order
    for i, c in enumerate(body.costs):
        _positive(c.amount, f"costs[{i}].amount")
    customers = {s.customer_id for s in body.sales}
    vendors = {p.vendor_id for p in body.purchases}
    references: set[str] = set()
    for i, m in enumerate(body.payments):
        if m.reference is not None:
            # The same transfer twice on one trip (the index is the backstop).
            if m.reference in references:
                raise refuse({"code": "reference-used", "line": i, "reference": m.reference})
            references.add(m.reference)
        if m.direction == "in" and m.party_id not in customers:
            raise invalid(f"payments[{i}].partyId", "not a customer of this trip")
        if m.direction == "out" and m.party_id not in vendors:
            raise invalid(f"payments[{i}].partyId", "not a vendor of this trip")
        _not_after_today(m.paid_on, calendar, f"payments[{i}].paidOn")
        _positive(m.amount, f"payments[{i}].amount")

    # ---- diesel: what each linked line names, and nothing counted twice
    old_links = await _old_fills(db, old_diesel)
    fills = await _resolve_fills(db, body, {f for f in old_links.values() if f})
    await _check_double_counts(db, body, fills, existing.trip.id if existing else None)

    # ---- invoice photos: already on this trip, or an upload of this person's on no purchase yet
    old_files = {f.id: pid for pid, files in (existing.files.items() if existing else []) for f in files}
    for i, p in enumerate(body.purchases):
        if len(set(p.attachment_ids)) != len(p.attachment_ids):
            raise invalid(f"purchases[{i}].attachmentIds", "a photo appears twice")
        for file_id in p.attachment_ids:
            if file_id in old_files:
                continue
            file = await db.get(File, file_id)
            taken = await db.scalar(select(TripPurchaseFile.id).where(TripPurchaseFile.file_id == file_id))
            if (
                file is None
                or file.uploaded_by != access.user_id
                or file.purpose != "purchase_invoice"
                or taken
            ):
                raise invalid(f"purchases[{i}].attachmentIds", "no such upload of yours")

    # ---- the vehicle day, and the trip itself
    duty_log_id = await _duty_log(db, organization_id, body.vehicle_id, body.date)
    days = {duty_log_id}
    header = {
        "site_id": body.site_id,
        "vehicle_ref": body.vehicle_id,
        "registration_number": body.registration_number,
        "vehicle_model": body.vehicle_model,
        "driver_ref": body.driver_id,
        "driver_name": body.driver_name,
        "driver_phone": body.driver_phone,
        "trip_date": body.date,
        "start_km": body.start_km,
        "end_km": body.end_km,
        "notes": body.notes,
    }
    fill_of = {f.index: f for f in fills}
    same_day = existing is not None and existing.trip.duty_log_id == duty_log_id

    def kept(i: int, d: DieselIn) -> bool:
        """A line updated in place: same id, same kind, and for a link the same fill on the same day."""
        row = old_diesel.get(d.id) if d.id else None
        if row is None or row.source != d.source:
            return False
        if d.source == "typed":
            return True
        return same_day and old_links.get(row.id) == fill_of[i].key

    keep_diesel = {d.id for i, d in enumerate(body.diesel) if kept(i, d)}
    if existing is None:
        year = calendar.financial_year(body.date)
        serial = await next_serial(db, "logistics.trips", organization_id, year)
        trip = Trip(
            id=uuid.uuid4(),
            organization_id=organization_id,
            financial_year=year,
            serial=serial,
            trip_number=f"TRP/{year}/{serial:04d}",
            duty_log_id=duty_log_id,
            created_by=access.user_id,
            created_by_name=access.name,
            **header,
        )
        db.add(trip)
        await db.flush()
    else:
        trip = existing.trip
        days.add(trip.duty_log_id)
        # A link runs through the trip's day, so a link that does not stay as
        # it is goes before the day can change.
        stale = [row_id for row_id in old_diesel if row_id not in keep_diesel]
        if stale:
            await db.execute(delete(TripDiesel).where(TripDiesel.id.in_(stale)))
        trip.duty_log_id = duty_log_id
        for key, value in header.items():
            setattr(trip, key, value)
        await db.flush()

    # ---- diesel lines
    for i, d in enumerate(body.diesel):
        row = old_diesel.get(d.id) if d.id in keep_diesel else None
        if row is not None:
            row.position = i
            if d.source == "typed":
                row.litres, row.rate, row.vendor, row.bill_number = d.litres, d.rate, d.vendor, d.bill_number
            else:
                await _link_for(db, organization_id, duty_log_id, fill_of[i], trip.id)
            continue
        line = TripDiesel(
            id=uuid.uuid4(), organization_id=organization_id, trip_id=trip.id, position=i, source=d.source
        )
        if d.source == "typed":
            line.litres, line.rate, line.vendor, line.bill_number = d.litres, d.rate, d.vendor, d.bill_number
        else:
            line.link_id = await _link_for(db, organization_id, duty_log_id, fill_of[i], trip.id)
            line.duty_log_id = duty_log_id
        db.add(line)
    await db.flush()

    # ---- purchases and their invoice photos
    wanted = {(p.id, f) for p in body.purchases if p.id for f in p.attachment_ids}
    for purchase_id, files in existing.files.items() if existing else []:
        for file in files:
            if (purchase_id, file.id) not in wanted:
                await db.execute(
                    delete(TripPurchaseFile).where(
                        TripPurchaseFile.purchase_id == purchase_id, TripPurchaseFile.file_id == file.id
                    )
                )
    await db.flush()
    rows = await _sync(
        db,
        TripPurchase,
        old_purchases,
        body.purchases,
        trip.id,
        organization_id,
        lambda i, p: {
            "position": i,
            "vendor_party_id": p.vendor_id,
            "item_id": p.material_id,
            "hsn_code": p.hsn_code or items[p.material_id].hsn_code,
            "unit": p.unit or items[p.material_id].unit,
            "quantity": p.quantity,
            "rate": p.rate,
            "gst_billed": p.gst_billed,
            "gst_rate_pct": items[p.material_id].gst_rate_pct if p.gst_rate_pct is None else p.gst_rate_pct,
            "invoice_number": p.invoice_number,
            "invoice_date": p.invoice_date,
        },
    )
    for p, row in zip(body.purchases, rows, strict=True):
        for file_id in p.attachment_ids:
            if (p.id, file_id) not in wanted or old_files.get(file_id) != row.id:
                db.add(TripPurchaseFile(organization_id=organization_id, purchase_id=row.id, file_id=file_id))
    try:
        await db.flush()
    except IntegrityError as exc:
        if "uq_trip_purchase_files_organization_id_file_id" in str(exc.orig):
            raise invalid("purchases.attachmentIds", "already on another purchase") from exc
        raise

    # ---- sales, costs, payments
    await _sync(
        db,
        TripSale,
        old_sales,
        body.sales,
        trip.id,
        organization_id,
        lambda i, s: {
            "position": i,
            "customer_party_id": s.customer_id,
            "purchase_order_id": s.purchase_order_id,
            "po_ref": s.po_ref
            or (orders[s.purchase_order_id].customer_po_ref if s.purchase_order_id else ""),
            "item_id": s.material_id,
            "hsn_code": s.hsn_code or items[s.material_id].hsn_code,
            "unit": s.unit or items[s.material_id].unit,
            "quantity": s.quantity,
            "rate": s.rate,
            "gst_billed": s.gst_billed,
            "gst_rate_pct": items[s.material_id].gst_rate_pct if s.gst_rate_pct is None else s.gst_rate_pct,
            "transport_amount": s.transport or Decimal(0),
            "transport_gst_rate_pct": s.transport_gst_rate_pct or Decimal(0),
            "challan_number": s.challan_number,
            "invoice_number": s.invoice_number,
        },
    )
    await _sync(
        db,
        TripCost,
        old_costs,
        body.costs,
        trip.id,
        organization_id,
        lambda i, c: {"position": i, "kind": c.kind, "description": c.description, "amount": c.amount},
    )
    try:
        await _sync(
            db,
            TripPayment,
            old_payments,
            body.payments,
            trip.id,
            organization_id,
            lambda i, m: {
                "position": i,
                "direction": m.direction,
                "party_id": m.party_id,
                "paid_on": m.paid_on,
                "method": METHOD_OF_MODE[m.mode],
                "reference_no": m.reference,
                "amount": m.amount,
                "note": m.note,
            },
            on_insert={"recorded_by": access.user_id},
        )
    except IntegrityError as exc:
        if "uq_trip_payments_organization_id_trip_id_reference_no" in str(exc.orig):
            raise refuse({"code": "reference-used"}) from exc
        raise
    await _tidy(db, days)
    return trip.id


async def _sync(  # type: ignore[no-untyped-def]
    db: AsyncSession,
    model,
    old: dict[uuid.UUID, object],
    incoming: Sequence[object],
    trip_id: uuid.UUID,
    organization_id: uuid.UUID,
    values_of,
    on_insert: dict[str, object] | None = None,
) -> list:
    """Make one section's rows what the trip page holds: update by id, add the new
    (with new ids), drop the rest. Returns the rows in the page's order."""
    keep = {getattr(line, "id", None) for line in incoming} - {None}
    gone = [row_id for row_id in old if row_id not in keep]
    if gone:
        await db.execute(delete(model).where(model.id.in_(gone)))
    rows = []
    for i, line in enumerate(incoming):
        values = values_of(i, line)
        line_id = getattr(line, "id", None)
        row = old.get(line_id) if line_id is not None else None
        if row is None:
            row = model(
                id=uuid.uuid4(),
                organization_id=organization_id,
                trip_id=trip_id,
                **values,
                **(on_insert or {}),
            )
            db.add(row)
        else:
            for key, value in values.items():
                setattr(row, key, value)
        rows.append(row)
    await db.flush()
    return rows


async def delete_trip(db: AsyncSession, bundle: TripBundle) -> None:
    """A trip and every line of it. The audit log keeps what was there."""
    trip = bundle.trip
    purchase_ids = [p.id for p in bundle.purchases]
    if purchase_ids:
        await db.execute(delete(TripPurchaseFile).where(TripPurchaseFile.purchase_id.in_(purchase_ids)))
    for model in (TripPayment, TripSale, TripPurchase, TripCost, TripDiesel):
        await db.execute(delete(model).where(model.trip_id == trip.id))
    await db.execute(delete(Trip).where(Trip.id == trip.id))
    await _tidy(db, [trip.duty_log_id])


# ------------------------------------------------------------------ reports


def sum_rows(ctx: Context, bundles: Sequence[TripBundle]) -> pl.PlTotals:
    return pl.sum_pl([ctx.calcs[str(b.trip.id)].pl for b in bundles])


def domain_trips(ctx: Context, bundles: Sequence[TripBundle]) -> list[pl.Trip]:
    return [domain_trip(b, ctx.links, ctx.bills) for b in bundles]


def latest_vehicle(bundles: Sequence[TripBundle]) -> dict[str, Trip]:
    """Each vehicle's most recent trip, for its registration number and model as they are now."""
    latest: dict[str, Trip] = {}
    for b in bundles:
        current = latest.get(b.trip.vehicle_ref)
        if current is None or (b.trip.trip_date, b.trip.trip_number) > (
            current.trip_date,
            current.trip_number,
        ):
            latest[b.trip.vehicle_ref] = b.trip
    return latest

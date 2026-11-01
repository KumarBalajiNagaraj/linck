"""Party invoices between the database, the rules and the wire (LIN-27).

An invoice bills one customer for the sale lines of one trip or several, all
from one site's trip sheets: that site's GST registration is the seller. It
starts as a draft with no number; issuing it takes the next number of the
seller's series and freezes everything it prints; cancelling keeps it on
record with its number and frees its trips; only a draft that was never
issued may be deleted. app/domain/party_invoice.py works out every figure.

Everything here runs in the request's tenant transaction, so RLS has already
confined every query to the caller's organization; site scope is checked by
the functions below against the invoice's site, as app/services/vehicle_pl.py
checks a sheet's. A refusal raised half way rolls the whole request back.

Concurrency: whatever makes, issues, cancels or matches an invoice first locks
the trip sheets it bills (in id order, the lock a sheet's save takes too), then
the invoice. So a sheet is never saved half way through an invoice being made
from it, two drafts of the same trips wait for each other (and the second is
refused), and two receipts of one payment are matched one after the other. The
partial unique index on invoice lines and the series row are the database's
own backstops for the same rules.

The trip sheet's side of it is in app/services/vehicle_pl.py, through the
three hooks at the top of this file: a sale line on a live invoice cannot be
changed or removed, a cancelled invoice lets go of a sale line deleted from its
trip, and a payment changed or deleted on its sheet loses its matches.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import ColumnElement, Date, and_, cast, delete, exists, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, Scope, TenantCalendar, next_invoice_serial
from app.api.problems import gone, invalid, needs_permission, refuse
from app.domain import party_invoice as inv
from app.domain import vehicle_pl as pl
from app.models.core import GstRegistration, LegalEntity, Site
from app.models.finance import InvoiceReceipt, TripPayment
from app.models.logistics import Trip, TripSheet
from app.models.master import Item, Party, PartyLocation
from app.models.sales import Invoice, InvoiceLine, TripSale
from app.schemas.common import money, number
from app.schemas.party_invoices import (
    BuyerOut,
    InvoiceIn,
    InvoiceLineOut,
    InvoiceListOut,
    InvoiceOut,
    InvoicePatch,
    InvoiceRowOut,
    InvoiceTotalOut,
    InvoiceTripOut,
    MatchIn,
    ReceiptOut,
    ReceiptsOut,
    SellerOut,
    ShipToOut,
    TaxRowOut,
    UnmatchedOut,
)
from app.services.expense_bills import MODE_OF_METHOD

READ = "sales.invoice.read"
#: Make a draft, issue it, delete a draft: "Raise and issue invoices".
WRITE = "sales.invoice.write"
#: Cancelling an issued invoice is accounts' work.
CANCEL = "sales.invoice.cancel"
#: Matching money received to an invoice is accounts' confirmation of money received, as closing a trip is.
RECEIVE = "finance.receipt.verify"

#: The statuses that hold a sale line: a draft, or an issued invoice.
LIVE = ("draft", "issued")
#: The sale line's fields an invoice bills by or prints; frozen while it is on a live invoice. Not
#: the GSTIN: a line keeps the customer's as it was, and an invoice reads it again when issued.
BILLED_FIELDS = (
    "customer_party_id",
    "location",
    "item_id",
    "hsn_code",
    "unit",
    "quantity",
    "rate",
    "transport_amount",
    "gst_billed",
    "gst_rate_pct",
    "challan_number",
    "invoice_number",
)


def may_read(access: Access, invoice: Invoice) -> bool:
    return access.scope(READ).covers(invoice.site_id)


# ------------------------------------------------- the trip sheet's side


@dataclass(frozen=True)
class InvoiceRef:
    """The live invoice a sale line is on."""

    id: uuid.UUID
    number: str | None
    status: str

    def wire(self) -> dict[str, Any]:
        return {"invoiceId": str(self.id), "invoiceNumber": self.number, "status": self.status}


async def live_invoices_of(
    db: AsyncSession, sale_ids: Iterable[uuid.UUID | None]
) -> dict[uuid.UUID, InvoiceRef]:
    """For each sale line on a draft or issued invoice, that invoice."""
    ids = list({i for i in sale_ids if i is not None})
    if not ids:
        return {}
    rows = await db.execute(
        select(InvoiceLine.trip_sale_id, Invoice.id, Invoice.invoice_number, Invoice.status)
        .join(Invoice, Invoice.id == InvoiceLine.invoice_id)
        .where(InvoiceLine.trip_sale_id.in_(ids), InvoiceLine.invoice_status.in_(LIVE))
    )
    return {sale_id: InvoiceRef(i, n, s) for sale_id, i, n, s in rows.all()}


async def let_go_of_sales(db: AsyncSession, sale_ids: Sequence[uuid.UUID]) -> None:
    """Sale lines about to be deleted from their trips: a cancelled invoice keeps its copy and lets go."""
    if sale_ids:
        await db.execute(
            update(InvoiceLine)
            .where(InvoiceLine.trip_sale_id.in_(sale_ids), InvoiceLine.invoice_status == "cancelled")
            .values(trip_sale_id=None)
            .execution_options(synchronize_session=False)
        )


async def release_payments(db: AsyncSession, payment_ids: Sequence[uuid.UUID]) -> None:
    """Payments deleted or changed on their sheets lose their matches; the invoices show them due again."""
    if payment_ids:
        await db.execute(
            delete(InvoiceReceipt)
            .where(InvoiceReceipt.trip_payment_id.in_(payment_ids))
            .execution_options(synchronize_session=False)
        )


# ---------------------------------------------------------------- loading


async def _by_id(db: AsyncSession, model: Any, ids: Iterable[uuid.UUID | None]) -> dict[uuid.UUID, Any]:
    wanted = {i for i in ids if i is not None}
    if not wanted:
        return {}
    return {r.id: r for r in (await db.scalars(select(model).where(model.id.in_(wanted)))).all()}


async def _lock_sheets(db: AsyncSession, sheet_ids: Iterable[uuid.UUID]) -> None:
    """The trip sheets an invoice bills, locked in id order: the lock a sheet's save takes."""
    ids = list(set(sheet_ids))
    if ids:
        await db.execute(
            select(TripSheet.id).where(TripSheet.id.in_(ids)).order_by(TripSheet.id).with_for_update()
        )


async def load_invoice(db: AsyncSession, invoice_id: uuid.UUID, *, lock: bool = False) -> Invoice:
    """The invoice; another tenant's is not there, as if it never was."""
    stmt = select(Invoice).where(Invoice.id == invoice_id).execution_options(populate_existing=True)
    if lock:
        stmt = stmt.with_for_update()
    invoice = await db.scalar(stmt)
    if invoice is None:
        raise gone("invoice-gone")
    return invoice


async def _lines(db: AsyncSession, invoice_ids: Sequence[uuid.UUID]) -> dict[uuid.UUID, list[InvoiceLine]]:
    out: dict[uuid.UUID, list[InvoiceLine]] = {i: [] for i in invoice_ids}
    if invoice_ids:
        stmt = (
            select(InvoiceLine)
            .where(InvoiceLine.invoice_id.in_(invoice_ids))
            .order_by(InvoiceLine.invoice_id, InvoiceLine.position)
            .execution_options(populate_existing=True)
        )
        for line in (await db.scalars(stmt)).all():
            out[line.invoice_id].append(line)
    return out


@dataclass
class Billed:
    """A trip sale line with the trip and sheet it is on, and its material."""

    sale: TripSale
    trip: Trip
    sheet: TripSheet
    item: Item | None


async def _billed(db: AsyncSession, sales: Sequence[TripSale]) -> list[Billed]:
    """In the order an invoice lists them: by trip date, trip number, then the line's place on the trip."""
    trips = await _by_id(db, Trip, [s.trip_id for s in sales])
    sheets = await _by_id(db, TripSheet, [t.trip_sheet_id for t in trips.values()])
    items = await _by_id(db, Item, [s.item_id for s in sales])
    out = [
        Billed(s, trips[s.trip_id], sheets[trips[s.trip_id].trip_sheet_id], items.get(s.item_id))
        for s in sales
    ]
    out.sort(key=lambda b: (b.trip.trip_date, b.trip.trip_number, b.sale.position, str(b.sale.id)))
    return out


async def _sheet_ids_of(db: AsyncSession, invoice_id: uuid.UUID) -> set[uuid.UUID]:
    rows = await db.scalars(
        select(Trip.trip_sheet_id)
        .join(TripSale, TripSale.trip_id == Trip.id)
        .join(InvoiceLine, InvoiceLine.trip_sale_id == TripSale.id)
        .where(InvoiceLine.invoice_id == invoice_id)
    )
    return set(rows.all())


# ------------------------------------------------------------ what it says


def address_text(address: dict[str, Any] | None) -> str:
    """A site's address as one line: "12 Main Road, Karapakkam, Chennai - 600097"."""
    a = address or {}
    parts = [str(a.get(k) or "").strip() for k in ("line1", "line2", "city", "district")]
    text = ", ".join(p for p in parts if p)
    pin = str(a.get("pincode") or "").strip()
    return f"{text} - {pin}" if text and pin else (text or pin)


async def _seller(db: AsyncSession, site_id: uuid.UUID) -> tuple[GstRegistration, dict[str, Any]]:
    """The GST registration of the site the trips' sheets are at, and the seller as printed."""
    site = await db.get(Site, site_id)
    registration = (
        await db.get(GstRegistration, site.gst_registration_id) if site and site.gst_registration_id else None
    )
    if site is None or registration is None:
        raise refuse({"code": "site-no-gstin", "siteId": str(site_id), "siteName": site.name if site else ""})
    if not inv.state_of_gstin(registration.gstin):
        raise refuse({"code": "seller-gstin-wrong", "gstin": registration.gstin})
    entity = await db.get(LegalEntity, registration.legal_entity_id)
    return registration, {
        "gst_registration_id": registration.id,
        "seller_legal_name": registration.legal_name,
        "seller_trade_name": (entity.trade_name or "") if entity else "",
        "seller_gstin": registration.gstin,
        # The GSTIN's own digits, which are the state it is registered in.
        "seller_state_code": registration.gstin[:2],
        "seller_address": address_text(site.address),
    }


@dataclass(frozen=True)
class Kept:
    """What a draft was told by hand, which working it out again keeps."""

    place_of_supply: str
    pos_basis: str
    buyer_address: str
    ship_to_address: str

    @classmethod
    def of(cls, invoice: Invoice) -> Kept:
        return cls(invoice.place_of_supply, invoice.pos_basis, invoice.buyer_address, invoice.ship_to_address)


async def _header(
    db: AsyncSession, site_id: uuid.UUID, customer: Party, billed: Sequence[Billed], kept: Kept | None
) -> dict[str, Any]:
    """Seller, buyer, delivery and place of supply, as of now; a draft's own choices (`kept`) stay."""
    _, seller = await _seller(db, site_id)
    gstins = sorted({b.sale.party_gstin for b in billed if b.sale.party_gstin} | {customer.gstin} - {None})
    if len(gstins) > 1:
        raise refuse({"code": "buyer-gstins-differ", "gstins": gstins})
    buyer_gstin = gstins[0] if gstins else None
    locations = {
        x.name.strip().lower(): x
        for x in (await db.scalars(select(PartyLocation).where(PartyLocation.party_id == customer.id))).all()
    }
    names = sorted({b.sale.location.strip() for b in billed})
    delivered = [locations.get(b.sale.location.strip().lower()) for b in billed]
    if kept is not None and kept.pos_basis == "chosen":
        place, basis = kept.place_of_supply, "chosen"
    else:
        pos = inv.place_of_supply(
            [x.state_code if x else None for x in delivered], buyer_gstin, seller["seller_state_code"]
        )
        if isinstance(pos, inv.PlacesDiffer):
            raise refuse({"code": "places-differ", "states": list(pos.states)})
        place, basis = pos.state_code, pos.basis
    one_place = len(names) == 1 and names[0] != ""
    location = locations.get(names[0].lower()) if one_place else None
    return {
        **seller,
        "buyer_name": customer.legal_name or customer.display_name,
        "buyer_gstin": buyer_gstin,
        "buyer_address": (kept.buyer_address if kept and kept.buyer_address else customer.address),
        "ship_to_name": names[0] if one_place else "",
        "ship_to_address": (
            kept.ship_to_address if kept and kept.ship_to_address else (location.address if location else "")
        ),
        "place_of_supply": place,
        "pos_basis": basis,
        "supply_type": inv.supply_type(seller["seller_state_code"], place),
    }


def _domain_line(b: Billed) -> inv.InvoiceLineInput:
    s = b.sale
    return inv.InvoiceLineInput(
        id=str(s.id),
        quantity=s.quantity,
        rate=s.rate,
        gst_rate_pct=s.gst_rate_pct,
        transport=s.transport_amount,
        hsn_code=s.hsn_code,
    )


def _line_values(b: Billed, f: inv.LineFigures) -> dict[str, Any]:
    s = b.sale
    return {
        "trip_sale_id": s.id,
        "sheet_number": b.sheet.sheet_number,
        "trip_number": b.trip.trip_number,
        "trip_date": b.trip.trip_date,
        "registration_number": b.sheet.registration_number,
        "challan_number": s.challan_number,
        "location": s.location,
        "description": b.item.name if b.item else "",
        "hsn_code": s.hsn_code,
        "unit": s.unit,
        "quantity": s.quantity,
        "rate": s.rate,
        "amount": f.amount,
        "transport": f.transport,
        "taxable": f.taxable,
        "gst_rate_pct": s.gst_rate_pct,
        "cgst": f.cgst,
        "sgst": f.sgst,
        "igst": f.igst,
        "total": f.total,
    }


def _totals(f: inv.InvoiceFigures) -> dict[str, Decimal]:
    return {
        "taxable_total": f.taxable,
        "cgst_total": f.cgst,
        "sgst_total": f.sgst,
        "igst_total": f.igst,
        "round_off": f.round_off,
        "total": f.total,
    }


def _billable(b: Billed, live: dict[uuid.UUID, InvoiceRef]) -> None:
    """A sale line may go on a new invoice: on no live one, with GST, not billed outside, with an HSN."""
    trip = b.trip.trip_number
    ref = live.get(b.sale.id)
    if ref is not None:
        raise refuse({"code": "sale-on-invoice", "tripNumber": trip, **ref.wire()})
    if not b.sale.gst_billed:
        # A tax invoice charges GST; a sale billed without it is not one.
        raise refuse({"code": "sale-not-gst", "tripNumber": trip})
    if b.sale.invoice_number.strip():
        # An invoice number typed on the trip is a bill raised outside Linck: billing it here bills it twice.
        raise refuse(
            {"code": "sale-billed-outside", "tripNumber": trip, "invoiceNumber": b.sale.invoice_number}
        )
    if not b.sale.hsn_code:
        raise refuse({"code": "sale-no-hsn", "tripNumber": trip})


# -------------------------------------------------------------- the draft


async def make_draft(db: AsyncSession, access: Access, body: InvoiceIn) -> uuid.UUID:
    """A draft for one customer from the sale lines to them on these trips. It takes no number yet."""
    trip_ids = list(dict.fromkeys(body.trip_ids))
    trips = await _by_id(db, Trip, trip_ids)
    for i, trip_id in enumerate(body.trip_ids):
        if trip_id not in trips:
            raise invalid(f"tripIds[{i}]", "no such trip")
    sheets = await _by_id(db, TripSheet, [t.trip_sheet_id for t in trips.values()])
    sites = {s.site_id for s in sheets.values()}
    if not all(access.can(WRITE, site) for site in sites):
        raise needs_permission(WRITE)
    if len(sites) > 1:
        # A site is the invoice's scope and its seller: one invoice, one site.
        raise refuse({"code": "trips-other-site"})
    (site_id,) = sites
    await _lock_sheets(db, sheets)
    customer = await db.get(Party, body.customer_id)
    if customer is None or "customer" not in customer.party_roles:
        raise invalid("customerId", "not a customer")
    sales = (
        await db.scalars(
            select(TripSale)
            .where(TripSale.trip_id.in_(trip_ids), TripSale.customer_party_id == customer.id)
            .execution_options(populate_existing=True)
        )
    ).all()
    billed = await _billed(db, list(sales))
    live = await live_invoices_of(db, [b.sale.id for b in billed])
    for trip_id in trip_ids:
        on_trip = [b for b in billed if b.trip.id == trip_id]
        if not on_trip:
            raise refuse({"code": "trip-not-for-customer", "tripNumber": trips[trip_id].trip_number})
        # A trip whose lines are all on a live invoice has nothing left to bill; one with a line
        # added since bills that line.
        if all(b.sale.id in live for b in on_trip):
            _billable(on_trip[0], live)
    billed = [b for b in billed if b.sale.id not in live]
    for b in billed:
        _billable(b, live)
    header = await _header(db, site_id, customer, billed, None)
    figures = inv.invoice_figures([_domain_line(b) for b in billed], header["supply_type"])
    invoice = Invoice(
        id=uuid.uuid4(),
        organization_id=access.organization_id,
        site_id=site_id,
        customer_party_id=customer.id,
        status="draft",
        rules_version=inv.INVOICE_RULES_VERSION,
        created_by=access.user_id,
        created_by_name=access.name,
        **header,
        **_totals(figures),
    )
    db.add(invoice)
    await db.flush()
    for i, b in enumerate(billed):
        db.add(
            InvoiceLine(
                id=uuid.uuid4(),
                organization_id=access.organization_id,
                invoice_id=invoice.id,
                invoice_status="draft",
                position=i,
                **_line_values(b, figures.lines[str(b.sale.id)]),
            )
        )
    try:
        await db.flush()
    except IntegrityError as exc:  # pragma: no cover - the sheets are locked, so only a bug gets here
        if "uq_invoice_lines_live_trip_sale" in str(exc.orig):
            raise refuse({"code": "sale-on-invoice"}) from exc
        raise
    return invoice.id


async def _refigure(
    db: AsyncSession,
    invoice: Invoice,
    lines: Sequence[InvoiceLine],
    billed: Sequence[Billed],
    header: dict[str, Any],
) -> None:
    """A draft's lines and totals worked out again, as of now. Positions stay as they were."""
    figures = inv.invoice_figures([_domain_line(b) for b in billed], header["supply_type"])
    by_sale = {line.trip_sale_id: line for line in lines}
    for b in billed:
        line = by_sale[b.sale.id]
        for key, value in _line_values(b, figures.lines[str(b.sale.id)]).items():
            setattr(line, key, value)
    # Lines first, while they are still a draft's: the guard freezes them once issued.
    await db.flush()
    for key, value in {**header, **_totals(figures)}.items():
        setattr(invoice, key, value)


async def _draft_to_change(
    db: AsyncSession, access: Access, invoice_id: uuid.UUID
) -> tuple[Invoice, list[InvoiceLine], list[Billed]]:
    """A draft, locked with the sheets it bills, its lines and their sale lines."""
    invoice = await load_invoice(db, invoice_id)
    if not access.can(WRITE, invoice.site_id):
        raise needs_permission(WRITE)
    await _lock_sheets(db, await _sheet_ids_of(db, invoice.id))
    invoice = await load_invoice(db, invoice_id, lock=True)
    if invoice.status != "draft":
        raise refuse(
            {"code": "not-a-draft", "status": invoice.status, "invoiceNumber": invoice.invoice_number}
        )
    lines = (await _lines(db, [invoice.id]))[invoice.id]
    sales = await _by_id(db, TripSale, [line.trip_sale_id for line in lines])
    return invoice, lines, await _billed(db, list(sales.values()))


async def patch_draft(db: AsyncSession, access: Access, invoice_id: uuid.UUID, body: InvoicePatch) -> None:
    """Where to bill and deliver, the place of supply (then kept as chosen), a note: a draft's only."""
    invoice, lines, billed = await _draft_to_change(db, access, invoice_id)
    if body.place_of_supply is not None and body.place_of_supply not in inv.GST_STATES:
        raise invalid("placeOfSupply", "not a state")
    was = Kept.of(invoice)
    kept = Kept(
        place_of_supply=body.place_of_supply if body.place_of_supply is not None else was.place_of_supply,
        pos_basis="chosen" if body.place_of_supply is not None else was.pos_basis,
        buyer_address=body.buyer_address if body.buyer_address is not None else was.buyer_address,
        ship_to_address=body.ship_to_address if body.ship_to_address is not None else was.ship_to_address,
    )
    customer = await db.get(Party, invoice.customer_party_id)
    assert customer is not None
    # Worked out before anything on the invoice moves, so no flush meets it half changed.
    await _refigure(db, invoice, lines, billed, await _header(db, invoice.site_id, customer, billed, kept))
    if body.notes is not None:
        invoice.notes = body.notes
    await db.flush()


async def delete_draft(db: AsyncSession, access: Access, invoice_id: uuid.UUID) -> None:
    """A draft that was never issued, and its lines. An issued invoice is cancelled instead, never deleted."""
    invoice = await load_invoice(db, invoice_id, lock=True)
    if not access.can(WRITE, invoice.site_id):
        raise needs_permission(WRITE)
    if invoice.status != "draft":
        raise refuse(
            {"code": "not-a-draft", "status": invoice.status, "invoiceNumber": invoice.invoice_number}
        )
    await db.execute(delete(InvoiceLine).where(InvoiceLine.invoice_id == invoice.id))
    await db.execute(delete(Invoice).where(Invoice.id == invoice.id))


# ------------------------------------------------------------- the number


async def issue(db: AsyncSession, access: Access, calendar: TenantCalendar, invoice_id: uuid.UUID) -> None:
    """Take the next number of the seller GSTIN's series for today's financial year, and freeze the invoice.

    The seller and the buyer are read again as they are now; the lines cannot
    have moved, because a sale line on a draft is locked on its trip. Money
    already paid on the trips is matched to it at once (`_match`).
    """
    invoice, lines, billed = await _draft_to_change(db, access, invoice_id)
    if len(billed) != len(lines):  # pragma: no cover - a live line always names its sale
        raise refuse({"code": "invoice-changed"})
    customer = await db.get(Party, invoice.customer_party_id)
    assert customer is not None
    header = await _header(db, invoice.site_id, customer, billed, Kept.of(invoice))
    await _refigure(db, invoice, lines, billed, header)
    day = calendar.today()
    year = calendar.financial_year(day)
    registration = await db.get(GstRegistration, header["gst_registration_id"])
    assert registration is not None
    series_id, serial = await next_invoice_serial(db, access.organization_id, registration.id, year)
    number_ = inv.invoice_number(registration.invoice_prefix, year, serial)
    if not inv.is_invoice_number(number_):
        raise refuse({"code": "series-full", "gstin": registration.gstin, "financialYear": year})
    invoice.status = "issued"
    invoice.series_id = series_id
    invoice.financial_year = year
    invoice.serial = serial
    invoice.invoice_number = number_
    invoice.invoice_date = day
    invoice.issued_at = datetime.now(UTC)
    invoice.issued_by = access.user_id
    invoice.issued_by_name = access.name
    await db.flush()
    await _match(db, access, invoice)


async def cancel(db: AsyncSession, access: Access, invoice_id: uuid.UUID, reason: str) -> None:
    """Keep an issued invoice on record, marked cancelled, with its number; its trips can be invoiced again.

    Money matched to it is let go first, back to be matched to the invoice that replaces it.
    """
    invoice = await load_invoice(db, invoice_id)
    if not access.can(CANCEL, invoice.site_id):
        raise needs_permission(CANCEL)
    await _lock_sheets(db, await _sheet_ids_of(db, invoice.id))
    invoice = await load_invoice(db, invoice_id, lock=True)
    if invoice.status == "draft":
        raise refuse({"code": "not-issued", "status": invoice.status})
    if invoice.status == "cancelled":
        raise refuse({"code": "already-cancelled", "invoiceNumber": invoice.invoice_number})
    await db.execute(delete(InvoiceReceipt).where(InvoiceReceipt.invoice_id == invoice.id))
    await db.flush()
    invoice.status = "cancelled"
    invoice.cancelled_at = datetime.now(UTC)
    invoice.cancelled_by = access.user_id
    invoice.cancelled_by_name = access.name
    invoice.cancel_reason = reason
    await db.flush()


# --------------------------------------------------------- money received


@dataclass
class Candidate:
    """A payment from the invoice's customer on its trips, or on their sheets, and what of it is free."""

    payment: TripPayment
    on_trip: bool
    free: Decimal
    sheet: TripSheet
    trip: Trip | None


async def _candidates(db: AsyncSession, invoice: Invoice, lines: Sequence[InvoiceLine]) -> list[Candidate]:
    sales = await _by_id(db, TripSale, [line.trip_sale_id for line in lines])
    trips = await _by_id(db, Trip, [s.trip_id for s in sales.values()])
    sheet_ids = {t.trip_sheet_id for t in trips.values()}
    if not trips:
        return []
    payments = (
        await db.scalars(
            select(TripPayment).where(
                TripPayment.direction == "in",
                TripPayment.party_id == invoice.customer_party_id,
                or_(
                    TripPayment.trip_id.in_(list(trips)),
                    and_(TripPayment.trip_id.is_(None), TripPayment.trip_sheet_id.in_(sheet_ids)),
                ),
            )
        )
    ).all()
    if not payments:
        return []
    taken = dict(
        (
            await db.execute(
                select(InvoiceReceipt.trip_payment_id, func.sum(InvoiceReceipt.amount))
                .where(InvoiceReceipt.trip_payment_id.in_([p.id for p in payments]))
                .group_by(InvoiceReceipt.trip_payment_id)
            )
        ).all()
    )
    sheets = await _by_id(db, TripSheet, [p.trip_sheet_id for p in payments])
    return [
        Candidate(
            payment=p,
            on_trip=p.trip_id is not None,
            free=pl.round_to(p.amount - Decimal(taken.get(p.id, 0)), 2),
            sheet=sheets[p.trip_sheet_id],
            trip=trips.get(p.trip_id) if p.trip_id else None,
        )
        for p in payments
    ]


async def _receipts(
    db: AsyncSession, invoice_ids: Sequence[uuid.UUID]
) -> dict[uuid.UUID, list[InvoiceReceipt]]:
    out: dict[uuid.UUID, list[InvoiceReceipt]] = {i: [] for i in invoice_ids}
    if invoice_ids:
        stmt = (
            select(InvoiceReceipt)
            .where(InvoiceReceipt.invoice_id.in_(invoice_ids))
            .order_by(InvoiceReceipt.matched_at, InvoiceReceipt.id)
            .execution_options(populate_existing=True)
        )
        for r in (await db.scalars(stmt)).all():
            out[r.invoice_id].append(r)
    return out


async def _match(
    db: AsyncSession,
    access: Access,
    invoice: Invoice,
    payment_id: uuid.UUID | None = None,
    amount: Decimal | None = None,
) -> None:
    """Match the customer's payments to what the invoice still has due: all by the rule, or one."""
    lines = (await _lines(db, [invoice.id]))[invoice.id]
    candidates = await _candidates(db, invoice, lines)
    receipts = (await _receipts(db, [invoice.id]))[invoice.id]
    due = inv.invoice_due(invoice.total, sum((r.amount for r in receipts), Decimal(0)))
    if payment_id is None:
        matches = inv.match_receipts(
            due,
            [
                inv.ReceiptCandidate(str(c.payment.id), c.on_trip, c.payment.paid_on.isoformat(), c.free)
                for c in candidates
            ],
        )
    else:
        c = next((c for c in candidates if c.payment.id == payment_id), None)
        if c is None:
            raise invalid("paymentId", "not a payment from this customer on these trips")
        if c.free <= 0:
            raise refuse({"code": "payment-matched"})
        if due <= 0:
            raise refuse({"code": "invoice-paid"})
        take = amount if amount is not None else min(c.free, due)
        if take > c.free or take > due:
            raise refuse({"code": "too-much", "free": money(c.free), "due": money(due)})
        matches = [inv.ReceiptMatch(str(payment_id), take)]
    held = {r.trip_payment_id: r for r in receipts}
    for m in matches:
        pid = uuid.UUID(m.payment_id)
        if pid in held:
            held[pid].amount = held[pid].amount + m.amount
        else:
            db.add(
                InvoiceReceipt(
                    organization_id=access.organization_id,
                    invoice_id=invoice.id,
                    invoice_status="issued",
                    trip_payment_id=pid,
                    amount=m.amount,
                    matched_by=access.user_id,
                    matched_by_name=access.name,
                )
            )
    await db.flush()


async def _issued_to_receive(db: AsyncSession, access: Access, invoice_id: uuid.UUID) -> Invoice:
    invoice = await load_invoice(db, invoice_id)
    if not access.can(RECEIVE, invoice.site_id):
        raise needs_permission(RECEIVE)
    await _lock_sheets(db, await _sheet_ids_of(db, invoice.id))
    invoice = await load_invoice(db, invoice_id, lock=True)
    if invoice.status != "issued":
        raise refuse({"code": "not-issued", "status": invoice.status})
    return invoice


async def match(db: AsyncSession, access: Access, invoice_id: uuid.UUID, body: MatchIn) -> None:
    invoice = await _issued_to_receive(db, access, invoice_id)
    await _match(db, access, invoice, body.payment_id, body.amount)


async def unmatch(db: AsyncSession, access: Access, invoice_id: uuid.UUID, receipt_id: uuid.UUID) -> None:
    """Let one match go: the money is free again, and the invoice shows it due."""
    invoice = await _issued_to_receive(db, access, invoice_id)
    receipt = await db.scalar(
        select(InvoiceReceipt).where(InvoiceReceipt.id == receipt_id, InvoiceReceipt.invoice_id == invoice.id)
    )
    if receipt is None:
        raise gone("receipt-gone")
    await db.delete(receipt)
    await db.flush()


# ------------------------------------------------------------- the wire


def _money_of(invoice: Invoice, received: Decimal) -> tuple[str, str, str | None]:
    """(received, due, money status): only an issued invoice is owed anything."""
    if invoice.status != "issued":
        return money(Decimal(0)), money(Decimal(0)), None
    return (
        money(received),
        money(inv.invoice_due(invoice.total, received)),
        inv.money_status(invoice.total, received),
    )


def _row_fields(invoice: Invoice, lines: Sequence[InvoiceLine], received: Decimal) -> dict[str, Any]:
    got, due, status = _money_of(invoice, received)
    tax = invoice.cgst_total + invoice.sgst_total + invoice.igst_total
    return {
        "id": invoice.id,
        "status": invoice.status,
        "invoice_number": invoice.invoice_number,
        "invoice_date": invoice.invoice_date,
        "financial_year": invoice.financial_year,
        "site_id": invoice.site_id,
        "customer_id": invoice.customer_party_id,
        "buyer_name": invoice.buyer_name,
        "buyer_gstin": invoice.buyer_gstin,
        "kind": inv.invoice_kind(invoice.buyer_gstin),
        "seller_gstin": invoice.seller_gstin,
        "place_of_supply": invoice.place_of_supply,
        "supply_type": invoice.supply_type,
        "trip_numbers": list(dict.fromkeys(line.trip_number for line in lines)),
        "line_count": len(lines),
        "taxable": money(invoice.taxable_total),
        "tax": money(tax),
        "total": money(invoice.total),
        "received": got,
        "due": due,
        "money_status": status,
        "created_by": invoice.created_by_name,
        "created_at": invoice.created_at,
        "issued_at": invoice.issued_at,
        "cancelled_at": invoice.cancelled_at,
    }


def _pcts(rate: Decimal, supply: str) -> tuple[float | int, float | int, float | int]:
    """CGST, SGST and IGST rates of a line: half each within the state, the whole as IGST across."""
    half = number(rate * Decimal("0.5")) or 0
    return (half, half, 0) if supply == "intra" else (0, 0, number(rate) or 0)


def _tax_rows(lines: Sequence[InvoiceLine]) -> list[TaxRowOut]:
    """The tax by HSN and rate, added up from the lines as stored."""
    rows: dict[tuple[str, str], inv.TaxRow] = {}
    for line in lines:
        key = (line.hsn_code, pl.to_fixed(line.gst_rate_pct, 2))
        row = rows.get(key)
        rows[key] = inv.TaxRow(
            line.hsn_code,
            line.gst_rate_pct,
            (row.taxable if row else Decimal(0)) + line.taxable,
            (row.cgst if row else Decimal(0)) + line.cgst,
            (row.sgst if row else Decimal(0)) + line.sgst,
            (row.igst if row else Decimal(0)) + line.igst,
        )
    return [
        TaxRowOut.model_validate(rows[k].wire()) for k in sorted(rows, key=lambda k: (k[0], Decimal(k[1])))
    ]


async def receipts_out(db: AsyncSession, invoice: Invoice) -> ReceiptsOut:
    lines = (await _lines(db, [invoice.id]))[invoice.id]
    receipts = (await _receipts(db, [invoice.id]))[invoice.id]
    received = sum((r.amount for r in receipts), Decimal(0))
    got, due, status = _money_of(invoice, received)
    candidates = await _candidates(db, invoice, lines) if invoice.status == "issued" else []
    payments = await _by_id(db, TripPayment, [r.trip_payment_id for r in receipts])
    sheets = await _by_id(db, TripSheet, [p.trip_sheet_id for p in payments.values()])
    trips = await _by_id(db, Trip, [p.trip_id for p in payments.values()])
    out_receipts = []
    # In the order they were matched; one match's payments as the rule takes them.
    receipts = sorted(
        receipts,
        key=lambda r: (
            r.matched_at,
            payments[r.trip_payment_id].trip_id is None,
            payments[r.trip_payment_id].paid_on,
            str(r.trip_payment_id),
        ),
    )
    for r in receipts:
        p = payments[r.trip_payment_id]
        trip = trips.get(p.trip_id) if p.trip_id else None
        out_receipts.append(
            ReceiptOut(
                id=r.id,
                payment_id=p.id,
                paid_on=p.paid_on,
                mode=MODE_OF_METHOD[p.method],
                reference=p.reference_no,
                sheet_id=p.trip_sheet_id,
                sheet_number=sheets[p.trip_sheet_id].sheet_number,
                trip_number=trip.trip_number if trip else None,
                payment_amount=money(p.amount),
                amount=money(r.amount),
                matched_by=r.matched_by_name,
                matched_at=r.matched_at,
            )
        )
    unmatched = [
        UnmatchedOut(
            payment_id=c.payment.id,
            paid_on=c.payment.paid_on,
            mode=MODE_OF_METHOD[c.payment.method],
            reference=c.payment.reference_no,
            sheet_id=c.sheet.id,
            sheet_number=c.sheet.sheet_number,
            trip_number=c.trip.trip_number if c.trip else None,
            on_trip=c.on_trip,
            payment_amount=money(c.payment.amount),
            free=money(c.free),
        )
        for c in sorted(candidates, key=lambda c: (not c.on_trip, c.payment.paid_on, str(c.payment.id)))
        if c.free > 0
    ]
    return ReceiptsOut(
        invoice_id=invoice.id,
        total=money(invoice.total),
        received=got,
        due=due,
        money_status=status,
        receipts=out_receipts,
        unmatched=unmatched,
    )


async def invoice_out(db: AsyncSession, invoice_id: uuid.UUID) -> InvoiceOut:
    await db.flush()
    invoice = await load_invoice(db, invoice_id)
    lines = (await _lines(db, [invoice.id]))[invoice.id]
    money_in = await receipts_out(db, invoice)
    sales = await _by_id(db, TripSale, [line.trip_sale_id for line in lines])
    trips = await _by_id(db, Trip, [s.trip_id for s in sales.values()])
    out_lines = []
    for line in lines:
        cgst_pct, sgst_pct, igst_pct = _pcts(line.gst_rate_pct, invoice.supply_type)
        sale = sales.get(line.trip_sale_id) if line.trip_sale_id else None
        trip = trips.get(sale.trip_id) if sale else None
        out_lines.append(
            InvoiceLineOut(
                id=line.id,
                position=line.position,
                trip_sale_id=line.trip_sale_id,
                trip_id=trip.id if trip else None,
                sheet_id=trip.trip_sheet_id if trip else None,
                sheet_number=line.sheet_number,
                trip_number=line.trip_number,
                trip_date=line.trip_date,
                registration_number=line.registration_number,
                challan_number=line.challan_number,
                location=line.location,
                description=line.description,
                hsn_code=line.hsn_code,
                unit=line.unit,
                quantity=number(line.quantity) or 0,
                # As stored: the figures were worked out when it was made, and again when issued.
                rate=money(line.rate),
                amount=money(line.amount),
                transport=money(line.transport),
                taxable=money(line.taxable),
                gst_rate_pct=number(line.gst_rate_pct) or 0,
                cgst_pct=cgst_pct,
                sgst_pct=sgst_pct,
                igst_pct=igst_pct,
                cgst=money(line.cgst),
                sgst=money(line.sgst),
                igst=money(line.igst),
                total=money(line.total),
            )
        )
    received = sum((Decimal(r.amount) for r in money_in.receipts), Decimal(0))
    return InvoiceOut(
        **_row_fields(invoice, lines, received),
        seller=SellerOut(
            legal_name=invoice.seller_legal_name,
            trade_name=invoice.seller_trade_name,
            gstin=invoice.seller_gstin,
            state_code=invoice.seller_state_code,
            address=invoice.seller_address,
        ),
        buyer=BuyerOut(
            party_id=invoice.customer_party_id,
            name=invoice.buyer_name,
            gstin=invoice.buyer_gstin,
            state_code=inv.state_of_gstin(invoice.buyer_gstin),
            address=invoice.buyer_address,
        ),
        ship_to=(
            ShipToOut(name=invoice.ship_to_name, address=invoice.ship_to_address)
            if invoice.ship_to_name or invoice.ship_to_address
            else None
        ),
        pos_basis=invoice.pos_basis,
        lines=out_lines,
        by_hsn=_tax_rows(lines),
        cgst=money(invoice.cgst_total),
        sgst=money(invoice.sgst_total),
        igst=money(invoice.igst_total),
        before_rounding=money(invoice.total - invoice.round_off),
        round_off=money(invoice.round_off),
        words=inv.amount_in_words(invoice.total),
        notes=invoice.notes,
        issued_by=invoice.issued_by_name,
        cancelled_by=invoice.cancelled_by_name,
        cancel_reason=invoice.cancel_reason,
        irn=invoice.irn,
        irn_ack_number=invoice.irn_ack_number,
        irn_ack_date=invoice.irn_ack_date,
        receipts=money_in.receipts,
        unmatched=money_in.unmatched,
    )


# ------------------------------------------------------------- the lists


@dataclass
class InvoiceFilter:
    status: str | None = None
    #: due: issued with money still due; paid: issued and paid in full.
    money_status: str | None = None
    customer_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    date_from: date | None = None
    date_to: date | None = None
    q: str | None = None
    limit: int = 500


def _like(q: str) -> str:
    escaped = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _received_sum() -> ColumnElement[Decimal]:
    return (
        select(func.coalesce(func.sum(InvoiceReceipt.amount), 0))
        .where(InvoiceReceipt.invoice_id == Invoice.id)
        .scalar_subquery()
    )


async def list_invoices(
    db: AsyncSession, scope: Scope, calendar: TenantCalendar, f: InvoiceFilter
) -> InvoiceListOut:
    """Invoices at the sites this person reaches that match, drafts first, then the latest issued."""
    day = func.coalesce(
        Invoice.invoice_date, cast(func.timezone(calendar.timezone.key, Invoice.created_at), Date)
    )
    stmt = select(Invoice).where(scope.clause(Invoice.site_id))
    if f.status:
        stmt = stmt.where(Invoice.status == f.status)
    if f.money_status == "due":
        stmt = stmt.where(Invoice.status == "issued", Invoice.total > _received_sum())
    elif f.money_status == "paid":
        stmt = stmt.where(Invoice.status == "issued", Invoice.total <= _received_sum())
    if f.customer_id:
        stmt = stmt.where(Invoice.customer_party_id == f.customer_id)
    if f.site_id:
        stmt = stmt.where(Invoice.site_id == f.site_id)
    if f.date_from:
        stmt = stmt.where(day >= f.date_from)
    if f.date_to:
        stmt = stmt.where(day <= f.date_to)
    if f.q and f.q.strip():
        like = _like(f.q.strip())
        plate = _like("".join(f.q.split()).upper())
        on_line = select(InvoiceLine.id).where(
            InvoiceLine.invoice_id == Invoice.id,
            or_(
                InvoiceLine.trip_number.ilike(like, escape="\\"),
                InvoiceLine.sheet_number.ilike(like, escape="\\"),
                InvoiceLine.challan_number.ilike(like, escape="\\"),
                InvoiceLine.description.ilike(like, escape="\\"),
                func.replace(InvoiceLine.registration_number, " ", "").ilike(plate, escape="\\"),
            ),
        )
        stmt = stmt.where(
            or_(
                Invoice.invoice_number.ilike(like, escape="\\"),
                Invoice.buyer_name.ilike(like, escape="\\"),
                Invoice.buyer_gstin.ilike(like, escape="\\"),
                exists(on_line),
            )
        )
    stmt = stmt.order_by(
        (Invoice.status == "draft").desc(),
        Invoice.invoice_date.desc().nulls_first(),
        Invoice.serial.desc().nulls_first(),
        Invoice.created_at.desc(),
    ).limit(f.limit)
    invoices = list((await db.scalars(stmt)).all())
    ids = [i.id for i in invoices]
    lines = await _lines(db, ids)
    receipts = await _receipts(db, ids)
    rows = [
        InvoiceRowOut(**_row_fields(i, lines[i.id], sum((r.amount for r in receipts[i.id]), Decimal(0))))
        for i in invoices
    ]
    issued = [r for r in rows if r.status == "issued"]
    return InvoiceListOut(
        rows=rows,
        total=InvoiceTotalOut(
            invoices=len(rows),
            total=money(sum((Decimal(r.total) for r in issued), Decimal(0))),
            received=money(sum((Decimal(r.received) for r in issued), Decimal(0))),
            due=money(sum((Decimal(r.due) for r in issued), Decimal(0))),
        ),
    )


@dataclass
class TripFilter:
    customer_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    date_from: date | None = None
    date_to: date | None = None
    q: str | None = None
    limit: int = 500


async def trips_to_invoice(db: AsyncSession, scope: Scope, f: TripFilter) -> list[InvoiceTripOut]:
    """Each trip's sale lines to each customer that no draft or issued invoice bills yet, the latest first."""
    on_live = select(InvoiceLine.id).where(
        InvoiceLine.trip_sale_id == TripSale.id, InvoiceLine.invoice_status.in_(LIVE)
    )
    stmt = (
        select(TripSale, Trip, TripSheet)
        .join(Trip, Trip.id == TripSale.trip_id)
        .join(TripSheet, TripSheet.id == Trip.trip_sheet_id)
        .where(scope.clause(TripSheet.site_id), ~exists(on_live))
    )
    if f.customer_id:
        stmt = stmt.where(TripSale.customer_party_id == f.customer_id)
    if f.site_id:
        stmt = stmt.where(TripSheet.site_id == f.site_id)
    if f.date_from:
        stmt = stmt.where(Trip.trip_date >= f.date_from)
    if f.date_to:
        stmt = stmt.where(Trip.trip_date <= f.date_to)
    if f.q and f.q.strip():
        like = _like(f.q.strip())
        plate = _like("".join(f.q.split()).upper())
        named = select(Party.id).where(
            Party.id == TripSale.customer_party_id, Party.display_name.ilike(like, escape="\\")
        )
        stmt = stmt.where(
            or_(
                Trip.trip_number.ilike(like, escape="\\"),
                TripSheet.sheet_number.ilike(like, escape="\\"),
                func.replace(TripSheet.registration_number, " ", "").ilike(plate, escape="\\"),
                TripSale.challan_number.ilike(like, escape="\\"),
                TripSale.location.ilike(like, escape="\\"),
                exists(named),
            )
        )
    stmt = stmt.order_by(Trip.trip_date.desc(), Trip.trip_number.desc(), TripSale.position).limit(f.limit * 4)
    rows = (await db.execute(stmt)).all()
    parties = await _by_id(db, Party, [s.customer_party_id for s, _, _ in rows])
    items = await _by_id(db, Item, [s.item_id for s, _, _ in rows])
    grouped: dict[tuple[uuid.UUID, uuid.UUID], list[tuple[TripSale, Trip, TripSheet]]] = {}
    for sale, trip, sheet in rows:
        grouped.setdefault((trip.id, sale.customer_party_id), []).append((sale, trip, sheet))
    out: list[InvoiceTripOut] = []
    for (_, customer_id), group in list(grouped.items())[: f.limit]:
        _, trip, sheet = group[0]
        sales = [s for s, _, _ in group]
        figures = [
            pl.sale_figures(
                pl.Sale(
                    str(s.id),
                    str(s.customer_party_id),
                    s.quantity,
                    s.rate,
                    s.gst_billed,
                    s.gst_rate_pct,
                    s.transport_amount,
                )
            )
            for s in sales
        ]
        blocked = next(
            (
                code
                for s in sales
                for code, hit in (
                    ("not-gst", not s.gst_billed),
                    ("billed-outside", bool(s.invoice_number.strip())),
                    ("no-hsn", not s.hsn_code),
                )
                if hit
            ),
            None,
        )
        party = parties.get(customer_id)
        out.append(
            InvoiceTripOut(
                trip_id=trip.id,
                trip_number=trip.trip_number,
                trip_date=trip.trip_date,
                sheet_id=sheet.id,
                sheet_number=sheet.sheet_number,
                site_id=sheet.site_id,
                registration_number=sheet.registration_number,
                customer_id=customer_id,
                customer_name=party.display_name if party else "",
                customer_gstin=next(
                    (s.party_gstin for s in sales if s.party_gstin), party.gstin if party else None
                ),
                materials=list(dict.fromkeys(items[s.item_id].name for s in sales if s.item_id in items)),
                line_count=len(sales),
                taxable=money(sum((x.taxable for x in figures), Decimal(0))),
                total=money(sum((x.total for x in figures), Decimal(0))),
                blocked=blocked,  # type: ignore[arg-type]
                outside_invoice_number=next(
                    (s.invoice_number for s in sales if s.invoice_number.strip()), ""
                ),
            )
        )
    return out

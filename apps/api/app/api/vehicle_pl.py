"""The vehicle P&L (LIN-22): trip sheets with their trips and lines, the masters, and the reports.

    GET    /sheets                           trip sheets, searched and filtered        readers
    POST   /sheets                           a new sheet with its trips and lines      write
    GET    /sheets/{id}                      one sheet, every trip and line, the P&L   readers
    PUT    /sheets/{id}                      the sheet as the page holds it now        write
    DELETE /sheets/{id}                      the sheet, its trips and lines            write
    POST   /sheets/{id}/trips/{tripId}/close a customer paid the trip in full          close
    DELETE /sheets/{id}/trips/{tripId}/close take that back                            close
    GET    /masters                          vendors, customers, materials, GST rates
    POST   /parties                          a vendor or customer added from the sheet write
    PATCH  /parties/{id}                     a GSTIN, phone or address, saved          write*
    POST   /parties/{id}/locations           a purchase or delivery location, saved    write
    PATCH  /parties/{id}/locations/{locId}   a location's address and state            write*
    POST   /materials                        a material: HSN, unit, default GST rate   write
    PATCH  /materials/{id}                   correct a material, or retire it          write
    POST   /gst-rates                        a GST rate lines may be billed at         write
    PATCH  /gst-rates/{id}                   switch a rate off, or on again            write
    GET    /diesel-bills                     a vehicle's diesel bills a sheet may link
    POST   /attachments                      a photo or PDF of a trip's paper          write
    GET    /attachments/{id}                 that file, under the sheet's read keys
    GET    /reports/trips                    trip-wise, with totals                    readers
    GET    /reports/vehicles                 vehicle-wise                              report
    GET    /reports/months                   month-wise                                report
    GET    /reports/customers                money due from customers                  report
    GET    /reports/vendors                  money due to vendors                      report

    under /vehicle-pl. readers: fleet.trip_pl.read or finance.pl_report.read;
    write: fleet.trip_pl.write; close: finance.receipt.verify; report:
    finance.pl_report.read. write*: fleet.trip_pl.write or sales.invoice.write,
    since whoever makes invoices (LIN-27, app/api/party_invoices.py) keeps the
    addresses and delivery states they print.

A sheet is read where fleet.trip_pl.read or finance.pl_report.read reaches its
site, and written where fleet.trip_pl.write does: whoever enters a sheet sees
its P&L. The vehicle-wise and monthly reports and the money-due lists are the
director's and accounts'. Every figure is worked out on the server by
app/domain/vehicle_pl.py.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import StreamingResponse
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, Scope, access_for, calendar_for
from app.api.customers import gstin_is_valid
from app.api.deps import CurrentSessionDep
from app.api.problems import gone, invalid, needs_permission, refuse
from app.core.settings import get_settings
from app.core.storage import UploadRefused, clean_file_name, file_store, read_capped, stored_file_response
from app.domain import vehicle_pl as pl
from app.domain.party_invoice import GST_STATES
from app.models.core import File, Site
from app.models.finance import ExpenseBill
from app.models.logistics import DieselLine, EnRouteExpense, Trip, TripSheet
from app.models.master import GstRate, Item, Party, PartyLocation
from app.models.procurement import TripPurchase, TripPurchaseFile
from app.models.sales import TripSale
from app.schemas.common import money, number
from app.schemas.expenses import AttachmentOut
from app.schemas.vehicle_pl import (
    CloseIn,
    DieselBillOut,
    GstRateBody,
    GstRateOut,
    GstRatePatch,
    LinkedSheetOut,
    LocationIn,
    LocationOut,
    LocationPatch,
    MastersOut,
    MaterialIn,
    MaterialOut,
    MaterialPatch,
    MonthPlOut,
    MonthReportOut,
    OutstandingOut,
    OutstandingReportOut,
    OutstandingTotalOut,
    PartyIn,
    PartyOut,
    PartyPatch,
    SheetIn,
    SheetListOut,
    SheetOut,
    TripReportOut,
    VehiclePlOut,
    VehicleReportOut,
)
from app.services.expense_bills import size_kb
from app.services.vehicle_pl import (
    READ,
    READ_KEYS,
    REPORT,
    VOID_BILL,
    WRITE,
    Context,
    SheetBundle,
    SheetFilter,
    Unit,
    build_context,
    close_trip,
    delete_sheet,
    diesel_bill_scope,
    find_sheet_ids,
    latest_vehicle,
    load_bundles,
    may_read,
    save_sheet,
    sheet_out,
    sheet_row,
    totals_out,
    trip_row,
    units_of,
)

router = APIRouter(prefix="/vehicle-pl", tags=["fleet"])

DateFrom = Annotated[date | None, Query(alias="from", description="Trip date, inclusive")]
DateTo = Annotated[date | None, Query(alias="to", description="Trip date, inclusive")]
VehicleId = Annotated[str | None, Query(alias="vehicleId", max_length=64)]
CustomerId = Annotated[uuid.UUID | None, Query(alias="customerId")]
VendorId = Annotated[uuid.UUID | None, Query(alias="vendorId")]
SiteId = Annotated[uuid.UUID | None, Query(alias="siteId")]
Search = Annotated[str | None, Query(alias="q", max_length=100)]
Limit = Annotated[int, Query(ge=1, le=2000)]

#: Every sheet of a report: the reports add trips up, so none is cut off.
ALL = 100000


def _scope_or_refuse(access: Access, *keys: str) -> Scope:
    scope = access.scope(*keys)
    if scope.empty:
        raise needs_permission(keys[0])
    return scope


async def _sheet(db: AsyncSession, sheet_id: uuid.UUID, *, lock: bool = False) -> SheetBundle:
    """The sheet with its trips and lines; another tenant's is not there, as if it never was."""
    stmt = select(TripSheet.id).where(TripSheet.id == sheet_id)
    if lock:
        stmt = stmt.with_for_update()
    if await db.scalar(stmt) is None:
        raise gone("sheet-gone")
    return (await load_bundles(db, [sheet_id]))[0]


async def _respond(db: AsyncSession, sheet_id: uuid.UUID) -> SheetOut:
    await db.flush()
    db.expire_all()
    bundles = await load_bundles(db, [sheet_id])
    return sheet_out(bundles[0], await build_context(db, bundles))


# ------------------------------------------------------------------- sheets


@router.get("/sheets", response_model=SheetListOut)
async def list_sheets(
    current: CurrentSessionDep,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    vehicle_id: VehicleId = None,
    customer_id: CustomerId = None,
    vendor_id: VendorId = None,
    site_id: SiteId = None,
    q: Search = None,
    limit: Limit = 500,
) -> SheetListOut:
    """Trip sheets this person may read, the latest first, each with its total P&L."""
    scope = _scope_or_refuse(await access_for(current), *READ_KEYS)
    f = SheetFilter(date_from, date_to, vehicle_id, customer_id, vendor_id, site_id, q, limit)
    bundles = await load_bundles(current.db, await find_sheet_ids(current.db, scope, f))
    ctx = await build_context(current.db, bundles)
    rows = [sheet_row(b, ctx) for b in bundles]
    return SheetListOut(
        rows=rows,
        total=totals_out(
            pl.sum_pl([ctx.calcs[str(b.sheet.id)].pl for b in bundles], sum(len(b.trips) for b in bundles))
        ),
    )


@router.get("/sheets/{sheet_id}", response_model=SheetOut)
async def get_sheet(sheet_id: uuid.UUID, current: CurrentSessionDep) -> SheetOut:
    access = await access_for(current)
    bundle = await _sheet(current.db, sheet_id)
    if not may_read(access, bundle.sheet):
        raise needs_permission(READ)
    return sheet_out(bundle, await build_context(current.db, [bundle]))


def _no_ids(body: SheetIn) -> None:
    sections = [body.diesel, body.en_route, body.payments, body.trips]
    for trip in body.trips:
        sections += [trip.diesel, trip.en_route, trip.purchases, trip.sales, trip.payments]
    if any(line.id is not None for section in sections for line in section):
        raise invalid("id", "a new sheet's trips and lines have no ids yet")


@router.post("/sheets", response_model=SheetOut, status_code=status.HTTP_201_CREATED)
async def create_sheet(body: SheetIn, current: CurrentSessionDep) -> SheetOut:
    _no_ids(body)
    access = await access_for(current)
    sheet_id = await save_sheet(current.db, access, await calendar_for(current), body, None)
    return await _respond(current.db, sheet_id)


@router.put("/sheets/{sheet_id}", response_model=SheetOut)
async def replace_sheet(sheet_id: uuid.UUID, body: SheetIn, current: CurrentSessionDep) -> SheetOut:
    """The sheet as the page holds it now: trips and lines kept by id are corrected,
    the rest added or deleted. Values the rules derive are worked out again."""
    access = await access_for(current)
    bundle = await _sheet(current.db, sheet_id, lock=True)
    if not may_read(access, bundle.sheet):
        raise needs_permission(READ)
    await save_sheet(current.db, access, await calendar_for(current), body, bundle)
    return await _respond(current.db, sheet_id)


@router.delete("/sheets/{sheet_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_sheet(sheet_id: uuid.UUID, current: CurrentSessionDep) -> Response:
    access = await access_for(current)
    bundle = await _sheet(current.db, sheet_id, lock=True)
    if not access.can(WRITE, bundle.sheet.site_id):
        raise needs_permission(WRITE)
    await delete_sheet(current.db, bundle)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/sheets/{sheet_id}/trips/{trip_id}/close", response_model=SheetOut)
async def close(
    sheet_id: uuid.UUID, trip_id: uuid.UUID, body: CloseIn, current: CurrentSessionDep
) -> SheetOut:
    """Accounts confirm a customer paid this trip in full: its status turns closed."""
    bundle = await _sheet(current.db, sheet_id, lock=True)
    await close_trip(current.db, await access_for(current), bundle, trip_id, body.party_id, close=True)
    return await _respond(current.db, sheet_id)


@router.delete("/sheets/{sheet_id}/trips/{trip_id}/close", response_model=SheetOut)
async def reopen(
    sheet_id: uuid.UUID,
    trip_id: uuid.UUID,
    current: CurrentSessionDep,
    party_id: Annotated[uuid.UUID, Query(alias="partyId")],
) -> SheetOut:
    bundle = await _sheet(current.db, sheet_id, lock=True)
    await close_trip(current.db, await access_for(current), bundle, trip_id, party_id, close=False)
    return await _respond(current.db, sheet_id)


# ----------------------------------------------------------------- masters


def party_out(p: Party, locations: list[PartyLocation]) -> PartyOut:
    return PartyOut(
        id=p.id,
        name=p.display_name,
        gstin=p.gstin,
        phone=p.phone,
        contact_name=p.contact_name,
        roles=list(p.party_roles),
        locations=[
            LocationOut(id=x.id, name=x.name, address=x.address, state_code=x.state_code)
            for x in locations
            if x.party_id == p.id
        ],
        address=p.address,
    )


def material_out(i: Item) -> MaterialOut:
    return MaterialOut(
        id=i.id,
        code=i.code,
        name=i.name,
        hsn_code=i.hsn_code,
        gst_rate_pct=number(i.gst_rate_pct) or 0,
        unit=i.unit,
        active=i.is_active,
    )


def rate_out(r: GstRate) -> GstRateOut:
    return GstRateOut(id=r.id, rate_pct=number(r.rate_pct) or 0, active=r.is_active)


async def _locations(db: AsyncSession, party_ids: list[uuid.UUID] | None = None) -> list[PartyLocation]:
    stmt = select(PartyLocation).order_by(PartyLocation.name, PartyLocation.id)
    if party_ids is not None:
        stmt = stmt.where(PartyLocation.party_id.in_(party_ids))
    return list((await db.scalars(stmt)).all())


@router.get("/masters", response_model=MastersOut)
async def masters(current: CurrentSessionDep) -> MastersOut:
    """Who and what a line can name. The party master is read org-wide, as the customer database is."""
    _scope_or_refuse(await access_for(current), READ, WRITE, REPORT)
    db = current.db
    parties = (await db.scalars(select(Party).order_by(Party.display_name, Party.id))).all()
    locations = await _locations(db)
    items = (await db.scalars(select(Item).order_by(Item.name, Item.id))).all()
    rates = (await db.scalars(select(GstRate).order_by(GstRate.rate_pct))).all()
    return MastersOut(
        customers=[party_out(p, locations) for p in parties if "customer" in p.party_roles],
        vendors=[party_out(p, locations) for p in parties if "vendor" in p.party_roles],
        materials=[material_out(i) for i in items],
        gst_rates=[rate_out(r) for r in rates],
    )


async def _add_locations(db: AsyncSession, party: Party, names: list[str]) -> None:
    have = {x.name.lower() for x in await _locations(db, [party.id])}
    for name in dict.fromkeys(names):
        if name.lower() not in have:
            db.add(PartyLocation(organization_id=party.organization_id, party_id=party.id, name=name))
            have.add(name.lower())
    await db.flush()


@router.post("/parties", response_model=PartyOut, status_code=status.HTTP_201_CREATED)
async def add_party(body: PartyIn, current: CurrentSessionDep) -> PartyOut:
    """A vendor or customer from the sheet. A firm already in the master under the
    same GSTIN takes the role, so one firm is never two parties."""
    db = current.db
    access = await access_for(current)
    if body.role == "customer":
        if body.site_id is None:
            raise invalid("siteId", "required for a customer")
        if not access.can(WRITE, body.site_id):
            raise needs_permission(WRITE)
        if await db.get(Site, body.site_id) is None:
            raise invalid("siteId", "no such site")
    elif not access.can(WRITE):
        raise needs_permission(WRITE)
    party: Party | None = None
    if body.gstin is not None:
        if not gstin_is_valid(body.gstin):
            raise invalid("gstin", "not a valid GSTIN")
        party = await db.scalar(select(Party).where(Party.gstin == body.gstin).with_for_update())
        if party is not None and body.role not in party.party_roles:
            party.party_roles = [*party.party_roles, body.role]
            if body.role == "customer" and party.served_from_site_id is None:
                party.served_from_site_id = body.site_id
            await db.flush()
    if party is None:
        party = Party(
            organization_id=current.organization_id,
            display_name=body.name,
            legal_name=body.name,
            party_roles=[body.role],
            gstin=body.gstin,
            contact_name=body.contact_name,
            phone=body.phone,
            address=body.address,
            served_from_site_id=body.site_id if body.role == "customer" else None,
        )
        db.add(party)
        try:
            await db.flush()
        except IntegrityError as exc:  # pragma: no cover - two people adding one GSTIN at once
            raise refuse({"code": "gstin-used", "gstin": body.gstin}) from exc
    await _add_locations(db, party, body.locations)
    return party_out(party, await _locations(db, [party.id]))


#: Whoever makes invoices from trips (LIN-27) may keep the addresses and states they print.
INVOICE_WRITE = "sales.invoice.write"


async def _party_to_write(current: CurrentSessionDep, party_id: uuid.UUID, *keys: str) -> Party:
    access = await access_for(current)
    keys = keys or (WRITE,)
    if not any(access.can(k) for k in keys):
        raise needs_permission(keys[0])
    party = await current.db.get(Party, party_id, with_for_update=True)
    if party is None:
        raise gone()
    return party


def _state(code: str | None) -> str | None:
    if code is not None and code not in GST_STATES:
        raise invalid("stateCode", "not a state")
    return code


@router.patch("/parties/{party_id}", response_model=PartyOut)
async def update_party(party_id: uuid.UUID, body: PartyPatch, current: CurrentSessionDep) -> PartyOut:
    """A GSTIN typed on a line, saved into the master; only where the master has none,
    so a line never rewrites a firm's registered GSTIN. Or the billing address an invoice prints."""
    party = await _party_to_write(current, party_id, WRITE, INVOICE_WRITE)
    if body.gstin is not None and body.gstin != party.gstin:
        if not gstin_is_valid(body.gstin):
            raise invalid("gstin", "not a valid GSTIN")
        if party.gstin is not None:
            raise refuse({"code": "gstin-set", "gstin": party.gstin})
        party.gstin = body.gstin
    if body.phone is not None:
        party.phone = body.phone
    if body.address is not None:
        party.address = body.address
    try:
        await current.db.flush()
    except IntegrityError as exc:
        raise refuse({"code": "gstin-used", "gstin": body.gstin}) from exc
    return party_out(party, await _locations(current.db, [party.id]))


@router.post("/parties/{party_id}/locations", response_model=PartyOut, status_code=status.HTTP_201_CREATED)
async def add_location(party_id: uuid.UUID, body: LocationIn, current: CurrentSessionDep) -> PartyOut:
    """A purchase or delivery location typed on a line, saved into the party's master, with its
    address and state when given (filling in a location that has none yet)."""
    party = await _party_to_write(current, party_id)
    state = _state(body.state_code)
    await _add_locations(current.db, party, [body.name])
    location = next(
        x for x in await _locations(current.db, [party.id]) if x.name.lower() == body.name.lower()
    )
    if body.address and not location.address:
        location.address = body.address
    if state and not location.state_code:
        location.state_code = state
    await current.db.flush()
    return party_out(party, await _locations(current.db, [party.id]))


@router.patch("/parties/{party_id}/locations/{location_id}", response_model=PartyOut)
async def update_location(
    party_id: uuid.UUID, location_id: uuid.UUID, body: LocationPatch, current: CurrentSessionDep
) -> PartyOut:
    """A delivery location's address and state: the state is the place of supply an invoice for
    goods delivered there takes, so it decides CGST and SGST or IGST (LIN-27)."""
    party = await _party_to_write(current, party_id, WRITE, INVOICE_WRITE)
    location = await current.db.get(PartyLocation, location_id, with_for_update=True)
    if location is None or location.party_id != party.id:
        raise gone()
    if body.address is not None:
        location.address = body.address
    if body.state_code is not None:
        location.state_code = _state(body.state_code)
    await current.db.flush()
    return party_out(party, await _locations(current.db, [party.id]))


async def _name_free(db: AsyncSession, name: str, item_id: uuid.UUID | None = None) -> None:
    stmt = select(Item.id).where(Item.name.ilike(name.replace("\\", "\\\\").replace("%", "\\%"), escape="\\"))
    if item_id is not None:
        stmt = stmt.where(Item.id != item_id)
    if await db.scalar(stmt) is not None:
        raise refuse({"code": "name-used", "name": name})


@router.post("/materials", response_model=MaterialOut, status_code=status.HTTP_201_CREATED)
async def add_material(body: MaterialIn, current: CurrentSessionDep) -> MaterialOut:
    if not (await access_for(current)).can(WRITE):
        raise needs_permission(WRITE)
    await _name_free(current.db, body.name)
    item = Item(
        organization_id=current.organization_id,
        code=body.code,
        name=body.name,
        hsn_code=body.hsn_code,
        gst_rate_pct=body.gst_rate_pct,
        unit=body.unit,
    )
    current.db.add(item)
    try:
        await current.db.flush()
    except IntegrityError as exc:
        if "uq_items_organization_id_code" in str(exc.orig):
            raise refuse({"code": "code-used", "materialCode": body.code}) from exc
        raise
    return material_out(item)


@router.patch("/materials/{material_id}", response_model=MaterialOut)
async def update_material(
    material_id: uuid.UUID, body: MaterialPatch, current: CurrentSessionDep
) -> MaterialOut:
    """A new rate, HSN code or unit applies to lines entered from now; a line keeps what it was billed at."""
    if not (await access_for(current)).can(WRITE):
        raise needs_permission(WRITE)
    item = await current.db.get(Item, material_id)
    if item is None:
        raise gone()
    if body.name is not None:
        await _name_free(current.db, body.name, item.id)
        item.name = body.name
    if body.hsn_code is not None:
        item.hsn_code = body.hsn_code
    if body.gst_rate_pct is not None:
        item.gst_rate_pct = body.gst_rate_pct
    if body.unit is not None:
        item.unit = body.unit
    if body.active is not None:
        item.is_active = body.active
    await current.db.flush()
    await current.db.refresh(item)
    return material_out(item)


@router.post("/gst-rates", response_model=GstRateOut, status_code=status.HTTP_201_CREATED)
async def add_gst_rate(body: GstRateBody, current: CurrentSessionDep) -> GstRateOut:
    """A GST rate lines may be billed at. A rate already on the list is switched on again."""
    if not (await access_for(current)).can(WRITE):
        raise needs_permission(WRITE)
    rate = await current.db.scalar(select(GstRate).where(GstRate.rate_pct == body.rate_pct).with_for_update())
    if rate is None:
        rate = GstRate(organization_id=current.organization_id, rate_pct=body.rate_pct)
        current.db.add(rate)
    rate.is_active = True
    await current.db.flush()
    await current.db.refresh(rate)
    return rate_out(rate)


@router.patch("/gst-rates/{rate_id}", response_model=GstRateOut)
async def update_gst_rate(rate_id: uuid.UUID, body: GstRatePatch, current: CurrentSessionDep) -> GstRateOut:
    """Switched off, a rate is no longer offered; lines billed at it still read."""
    if not (await access_for(current)).can(WRITE):
        raise needs_permission(WRITE)
    rate = await current.db.get(GstRate, rate_id)
    if rate is None:
        raise gone()
    rate.is_active = body.active
    await current.db.flush()
    await current.db.refresh(rate)
    return rate_out(rate)


@router.get("/diesel-bills", response_model=list[DieselBillOut])
async def diesel_bills(
    current: CurrentSessionDep,
    vehicle_id: Annotated[str, Query(alias="vehicleId", min_length=1, max_length=64)],
    date_from: DateFrom = None,
    date_to: DateTo = None,
) -> list[DieselBillOut]:
    """A vehicle's diesel bills, newest first, and the sheet each is already linked on.

    Only bills at the sites the person keeps or reads sheets at (diesel_bill_scope)."""
    scope = diesel_bill_scope(await access_for(current))
    if scope.empty:
        raise needs_permission(WRITE)
    stmt = select(ExpenseBill).where(
        scope.clause(ExpenseBill.site_id),
        ExpenseBill.desk == "fleet",
        ExpenseBill.kind == "diesel",
        ExpenseBill.status.notin_(VOID_BILL),
        or_(ExpenseBill.vehicle_ref == vehicle_id, ExpenseBill.vehicle_ref.is_(None)),
    )
    if date_from:
        stmt = stmt.where(ExpenseBill.bill_date >= date_from)
    if date_to:
        stmt = stmt.where(ExpenseBill.bill_date <= date_to)
    bills = (await current.db.scalars(stmt.order_by(ExpenseBill.bill_date.desc()).limit(100))).all()
    linked: dict[uuid.UUID, LinkedSheetOut] = {}
    if bills:
        rows = await current.db.execute(
            select(DieselLine.expense_bill_id, TripSheet.id, TripSheet.sheet_number)
            .join(TripSheet, TripSheet.id == DieselLine.trip_sheet_id)
            .where(DieselLine.expense_bill_id.in_([b.id for b in bills]))
        )
        for bill_id, sheet_id, sheet_number in rows:
            linked[bill_id] = LinkedSheetOut(sheet_id=sheet_id, sheet_number=sheet_number)
    return [
        DieselBillOut(
            id=b.id,
            bill_number=b.bill_number,
            bill_date=b.bill_date,
            vendor=b.vendor,
            vehicle_id=b.vehicle_ref,
            litres=number(b.litres),
            amount=money(b.amount),
            status=b.status,
            linked_sheet=linked.get(b.id),
        )
        for b in bills
    ]


# ------------------------------------------------------------- attachments


@router.post("/attachments", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_attachment(current: CurrentSessionDep, file: UploadFile) -> AttachmentOut:
    """A photo or PDF of a trip's paper (a vendor's bill, a PO, a signed DC, a diesel,
    toll, police or maintenance bill), ten megabytes at most, put on a line by saving the sheet."""
    access = await access_for(current)
    if not access.can(WRITE):
        raise needs_permission(WRITE)
    try:
        content = await read_capped(file, get_settings().file_max_bytes)
        stored = await file_store().put(current.organization_id, content)
    except UploadRefused as refused:
        code = {
            "too-big": status.HTTP_413_CONTENT_TOO_LARGE,
            "wrong-file": status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
        }.get(refused.code, status.HTTP_422_UNPROCESSABLE_CONTENT)
        raise HTTPException(status_code=code, detail={"problem": {"code": refused.code}}) from refused
    row = File(
        organization_id=current.organization_id,
        purpose="trip_document",
        sha256=stored.sha256,
        mime_type=stored.mime_type,
        size_bytes=stored.size,
        original_name=clean_file_name(file.filename, "photo"),
        uploaded_by=access.user_id,
    )
    current.db.add(row)
    await current.db.flush()
    return AttachmentOut(
        id=row.id, file_name=row.original_name, mime_type=row.mime_type, size_kb=size_kb(row.size_bytes)
    )


async def _sheet_of_file(db: AsyncSession, file_id: uuid.UUID) -> TripSheet | None:
    """The sheet a file is on, through whichever line holds it."""
    candidates = [
        select(TripSheet)
        .join(Trip, Trip.trip_sheet_id == TripSheet.id)
        .join(TripPurchase, TripPurchase.trip_id == Trip.id)
        .join(TripPurchaseFile, TripPurchaseFile.purchase_id == TripPurchase.id)
        .where(TripPurchaseFile.file_id == file_id),
        select(TripSheet)
        .join(Trip, Trip.trip_sheet_id == TripSheet.id)
        .join(TripSale, TripSale.trip_id == Trip.id)
        .where(or_(TripSale.po_file_id == file_id, TripSale.dc_file_id == file_id)),
        select(TripSheet)
        .join(DieselLine, DieselLine.trip_sheet_id == TripSheet.id)
        .where(DieselLine.file_id == file_id),
        select(TripSheet)
        .join(EnRouteExpense, EnRouteExpense.trip_sheet_id == TripSheet.id)
        .where(EnRouteExpense.file_id == file_id),
    ]
    for stmt in candidates:
        sheet = await db.scalar(stmt.limit(1))
        if sheet is not None:
            return sheet
    return None


@router.get("/attachments/{file_id}")
async def download_attachment(file_id: uuid.UUID, current: CurrentSessionDep) -> StreamingResponse:
    """The file, streamed through here so the sheet's read keys still decide: to whoever
    may read the sheet it is on, or to whoever uploaded it before it was."""
    db = current.db
    access = await access_for(current)
    file = await db.get(File, file_id)
    if file is None or file.purpose != "trip_document":
        raise gone("file-gone")
    sheet = await _sheet_of_file(db, file_id)
    if sheet is None:
        if file.uploaded_by != access.user_id:
            raise gone("file-gone")
    elif not may_read(access, sheet):
        raise needs_permission(READ)
    stored = await file_store().open(current.organization_id, file.sha256)
    if stored is None:
        raise gone("file-missing")
    return stored_file_response(stored, media_type=file.mime_type, filename=file.original_name)


# ----------------------------------------------------------------- reports


async def _units(
    current: CurrentSessionDep, scope: Scope, f: SheetFilter
) -> tuple[list[Unit], list[SheetBundle], Context]:
    bundles = await load_bundles(current.db, await find_sheet_ids(current.db, scope, f))
    ctx = await build_context(current.db, bundles)
    return units_of(bundles, ctx, f), bundles, ctx


def _total(units: list[Unit]) -> pl.PlTotals:
    return pl.total_pl([u.unit for u in units])


@router.get("/reports/trips", response_model=TripReportOut)
async def trip_report(
    current: CurrentSessionDep,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    vehicle_id: VehicleId = None,
    customer_id: CustomerId = None,
    vendor_id: VendorId = None,
    site_id: SiteId = None,
    q: Search = None,
) -> TripReportOut:
    """Trip-wise P&L with its totals: each trip with its share of its sheet's costs, by trip date."""
    scope = _scope_or_refuse(await access_for(current), *READ_KEYS)
    f = SheetFilter(date_from, date_to, vehicle_id, customer_id, vendor_id, site_id, q, ALL)
    units, _, ctx = await _units(current, scope, f)
    return TripReportOut(
        rows=[trip_row(u, ctx) for u in units],
        total=totals_out(_total(units)),
    )


@router.get("/reports/vehicles", response_model=VehicleReportOut)
async def vehicle_report(
    current: CurrentSessionDep,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    vehicle_id: VehicleId = None,
    site_id: SiteId = None,
    q: Search = None,
) -> VehicleReportOut:
    """One row per vehicle, the most profitable first."""
    scope = _scope_or_refuse(await access_for(current), REPORT)
    f = SheetFilter(date_from, date_to, vehicle_id, None, None, site_id, q, ALL)
    units, bundles, _ = await _units(current, scope, f)
    latest = latest_vehicle(bundles)
    rows = [
        VehiclePlOut(
            vehicle_id=vid,
            registration_number=latest[vid].registration_number,
            vehicle_model=latest[vid].vehicle_model,
            **totals.wire(),
        )
        for vid, totals in pl.pl_by_vehicle([u.unit for u in units])
    ]
    return VehicleReportOut(rows=rows, total=totals_out(_total(units)))


@router.get("/reports/months", response_model=MonthReportOut)
async def month_report(
    current: CurrentSessionDep,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    vehicle_id: VehicleId = None,
    site_id: SiteId = None,
) -> MonthReportOut:
    """One row per month of the trip date, oldest first."""
    scope = _scope_or_refuse(await access_for(current), REPORT)
    f = SheetFilter(date_from, date_to, vehicle_id, None, None, site_id, None, ALL)
    units, _, _ = await _units(current, scope, f)
    rows = [
        MonthPlOut(month=month, **totals.wire()) for month, totals in pl.pl_by_month([u.unit for u in units])
    ]
    return MonthReportOut(rows=rows, total=totals_out(_total(units)))


async def _outstanding(
    current: CurrentSessionDep, role: str, date_from: date | None, date_to: date | None, q: str | None
) -> OutstandingReportOut:
    scope = _scope_or_refuse(await access_for(current), REPORT)
    f = SheetFilter(date_from, date_to, None, None, None, None, None, ALL)
    units, _, ctx = await _units(current, scope, f)
    parties = ctx.parties
    needle = (q or "").strip().lower()
    out = []
    for r in pl.outstanding([u.unit for u in units], role):
        party = parties.get(uuid.UUID(r.party_id))
        name = party.display_name if party else ""
        if (
            needle
            and needle not in name.lower()
            and needle not in ((party.gstin if party else "") or "").lower()
        ):
            continue
        out.append(
            OutstandingOut(
                party_id=uuid.UUID(r.party_id),
                name=name,
                gstin=party.gstin if party else None,
                phone=party.phone if party else "",
                role=role,
                trips=r.trips,
                billed=money(r.billed),
                settled=money(r.settled),
                due=money(r.due),
                status=r.status,
                first_date=date.fromisoformat(r.first_date),
                last_date=date.fromisoformat(r.last_date),
            )
        )
    # The most due first, as the rules order it; equal dues by name, as people look one up.
    out.sort(key=lambda o: (-Decimal(o.due), o.name.lower(), str(o.party_id)))
    total = OutstandingTotalOut(
        parties=len(out),
        billed=money(sum((Decimal(o.billed) for o in out), Decimal(0))),
        settled=money(sum((Decimal(o.settled) for o in out), Decimal(0))),
        due=money(sum((Decimal(o.due) for o in out), Decimal(0))),
    )
    return OutstandingReportOut(rows=out, total=total)


@router.get("/reports/customers", response_model=OutstandingReportOut)
async def customer_dues(
    current: CurrentSessionDep, date_from: DateFrom = None, date_to: DateTo = None, q: Search = None
) -> OutstandingReportOut:
    """Money due from each customer: AX, their bills with GST, less BA, what they paid."""
    return await _outstanding(current, "customer", date_from, date_to, q)


@router.get("/reports/vendors", response_model=OutstandingReportOut)
async def vendor_dues(
    current: CurrentSessionDep, date_from: DateFrom = None, date_to: DateTo = None, q: Search = None
) -> OutstandingReportOut:
    """Money due to each vendor: BD, their bills with GST, less BE, what we paid."""
    return await _outstanding(current, "vendor", date_from, date_to, q)

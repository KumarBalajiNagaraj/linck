"""The vehicle P&L (LIN-22): trips with their lines, the masters they pick from, and the reports.

    GET    /vehicle-pl/trips               trip-wise list, with search and filters   trip readers
    POST   /vehicle-pl/trips               a new trip with its lines                  fleet.trip_pl.write
    GET    /vehicle-pl/trips/{id}          one trip, every line, its P&L              trip readers
    PUT    /vehicle-pl/trips/{id}          the trip as the page holds it now          fleet.trip_pl.write
    DELETE /vehicle-pl/trips/{id}          the trip and its lines                     fleet.trip_pl.write
    GET    /vehicle-pl/masters             customers, vendors and materials to pick
    POST   /vehicle-pl/parties             a customer or vendor added from the trip page
    POST   /vehicle-pl/materials           a material, with its HSN code and GST rate
    PATCH  /vehicle-pl/materials/{id}      correct a material, or retire it
    GET    /vehicle-pl/diesel-bills        a vehicle's diesel bills a trip may link
    POST   /vehicle-pl/attachments         a photo or PDF of a vendor's invoice
    GET    /vehicle-pl/attachments/{id}    that file, under the trip's read keys
    GET    /vehicle-pl/reports/trips       trip-wise, with totals                     trip readers
    GET    /vehicle-pl/reports/vehicles    vehicle-wise                               finance.pl_report.read
    GET    /vehicle-pl/reports/months      month-wise                                 finance.pl_report.read
    GET    /vehicle-pl/reports/customers   money due from customers                   finance.pl_report.read
    GET    /vehicle-pl/reports/vendors     money due to vendors                       finance.pl_report.read

A trip is read where fleet.trip_pl.read or finance.pl_report.read reaches its
site, and written where fleet.trip_pl.write does: whoever enters a trip sees
that trip's P&L. The vehicle-wise and monthly reports and the money-due lists
are the director's and accounts'. Every figure is worked out on the server by
app/domain/vehicle_pl.py.
"""

from __future__ import annotations

import uuid
from datetime import date
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query, Response, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, Scope, access_for, calendar_for
from app.api.customers import gstin_is_valid
from app.api.deps import CurrentSessionDep
from app.api.problems import gone, invalid, needs_permission, refuse
from app.core.settings import get_settings
from app.core.storage import UploadRefused, clean_file_name, file_store, read_capped
from app.domain import vehicle_pl as pl
from app.models.core import File, Site
from app.models.finance import ExpenseBill
from app.models.logistics import DutyFuelLink, Trip, TripDiesel
from app.models.master import Item, Party
from app.models.procurement import TripPurchase, TripPurchaseFile
from app.schemas.common import money, number
from app.schemas.expenses import AttachmentOut
from app.schemas.vehicle_pl import (
    DieselBillOut,
    LinkedTripOut,
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
    TripIn,
    TripOut,
    TripReportOut,
    TripRowOut,
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
    TripBundle,
    TripFilter,
    build_context,
    delete_trip,
    domain_trips,
    find_trip_ids,
    latest_vehicle,
    load_bundles,
    may_read,
    row_out,
    save_trip,
    sum_rows,
    totals_out,
    trip_out,
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


def _scope_or_refuse(access: Access, *keys: str) -> Scope:
    scope = access.scope(*keys)
    if scope.empty:
        raise needs_permission(keys[0])
    return scope


async def _trip(db: AsyncSession, trip_id: uuid.UUID, *, lock: bool = False) -> TripBundle:
    """The trip with its lines; another tenant's is not there, as if it never was."""
    stmt = select(Trip.id).where(Trip.id == trip_id)
    if lock:
        stmt = stmt.with_for_update()
    if await db.scalar(stmt) is None:
        raise gone("trip-gone")
    return (await load_bundles(db, [trip_id]))[0]


async def _respond(db: AsyncSession, trip_id: uuid.UUID) -> TripOut:
    await db.flush()
    bundles = await load_bundles(db, [trip_id])
    return trip_out(bundles[0], await build_context(db, bundles))


# ------------------------------------------------------------------- trips


@router.get("/trips", response_model=list[TripRowOut])
async def list_trips(
    current: CurrentSessionDep,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    vehicle_id: VehicleId = None,
    customer_id: CustomerId = None,
    vendor_id: VendorId = None,
    site_id: SiteId = None,
    q: Search = None,
    limit: Limit = 500,
) -> list[TripRowOut]:
    """Trips this person may read, newest first, each with its P&L."""
    scope = _scope_or_refuse(await access_for(current), *READ_KEYS)
    f = TripFilter(date_from, date_to, vehicle_id, customer_id, vendor_id, site_id, q, limit)
    bundles = await load_bundles(current.db, await find_trip_ids(current.db, scope, f))
    ctx = await build_context(current.db, bundles)
    return [row_out(b, ctx) for b in bundles]


@router.get("/trips/{trip_id}", response_model=TripOut)
async def get_trip(trip_id: uuid.UUID, current: CurrentSessionDep) -> TripOut:
    access = await access_for(current)
    bundle = await _trip(current.db, trip_id)
    if not may_read(access, bundle.trip):
        raise needs_permission(READ)
    return trip_out(bundle, await build_context(current.db, [bundle]))


@router.post("/trips", response_model=TripOut, status_code=status.HTTP_201_CREATED)
async def create_trip(body: TripIn, current: CurrentSessionDep) -> TripOut:
    for section in (body.diesel, body.purchases, body.sales, body.costs, body.payments):
        if any(line.id is not None for line in section):
            raise invalid("id", "a new trip's lines have no ids yet")
    access = await access_for(current)
    trip_id = await save_trip(current.db, access, await calendar_for(current), body, None)
    return await _respond(current.db, trip_id)


@router.put("/trips/{trip_id}", response_model=TripOut)
async def replace_trip(trip_id: uuid.UUID, body: TripIn, current: CurrentSessionDep) -> TripOut:
    """The trip as the page holds it now: lines kept by id are corrected, the
    rest added or deleted. Values the rules derive are worked out again."""
    access = await access_for(current)
    bundle = await _trip(current.db, trip_id, lock=True)
    if not may_read(access, bundle.trip):
        raise needs_permission(READ)
    await save_trip(current.db, access, await calendar_for(current), body, bundle)
    return await _respond(current.db, trip_id)


@router.delete("/trips/{trip_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_trip(trip_id: uuid.UUID, current: CurrentSessionDep) -> Response:
    access = await access_for(current)
    bundle = await _trip(current.db, trip_id, lock=True)
    if not access.can(WRITE, bundle.trip.site_id):
        raise needs_permission(WRITE)
    await delete_trip(current.db, bundle)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ----------------------------------------------------------------- masters


def party_out(p: Party) -> PartyOut:
    return PartyOut(
        id=p.id,
        name=p.display_name,
        gstin=p.gstin,
        phone=p.phone,
        contact_name=p.contact_name,
        roles=list(p.party_roles),
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


@router.get("/masters", response_model=MastersOut)
async def masters(current: CurrentSessionDep) -> MastersOut:
    """Who and what a trip line can name. The party master is read org-wide, as the customer database is."""
    _scope_or_refuse(await access_for(current), READ, WRITE, REPORT)
    parties = (await current.db.scalars(select(Party).order_by(Party.display_name, Party.id))).all()
    items = (await current.db.scalars(select(Item).order_by(Item.name, Item.id))).all()
    return MastersOut(
        customers=[party_out(p) for p in parties if "customer" in p.party_roles],
        vendors=[party_out(p) for p in parties if "vendor" in p.party_roles],
        materials=[material_out(i) for i in items],
    )


@router.post("/parties", response_model=PartyOut, status_code=status.HTTP_201_CREATED)
async def add_party(body: PartyIn, current: CurrentSessionDep) -> PartyOut:
    """A customer or vendor from the trip page. A firm already in the master under
    the same GSTIN takes the role, so one firm is never two parties."""
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
    if body.gstin is not None:
        if not gstin_is_valid(body.gstin):
            raise invalid("gstin", "not a valid GSTIN")
        found = await db.scalar(select(Party).where(Party.gstin == body.gstin).with_for_update())
        if found is not None:
            if body.role not in found.party_roles:
                found.party_roles = [*found.party_roles, body.role]
                if body.role == "customer" and found.served_from_site_id is None:
                    found.served_from_site_id = body.site_id
                await db.flush()
            return party_out(found)
    party = Party(
        organization_id=current.organization_id,
        display_name=body.name,
        legal_name=body.name,
        party_roles=[body.role],
        gstin=body.gstin,
        contact_name=body.contact_name,
        phone=body.phone,
        served_from_site_id=body.site_id if body.role == "customer" else None,
    )
    db.add(party)
    try:
        await db.flush()
    except IntegrityError as exc:  # pragma: no cover - two people adding one GSTIN at once
        raise refuse({"code": "gstin-used", "gstin": body.gstin}) from exc
    return party_out(party)


@router.post("/materials", response_model=MaterialOut, status_code=status.HTTP_201_CREATED)
async def add_material(body: MaterialIn, current: CurrentSessionDep) -> MaterialOut:
    if not (await access_for(current)).can(WRITE):
        raise needs_permission(WRITE)
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
    """A new rate or HSN code applies to lines entered from now: each line keeps what it was billed at."""
    if not (await access_for(current)).can(WRITE):
        raise needs_permission(WRITE)
    item = await current.db.get(Item, material_id)
    if item is None:
        raise gone()
    if body.name is not None:
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


@router.get("/diesel-bills", response_model=list[DieselBillOut])
async def diesel_bills(
    current: CurrentSessionDep,
    vehicle_id: Annotated[str, Query(alias="vehicleId", min_length=1, max_length=64)],
    date_from: DateFrom = None,
    date_to: DateTo = None,
) -> list[DieselBillOut]:
    """A vehicle's diesel bills, newest first, and the trips each is already split across."""
    _scope_or_refuse(await access_for(current), WRITE, READ)
    stmt = select(ExpenseBill).where(
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
    linked: dict[uuid.UUID, list[LinkedTripOut]] = {}
    if bills:
        rows = await current.db.execute(
            select(DutyFuelLink.expense_bill_id, Trip.id, Trip.trip_number, Trip.trip_date)
            .join(TripDiesel, TripDiesel.link_id == DutyFuelLink.id)
            .join(Trip, Trip.id == TripDiesel.trip_id)
            .where(DutyFuelLink.expense_bill_id.in_([b.id for b in bills]))
            .order_by(Trip.trip_number)
        )
        for bill_id, trip_id, trip_number, trip_date in rows:
            linked.setdefault(bill_id, []).append(
                LinkedTripOut(trip_id=trip_id, trip_number=trip_number, date=trip_date)
            )
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
            linked_trips=linked.get(b.id, []),
        )
        for b in bills
    ]


# ------------------------------------------------------------- attachments


@router.post("/attachments", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_attachment(current: CurrentSessionDep, file: UploadFile) -> AttachmentOut:
    """A photo or PDF of a vendor's invoice, ten megabytes at most, put on a purchase by saving the trip."""
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
        purpose="purchase_invoice",
        sha256=stored.sha256,
        mime_type=stored.mime_type,
        size_bytes=stored.size,
        original_name=clean_file_name(file.filename, "invoice"),
        uploaded_by=access.user_id,
    )
    current.db.add(row)
    await current.db.flush()
    return AttachmentOut(
        id=row.id, file_name=row.original_name, mime_type=row.mime_type, size_kb=size_kb(row.size_bytes)
    )


@router.get("/attachments/{file_id}")
async def download_attachment(file_id: uuid.UUID, current: CurrentSessionDep) -> FileResponse:
    """The file, to whoever may read the trip it is on, or to whoever uploaded it before it was."""
    db = current.db
    access = await access_for(current)
    file = await db.get(File, file_id)
    if file is None or file.purpose != "purchase_invoice":
        raise gone("file-gone")
    trip = await db.scalar(
        select(Trip)
        .join(TripPurchase, TripPurchase.trip_id == Trip.id)
        .join(TripPurchaseFile, TripPurchaseFile.purchase_id == TripPurchase.id)
        .where(TripPurchaseFile.file_id == file_id)
    )
    if trip is None:
        if file.uploaded_by != access.user_id:
            raise gone("file-gone")
    elif not may_read(access, trip):
        raise needs_permission(READ)
    path = file_store().path_for(current.organization_id, file.sha256)
    if not path.is_file():
        raise gone("file-missing")
    return FileResponse(
        path,
        media_type=file.mime_type,
        filename=file.original_name,
        content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-cache"},
    )


# ----------------------------------------------------------------- reports


async def _report_trips(
    current: CurrentSessionDep, scope: Scope, f: TripFilter
) -> tuple[list[TripBundle], Context]:
    bundles = await load_bundles(current.db, await find_trip_ids(current.db, scope, f))
    return bundles, await build_context(current.db, bundles)


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
    """Trip-wise P&L with its totals, for the trips this person may read."""
    scope = _scope_or_refuse(await access_for(current), *READ_KEYS)
    f = TripFilter(date_from, date_to, vehicle_id, customer_id, vendor_id, site_id, q, 2000)
    bundles, ctx = await _report_trips(current, scope, f)
    return TripReportOut(
        rows=[row_out(b, ctx) for b in bundles],
        total=totals_out(sum_rows(ctx, bundles)),
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
    f = TripFilter(date_from, date_to, vehicle_id, None, None, site_id, q, 100000)
    bundles, ctx = await _report_trips(current, scope, f)
    trips = domain_trips(ctx, bundles)
    latest = latest_vehicle(bundles)
    rows = [
        VehiclePlOut(
            vehicle_id=vehicle_id_,
            registration_number=latest[vehicle_id_].registration_number,
            vehicle_model=latest[vehicle_id_].vehicle_model,
            **totals.wire(),
        )
        for vehicle_id_, totals in pl.pl_by_vehicle(trips, ctx.calcs)
    ]
    return VehicleReportOut(rows=rows, total=totals_out(sum_rows(ctx, bundles)))


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
    f = TripFilter(date_from, date_to, vehicle_id, None, None, site_id, None, 100000)
    bundles, ctx = await _report_trips(current, scope, f)
    trips = domain_trips(ctx, bundles)
    rows = [MonthPlOut(month=month, **totals.wire()) for month, totals in pl.pl_by_month(trips, ctx.calcs)]
    return MonthReportOut(rows=rows, total=totals_out(sum_rows(ctx, bundles)))


async def _outstanding(
    current: CurrentSessionDep, role: str, date_from: date | None, date_to: date | None, q: str | None
) -> OutstandingReportOut:
    scope = _scope_or_refuse(await access_for(current), REPORT)
    f = TripFilter(date_from, date_to, None, None, None, None, None, 100000)
    bundles, ctx = await _report_trips(current, scope, f)
    rows = pl.outstanding(domain_trips(ctx, bundles), ctx.calcs, role)
    parties = ctx.parties
    needle = (q or "").strip().lower()
    out = []
    for r in rows:
        party = parties.get(uuid.UUID(r.party_id))
        name = party.display_name if party else ""
        if needle and needle not in name.lower() and needle not in (party.gstin or "").lower():
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
    """Money due from each customer: their bills with GST, less what they paid. The most due first."""
    return await _outstanding(current, "customer", date_from, date_to, q)


@router.get("/reports/vendors", response_model=OutstandingReportOut)
async def vendor_dues(
    current: CurrentSessionDep, date_from: DateFrom = None, date_to: DateTo = None, q: Search = None
) -> OutstandingReportOut:
    """Money due to each vendor: their bills with GST, less what we paid. The most due first."""
    return await _outstanding(current, "vendor", date_from, date_to, q)

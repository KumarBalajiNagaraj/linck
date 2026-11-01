"""The breakdown register: what failed, where, since when, and what it cost.

Read under fleet.breakdown.read and written under fleet.vehicle.write (a
breakdown is the vehicle's status changing), both at the vehicle's site. A
vehicle has at most one breakdown that is not resolved; a second one while the
first is open is refused, so the register cannot show a tipper down twice.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, access_for, calendar_for, next_serial
from app.api.deps import CurrentSessionDep
from app.api.problems import gone, invalid, needs_permission, refuse
from app.models.core import Site
from app.models.fleet import Breakdown
from app.schemas.common import money, number
from app.schemas.fleet import BreakdownIn, BreakdownOut, BreakdownPatch, BreakdownStatus, ResolveIn

router = APIRouter(prefix="/breakdowns", tags=["fleet"])

READ = "fleet.breakdown.read"
WRITE = "fleet.vehicle.write"

TENTH = Decimal("0.1")


def downtime_hours(b: Breakdown, now: datetime) -> float | int:
    """Hours off the road to a tenth, counting an open breakdown to now."""
    seconds = Decimal(((b.resolved_at or now) - b.reported_at).total_seconds())
    hours = max(seconds / 3600, Decimal(0)).quantize(TENTH, rounding=ROUND_HALF_UP)
    return number(hours) or 0


def breakdown_out(b: Breakdown, now: datetime | None = None) -> BreakdownOut:
    return BreakdownOut(
        id=b.id,
        number=b.number,
        vehicle_id=b.vehicle_ref,
        driver_id=b.driver_ref,
        reported_at=b.reported_at,
        reported_by=b.reported_by,
        location=b.location,
        cause=b.cause,
        status=b.status,
        resolved_at=b.resolved_at,
        downtime_hours=downtime_hours(b, now or datetime.now(UTC)),
        repair_cost=money(b.repair_cost) if b.repair_cost is not None else None,
        site_id=b.site_id,
    )


async def _load(db: AsyncSession, breakdown_id: uuid.UUID, *, lock: bool = False) -> Breakdown:
    stmt = select(Breakdown).where(Breakdown.id == breakdown_id).execution_options(populate_existing=True)
    if lock:
        stmt = stmt.with_for_update()
    b = await db.scalar(stmt)
    if b is None:
        raise gone()
    return b


async def _writable(db: AsyncSession, access: Access, breakdown_id: uuid.UUID) -> Breakdown:
    b = await _load(db, breakdown_id, lock=True)
    if not access.can(WRITE, b.site_id):
        raise needs_permission(WRITE)
    return b


async def _flush(db: AsyncSession, vehicle_ref: str) -> None:
    try:
        await db.flush()
    except IntegrityError as exc:
        if "uq_breakdowns_one_open_per_vehicle" in str(exc.orig):
            raise refuse({"code": "vehicle-already-down", "vehicle": vehicle_ref}) from exc
        raise


def _not_before_report(b: Breakdown, at: datetime, field: str) -> None:
    if at < b.reported_at:
        raise invalid(field, "before the breakdown was reported")


@router.get("", response_model=list[BreakdownOut])
async def list_breakdowns(
    current: CurrentSessionDep,
    status_: Annotated[list[BreakdownStatus] | None, Query(alias="status")] = None,
    site_id: Annotated[uuid.UUID | None, Query(alias="siteId")] = None,
    vehicle_id: Annotated[str | None, Query(alias="vehicleId", max_length=64)] = None,
) -> list[BreakdownOut]:
    """Every breakdown at the sites this person may see, newest first."""
    scope = (await access_for(current)).scope(READ)
    if scope.empty:
        raise needs_permission(READ)
    stmt = select(Breakdown).where(scope.clause(Breakdown.site_id))
    if status_:
        stmt = stmt.where(Breakdown.status.in_(status_))
    if site_id:
        stmt = stmt.where(Breakdown.site_id == site_id)
    if vehicle_id:
        stmt = stmt.where(Breakdown.vehicle_ref == vehicle_id)
    now = datetime.now(UTC)
    rows = await current.db.scalars(stmt.order_by(Breakdown.reported_at.desc(), Breakdown.id))
    return [breakdown_out(b, now) for b in rows]


@router.get("/{breakdown_id}", response_model=BreakdownOut)
async def get_breakdown(breakdown_id: uuid.UUID, current: CurrentSessionDep) -> BreakdownOut:
    access = await access_for(current)
    b = await _load(current.db, breakdown_id)
    if not access.can(READ, b.site_id):
        raise needs_permission(READ)
    return breakdown_out(b)


@router.post("", response_model=BreakdownOut, status_code=status.HTTP_201_CREATED)
async def report_breakdown(body: BreakdownIn, current: CurrentSessionDep) -> BreakdownOut:
    db = current.db
    access = await access_for(current)
    calendar = await calendar_for(current)
    if not access.can(WRITE, body.site_id):
        raise needs_permission(WRITE)
    if await db.get(Site, body.site_id) is None:
        raise invalid("siteId", "no such site")
    now = datetime.now(UTC)
    reported_at = body.reported_at or now
    if reported_at > now:
        raise invalid("reportedAt", "in the future")
    year = calendar.financial_year(calendar.business_date(reported_at))
    serial = await next_serial(db, "fleet.breakdowns", current.organization_id, year)
    b = Breakdown(
        organization_id=current.organization_id,
        financial_year=year,
        serial=serial,
        number=f"BD/{year}/{serial:03d}",
        site_id=body.site_id,
        vehicle_ref=body.vehicle_id,
        driver_ref=body.driver_id,
        reported_at=reported_at,
        reported_by=body.reported_by or access.name,
        location=body.location,
        cause=body.cause,
        status=body.status,
        recorded_by=access.user_id,
    )
    db.add(b)
    await _flush(db, body.vehicle_id)
    return breakdown_out(await _load(db, b.id))


@router.patch("/{breakdown_id}", response_model=BreakdownOut)
async def update_breakdown(
    breakdown_id: uuid.UUID, body: BreakdownPatch, current: CurrentSessionDep
) -> BreakdownOut:
    """Correct what was reported, move it between open and in the workshop, or
    record the repair cost (which often arrives after the vehicle is back)."""
    db = current.db
    access = await access_for(current)
    b = await _writable(db, access, breakdown_id)
    given = body.model_fields_set
    for field in ("reported_at", "reported_by", "location", "cause", "status"):
        if field in given and getattr(body, field) is None:
            raise invalid(field, "cannot be emptied")
    live_only = {"driver_id", "reported_at", "reported_by", "location", "cause", "status"} & given
    if b.status == "resolved" and live_only:
        raise refuse({"code": "wrong-step", "status": b.status, "action": "update"})
    if "driver_id" in given:
        b.driver_ref = body.driver_id
    if body.reported_at is not None:
        if body.reported_at > datetime.now(UTC):
            raise invalid("reportedAt", "in the future")
        b.reported_at = body.reported_at
    if body.reported_by is not None:
        b.reported_by = body.reported_by
    if body.location is not None:
        b.location = body.location
    if body.cause is not None:
        b.cause = body.cause
    if body.status is not None:
        b.status = body.status
    if "repair_cost" in given:
        b.repair_cost = body.repair_cost
    await _flush(db, b.vehicle_ref)
    return breakdown_out(await _load(db, b.id))


@router.post("/{breakdown_id}/resolve", response_model=BreakdownOut)
async def resolve_breakdown(
    breakdown_id: uuid.UUID, body: ResolveIn, current: CurrentSessionDep
) -> BreakdownOut:
    """Back on the road: the downtime stops counting."""
    db = current.db
    access = await access_for(current)
    b = await _writable(db, access, breakdown_id)
    if b.status == "resolved":
        raise refuse({"code": "wrong-step", "status": b.status, "action": "resolve"})
    now = datetime.now(UTC)
    resolved_at = body.resolved_at or now
    if resolved_at > now:
        raise invalid("resolvedAt", "in the future")
    _not_before_report(b, resolved_at, "resolvedAt")
    b.status = "resolved"
    b.resolved_at = resolved_at
    b.resolved_by = access.user_id
    if "repair_cost" in body.model_fields_set:
        b.repair_cost = body.repair_cost
    await _flush(db, b.vehicle_ref)
    return breakdown_out(await _load(db, b.id))

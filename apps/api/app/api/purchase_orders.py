"""Customer purchase orders, and the one decision that gates them.

Nothing is loaded against an order until it is approved, so the approval is
the place rate and credit are argued, once. The decision (who, when, why) is
kept on the order and every change to it is in the audit log; a rejected
order is final, and the customer raises a new one.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import access_for, calendar_for, next_serial
from app.api.customers import get_customer_row
from app.api.deps import CurrentSessionDep
from app.api.problems import gone, invalid, needs_permission, refuse
from app.models.core import Site
from app.models.master import Party
from app.models.sales import PurchaseOrder
from app.schemas.common import CENT, money, number
from app.schemas.sales import DecisionIn, PurchaseOrderIn, PurchaseOrderOut, PurchaseOrderStatus

router = APIRouter(prefix="/purchase-orders", tags=["sales"])

READ = "sales.order.read"
WRITE = "sales.order.write"
APPROVE = "sales.order.approve"


def po_out(po: PurchaseOrder, customer_name: str) -> PurchaseOrderOut:
    return PurchaseOrderOut(
        id=po.id,
        number=po.number,
        customer_po_ref=po.customer_po_ref,
        received_on=po.received_on,
        deliver_by=po.deliver_by,
        customer_id=po.customer_party_id,
        customer_name=customer_name,
        delivery_site=po.delivery_site,
        site_id=po.site_id,
        product_code=po.product_code,
        ordered_units=number(po.ordered_units) or 0,
        dispatched_units=number(po.dispatched_units) or 0,
        rate_per_unit=money(po.rate_per_unit),
        value=money(po.value),
        status=po.status,
        taken_by=po.taken_by_name,
    )


def _with_customer():  # type: ignore[no-untyped-def]
    return select(PurchaseOrder, Party.display_name).join(
        Party,
        and_(
            Party.organization_id == PurchaseOrder.organization_id,
            Party.id == PurchaseOrder.customer_party_id,
        ),
    )


async def _load(db: AsyncSession, order_id: uuid.UUID, *, lock: bool = False) -> tuple[PurchaseOrder, str]:
    stmt = _with_customer().where(PurchaseOrder.id == order_id).execution_options(populate_existing=True)
    if lock:
        stmt = stmt.with_for_update(of=PurchaseOrder)
    row = (await db.execute(stmt)).first()
    if row is None:
        raise gone()
    return row[0], row[1]


@router.get("", response_model=list[PurchaseOrderOut])
async def list_orders(
    current: CurrentSessionDep,
    status_: Annotated[list[PurchaseOrderStatus] | None, Query(alias="status")] = None,
    site_id: Annotated[uuid.UUID | None, Query(alias="siteId")] = None,
    customer_id: Annotated[uuid.UUID | None, Query(alias="customerId")] = None,
) -> list[PurchaseOrderOut]:
    """Orders at the sites this person may see them, newest first."""
    scope = (await access_for(current)).scope(READ)
    if scope.empty:
        raise needs_permission(READ)
    stmt = _with_customer().where(scope.clause(PurchaseOrder.site_id))
    if status_:
        stmt = stmt.where(PurchaseOrder.status.in_(status_))
    if site_id:
        stmt = stmt.where(PurchaseOrder.site_id == site_id)
    if customer_id:
        stmt = stmt.where(PurchaseOrder.customer_party_id == customer_id)
    rows = (await current.db.execute(stmt.order_by(PurchaseOrder.received_on.desc(), PurchaseOrder.id))).all()
    return [po_out(po, name) for po, name in rows]


@router.get("/{order_id}", response_model=PurchaseOrderOut)
async def get_order(order_id: uuid.UUID, current: CurrentSessionDep) -> PurchaseOrderOut:
    access = await access_for(current)
    po, name = await _load(current.db, order_id)
    if not access.can(READ, po.site_id):
        raise needs_permission(READ)
    return po_out(po, name)


@router.post("", response_model=PurchaseOrderOut, status_code=status.HTTP_201_CREATED)
async def create_order(body: PurchaseOrderIn, current: CurrentSessionDep) -> PurchaseOrderOut:
    """Record an order as taken: numbered SO/<year>/<n>, waiting on approval."""
    db = current.db
    access = await access_for(current)
    calendar = await calendar_for(current)
    if not access.can(WRITE, body.site_id):
        raise needs_permission(WRITE)
    if await db.get(Site, body.site_id) is None:
        raise invalid("siteId", "no such site")
    customer = await get_customer_row(db, body.customer_id)
    delivery_site = body.delivery_site or customer.default_delivery_site
    if not delivery_site:
        raise invalid("deliverySite", "required: the customer has no default delivery site")

    received_on = body.received_on or datetime.now(UTC)
    year = calendar.financial_year(calendar.business_date(received_on))
    serial = await next_serial(db, "sales.purchase_orders", current.organization_id, year)
    po = PurchaseOrder(
        organization_id=current.organization_id,
        financial_year=year,
        serial=serial,
        number=f"SO/{year}/{serial:03d}",
        customer_po_ref=body.customer_po_ref,
        customer_party_id=customer.id,
        site_id=body.site_id,
        delivery_site=delivery_site,
        product_code=body.product_code,
        ordered_units=body.ordered_units,
        rate_per_unit=body.rate_per_unit,
        value=(body.ordered_units * body.rate_per_unit).quantize(CENT, rounding=ROUND_HALF_UP),
        received_on=received_on,
        deliver_by=body.deliver_by,
        status="pending_approval",
        taken_by=access.user_id,
        taken_by_name=access.name,
    )
    db.add(po)
    await db.flush()
    po, name = await _load(db, po.id)
    return po_out(po, name)


async def _decide(
    order_id: uuid.UUID, current: CurrentSessionDep, action: str, reason: str | None
) -> PurchaseOrderOut:
    db = current.db
    access = await access_for(current)
    po, name = await _load(db, order_id, lock=True)
    if not access.can(APPROVE, po.site_id):
        raise needs_permission(APPROVE)
    if po.status != "pending_approval":
        raise refuse({"code": "wrong-step", "status": po.status, "action": action})
    reason = (reason or "").strip() or None
    if action == "reject" and reason is None:
        raise refuse({"code": "needs-reason", "action": "reject"})
    po.status = "approved" if action == "approve" else "rejected"
    po.decided_by = access.user_id
    po.decided_at = datetime.now(UTC)
    po.decision_reason = reason
    await db.flush()
    po, name = await _load(db, po.id)
    return po_out(po, name)


@router.post("/{order_id}/approve", response_model=PurchaseOrderOut)
async def approve_order(
    order_id: uuid.UUID, body: DecisionIn, current: CurrentSessionDep
) -> PurchaseOrderOut:
    return await _decide(order_id, current, "approve", body.reason)


@router.post("/{order_id}/reject", response_model=PurchaseOrderOut)
async def reject_order(order_id: uuid.UUID, body: DecisionIn, current: CurrentSessionDep) -> PurchaseOrderOut:
    """Turn the order down, with the reason. It cannot be reopened."""
    return await _decide(order_id, current, "reject", body.reason)

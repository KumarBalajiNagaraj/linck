"""Expense bills: the register, the scans, corrections, and the approval chain.

    POST /expenses/attachments          multipart scan  ──▶ core.files + <dir>/<org>/<sha256>
    POST /expenses                      keyed, or from that scan and what was read off it
    PATCH /expenses/{id}                correct what capture read, while nobody has signed
    POST /expenses/{id}/actions         validate, approve, pass, pay, reject, send back, delete, restore
    POST /expenses/actions/batch        one step for many bills, skipping the ones that cannot take it cleanly
    GET  /expenses, /expenses/{id}      ExpenseBill, exactly as packages/mock/src/types.ts has it
    GET  /expenses/{id}/attachment      the scan, under the bill's read permission

Every move goes through app/domain/expense_workflow.py with the signed-in
person as the actor. The client never names who is acting, who raised a bill,
or who corrected a field.
"""

from __future__ import annotations

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Form, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse
from sqlalchemy import and_, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, TenantCalendar, access_for, calendar_for
from app.api.deps import CurrentSessionDep
from app.api.problems import gone, invalid, needs_permission, refuse
from app.core.settings import get_settings
from app.core.storage import UploadRefused, clean_file_name, file_store, read_capped
from app.domain.expense_workflow import (
    ActionInput,
    PaymentRecord,
    WorkflowBill,
    WorkflowError,
    apply_action,
    plan_batch,
)
from app.models.core import File, Site
from app.models.finance import ExpenseBill, ExpenseBillEvent, Payment
from app.schemas.common import money, number, parse_day
from app.schemas.expenses import (
    ActionIn,
    AttachmentOut,
    BatchIn,
    BatchPlanOut,
    BatchSkipOut,
    CorrectionIn,
    Desk,
    ExpenseBillIn,
    ExpenseBillOut,
    ExpenseStatus,
    PaymentIn,
)
from app.services.expense_bills import (
    KINDS_BY_DESK,
    METHOD_OF_MODE,
    READ_KEYS,
    UPLOAD_KEY,
    VALIDATE_KEY,
    actor_for,
    bill_out,
    capture_rows,
    claim_attachment,
    litres_text,
    load_bill,
    load_bills,
    may_read,
    read_scope,
    same_reading,
    size_kb,
    with_everything,
    workflow_bill,
)

router = APIRouter(prefix="/expenses", tags=["expenses"])

#: What a correction may change, as the capture record's field keys name them.
EDITABLE = ("billNumber", "billDate", "vendor", "litres", "amount")


async def _readable_bill(
    db: AsyncSession, access: Access, bill_id: uuid.UUID, *, lock: bool = False
) -> ExpenseBill:
    bill = await load_bill(db, bill_id, lock=lock)
    # Another tenant's bill is invisible under RLS, so it is "gone" too.
    if bill is None:
        raise gone("bill-gone")
    if not may_read(access, bill):
        raise needs_permission(READ_KEYS[bill.desk][0])
    return bill


async def _respond(db: AsyncSession, bill_id: uuid.UUID, calendar: TenantCalendar) -> ExpenseBillOut:
    await db.flush()
    bill = await load_bill(db, bill_id)
    assert bill is not None
    return bill_out(bill, calendar)


def _day(value: str, calendar: TenantCalendar, field: str) -> date:
    try:
        day = parse_day(value, calendar.timezone)
    except ValueError as exc:
        raise invalid(field, "not a date") from exc
    if day > calendar.today():
        raise invalid(field, "after today")
    return day


def _check_figures(kind: str, litres: Decimal | None, amount: Decimal) -> None:
    if amount <= 0:
        raise invalid("amount", "must be more than zero")
    if kind == "diesel" and litres is None:
        raise invalid("litres", "a diesel bill needs litres")
    if kind != "diesel" and litres is not None:
        raise invalid("litres", "only diesel bills count litres")


# ------------------------------------------------------------------ reading


@router.get("", response_model=list[ExpenseBillOut])
async def list_bills(
    current: CurrentSessionDep,
    desk: Desk | None = None,
    status_: Annotated[list[ExpenseStatus] | None, Query(alias="status")] = None,
    vehicle_id: Annotated[str | None, Query(alias="vehicleId", max_length=64)] = None,
    site_id: Annotated[uuid.UUID | None, Query(alias="siteId")] = None,
    date_from: Annotated[date | None, Query(alias="from", description="Bill date, inclusive")] = None,
    date_to: Annotated[date | None, Query(alias="to", description="Bill date, inclusive")] = None,
    limit: Annotated[int, Query(ge=1, le=2000)] = 500,
) -> list[ExpenseBillOut]:
    """Bills this person may read, newest first: each desk's at the sites they hold its read key."""
    access = await access_for(current)
    desks = [desk] if desk else ["fleet", "stores"]
    scopes = {d: read_scope(access, d) for d in desks}
    if all(scope.empty for scope in scopes.values()):
        raise needs_permission(READ_KEYS[desk][0] if desk else "finance.expense.read")

    stmt = select(ExpenseBill).where(
        or_(*(and_(ExpenseBill.desk == d, scope.clause(ExpenseBill.site_id)) for d, scope in scopes.items()))
    )
    if status_:
        stmt = stmt.where(ExpenseBill.status.in_(status_))
    if vehicle_id:
        stmt = stmt.where(ExpenseBill.vehicle_ref == vehicle_id)
    if site_id:
        stmt = stmt.where(ExpenseBill.site_id == site_id)
    if date_from:
        stmt = stmt.where(ExpenseBill.bill_date >= date_from)
    if date_to:
        stmt = stmt.where(ExpenseBill.bill_date <= date_to)
    stmt = with_everything(stmt).order_by(ExpenseBill.submitted_at.desc(), ExpenseBill.id).limit(limit)
    bills = (await current.db.scalars(stmt)).all()
    calendar = await calendar_for(current)
    return [bill_out(b, calendar) for b in bills]


@router.get("/{bill_id}", response_model=ExpenseBillOut)
async def get_bill(bill_id: uuid.UUID, current: CurrentSessionDep) -> ExpenseBillOut:
    access = await access_for(current)
    bill = await _readable_bill(current.db, access, bill_id)
    return bill_out(bill, await calendar_for(current))


# ------------------------------------------------------------------- scans


@router.post("/attachments", response_model=AttachmentOut, status_code=status.HTTP_201_CREATED)
async def upload_attachment(
    current: CurrentSessionDep, file: UploadFile, desk: Annotated[Desk, Form()]
) -> AttachmentOut:
    """Store one scan of a bill: a JPEG, PNG, WebP or PDF, ten megabytes at most.

    Returns the upload's id, which `POST /expenses` (or a WhatsApp import)
    then puts on a bill. The type is read from the bytes, not from the request.
    """
    access = await access_for(current)
    key = UPLOAD_KEY[desk]
    if not access.can(key):
        raise needs_permission(key)
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
        purpose="expense_bill",
        sha256=stored.sha256,
        mime_type=stored.mime_type,
        size_bytes=stored.size,
        original_name=clean_file_name(file.filename),
        uploaded_by=access.user_id,
    )
    current.db.add(row)
    await current.db.flush()
    return AttachmentOut(
        id=row.id, file_name=row.original_name, mime_type=row.mime_type, size_kb=size_kb(row.size_bytes)
    )


@router.get("/{bill_id}/attachment")
async def download_attachment(bill_id: uuid.UUID, current: CurrentSessionDep) -> FileResponse:
    access = await access_for(current)
    bill = await _readable_bill(current.db, access, bill_id)
    if bill.attachment is None:
        raise gone("no-attachment")
    path = file_store().path_for(current.organization_id, bill.attachment.sha256)
    if not path.is_file():
        raise gone("file-missing")
    return FileResponse(
        path,
        media_type=bill.attachment.mime_type,
        filename=bill.attachment.original_name,
        content_disposition_type="inline",
        headers={"X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-cache"},
    )


# ------------------------------------------------------------------ writing


@router.post("", response_model=ExpenseBillOut, status_code=status.HTTP_201_CREATED)
async def create_bill(body: ExpenseBillIn, current: CurrentSessionDep) -> ExpenseBillOut:
    """A bill keyed by hand, or from an uploaded scan and the capture record of what was read off it."""
    db = current.db
    access = await access_for(current)
    calendar = await calendar_for(current)
    key = UPLOAD_KEY[body.desk]
    if not access.can(key, body.site_id):
        raise needs_permission(key)
    if await db.get(Site, body.site_id) is None:
        raise invalid("siteId", "no such site")
    bill_date = _day(body.bill_date, calendar, "billDate")
    if not body.bill_number:
        raise invalid("billNumber", "required")
    if not body.vendor:
        raise invalid("vendor", "required")
    if body.kind not in KINDS_BY_DESK[body.desk]:
        raise invalid("kind", f"the {body.desk} desk does not raise {body.kind} bills")
    _check_figures(body.kind, body.litres, body.amount)
    if body.desk == "stores" and (body.vehicle_id or body.driver_id):
        raise invalid("vehicleId", "a stores bill is against no vehicle")
    if body.desk == "fleet" and body.kind not in ("toll", "other") and not body.vehicle_id:
        raise invalid("vehicleId", "required")
    if body.attachment_id is not None:
        await claim_attachment(db, access, body.attachment_id)

    bill = ExpenseBill(
        id=uuid.uuid4(),
        organization_id=current.organization_id,
        desk=body.desk,
        site_id=body.site_id,
        kind=body.kind,
        bill_number=body.bill_number,
        bill_date=bill_date,
        vendor=body.vendor,
        description=body.description,
        vehicle_ref=body.vehicle_id,
        driver_ref=body.driver_id,
        litres=body.litres,
        amount=body.amount,
        status="submitted",
        provenance="human",
        submitted_by_ref=access.actor_id,
        submitted_by_name=access.name,
        created_by=access.user_id,
        attachment_file_id=body.attachment_id,
        capture_engine=body.capture.engine if body.capture else None,
        captured_at=body.capture.captured_at if body.capture else None,
        capture_warnings=list(body.capture.warnings) if body.capture else [],
    )
    rows = capture_rows(bill, body.capture, access, corrections_by_uploader=True) if body.capture else []
    if body.capture:
        # Keyed with no capture is a human value; captured and accepted as read
        # is confirmed; any correction marks the whole bill overridden.
        bill.provenance = "overridden" if any(r.overridden for r in rows) else "confirmed"
    db.add(bill)
    await _flush_or_refuse(db)
    db.add_all(rows)
    return await _respond(db, bill.id, calendar)


@router.patch("/{bill_id}", response_model=ExpenseBillOut)
async def correct_bill(bill_id: uuid.UUID, body: CorrectionIn, current: CurrentSessionDep) -> ExpenseBillOut:
    """Correct what capture read, while the bill still waits on its first signature.

    The reading is kept beside the correction. A field corrected now is
    credited to this person; an earlier correction somebody else made and
    this one leaves alone stays theirs.
    """
    db = current.db
    access = await access_for(current)
    calendar = await calendar_for(current)
    bill = await _readable_bill(db, access, bill_id, lock=True)
    if bill.status != "submitted":
        raise refuse({"code": "wrong-step", "status": bill.status, "action": "correct"})
    if not (
        access.can(UPLOAD_KEY[bill.desk], bill.site_id) or access.can(VALIDATE_KEY[bill.desk], bill.site_id)
    ):
        raise needs_permission(UPLOAD_KEY[bill.desk])
    given = body.model_fields_set
    if not given:
        raise invalid("body", "nothing to correct")

    if "bill_number" in given:
        if not body.bill_number:
            raise invalid("billNumber", "required")
        bill.bill_number = body.bill_number
    if "vendor" in given:
        if not body.vendor:
            raise invalid("vendor", "required")
        bill.vendor = body.vendor
    if "bill_date" in given:
        if body.bill_date is None:
            raise invalid("billDate", "required")
        bill.bill_date = _day(body.bill_date, calendar, "billDate")
    if "amount" in given:
        if body.amount is None:
            raise invalid("amount", "required")
        bill.amount = body.amount
    if "litres" in given:
        bill.litres = body.litres
    _check_figures(bill.kind, bill.litres, bill.amount)

    after = {
        "billNumber": bill.bill_number,
        "billDate": bill.bill_date.isoformat(),
        "vendor": bill.vendor,
        "litres": litres_text(bill.litres),
        "amount": money(bill.amount),
    }
    for f in bill.fields:
        if f.key not in after:
            continue
        value = after[f.key]
        differs = f.captured_value is not None and not same_reading(f.key, value, f.captured_value)
        if not differs:
            f.overridden_by, f.overridden_by_name = None, None
        elif not (f.overridden_by is not None and same_reading(f.key, value, f.value)):
            f.overridden_by, f.overridden_by_name = access.user_id, access.name
        f.value = value
        f.overridden = differs
    if bill.capture_engine is not None:
        bill.provenance = "overridden" if any(f.overridden for f in bill.fields) else "confirmed"
    return await _respond(db, bill.id, calendar)


# ---------------------------------------------------------- the approval chain


def _payment_record(payment: PaymentIn | None) -> PaymentRecord | None:
    return (
        None
        if payment is None
        else PaymentRecord(utr=payment.utr, paid_on=payment.paid_on, mode=payment.mode)
    )


async def _used_utrs(db: AsyncSession, payment: PaymentRecord | None) -> frozenset[str]:
    """Whether this UTR is already on a payment of this tenant's (RLS keeps it to the tenant)."""
    if payment is None or payment.mode == "Cash":
        return frozenset()
    utr = payment.utr.strip().upper()
    taken = await db.scalar(select(Payment.id).where(Payment.reference_no == utr).limit(1))
    return frozenset({utr}) if taken else frozenset()


async def _flush_or_refuse(db: AsyncSession) -> None:
    """Flush now, so a constraint the database holds becomes a problem the web words."""
    try:
        await db.flush()
    except IntegrityError as exc:
        # Two requests raced to put one scan on two bills; the first one won.
        if "uq_expense_bills_organization_id_attachment_file_id" in str(exc.orig):
            raise invalid("attachmentId", "already on another bill") from exc
        raise


async def _record_payment(
    db: AsyncSession, access: Access, record: PaymentRecord, amount: Decimal
) -> Payment:
    payment = Payment(
        organization_id=access.organization_id,
        direction="outbound",
        payment_date=date.fromisoformat(record.paid_on),
        method=METHOD_OF_MODE[record.mode],
        amount=amount,
        reference_no=None if record.mode == "Cash" else record.utr,
        recorded_by=access.user_id,
    )
    db.add(payment)
    try:
        await db.flush()
    except IntegrityError as exc:
        if "uq_payments_organization_id_reference_no" in str(exc.orig):
            raise refuse({"code": "utr-used", "utr": record.utr}) from exc
        raise
    return payment


async def _record_move(
    db: AsyncSession, bill: ExpenseBill, after: WorkflowBill, access: Access, payment: Payment | None
) -> None:
    """Make one move permanent: the bill's new status, and one more line of history."""
    event = after.history[-1]
    if event.action == "pay":
        assert payment is not None
        bill.payment_id = payment.id
    bill.status = after.status
    if event.action == "validate" and bill.provenance == "proposed":
        # Machine-read and not yet looked at by a person: validation confirms it.
        bill.provenance = "confirmed"
    await db.flush()
    db.add(
        ExpenseBillEvent(
            organization_id=bill.organization_id,
            bill_id=bill.id,
            seq=len(bill.events) + 1,
            action=event.action,
            from_status=event.from_status,
            to_status=event.to_status,
            actor_user_id=access.user_id,
            actor_name=access.name,
            at=event.at,
            note=event.note,
            exception=event.exception,
            payment_id=payment.id if event.action == "pay" and payment else None,
        )
    )
    await db.flush()


@router.post("/actions/batch", response_model=BatchPlanOut)
async def act_on_many(body: BatchIn, current: CurrentSessionDep) -> BatchPlanOut:
    """One step for many bills: everything this person may sign cleanly, and every
    bill left out with its reason. A batch never carries a second signature.

    For `pay`, the batch is one bank transfer: one payment row, one UTR, every
    bill. A bad UTR refuses the whole batch, as the confirm box does.
    """
    db = current.db
    access = await access_for(current)
    calendar = await calendar_for(current)
    ids = list(dict.fromkeys(body.ids))
    bills = {b.id: b for b in await load_bills(db, ids, lock=not body.dry_run)}

    skipped: list[BatchSkipOut] = []
    readable: list[ExpenseBill] = []
    for bill_id in ids:
        bill = bills.get(bill_id)
        if bill is None:
            skipped.append(BatchSkipOut(id=bill_id, bill=None, problem={"code": "bill-gone"}))
        elif not may_read(access, bill):
            problem = {"code": "needs-permission", "permission": READ_KEYS[bill.desk][0]}
            skipped.append(BatchSkipOut(id=bill_id, bill=None, problem=problem))
        else:
            readable.append(bill)

    actor = actor_for(access)
    plan = plan_batch([workflow_bill(b) for b in readable], body.action, actor)
    for wf, problem in plan.skipped:
        bill = bills[uuid.UUID(wf.id)]
        skipped.append(BatchSkipOut(id=bill.id, bill=bill_out(bill, calendar), problem=problem))
    eligible = [bills[uuid.UUID(wf.id)] for wf in plan.eligible]

    if not body.dry_run and eligible:
        record = _payment_record(body.payment)
        used = await _used_utrs(db, record)
        now = datetime.now(UTC)
        try:
            afters = [
                apply_action(
                    workflow_bill(b),
                    body.action,
                    actor,
                    now,
                    ActionInput(payment=record, used_utrs=used),
                    today=calendar.today(),
                    hard_block=calendar.hard_block,
                )
                for b in eligible
            ]
        except WorkflowError as exc:
            raise refuse(exc.problem) from exc
        payment = None
        if body.action == "pay":
            paid = afters[0].payment
            assert paid is not None
            payment = await _record_payment(db, access, paid, sum((b.amount for b in eligible), Decimal(0)))
        for bill, after in zip(eligible, afters, strict=True):
            await _record_move(db, bill, after, access, payment)
        fresh = {b.id: b for b in await load_bills(db, [b.id for b in eligible])}
        eligible = [fresh[b.id] for b in eligible]

    return BatchPlanOut(
        action=body.action,
        done=not body.dry_run,
        eligible=[bill_out(b, calendar) for b in eligible],
        skipped=skipped,
        total_paise=plan.total_paise,
        litres=number(plan.litres) or 0,
    )


@router.post("/{bill_id}/actions", response_model=ExpenseBillOut)
async def act(bill_id: uuid.UUID, body: ActionIn, current: CurrentSessionDep) -> ExpenseBillOut:
    """One move on one bill, by the signed-in person, under the chain's rules."""
    db = current.db
    access = await access_for(current)
    calendar = await calendar_for(current)
    bill = await _readable_bill(db, access, bill_id, lock=True)
    record = _payment_record(body.payment)
    try:
        after = apply_action(
            workflow_bill(bill),
            body.action,
            actor_for(access),
            datetime.now(UTC),
            ActionInput(note=body.note, payment=record, used_utrs=await _used_utrs(db, record)),
            today=calendar.today(),
            hard_block=calendar.hard_block,
        )
    except WorkflowError as exc:
        raise refuse(exc.problem) from exc
    payment = None
    if body.action == "pay":
        assert after.payment is not None
        payment = await _record_payment(db, access, after.payment, bill.amount)
    await _record_move(db, bill, after, access, payment)
    return await _respond(db, bill.id, calendar)

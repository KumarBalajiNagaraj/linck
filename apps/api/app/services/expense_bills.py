"""Expense bills between the database and the wire, and between the database and the workflow.

Shared by the expense routes and the WhatsApp import, which both create
bills. Everything here runs inside the request's tenant transaction, so RLS
has already confined every query to the caller's organization.
"""

from __future__ import annotations

import re
import uuid
from collections.abc import Sequence
from decimal import ROUND_HALF_UP, Decimal

from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.api.access import Access, Scope, TenantCalendar
from app.api.problems import invalid
from app.domain.expense_workflow import Actor, BillEvent, PaymentRecord, WorkflowBill
from app.models.core import File
from app.models.finance import EXPENSE_KINDS, STORES_KINDS, ExpenseBill, ExpenseBillField, WhatsAppImportClaim
from app.schemas.common import money, number
from app.schemas.expenses import (
    BillAttachmentOut,
    BillCaptureRecordOut,
    BillEventOut,
    BillSourceOut,
    CapturedBillFieldOut,
    CaptureIn,
    ExpenseBillOut,
    PaymentRecordOut,
)

#: Who reads a desk's bills: the desk itself, or accounts and the director.
READ_KEYS = {
    "fleet": ("fleet.expense.read", "finance.expense.read"),
    "stores": ("stores.expense.read", "finance.expense.read"),
}
UPLOAD_KEY = {"fleet": "fleet.expense.upload", "stores": "stores.expense.upload"}
VALIDATE_KEY = {"fleet": "fleet.expense.validate", "stores": "stores.expense.validate"}

#: The screen's payment modes against the design's payment_method.
METHOD_OF_MODE = {
    "NEFT": "neft",
    "RTGS": "rtgs",
    "IMPS": "imps",
    "UPI": "upi",
    "Cheque": "cheque",
    "Cash": "cash",
}
MODE_OF_METHOD = {method: mode for mode, method in METHOD_OF_MODE.items()}

#: The kinds each desk raises, as the upload sheet offers them.
KINDS_BY_DESK = {"fleet": EXPENSE_KINDS, "stores": STORES_KINDS}


def read_scope(access: Access, desk: str) -> Scope:
    return access.scope(*READ_KEYS[desk])


def may_read(access: Access, bill: ExpenseBill) -> bool:
    return read_scope(access, bill.desk).covers(bill.site_id)


def with_everything(stmt: Select[tuple[ExpenseBill]]) -> Select[tuple[ExpenseBill]]:
    """Everything a response needs, in one query per relation rather than one per bill."""
    return stmt.options(
        selectinload(ExpenseBill.fields),
        selectinload(ExpenseBill.events),
        selectinload(ExpenseBill.payment),
        selectinload(ExpenseBill.attachment),
        selectinload(ExpenseBill.claim).selectinload(WhatsAppImportClaim.batch),
    )


async def load_bills(db: AsyncSession, ids: Sequence[uuid.UUID], *, lock: bool = False) -> list[ExpenseBill]:
    """These bills, fresh from the database, in id order. `lock` takes their row
    locks for the rest of the transaction, so two people acting on one bill
    take turns rather than both reading the same history."""
    stmt = with_everything(select(ExpenseBill).where(ExpenseBill.id.in_(list(ids)))).order_by(ExpenseBill.id)
    if lock:
        stmt = stmt.with_for_update(of=ExpenseBill)
    return list((await db.scalars(stmt.execution_options(populate_existing=True))).all())


async def load_bill(db: AsyncSession, bill_id: uuid.UUID, *, lock: bool = False) -> ExpenseBill | None:
    found = await load_bills(db, [bill_id], lock=lock)
    return found[0] if found else None


# ------------------------------------------------------------------ the wire


def attachment_url(bill_id: uuid.UUID) -> str:
    return f"/expenses/{bill_id}/attachment"


def size_kb(size_bytes: int) -> int:
    # Math.round(size / 1024), as the upload sheet shows it.
    return int((Decimal(size_bytes) / 1024).to_integral_value(rounding=ROUND_HALF_UP))


def payment_out(bill: ExpenseBill) -> PaymentRecordOut | None:
    p = bill.payment
    if p is None:
        return None
    return PaymentRecordOut(
        utr=p.reference_no or "", paid_on=p.payment_date.isoformat(), mode=MODE_OF_METHOD[p.method]
    )


def bill_out(bill: ExpenseBill, calendar: TenantCalendar) -> ExpenseBillOut:
    capture = None
    if bill.capture_engine is not None and bill.captured_at is not None:
        capture = BillCaptureRecordOut(
            engine=bill.capture_engine,
            captured_at=bill.captured_at,
            fields=[
                CapturedBillFieldOut(
                    key=f.key,
                    label=f.label,
                    captured=f.captured_value,
                    confidence=f.confidence,
                    value=f.value,
                    overridden=f.overridden,
                    overridden_by=f.overridden_by_name,
                )
                for f in bill.fields
            ],
            warnings=list(bill.capture_warnings),
        )
    source = None
    if bill.claim is not None:
        source = BillSourceOut(
            claim_key=bill.claim.claim_key,
            via=bill.claim.batch.via,
            sender=bill.claim.sender,
            posted_at=bill.claim.posted_at,
            message=bill.claim.message,
            attachments=list(bill.claim.attachments),
        )
    attachment = None
    if bill.attachment is not None:
        attachment = BillAttachmentOut(
            file_name=bill.attachment.original_name,
            mime_type=bill.attachment.mime_type,
            size_kb=size_kb(bill.attachment.size_bytes),
            url=attachment_url(bill.id),
        )
    return ExpenseBillOut(
        id=bill.id,
        desk=bill.desk,
        bill_number=bill.bill_number,
        kind=bill.kind,
        bill_date=calendar.midnight(bill.bill_date),
        vehicle_id=bill.vehicle_ref,
        driver_id=bill.driver_ref,
        vendor=bill.vendor,
        description=bill.description,
        litres=number(bill.litres),
        amount=money(bill.amount),
        status=bill.status,
        submitted_by=bill.submitted_by_name,
        submitted_at=bill.submitted_at,
        site_id=bill.site_id,
        provenance=bill.provenance,
        attachment=attachment,
        capture=capture,
        source=source,
        submitted_by_id=bill.submitted_by_ref,
        history=[
            BillEventOut(
                action=e.action,
                from_=e.from_status,
                to=e.to_status,
                by_id=f"user:{e.actor_user_id}",
                by=e.actor_name,
                at=e.at,
                note=e.note,
                exception=e.exception,
            )
            for e in bill.events
        ],
        payment=payment_out(bill),
    )


# -------------------------------------------------------------- the workflow


def workflow_bill(bill: ExpenseBill) -> WorkflowBill:
    p = bill.payment
    return WorkflowBill(
        id=str(bill.id),
        status=bill.status,
        desk=bill.desk,
        site_id=str(bill.site_id),
        amount=bill.amount,
        litres=bill.litres,
        submitted_by_id=bill.submitted_by_ref,
        submitted_by=bill.submitted_by_name,
        history=tuple(
            BillEvent(
                action=e.action,
                from_status=e.from_status,
                to_status=e.to_status,
                by_id=f"user:{e.actor_user_id}",
                by=e.actor_name,
                at=e.at,
                note=e.note,
                exception=e.exception,
            )
            for e in bill.events
        ),
        payment=PaymentRecord(
            utr=p.reference_no or "", paid_on=p.payment_date.isoformat(), mode=MODE_OF_METHOD[p.method]
        )
        if p
        else None,
    )


def actor_for(access: Access) -> Actor:
    """The signed-in person, as the workflow sees them: never a name or id the client sent."""
    return Actor(
        id=access.actor_id, name=access.name, can=lambda permission, site_id: access.can(permission, site_id)
    )


# --------------------------------------------------- what capture read, and corrections

_RUPEE_PREFIX = re.compile(r"^(?:₹|rs\.?|inr)\s*", re.IGNORECASE)
_GROUPED_INDIAN = re.compile(r"^\d{1,3}(?:,\d{2})*,\d{3}(?:\.\d+)?$")
_GROUPED_INTERNATIONAL = re.compile(r"^\d{1,3}(?:,\d{3})+(?:\.\d+)?$")
_PLAIN = re.compile(r"^\d+(?:\.\d+)?$")


def parse_typed_amount(text: str, max_decimals: int = 2) -> Decimal | None:
    """parseTypedAmount from packages/domain/src/money.ts: '12,500' is twelve and a
    half thousand, and a figure that cannot be read is None, not a guess."""
    t = _RUPEE_PREFIX.sub("", text.strip())
    if not (_GROUPED_INDIAN.match(t) or _GROUPED_INTERNATIONAL.match(t) or _PLAIN.match(t)):
        return None
    if len(t.split(".")[1] if "." in t else "") > max_decimals:
        return None
    return Decimal(t.replace(",", ""))


def same_reading(key: str, a: str, b: str) -> bool:
    """Whether two values of a captured field say the same thing, as the screens compare them."""
    if key in ("amount", "litres"):
        x = parse_typed_amount(a, 3)
        return x is not None and x == parse_typed_amount(b, 3)
    return a.strip().upper() == b.strip().upper()


def litres_text(litres: Decimal | None) -> str:
    """String(litres) as the screens write it into a capture field: '432', '120.455', '' for none."""
    value = number(litres)
    return "" if value is None else str(value)


def capture_rows(
    bill: ExpenseBill, capture: CaptureIn, access: Access, *, corrections_by_uploader: bool
) -> list[ExpenseBillField]:
    """The capture record's fields for a new bill.

    For an upload, a field whose value differs from what capture read was
    corrected by the uploader, and is credited to them — decided here, from the
    two values, never from a flag the client sends. Two readings are not
    corrections anyone made, as on the upload sheet: a vehicle the form could
    not pick (left blank), and a kind this desk does not raise. For a WhatsApp
    import nobody has corrected anything yet.
    """
    seen: set[str] = set()
    rows: list[ExpenseBillField] = []
    for position, f in enumerate(capture.fields):
        if f.key in seen:
            raise invalid("capture.fields", f"{f.key} appears twice")
        seen.add(f.key)
        captured = f.captured
        corrected = (
            corrections_by_uploader
            and captured is not None
            and not (f.key == "vehicle" and not f.value.strip())
            and not (f.key == "kind" and captured not in KINDS_BY_DESK[bill.desk])
            and not same_reading(f.key, f.value, captured)
        )
        rows.append(
            ExpenseBillField(
                organization_id=bill.organization_id,
                bill_id=bill.id,
                position=position,
                key=f.key,
                label=f.label,
                captured_value=captured,
                confidence=f.confidence if captured is not None else None,
                value=f.value,
                overridden=corrected,
                overridden_by=access.user_id if corrected else None,
                overridden_by_name=access.name if corrected else None,
            )
        )
    return rows


async def claim_attachment(db: AsyncSession, access: Access, file_id: uuid.UUID) -> File:
    """An uploaded scan this person may put on a new bill: in this tenant (RLS),
    uploaded by them, for a bill, and not already on another bill (the unique
    key on expense_bills is the backstop)."""
    file = await db.get(File, file_id)
    if file is None or file.uploaded_by != access.user_id or file.purpose != "expense_bill":
        raise invalid("attachmentId", "no such upload of yours")
    taken = await db.scalar(select(ExpenseBill.id).where(ExpenseBill.attachment_file_id == file_id))
    if taken is not None:
        raise invalid("attachmentId", "already on another bill")
    return file

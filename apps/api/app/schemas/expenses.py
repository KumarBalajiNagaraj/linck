"""Expense bills on the wire: ExpenseBill, BillAttachment, BillCaptureRecord,
CapturedBillField, BillSource, BillEvent and PaymentRecord from
packages/mock/src/types.ts and packages/domain, field for field."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, AwareDatetime, Field, StringConstraints, model_serializer

from app.schemas.common import CamelIn, CamelModel, MoneyIn, QuantityIn

Desk = Literal["fleet", "stores"]
ExpenseKind = Literal["diesel", "repair", "tyre", "spares", "toll", "other"]
ExpenseStatus = Literal["submitted", "validated", "approved", "passed", "paid", "rejected", "deleted"]
BillAction = Literal["validate", "approve", "pass", "pay", "reject", "send_back", "delete", "restore"]
SigningAction = Literal["validate", "approve", "pass", "pay"]
PaymentMode = Literal["NEFT", "RTGS", "IMPS", "UPI", "Cheque", "Cash"]
BillFieldKey = Literal[
    "kind", "billNumber", "billDate", "vendor", "gstin", "vehicle", "litres", "rate", "amount"
]

#: A vehicle or driver as the screens name it ('veh-001', 'drv-001') until
#: fleet.vehicles and the driver roster are migrated.
Ref = Annotated[str, StringConstraints(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")]

Text60 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)]
Text200 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Text500 = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]
Note = Annotated[str, StringConstraints(max_length=1000)]

#: BillNotice codes: CaptureWarning (bill-capture.ts) and ClaimIssue (whatsapp.ts).
NOTICE_CODES = frozenset(
    {
        # CaptureWarning
        "litres-rate-mismatch",
        "unreadable",
        "no-total",
        "no-bill-number",
        # ClaimIssue
        "rate-out-of-band",
        "inferred",
        "no-litres",
        "no-amount",
        "no-photo",
        "photo-only",
        "media-omitted",
        "no-vehicle",
        "vehicle-unmatched",
        "not-own-fill",
        "not-a-driver",
        "no-fill",
        "same-photo-as-line",
        "same-figures-as-line",
        "slip-litres-differ",
        "slip-amount-differ",
        "slip-names-other-vehicle",
        "slip-vehicle-unknown",
        "slip-unreadable",
    }
)


def _notice(value: dict[str, Any]) -> dict[str, Any]:
    """A notice is a known code and a few plain values, stored as sent."""
    if value.get("code") not in NOTICE_CODES:
        raise ValueError(f"unknown notice code {value.get('code')!r}")
    if len(value) > 8:
        raise ValueError("too many values on one notice")
    for key, item in value.items():
        if not isinstance(key, str) or len(key) > 40:
            raise ValueError("notice keys are short strings")
        if not (
            item is None
            or isinstance(item, bool | int | float)
            or (isinstance(item, str) and len(item) <= 200)
        ):
            raise ValueError(f"notice value {key!r} must be a number, a short string, true/false or null")
    return value


Notice = Annotated[dict[str, Any], AfterValidator(_notice)]


# ---------------------------------------------------------------- responses


class BillAttachmentOut(CamelModel):
    file_name: str
    mime_type: str
    size_kb: int
    #: Where the scan can be opened, relative to the API (as /whatsapp/media is).
    url: str


class CapturedBillFieldOut(CamelModel):
    key: str
    label: str
    captured: str | None
    confidence: int | None
    value: str
    overridden: bool
    overridden_by: str | None


class BillCaptureRecordOut(CamelModel):
    engine: str
    captured_at: datetime
    fields: list[CapturedBillFieldOut]
    warnings: list[dict[str, Any]]


class BillSourceOut(CamelModel):
    channel: Literal["whatsapp"] = "whatsapp"
    claim_key: str
    via: str
    sender: str
    posted_at: datetime
    message: str
    attachments: list[str]


class BillEventOut(CamelModel):
    action: str
    from_: str = Field(alias="from")
    to: str
    by_id: str
    by: str
    at: datetime
    note: str | None
    exception: bool


class PaymentRecordOut(CamelModel):
    utr: str
    paid_on: str
    mode: str


class ExpenseBillOut(CamelModel):
    id: uuid.UUID
    desk: str
    bill_number: str
    kind: str
    bill_date: datetime
    vehicle_id: str | None
    driver_id: str | None
    vendor: str
    description: str
    litres: float | int | None
    amount: str
    status: str
    submitted_by: str
    submitted_at: datetime
    site_id: uuid.UUID
    provenance: str
    attachment: BillAttachmentOut | None
    capture: BillCaptureRecordOut | None
    source: BillSourceOut | None = None
    submitted_by_id: str | None
    history: list[BillEventOut]
    payment: PaymentRecordOut | None

    @model_serializer(mode="wrap")
    def _omit_absent_source(self, handler):  # type: ignore[no-untyped-def]
        # `source?: BillSource` is absent, not null, on a bill that did not
        # come in on WhatsApp.
        data = handler(self)
        if data.get("source") is None:
            data.pop("source", None)
        return data


class AttachmentOut(CamelModel):
    """A stored scan, before it is put on a bill."""

    id: uuid.UUID
    file_name: str
    mime_type: str
    size_kb: int


class BatchSkipOut(CamelModel):
    id: uuid.UUID
    #: Null when the id names no bill this person can see.
    bill: ExpenseBillOut | None
    problem: dict[str, Any]


class BatchPlanOut(CamelModel):
    """BatchPlan from expense-workflow.ts. `eligible` are the bills after the
    move, or as they stand when `done` is false (a dry run)."""

    action: str
    done: bool
    eligible: list[ExpenseBillOut]
    skipped: list[BatchSkipOut]
    total_paise: int
    litres: float | int


# ----------------------------------------------------------------- requests


class CaptureFieldIn(CamelIn):
    key: BillFieldKey
    label: Annotated[str, StringConstraints(min_length=1, max_length=60)]
    captured: Annotated[str, StringConstraints(max_length=200)] | None
    confidence: Literal[1, 2, 3] | None = None
    value: Annotated[str, StringConstraints(max_length=200)]


class CaptureIn(CamelIn):
    engine: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    captured_at: AwareDatetime
    fields: Annotated[list[CaptureFieldIn], Field(max_length=12)]
    warnings: Annotated[list[Notice], Field(max_length=50)] = []


class ExpenseBillIn(CamelIn):
    """A bill keyed by hand, or from an uploaded scan (`attachmentId`) and what was read off it."""

    desk: Desk
    site_id: uuid.UUID
    kind: ExpenseKind
    bill_number: Text60
    bill_date: Annotated[str, StringConstraints(max_length=40)]
    vendor: Text200
    description: Text500 = ""
    vehicle_id: Ref | None = None
    driver_id: Ref | None = None
    litres: QuantityIn | None = None
    amount: MoneyIn
    attachment_id: uuid.UUID | None = None
    capture: CaptureIn | None = None


class CorrectionIn(CamelIn):
    """What a person may correct while a bill is still unsigned. Omitted fields stay as they are."""

    bill_number: Text60 | None = None
    bill_date: Annotated[str, StringConstraints(max_length=40)] | None = None
    vendor: Text200 | None = None
    litres: QuantityIn | None = None
    amount: MoneyIn | None = None


class PaymentIn(CamelIn):
    utr: Annotated[str, StringConstraints(max_length=40)] = ""
    paid_on: Annotated[str, StringConstraints(max_length=20)]
    mode: PaymentMode


class ActionIn(CamelIn):
    action: BillAction
    note: Note | None = None
    payment: PaymentIn | None = None


class BatchIn(CamelIn):
    action: SigningAction
    ids: Annotated[list[uuid.UUID], Field(min_length=1, max_length=500)]
    #: One bank transfer for the whole batch: its UTR goes on every bill.
    payment: PaymentIn | None = None
    #: Plan only: say what would happen, change nothing.
    dry_run: bool = False

"""A WhatsApp import on the wire: the claims the fleet manager chose to add, and what became of them."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import AwareDatetime, Field, StringConstraints

from app.schemas.common import CamelIn, CamelModel, MoneyIn, QuantityIn
from app.schemas.expenses import CaptureIn, ExpenseBillOut, Ref

#: Who sent the slip, as the four-eyes rule names them: a rostered driver, or
#: the sender as the chat names them (a number or a saved contact name).
DriverActor = Annotated[
    str, StringConstraints(pattern=r"^(driver:[A-Za-z0-9._-]{1,64}|wa:[^\x00-\x1f]{1,120})$")
]


class ClaimBillIn(CamelIn):
    """The bill a claim becomes: billFromClaim() in apps/web/src/features/expenses/whatsappImport.ts."""

    site_id: uuid.UUID
    vehicle_id: Ref
    driver_id: Ref | None = None
    bill_number: Annotated[str, StringConstraints(strip_whitespace=True, max_length=60)] = ""
    bill_date: Annotated[str, StringConstraints(max_length=40)]
    vendor: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""
    litres: QuantityIn | None = None
    amount: MoneyIn
    submitted_by: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]
    submitted_by_id: DriverActor
    attachment_id: uuid.UUID | None = None
    capture: CaptureIn | None = None


class ClaimIn(CamelIn):
    #: The claim's stable key from packages/domain/src/whatsapp.ts.
    claim_key: Annotated[str, StringConstraints(min_length=1, max_length=1000)]
    sender: Annotated[str, StringConstraints(min_length=1, max_length=120)]
    posted_at: AwareDatetime
    message: Annotated[str, StringConstraints(max_length=4000)] = ""
    attachments: Annotated[list[Annotated[str, StringConstraints(max_length=200)]], Field(max_length=10)] = []
    bill: ClaimBillIn


class ImportIn(CamelIn):
    source: Literal["inbox", "export"]
    #: The group an export came from; empty for the business number's inbox.
    via: Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)] = ""
    #: Inbox messages behind these claims, marked imported in the same transaction.
    inbox_message_ids: Annotated[list[uuid.UUID], Field(max_length=2000)] = []
    claims: Annotated[list[ClaimIn], Field(min_length=1, max_length=500)]


class ImportBatchOut(CamelModel):
    id: uuid.UUID
    source: str
    via: str
    claims_received: int
    claims_imported: int
    claims_skipped: int
    imported_by: str
    imported_at: datetime


class ImportSkipOut(CamelModel):
    claim_key: str
    #: A PlanReason: {"code": "already-imported", "on": <when it was first imported>}.
    reason: dict[str, Any]


class ImportResultOut(CamelModel):
    batch: ImportBatchOut
    imported: list[ExpenseBillOut]
    skipped: list[ImportSkipOut]

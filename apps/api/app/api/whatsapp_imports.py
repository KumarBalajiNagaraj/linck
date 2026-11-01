"""WhatsApp diesel imports: driver slips taken into the expense ledger, once each.

    fleet manager reads the inbox or a chat export, picks the claims to add
        │
        └──▶ POST /whatsapp/imports ──▶ one batch row
                                        one claim row per message  (UNIQUE organization_id, claim_key)
                                        one fleet diesel bill per NEW claim, linked back to it

A message imported before, from this export or any other phone's, is not
imported again: its claim key is already there, and the response lists it
under `skipped` with when it first came in. The de-duplication is the unique
key, not a lookup, so two imports racing each other cannot both win.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Query, status
from sqlalchemy import select, update
from sqlalchemy.dialects.postgresql import insert

from app.api.access import access_for, calendar_for
from app.api.deps import CurrentSessionDep
from app.api.problems import invalid, needs_permission
from app.models.core import Site, User, WhatsAppMessage
from app.models.finance import ExpenseBill, WhatsAppImportBatch, WhatsAppImportClaim
from app.schemas.common import parse_day
from app.schemas.whatsapp_imports import ImportBatchOut, ImportIn, ImportResultOut, ImportSkipOut
from app.services.expense_bills import bill_out, capture_rows, claim_attachment, load_bills

router = APIRouter(prefix="/whatsapp/imports", tags=["whatsapp"])

# Importing slips is part of raising fleet bills, as for the inbox itself.
IMPORT_PERMISSION = "fleet.expense.upload"


def _batch_out(batch: WhatsAppImportBatch, imported_by: str) -> ImportBatchOut:
    return ImportBatchOut(
        id=batch.id,
        source=batch.source,
        via=batch.via,
        claims_received=batch.claims_received,
        claims_imported=batch.claims_imported,
        claims_skipped=batch.claims_skipped,
        imported_by=imported_by,
        imported_at=batch.imported_at,
    )


@router.post("", response_model=ImportResultOut, status_code=status.HTTP_201_CREATED)
async def import_claims(body: ImportIn, current: CurrentSessionDep) -> ImportResultOut:
    """Take these claims into the ledger as submitted fleet diesel bills.

    Each bill is machine-read and unconfirmed (`proposed`) until the fleet
    manager validates it, and is raised by the driver who sent it, not by
    whoever ran the import: so the fleet manager's validation is a clean
    second pair of eyes.
    """
    db = current.db
    access = await access_for(current)
    calendar = await calendar_for(current)
    if not access.can(IMPORT_PERMISSION):
        raise needs_permission(IMPORT_PERMISSION)
    sites = {c.bill.site_id for c in body.claims}
    for site_id in sites:
        if not access.can(IMPORT_PERMISSION, site_id):
            raise needs_permission(IMPORT_PERMISSION)
    known = set((await db.scalars(select(Site.id).where(Site.id.in_(sites)))).all())
    if known != sites:
        raise invalid("claims.bill.siteId", "no such site")

    batch = WhatsAppImportBatch(
        id=uuid.uuid4(),
        organization_id=current.organization_id,
        source=body.source,
        via=body.via,
        # Counted at the end, all three together, so the row always adds up.
        claims_received=0,
        claims_imported=0,
        claims_skipped=0,
        imported_by=access.user_id,
        imported_at=datetime.now(UTC),
    )
    db.add(batch)
    await db.flush()

    imported: list[uuid.UUID] = []
    skipped: list[ImportSkipOut] = []
    for claim in body.claims:
        claim_id = (
            await db.execute(
                insert(WhatsAppImportClaim)
                .values(
                    organization_id=current.organization_id,
                    batch_id=batch.id,
                    claim_key=claim.claim_key,
                    sender=claim.sender,
                    posted_at=claim.posted_at,
                    message=claim.message,
                    attachments=claim.attachments,
                )
                .on_conflict_do_nothing(index_elements=["organization_id", "claim_key"])
                .returning(WhatsAppImportClaim.id)
            )
        ).scalar_one_or_none()
        if claim_id is None:
            first = await db.scalar(
                select(WhatsAppImportBatch.imported_at)
                .join(WhatsAppImportClaim, WhatsAppImportClaim.batch_id == WhatsAppImportBatch.id)
                .where(WhatsAppImportClaim.claim_key == claim.claim_key)
            )
            # ISO-8601 UTC, written as every other instant in the API is.
            on = (first or batch.imported_at).astimezone(UTC).isoformat().replace("+00:00", "Z")
            skipped.append(
                ImportSkipOut(claim_key=claim.claim_key, reason={"code": "already-imported", "on": on})
            )
            continue

        b = claim.bill
        if b.amount <= 0:
            raise invalid("claims.bill.amount", "must be more than zero")
        try:
            bill_date = parse_day(b.bill_date, calendar.timezone)
        except ValueError as exc:
            raise invalid("claims.bill.billDate", "not a date") from exc
        if b.attachment_id is not None:
            await claim_attachment(db, access, b.attachment_id)
        bill = ExpenseBill(
            id=uuid.uuid4(),
            organization_id=current.organization_id,
            desk="fleet",
            site_id=b.site_id,
            kind="diesel",
            bill_number=b.bill_number,
            bill_date=bill_date,
            vendor=b.vendor,
            description="",
            vehicle_ref=b.vehicle_id,
            driver_ref=b.driver_id,
            litres=b.litres,
            amount=b.amount,
            status="submitted",
            # Machine-read and not yet looked at by a person: validation confirms it.
            provenance="proposed",
            submitted_by_ref=b.submitted_by_id,
            submitted_by_name=b.submitted_by,
            submitted_at=claim.posted_at,
            created_by=access.user_id,
            attachment_file_id=b.attachment_id,
            capture_engine=b.capture.engine if b.capture else None,
            captured_at=b.capture.captured_at if b.capture else None,
            capture_warnings=list(b.capture.warnings) if b.capture else [],
            whatsapp_claim_id=claim_id,
        )
        db.add(bill)
        await db.flush()
        if b.capture:
            db.add_all(capture_rows(bill, b.capture, access, corrections_by_uploader=False))
            await db.flush()
        imported.append(bill.id)

    batch.claims_received = len(body.claims)
    batch.claims_imported = len(imported)
    batch.claims_skipped = len(skipped)
    if body.inbox_message_ids:
        await db.execute(
            update(WhatsAppMessage)
            .where(WhatsAppMessage.id.in_(body.inbox_message_ids), WhatsAppMessage.imported_at.is_(None))
            .values(imported_at=batch.imported_at, imported_by=access.user_id)
        )
    await db.flush()

    bills = {b.id: b for b in await load_bills(db, imported)}
    return ImportResultOut(
        batch=_batch_out(batch, access.name),
        imported=[bill_out(bills[bill_id], calendar) for bill_id in imported],
        skipped=skipped,
    )


@router.get("", response_model=list[ImportBatchOut])
async def list_imports(
    current: CurrentSessionDep, limit: Annotated[int, Query(ge=1, le=500)] = 100
) -> list[ImportBatchOut]:
    """Imports, newest first: when, from where, by whom, and how many were new."""
    access = await access_for(current)
    if not access.can(IMPORT_PERMISSION):
        raise needs_permission(IMPORT_PERMISSION)
    rows = (
        await current.db.execute(
            select(WhatsAppImportBatch, User.full_name)
            .join(User, User.id == WhatsAppImportBatch.imported_by)
            .order_by(WhatsAppImportBatch.imported_at.desc(), WhatsAppImportBatch.id)
            .limit(limit)
        )
    ).all()
    return [_batch_out(batch, name) for batch, name in rows]

"""Party invoices (LIN-27): GST tax invoices made from Vehicle P&L trips.

    GET    /invoices                          invoices, searched and filtered            read
    GET    /invoices/trips                    trips' sale lines no live invoice bills    read
    POST   /invoices                          a draft from trip ids, for one customer    write
    GET    /invoices/{id}                     one invoice, all it prints, its money      read
    PATCH  /invoices/{id}                     a draft's addresses, place of supply, note write
    DELETE /invoices/{id}                     a draft that was never issued              write
    POST   /invoices/{id}/issue               take the next number; nothing changes now  write
    POST   /invoices/{id}/cancel              keep it on record, cancelled, with a reason cancel
    GET    /invoices/{id}/receipts            the money received against it              read
    POST   /invoices/{id}/receipts            match payments on its trips: all, or one   receive
    DELETE /invoices/{id}/receipts/{rid}      let one match go                           receive

    under /vehicle-pl. read: sales.invoice.read; write: sales.invoice.write;
    cancel: sales.invoice.cancel (accounts); receive: finance.receipt.verify.

An invoice is at the site its trips' sheets are at, and is read and written
where those keys reach that site, as a trip sheet is (app/api/vehicle_pl.py):
a person sees and invoices only trips at the sites they reach. Refusals are
problem codes the screen words (app/api/problems.py); the figures are
app/domain/party_invoice.py's.
"""

from __future__ import annotations

import uuid
from datetime import date
from typing import Annotated, Literal

from fastapi import APIRouter, Query, Response, status

from app.api.access import Access, Scope, access_for, calendar_for
from app.api.deps import CurrentSessionDep
from app.api.problems import needs_permission
from app.models.sales import Invoice
from app.schemas.party_invoices import (
    CancelIn,
    InvoiceIn,
    InvoiceListOut,
    InvoiceOut,
    InvoicePatch,
    InvoiceTripsOut,
    MatchIn,
    ReceiptsOut,
)
from app.services import party_invoices as svc

router = APIRouter(prefix="/vehicle-pl/invoices", tags=["sales"])

#: The day issued, or a draft's day made.
DateFrom = Annotated[date | None, Query(alias="from", description="Invoice date, inclusive")]
DateTo = Annotated[date | None, Query(alias="to", description="Invoice date, inclusive")]
TripFrom = Annotated[date | None, Query(alias="from", description="Trip date, inclusive")]
TripTo = Annotated[date | None, Query(alias="to", description="Trip date, inclusive")]
CustomerId = Annotated[uuid.UUID | None, Query(alias="customerId")]
SiteId = Annotated[uuid.UUID | None, Query(alias="siteId")]
Search = Annotated[str | None, Query(alias="q", max_length=100)]
MoneyStatus = Annotated[Literal["due", "paid"] | None, Query(alias="money")]
Limit = Annotated[int, Query(ge=1, le=2000)]


def _scope_or_refuse(access: Access, key: str) -> Scope:
    scope = access.scope(key)
    if scope.empty:
        raise needs_permission(key)
    return scope


async def _readable(current: CurrentSessionDep, invoice_id: uuid.UUID) -> Invoice:
    access = await access_for(current)
    invoice = await svc.load_invoice(current.db, invoice_id)
    if not svc.may_read(access, invoice):
        raise needs_permission(svc.READ)
    return invoice


@router.get("", response_model=InvoiceListOut)
async def list_invoices(
    current: CurrentSessionDep,
    status_: Annotated[Literal["draft", "issued", "cancelled"] | None, Query(alias="status")] = None,
    money_status: MoneyStatus = None,
    customer_id: CustomerId = None,
    site_id: SiteId = None,
    date_from: DateFrom = None,
    date_to: DateTo = None,
    q: Search = None,
    limit: Limit = 500,
) -> InvoiceListOut:
    """Every invoice at the sites this person reaches that matches: drafts first, then the latest issued."""
    scope = _scope_or_refuse(await access_for(current), svc.READ)
    f = svc.InvoiceFilter(status_, money_status, customer_id, site_id, date_from, date_to, q, limit)
    return await svc.list_invoices(current.db, scope, await calendar_for(current), f)


@router.get("/trips", response_model=InvoiceTripsOut)
async def trips_to_invoice(
    current: CurrentSessionDep,
    customer_id: CustomerId = None,
    site_id: SiteId = None,
    date_from: TripFrom = None,
    date_to: TripTo = None,
    q: Search = None,
    limit: Limit = 500,
) -> InvoiceTripsOut:
    """The trips to make invoices from: each one's sale lines to each customer that no draft or
    issued invoice bills yet, with the reason when one cannot go on an invoice here."""
    scope = _scope_or_refuse(await access_for(current), svc.READ)
    f = svc.TripFilter(customer_id, site_id, date_from, date_to, q, limit)
    return InvoiceTripsOut(rows=await svc.trips_to_invoice(current.db, scope, f))


@router.post("", response_model=InvoiceOut, status_code=status.HTTP_201_CREATED)
async def make_draft(body: InvoiceIn, current: CurrentSessionDep) -> InvoiceOut:
    """A draft for one customer, from the sale lines to them on these trips. No number until issued."""
    invoice_id = await svc.make_draft(current.db, await access_for(current), body)
    return await svc.invoice_out(current.db, invoice_id)


@router.get("/{invoice_id}", response_model=InvoiceOut)
async def get_invoice(invoice_id: uuid.UUID, current: CurrentSessionDep) -> InvoiceOut:
    invoice = await _readable(current, invoice_id)
    return await svc.invoice_out(current.db, invoice.id)


@router.patch("/{invoice_id}", response_model=InvoiceOut)
async def patch_draft(invoice_id: uuid.UUID, body: InvoicePatch, current: CurrentSessionDep) -> InvoiceOut:
    """A draft's billing and delivery addresses, its place of supply (kept as chosen), a note."""
    await svc.patch_draft(current.db, await access_for(current), invoice_id, body)
    return await svc.invoice_out(current.db, invoice_id)


@router.delete("/{invoice_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_draft(invoice_id: uuid.UUID, current: CurrentSessionDep) -> Response:
    """Only a draft that was never issued: GST does not allow deleting an issued invoice."""
    await svc.delete_draft(current.db, await access_for(current), invoice_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{invoice_id}/issue", response_model=InvoiceOut)
async def issue(invoice_id: uuid.UUID, current: CurrentSessionDep) -> InvoiceOut:
    """Take the next number of the seller GSTIN's series for this financial year. From now on
    nothing it prints changes; money already paid on its trips is matched to it at once."""
    await svc.issue(current.db, await access_for(current), await calendar_for(current), invoice_id)
    return await svc.invoice_out(current.db, invoice_id)


@router.post("/{invoice_id}/cancel", response_model=InvoiceOut)
async def cancel(invoice_id: uuid.UUID, body: CancelIn, current: CurrentSessionDep) -> InvoiceOut:
    """Keep it on record, marked cancelled, with its number; its trips can be invoiced again."""
    await svc.cancel(current.db, await access_for(current), invoice_id, body.reason)
    return await svc.invoice_out(current.db, invoice_id)


@router.get("/{invoice_id}/receipts", response_model=ReceiptsOut)
async def receipts(invoice_id: uuid.UUID, current: CurrentSessionDep) -> ReceiptsOut:
    """What the invoice has received, what is still due, and the money on its trips not matched yet."""
    invoice = await _readable(current, invoice_id)
    return await svc.receipts_out(current.db, invoice)


@router.post("/{invoice_id}/receipts", response_model=ReceiptsOut)
async def match(invoice_id: uuid.UUID, body: MatchIn, current: CurrentSessionDep) -> ReceiptsOut:
    """Match the customer's payments on the invoice's trips: its own trips' first, then their
    sheets', oldest first, up to what is due; or one payment, up to `amount`."""
    await svc.match(current.db, await access_for(current), invoice_id, body)
    await current.db.flush()
    return await svc.receipts_out(current.db, await svc.load_invoice(current.db, invoice_id))


@router.delete("/{invoice_id}/receipts/{receipt_id}", response_model=ReceiptsOut)
async def unmatch(invoice_id: uuid.UUID, receipt_id: uuid.UUID, current: CurrentSessionDep) -> ReceiptsOut:
    await svc.unmatch(current.db, await access_for(current), invoice_id, receipt_id)
    return await svc.receipts_out(current.db, await svc.load_invoice(current.db, invoice_id))

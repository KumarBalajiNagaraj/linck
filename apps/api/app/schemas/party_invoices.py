"""Party invoices on the wire (LIN-27): GST tax invoices made from Vehicle P&L trips.

The web app's demo store (apps/web/src/features/vehicle-pl/invoiceStore.ts) is
shaped exactly like these, field for field (packages/mock/src/party-invoices.ts),
so the store becomes fetches of /vehicle-pl/invoices and nothing else changes.
The encodings are app/schemas/common.py's: money a two-place decimal string,
quantities and GST rates JSON numbers, dates YYYY-MM-DD, instants ISO-8601.

Every figure comes from app/domain/party_invoice.py. A request carries only
what a person picks or types; anything else is refused, not ignored.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Annotated, Literal

from pydantic import Field, StringConstraints

from app.schemas.common import CamelIn, CamelModel, MoneyIn

Number = float | int

#: Trips on one invoice: a month of a builder's loads, short of a runaway client.
MAX_TRIPS = 200

Address = Annotated[str, StringConstraints(strip_whitespace=True, max_length=300)]
StateCode = Annotated[str, StringConstraints(strip_whitespace=True, pattern=r"^[0-9]{2}$")]
Reason = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Notes = Annotated[str, StringConstraints(strip_whitespace=True, max_length=500)]


# ------------------------------------------------------------------ requests


class InvoiceIn(CamelIn):
    """Make a draft: one customer, the trips whose sale lines to that customer it bills."""

    customer_id: uuid.UUID
    trip_ids: list[uuid.UUID] = Field(min_length=1, max_length=MAX_TRIPS)


class InvoicePatch(CamelIn):
    """What a draft may still be told: where to bill and deliver, the place of supply, a note.

    A place of supply set here is kept as chosen, and decides the tax."""

    buyer_address: Address | None = None
    ship_to_address: Address | None = None
    place_of_supply: StateCode | None = None
    notes: Notes | None = None


class CancelIn(CamelIn):
    reason: Reason


class MatchIn(CamelIn):
    """Match the money paid on the invoice's trips: every payment by the rule, or one, up to `amount`."""

    payment_id: uuid.UUID | None = None
    amount: MoneyIn | None = None


# ----------------------------------------------------------------- responses


class SellerOut(CamelModel):
    legal_name: str
    trade_name: str
    gstin: str
    state_code: str
    address: str


class BuyerOut(CamelModel):
    party_id: uuid.UUID
    name: str
    #: None on a B2C invoice.
    gstin: str | None
    #: The state its GSTIN is registered in; None without one.
    state_code: str | None
    address: str


class ShipToOut(CamelModel):
    name: str
    address: str


class InvoiceLineOut(CamelModel):
    id: uuid.UUID
    position: int
    #: The trip sale it bills; None only on a cancelled invoice whose sale was deleted since.
    trip_sale_id: uuid.UUID | None
    trip_id: uuid.UUID | None
    sheet_id: uuid.UUID | None
    sheet_number: str
    trip_number: str
    trip_date: dt.date
    registration_number: str
    challan_number: str
    location: str
    description: str
    hsn_code: str
    unit: str
    quantity: Number
    rate: str
    amount: str
    transport: str
    taxable: str
    gst_rate_pct: Number
    cgst_pct: Number
    sgst_pct: Number
    igst_pct: Number
    cgst: str
    sgst: str
    igst: str
    total: str


class TaxRowOut(CamelModel):
    hsn_code: str | None
    gst_rate_pct: Number
    taxable: str
    cgst: str
    sgst: str
    igst: str
    tax: str


class ReceiptOut(CamelModel):
    """A trip payment matched to the invoice: how much of it, and from where."""

    id: uuid.UUID
    payment_id: uuid.UUID
    paid_on: dt.date
    mode: str
    reference: str | None
    sheet_id: uuid.UUID
    sheet_number: str
    trip_number: str | None
    #: The payment's whole amount, and how much of it went to this invoice.
    payment_amount: str
    amount: str
    matched_by: str
    matched_at: dt.datetime


class UnmatchedOut(CamelModel):
    """A payment from the customer on the invoice's trips or their sheets with money no invoice has taken."""

    payment_id: uuid.UUID
    paid_on: dt.date
    mode: str
    reference: str | None
    sheet_id: uuid.UUID
    sheet_number: str
    trip_number: str | None
    on_trip: bool
    payment_amount: str
    free: str


class ReceiptsOut(CamelModel):
    """The money received against an invoice."""

    invoice_id: uuid.UUID
    total: str
    received: str
    due: str
    #: due, part_paid, paid; None for a draft or a cancelled invoice, which is owed nothing.
    money_status: str | None
    receipts: list[ReceiptOut]
    unmatched: list[UnmatchedOut]


class InvoiceRowOut(CamelModel):
    """An invoice in the list."""

    id: uuid.UUID
    status: str
    invoice_number: str | None
    invoice_date: dt.date | None
    financial_year: str | None
    site_id: uuid.UUID
    customer_id: uuid.UUID
    buyer_name: str
    buyer_gstin: str | None
    kind: Literal["b2b", "b2c"]
    seller_gstin: str
    place_of_supply: str
    supply_type: str
    trip_numbers: list[str]
    line_count: int
    taxable: str
    tax: str
    total: str
    received: str
    due: str
    money_status: str | None
    created_by: str
    created_at: dt.datetime
    issued_at: dt.datetime | None
    cancelled_at: dt.datetime | None


class InvoiceOut(InvoiceRowOut):
    """One invoice, everything it prints, and the money received against it."""

    seller: SellerOut
    buyer: BuyerOut
    ship_to: ShipToOut | None
    pos_basis: str
    lines: list[InvoiceLineOut]
    by_hsn: list[TaxRowOut]
    cgst: str
    sgst: str
    igst: str
    before_rounding: str
    round_off: str
    words: str
    notes: str
    issued_by: str | None
    cancelled_by: str | None
    cancel_reason: str | None
    irn: str | None
    irn_ack_number: str | None
    irn_ack_date: dt.datetime | None
    receipts: list[ReceiptOut]
    unmatched: list[UnmatchedOut]


class InvoiceTotalOut(CamelModel):
    invoices: int
    total: str
    received: str
    due: str


class InvoiceListOut(CamelModel):
    rows: list[InvoiceRowOut]
    total: InvoiceTotalOut


class InvoiceTripOut(CamelModel):
    """A trip's sale lines to one customer that no live invoice bills yet."""

    trip_id: uuid.UUID
    trip_number: str
    trip_date: dt.date
    sheet_id: uuid.UUID
    sheet_number: str
    site_id: uuid.UUID
    registration_number: str
    customer_id: uuid.UUID
    customer_name: str
    customer_gstin: str | None
    materials: list[str]
    line_count: int
    #: AV and AX of those lines, as the trip page shows them.
    taxable: str
    total: str
    #: Why it cannot go on an invoice here, if it cannot: a sale billed without GST,
    #: one with an invoice number typed on the trip (billed outside Linck), or one with no HSN.
    blocked: Literal["not-gst", "billed-outside", "no-hsn"] | None
    outside_invoice_number: str


class InvoiceTripsOut(CamelModel):
    rows: list[InvoiceTripOut]

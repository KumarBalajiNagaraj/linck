"""PARTY INVOICES (LIN-27): GST tax invoices made from Vehicle P&L trips, worked out where they are stored.

A port of packages/domain/src/party-invoice.ts, kept close enough to read side
by side, on the exact decimal helpers of app/domain/vehicle_pl.py. Both run
over packages/domain/src/party-invoice.fixtures.json, the golden figures worked
by hand (tests/test_party_invoice_domain.py), so a rule changed on one side
only fails a suite. The screens use the TypeScript; this copy decides what the
API stores on an invoice.

An invoice bills one customer for the sale lines of one trip or several:

    amount        = quantity × rate, to the paisa (the workbook's AO × AQ)
    taxable       = amount + transport (AV: transport is inside the taxable value)
    which tax     = CGST + SGST when the place of supply is the seller's own state,
                    IGST otherwise
    CGST, SGST    = taxable × half the rate, each rounded to the paisa, line by line
    IGST          = taxable × the rate, rounded to the paisa, line by line
    total         = Σ taxable + Σ tax, rounded to the rupee, half away from zero,
                    the round-off on its own line
    in words      = the total in Indian English (thousand, lakh, crore), "Only"

The place of supply is the delivery location's state (s.10(1)(a) IGST Act),
then the buyer's GSTIN state, then the seller's own, with the basis kept.
Numbers run PREFIX/26-27/0001 per GSTIN per financial year, at most 16
characters of letters, digits, "-" and "/". Money received is matched from
the customer's payments on the invoice's own trips first, then those on the
trips' sheets, oldest first, never past what is due.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

from app.domain.vehicle_pl import (
    ZERO,
    Num,
    add,
    dec,
    dsum,
    mul,
    percent_of,
    round_to,
    sub,
    to_fixed,
    to_number,
)

#: The rules' version, kept on each invoice.
INVOICE_RULES_VERSION = "invoice-v1"

SupplyType = Literal["intra", "inter"]
PosBasis = Literal["delivery_location", "buyer_gstin", "seller_state", "chosen"]

INVOICE_STATUSES: tuple[str, ...] = ("draft", "issued", "cancelled")
SUPPLY_TYPES: tuple[str, ...] = ("intra", "inter")
POS_BASES: tuple[str, ...] = ("delivery_location", "buyer_gstin", "seller_state", "chosen")

#: The GST state codes, as the portal names them. 25 merged into 26 in 2020 and
#: 28 is Andhra Pradesh's code before 2014: neither can be a place of supply.
GST_STATES: Mapping[str, str] = {
    "01": "Jammu and Kashmir",
    "02": "Himachal Pradesh",
    "03": "Punjab",
    "04": "Chandigarh",
    "05": "Uttarakhand",
    "06": "Haryana",
    "07": "Delhi",
    "08": "Rajasthan",
    "09": "Uttar Pradesh",
    "10": "Bihar",
    "11": "Sikkim",
    "12": "Arunachal Pradesh",
    "13": "Nagaland",
    "14": "Manipur",
    "15": "Mizoram",
    "16": "Tripura",
    "17": "Meghalaya",
    "18": "Assam",
    "19": "West Bengal",
    "20": "Jharkhand",
    "21": "Odisha",
    "22": "Chhattisgarh",
    "23": "Madhya Pradesh",
    "24": "Gujarat",
    "26": "Dadra and Nagar Haveli and Daman and Diu",
    "27": "Maharashtra",
    "29": "Karnataka",
    "30": "Goa",
    "31": "Lakshadweep",
    "32": "Kerala",
    "33": "Tamil Nadu",
    "34": "Puducherry",
    "35": "Andaman and Nicobar Islands",
    "36": "Telangana",
    "37": "Andhra Pradesh",
    "38": "Ladakh",
    "97": "Other Territory",
}

_GSTIN = re.compile(r"^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$")
_HALF = Decimal("0.5")


def _m(value: Decimal) -> str:
    return to_fixed(value, 2)


# ----------------------------------------------------------------- parties


def state_of_gstin(gstin: str | None) -> str | None:
    """The state a GSTIN is registered in: its first two digits. None for anything that is not a GSTIN."""
    value = (gstin or "").strip().upper()
    return value[:2] if _GSTIN.match(value) else None


def invoice_kind(buyer_gstin: str | None) -> str:
    """B2B when the buyer has a GSTIN, B2C otherwise."""
    return "b2b" if state_of_gstin(buyer_gstin) else "b2c"


def supply_type(seller_state: str, place_of_supply: str) -> SupplyType:
    """Inter-state exactly when the place of supply is not the seller's own state."""
    return "intra" if seller_state == place_of_supply else "inter"


@dataclass(frozen=True)
class PlaceOfSupply:
    state_code: str
    basis: PosBasis

    def wire(self) -> dict[str, str]:
        return {"stateCode": self.state_code, "basis": self.basis}


@dataclass(frozen=True)
class PlacesDiffer:
    """Lines delivered to two states are two invoices: one invoice has one place of supply."""

    states: tuple[str, ...]

    def wire(self) -> dict[str, Any]:
        return {"problem": "places-differ", "states": list(self.states)}


def place_of_supply(
    delivery_states: Iterable[str | None], buyer_gstin: str | None, seller_state: str
) -> PlaceOfSupply | PlacesDiffer:
    """Where the goods went decides it, not where the buyer is registered; a line
    whose location has no state yet goes with the others."""
    known = sorted({s for s in delivery_states if s})
    if len(known) > 1:
        return PlacesDiffer(tuple(known))
    if len(known) == 1:
        return PlaceOfSupply(known[0], "delivery_location")
    registered = state_of_gstin(buyer_gstin)
    if registered:
        return PlaceOfSupply(registered, "buyer_gstin")
    return PlaceOfSupply(seller_state, "seller_state")


# -------------------------------------------------------------------- sums


@dataclass(frozen=True)
class InvoiceLineInput:
    id: str
    quantity: Num
    rate: Num
    gst_rate_pct: Num
    #: The workbook's AR: inside the taxable value, at the line's own rate.
    transport: Num = None
    hsn_code: str | None = None


@dataclass(frozen=True)
class LineFigures:
    amount: Decimal
    transport: Decimal
    taxable: Decimal
    gst_rate_pct: Decimal
    cgst_pct: Decimal
    sgst_pct: Decimal
    igst_pct: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    total: Decimal

    def wire(self) -> dict[str, Any]:
        return {
            "amount": _m(self.amount),
            "transport": _m(self.transport),
            "taxable": _m(self.taxable),
            "gstRatePct": to_number(self.gst_rate_pct),
            "cgstPct": to_number(self.cgst_pct),
            "sgstPct": to_number(self.sgst_pct),
            "igstPct": to_number(self.igst_pct),
            "cgst": _m(self.cgst),
            "sgst": _m(self.sgst),
            "igst": _m(self.igst),
            "total": _m(self.total),
        }


@dataclass(frozen=True)
class TaxRow:
    """The tax by HSN and rate, as printed under the lines."""

    hsn_code: str | None
    gst_rate_pct: Decimal
    taxable: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal

    @property
    def tax(self) -> Decimal:
        return add(add(self.cgst, self.sgst), self.igst)

    def wire(self) -> dict[str, Any]:
        return {
            "hsnCode": self.hsn_code,
            "gstRatePct": to_number(self.gst_rate_pct),
            "taxable": _m(self.taxable),
            "cgst": _m(self.cgst),
            "sgst": _m(self.sgst),
            "igst": _m(self.igst),
            "tax": _m(self.tax),
        }


@dataclass(frozen=True)
class InvoiceFigures:
    supply: SupplyType
    lines: dict[str, LineFigures]
    taxable: Decimal
    cgst: Decimal
    sgst: Decimal
    igst: Decimal
    before_rounding: Decimal
    round_off: Decimal
    total: Decimal
    words: str
    by_hsn: tuple[TaxRow, ...]

    @property
    def tax(self) -> Decimal:
        return add(add(self.cgst, self.sgst), self.igst)

    def wire(self) -> dict[str, Any]:
        return {
            "supply": self.supply,
            "lines": {k: v.wire() for k, v in self.lines.items()},
            "taxable": _m(self.taxable),
            "cgst": _m(self.cgst),
            "sgst": _m(self.sgst),
            "igst": _m(self.igst),
            "tax": _m(self.tax),
            "beforeRounding": _m(self.before_rounding),
            "roundOff": _m(self.round_off),
            "total": _m(self.total),
            "words": self.words,
            "byHsn": [r.wire() for r in self.by_hsn],
        }


def line_figures(line: InvoiceLineInput, supply: SupplyType) -> LineFigures:
    """AO × AQ + AR, then the tax the supply type calls for, each rounded to the paisa once."""
    amount = round_to(mul(dec(line.quantity), dec(line.rate)), 2)
    transport = round_to(dec(line.transport), 2)
    taxable = add(amount, transport)
    rate = dec(line.gst_rate_pct)
    half = mul(rate, _HALF)
    intra = supply == "intra"
    cgst = percent_of(taxable, half) if intra else ZERO
    sgst = percent_of(taxable, half) if intra else ZERO
    igst = ZERO if intra else percent_of(taxable, rate)
    return LineFigures(
        amount=amount,
        transport=transport,
        taxable=taxable,
        gst_rate_pct=rate,
        cgst_pct=half if intra else ZERO,
        sgst_pct=half if intra else ZERO,
        igst_pct=ZERO if intra else rate,
        cgst=cgst,
        sgst=sgst,
        igst=igst,
        total=add(add(taxable, cgst), add(sgst, igst)),
    )


def round_to_rupee(amount: Decimal) -> tuple[Decimal, Decimal]:
    """(the total to the rupee, half away from zero; what that added), the round-off within ±50 paise."""
    before = round_to(amount, 2)
    total = round_to(before, 0)
    return round_to(total, 2), round_to(sub(total, before), 2)


def invoice_figures(lines: Sequence[InvoiceLineInput], supply: SupplyType) -> InvoiceFigures:
    figures: dict[str, LineFigures] = {}
    rows: dict[tuple[str, str], list[Any]] = {}
    for line in lines:
        f = line_figures(line, supply)
        figures[line.id] = f
        hsn = line.hsn_code or None
        rate = dec(line.gst_rate_pct)
        row = rows.setdefault((hsn or "", to_fixed(rate, 2)), [hsn, rate, ZERO, ZERO, ZERO, ZERO])
        row[2], row[3] = add(row[2], f.taxable), add(row[3], f.cgst)
        row[4], row[5] = add(row[4], f.sgst), add(row[5], f.igst)
    taxable = dsum(f.taxable for f in figures.values())
    cgst = dsum(f.cgst for f in figures.values())
    sgst = dsum(f.sgst for f in figures.values())
    igst = dsum(f.igst for f in figures.values())
    before = add(add(taxable, add(cgst, sgst)), igst)
    total, round_off = round_to_rupee(before)
    by_hsn = tuple(
        TaxRow(hsn, rate, t, c, s, i)
        for hsn, rate, t, c, s, i in sorted(rows.values(), key=lambda r: (r[0] or "", r[1]))
    )
    return InvoiceFigures(
        supply=supply,
        lines=figures,
        taxable=taxable,
        cgst=cgst,
        sgst=sgst,
        igst=igst,
        before_rounding=round_to(before, 2),
        round_off=round_off,
        total=total,
        words=amount_in_words(total),
        by_hsn=by_hsn,
    )


# ---------------------------------------------------------------- in words

_ONES = (
    *("Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"),
    *("Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"),
)
_TENS = ("", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety")


def _below_100(n: int) -> str:
    if n < 20:
        return _ONES[n]
    tens, ones = divmod(n, 10)
    return f"{_TENS[tens]} {_ONES[ones]}" if ones else _TENS[tens]


def _below_1000(n: int) -> str:
    hundreds, rest = divmod(n, 100)
    parts = [f"{_ONES[hundreds]} Hundred" if hundreds else "", _below_100(rest) if rest else ""]
    return " ".join(p for p in parts if p)


def _indian(n: int) -> str:
    """Crore, lakh, thousand, hundred; a count of crores is itself said the same way."""
    if n == 0:
        return _ONES[0]
    crore, rest = divmod(n, 10_000_000)
    lakh, rest = divmod(rest, 100_000)
    thousand, hundreds = divmod(rest, 1_000)
    parts = []
    if crore:
        parts.append(f"{_indian(crore)} Crore")
    if lakh:
        parts.append(f"{_below_100(lakh)} Lakh")
    if thousand:
        parts.append(f"{_below_100(thousand)} Thousand")
    if hundreds:
        parts.append(_below_1000(hundreds))
    return " ".join(parts)


def amount_in_words(amount: Num) -> str:
    """'Rupees One Lakh Twenty Three Thousand Four Hundred Fifty Six Only'.

    The amount in words is part of the invoice itself, said in English as
    invoices in this trade are, whatever language the clerk reads; the
    TypeScript's amountInWords is the same sentence.
    """
    paise = int(round_to(dec(amount), 2).scaleb(2))
    negative = paise < 0
    rupees, rest = divmod(abs(paise), 100)
    words = f"Rupees {_indian(rupees)}{f' and {_below_100(rest)} Paise' if rest else ''} Only"
    return f"Minus {words}" if negative else words


# ----------------------------------------------------------------- numbers

#: Rule 46(b): at most 16 characters, letters, digits, hyphen and slash only.
INVOICE_NUMBER_SHAPE = "^[A-Za-z0-9/-]{1,16}$"
#: A series' prefix: up to four capitals or digits, so PREFIX/26-27/99999 still fits in 16.
INVOICE_PREFIX_SHAPE = "^[A-Z0-9]{1,4}$"
_NUMBER = re.compile(INVOICE_NUMBER_SHAPE)


def invoice_number(prefix: str, financial_year: str, serial: int) -> str:
    """'INV/26-27/0007': the prefix, the financial year, the serial to four places at least."""
    return f"{prefix}/{financial_year}/{serial:04d}"


def is_invoice_number(value: str) -> bool:
    return bool(_NUMBER.match(value))


# ---------------------------------------------------------- money received


@dataclass(frozen=True)
class ReceiptCandidate:
    """A customer's payment that could be matched, and what of it no invoice has taken yet."""

    payment_id: str
    #: On one of the invoice's own trips (True), or on one of their sheets (False).
    on_trip: bool
    #: YYYY-MM-DD.
    paid_on: str
    free: Num


@dataclass(frozen=True)
class ReceiptMatch:
    payment_id: str
    amount: Decimal

    def wire(self) -> dict[str, str]:
        return {"paymentId": self.payment_id, "amount": _m(self.amount)}


def match_receipts(due: Num, candidates: Iterable[ReceiptCandidate]) -> list[ReceiptMatch]:
    """matchReceipts: the trips' own payments first, then the sheets', each oldest first
    (then by id), each up to what of it is free, never past what is due."""
    left = round_to(dec(due), 2)
    out: list[ReceiptMatch] = []
    for c in sorted(candidates, key=lambda c: (not c.on_trip, c.paid_on, c.payment_id)):
        if left <= 0:
            break
        free = round_to(dec(c.free), 2)
        if free <= 0:
            continue
        take = free if free < left else left
        out.append(ReceiptMatch(c.payment_id, take))
        left = sub(left, take)
    return out


def invoice_due(total: Num, received: Num) -> Decimal:
    """What an issued invoice still has due, never below nothing."""
    due = sub(dec(total), dec(received))
    return round_to(due if due > 0 else ZERO, 2)


def money_status(total: Num, received: Num) -> str:
    if dec(received) >= dec(total):
        return "paid"
    return "part_paid" if dec(received) > 0 else "due"


def line_from_wire(w: Mapping[str, Any]) -> InvoiceLineInput:
    """A fixture line, as the TypeScript reads it."""
    return InvoiceLineInput(
        id=w["id"],
        quantity=w.get("quantity"),
        rate=w.get("rate"),
        gst_rate_pct=w.get("gstRatePct"),
        transport=w.get("transport"),
        hsn_code=w.get("hsnCode"),
    )

"""The party invoice rules, over the golden figures the TypeScript is tested on.

packages/domain/src/party-invoice.fixtures.json holds invoices and the figures
they must produce, worked by hand. packages/domain/src/party-invoice.test.ts
runs the TypeScript over it and this file runs app/domain/party_invoice.py over
it, each comparing the wire shape (money as two-place strings, rates as JSON
numbers) exactly. A rule changed on one side only fails one of the two.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.domain import vehicle_pl as pl
from app.domain.party_invoice import (
    GST_STATES,
    PlaceOfSupply,
    ReceiptCandidate,
    amount_in_words,
    invoice_due,
    invoice_figures,
    invoice_kind,
    invoice_number,
    is_invoice_number,
    line_figures,
    line_from_wire,
    match_receipts,
    money_status,
    place_of_supply,
    round_to_rupee,
    state_of_gstin,
    supply_type,
)
from app.domain.vehicle_pl import dec, to_fixed

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "domain" / "src" / "party-invoice.fixtures.json"
DATA = json.loads(FIXTURES.read_text(encoding="utf-8"))


def test_the_fixtures_are_the_shared_ones() -> None:
    assert len(DATA["invoices"]) >= 6 and len(DATA["words"]) >= 15, "read the wrong file"


@pytest.mark.parametrize("case", DATA["invoices"], ids=lambda c: c["name"])
def test_golden_invoices(case: dict) -> None:  # type: ignore[type-arg]
    lines = [line_from_wire(x) for x in case["lines"]]
    assert invoice_figures(lines, case["supply"]).wire() == case["expect"]


def test_a_total_rounds_to_the_rupee_half_away_from_zero() -> None:
    for c in DATA["rounding"]:
        total, round_off = round_to_rupee(dec(c["amount"]))
        assert {"total": to_fixed(total), "roundOff": to_fixed(round_off)} == c["expect"], c


def test_an_amount_in_words_the_indian_way() -> None:
    for c in DATA["words"]:
        assert amount_in_words(c["amount"]) == c["expect"], c


@pytest.mark.parametrize("case", DATA["placeOfSupply"], ids=lambda c: c["name"])
def test_place_of_supply(case: dict) -> None:  # type: ignore[type-arg]
    i = case["input"]
    pos = place_of_supply(i["deliveryStates"], i.get("buyerGstin"), i["sellerState"])
    assert pos.wire() == case["expect"]
    if isinstance(pos, PlaceOfSupply):
        assert supply_type(i["sellerState"], pos.state_code) == case["supply"]


def test_a_gstins_state_is_its_first_two_digits() -> None:
    for c in DATA["gstinStates"]:
        assert state_of_gstin(c["gstin"]) == c["expect"], c


def test_numbers_fit_rule_46() -> None:
    for c in DATA["numbers"]:
        n = invoice_number(c["prefix"], c["financialYear"], c["serial"])
        assert (n, is_invoice_number(n)) == (c["expect"], c["valid"]), c
    for c in DATA["invoiceNumberShapes"]:
        assert is_invoice_number(c["value"]) == c["valid"], c


@pytest.mark.parametrize("case", DATA["matching"], ids=lambda c: c["name"])
def test_money_received_is_matched(case: dict) -> None:  # type: ignore[type-arg]
    candidates = [
        ReceiptCandidate(c["paymentId"], c["onTrip"], c["paidOn"], c["free"]) for c in case["candidates"]
    ]
    assert [m.wire() for m in match_receipts(case["due"], candidates)] == case["expect"]


def test_what_an_invoice_has_received() -> None:
    for c in DATA["money"]:
        assert money_status(c["total"], c["received"]) == c["status"], c
        assert to_fixed(invoice_due(c["total"], c["received"])) == c["due"], c


# ------------------------------------------- the rules the TS tests also state


def test_the_invoice_bills_the_trips_own_taxable_value() -> None:
    line = line_from_wire(
        {"id": "l", "quantity": "6.5", "rate": "4200.00", "transport": "2500.00", "gstRatePct": "5"}
    )
    sale = pl.sale_figures(pl.Sale("s", "c", "6.5", "4200.00", True, "5", "2500.00"))
    billed = line_figures(line, "intra")
    assert (billed.amount, billed.taxable) == (sale.amount, sale.taxable)


def test_the_supply_type_only_splits_the_tax() -> None:
    line = line_from_wire(
        {"id": "l", "quantity": "6.5", "rate": "4200.00", "transport": "2500", "gstRatePct": 5}
    )
    intra, inter = line_figures(line, "intra"), line_figures(line, "inter")
    assert intra.cgst == intra.sgst and intra.igst == 0
    assert inter.cgst == 0 and to_fixed(inter.igst) == "1490.00"
    assert intra.total == inter.total
    assert (supply_type("33", "33"), supply_type("33", "29")) == ("intra", "inter")


def test_b2b_exactly_when_the_buyer_has_a_gstin() -> None:
    assert (invoice_kind("33AABCU9603R1ZU"), invoice_kind(None), invoice_kind("")) == ("b2b", "b2c", "b2c")


def test_the_round_off_is_never_more_than_half_a_rupee() -> None:
    for paise in range(100):
        before = Decimal(f"1234.{paise:02d}")
        total, round_off = round_to_rupee(before)
        assert total == total.to_integral_value() and abs(round_off) <= Decimal("0.50")
        assert total - round_off == before


def test_tamil_nadu_is_33_and_retired_codes_are_left_out() -> None:
    assert GST_STATES["33"] == "Tamil Nadu" and "25" not in GST_STATES and "28" not in GST_STATES

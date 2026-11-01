"""The vehicle P&L rules, over the golden figures the TypeScript is tested on.

packages/domain/src/vehicle-pl.fixtures.json holds trip sheets and the figures
they must produce, worked by hand from the owner's workbook.
packages/domain/src/vehicle-pl.test.ts runs the TypeScript over it and this
file runs app/domain/vehicle_pl.py over it, each comparing the wire shape
(money as two-place strings, km and litres as JSON numbers) exactly. A rule
changed on one side only fails one of the two.

The fixtures are read with the stock JSON parser on purpose: a quantity
arrives at the API as a JSON number, so it is read here the same way.
"""

from __future__ import annotations

import json
from dataclasses import replace
from decimal import Decimal
from pathlib import Path

import pytest

from app.domain.vehicle_pl import (
    KnownDieselBill,
    OtherSheetDiesel,
    Payment,
    allocate,
    calculate_sheet,
    calculate_sheets,
    dec,
    div_to,
    find_double_counts,
    outstanding,
    parse_dec,
    percent_of,
    pl_by_month,
    pl_by_vehicle,
    pl_units,
    round_to,
    settle_sheet_payments,
    sheet_from_wire,
    spread_sheet_costs,
    sub,
    to_fixed,
    total_pl,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "domain" / "src" / "vehicle-pl.fixtures.json"
DATA = json.loads(FIXTURES.read_text(encoding="utf-8"))
SHEETS = {s["id"]: sheet_from_wire(s) for s in DATA["sheets"]}


def test_the_fixtures_are_the_shared_ones() -> None:
    assert len(DATA["cases"]) >= 6 and sum(len(s.trips) for s in SHEETS.values()) >= 11, "read the wrong file"


@pytest.mark.parametrize("case", DATA["cases"], ids=lambda c: c["name"])
def test_golden_sheets(case: dict) -> None:  # type: ignore[type-arg]
    assert calculate_sheet(SHEETS[case["sheet"]]).wire() == case["expect"]


@pytest.mark.parametrize("case", DATA["spread"], ids=lambda c: c["name"])
def test_a_sheets_costs_are_shared_out(case: dict) -> None:  # type: ignore[type-arg]
    spread = spread_sheet_costs(SHEETS[case["sheet"]])
    assert (None if spread is None else spread.wire()) == case["expect"]


def test_reports_add_trips_up() -> None:
    sheets = [SHEETS[i] for i in DATA["reports"]["sheets"]]
    units = pl_units(sheets, calculate_sheets(sheets))
    expected = DATA["reports"]["expect"]
    assert total_pl(units).wire() == expected["total"]
    assert [{"vehicleId": v, **t.wire()} for v, t in pl_by_vehicle(units)] == expected["byVehicle"]
    assert [{"month": m, **t.wire()} for m, t in pl_by_month(units)] == expected["byMonth"]
    assert [r.wire() for r in outstanding(units, "customer")] == expected["customers"]
    assert [r.wire() for r in outstanding(units, "vendor")] == expected["vendors"]


@pytest.mark.parametrize("case", DATA["doubleCounts"], ids=lambda c: c["name"])
def test_double_counting(case: dict) -> None:  # type: ignore[type-arg]
    bills = [KnownDieselBill(b["id"], b["billNumber"], b["vehicleId"]) for b in case["context"]["bills"]]
    others = [
        OtherSheetDiesel(o["sheetId"], o["sheetNumber"], o["vehicleId"], tuple(o["billNumbers"]))
        for o in case["context"]["otherSheets"]
    ]
    assert find_double_counts(sheet_from_wire(case["sheet"]), bills, others) == case["expect"]


def test_a_split_adds_up_exactly() -> None:
    for c in DATA["allocate"]:
        parts = allocate(dec(c["total"]), [dec(w) for w in c["weights"]], c["places"])
        assert [to_fixed(p, c["places"]) for p in parts] == c["expect"], c


def test_rounding_and_division_are_half_away_from_zero() -> None:
    for c in DATA["decimal"]["roundTo"]:
        assert to_fixed(round_to(dec(c["value"]), c["places"]), c["places"]) == c["expect"], c
    for c in DATA["decimal"]["divTo"]:
        assert to_fixed(div_to(dec(c["a"]), dec(c["b"]), c["places"]), c["places"]) == c["expect"], c
    for c in DATA["decimal"]["percentOf"]:
        assert to_fixed(percent_of(dec(c["value"]), dec(c["pct"])), 2) == c["expect"], c


# ------------------------------------------- the rules the TS tests also state


def test_profit_is_without_gst_not_the_workbooks_literal_wording() -> None:
    """The workbook's BI reads "Total Selling Price − Total Purchase cost − Total
    Enroute Expenses", and its Total Selling Price (AX) includes GST. GST is
    never profit (LIN-22), so the rule takes AV − AB − BH. Should the owner
    overrule it, `profit` is the one function to change on each side."""
    calc = calculate_sheet(SHEETS["s1"]).trips["t1"]
    sale, purchase = calc.sales["t1-s1"], calc.purchases["t1-p1"]
    assert (to_fixed(sale.taxable), to_fixed(sale.total), to_fixed(purchase.amount)) == (
        "18600.00",
        "19530.00",
        "10800.00",
    )
    assert to_fixed(calc.pl.total_en_route) == "3800.00"
    assert to_fixed(calc.pl.net) == "4000.00"  # AV − AB − BH
    assert (
        to_fixed(sub(sub(sale.total, purchase.amount), calc.pl.total_en_route)) == "4930.00"
    )  # AX − AB − BH
    assert to_fixed(calc.pl.gst_to_pay) == "390.00"


def test_gst_is_never_profit() -> None:
    s1 = SHEETS["s1"]
    t1 = s1.trips[0]
    taxed = replace(
        s1,
        trips=(
            replace(
                t1,
                sales=tuple(replace(s, gst_rate_pct=28) for s in t1.sales),
                purchases=tuple(replace(p, gst_rate_pct=28) for p in t1.purchases),
            ),
        ),
    )
    base, higher = calculate_sheet(s1).pl, calculate_sheet(taxed).pl
    assert (higher.net, higher.sales, higher.material_cost) == (base.net, base.sales, base.material_cost)
    assert higher.output_gst != base.output_gst


def test_a_sheets_trips_add_up_to_it_exactly() -> None:
    for sheet_id in ("s2", "s3", "s6"):
        calc = calculate_sheet(SHEETS[sheet_id])
        for attr in ("diesel", "batta", "en_route", "net", "sales"):
            parts = sum((getattr(t.pl, attr) for t in calc.trips.values()), Decimal(0))
            assert parts == getattr(calc.pl, attr), (sheet_id, attr)


def test_sheet_payments_settle_the_oldest_trip_first_and_keep_the_rest() -> None:
    taken, left = settle_sheet_payments(
        [Payment("m", "in", "c", "1000")],
        [
            ("a", [("c", "customer", Decimal("600"), Decimal("100"))]),
            ("b", [("c", "customer", Decimal("300"), Decimal("0"))]),
            ("c", [("c", "vendor", Decimal("300"), Decimal("0"))]),
        ],
    )
    assert taken == {"a": {"customer:c": Decimal("500.00")}, "b": {"customer:c": Decimal("300.00")}, "c": {}}
    assert left == {"customer:c": Decimal("200.00")}


def test_a_closure_holds_only_while_the_trip_is_billed_as_it_was() -> None:
    s2 = SHEETS["s2"]
    assert calculate_sheet(s2).trips["t2a"].dues[0].status == "closed"
    rebilled = replace(
        s2,
        trips=tuple(
            replace(t, sales=tuple(replace(s, quantity="4.9") for s in t.sales)) if t.id == "t2a" else t
            for t in s2.trips
        ),
    )
    due = calculate_sheet(rebilled).trips["t2a"].dues[0]
    assert (to_fixed(due.billed), due.status) == ("15435.00", "paid")


def test_reads_only_what_is_a_number() -> None:
    for text in ("12,500", "1e5", "NaN", "Infinity", "", "abc"):
        assert parse_dec(text) is None, text
    assert parse_dec(float("nan")) is None
    assert to_fixed(parse_dec(120.455), 3) == "120.455"  # type: ignore[arg-type]
    assert to_fixed(parse_dec(".5"), 2) == "0.50"  # type: ignore[arg-type]
    assert to_fixed(parse_dec(1e-7), 7) == "0.0000001"  # type: ignore[arg-type]
    assert to_fixed(round_to(Decimal("-0.004"), 2)) == "0.00"

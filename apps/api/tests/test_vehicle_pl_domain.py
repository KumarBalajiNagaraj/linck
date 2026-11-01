"""The vehicle P&L rules, over the golden figures the TypeScript is tested on.

packages/domain/src/vehicle-pl.fixtures.json holds trips and the figures they
must produce, worked by hand. packages/domain/src/vehicle-pl.test.ts runs the
TypeScript over it and this file runs app/domain/vehicle_pl.py over it, each
comparing the wire shape (money as two-place strings, km and litres as JSON
numbers) exactly. A rule changed on one side only fails one of the two.

The fixtures are read with the stock JSON parser on purpose: a quantity
arrives at the API as a JSON number, so it is read here the same way.
"""

from __future__ import annotations

import json
from decimal import Decimal
from pathlib import Path

import pytest

from app.domain.vehicle_pl import (
    KnownDieselBill,
    OtherTripDiesel,
    allocate,
    calculate_trip,
    calculate_trips,
    dec,
    div_to,
    find_double_counts,
    outstanding,
    parse_dec,
    percent_of,
    pl_by_month,
    pl_by_vehicle,
    round_to,
    sum_pl,
    to_fixed,
    trip_from_wire,
)

FIXTURES = Path(__file__).resolve().parents[3] / "packages" / "domain" / "src" / "vehicle-pl.fixtures.json"
DATA = json.loads(FIXTURES.read_text(encoding="utf-8"))
TRIPS = {t["id"]: trip_from_wire(t) for t in DATA["trips"]}


def test_the_fixtures_are_the_shared_ones() -> None:
    assert len(DATA["cases"]) >= 8 and len(TRIPS) >= 12, "read the wrong fixture file"


@pytest.mark.parametrize("case", DATA["cases"], ids=lambda c: c["name"])
def test_golden_trips(case: dict) -> None:  # type: ignore[type-arg]
    calcs = calculate_trips([TRIPS[i] for i in case["trips"]])
    for trip_id, expected in case["expect"].items():
        calc = calcs[trip_id]
        assert {k: v.wire() for k, v in calc.purchases.items()} == expected["purchases"]
        assert {k: v.wire() for k, v in calc.sales.items()} == expected["sales"]
        assert {k: v.wire() for k, v in calc.diesel.items()} == expected["diesel"]
        assert calc.pl.wire() == expected["pl"]
        assert [d.wire() for d in calc.dues] == expected["dues"]


def test_reports_add_trips_up() -> None:
    trips = [TRIPS[i] for i in DATA["reports"]["trips"]]
    calcs = calculate_trips(trips)
    expected = DATA["reports"]["expect"]
    assert sum_pl([c.pl for c in calcs.values()]).wire() == expected["total"]
    assert [{"vehicleId": v, **t.wire()} for v, t in pl_by_vehicle(trips, calcs)] == expected["byVehicle"]
    assert [{"month": m, **t.wire()} for m, t in pl_by_month(trips, calcs)] == expected["byMonth"]
    assert [r.wire() for r in outstanding(trips, calcs, "customer")] == expected["customers"]
    assert [r.wire() for r in outstanding(trips, calcs, "vendor")] == expected["vendors"]


@pytest.mark.parametrize("case", DATA["doubleCounts"], ids=lambda c: c["name"])
def test_double_counting(case: dict) -> None:  # type: ignore[type-arg]
    bills = [KnownDieselBill(b["id"], b["billNumber"], b["vehicleId"]) for b in case["context"]["bills"]]
    others = [
        OtherTripDiesel(o["tripId"], o["tripNumber"], o["vehicleId"], tuple(o["billNumbers"]))
        for o in case["context"]["otherTrips"]
    ]
    assert find_double_counts(trip_from_wire(case["trip"]), bills, others) == case["expect"]


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


def test_gst_is_never_profit() -> None:
    from dataclasses import replace

    t1 = TRIPS["t1"]
    taxed = replace(
        t1,
        sales=tuple(replace(s, gst_rate_pct=28, transport_gst_rate_pct=28) for s in t1.sales),
        purchases=tuple(replace(p, gst_rate_pct=28) for p in t1.purchases),
    )
    base, higher = calculate_trip(t1).pl, calculate_trip(taxed).pl
    assert (higher.net, higher.sales, higher.material_cost) == (base.net, base.sales, base.material_cost)
    assert higher.output_gst != base.output_gst


def test_a_trip_alone_counts_a_linked_fill_in_full_and_with_its_day_only_its_part() -> None:
    assert to_fixed(calculate_trip(TRIPS["t3b"]).pl.diesel) == "3833.20"
    day = calculate_trips([TRIPS["t3a"], TRIPS["t3b"], TRIPS["t3c"]])
    assert to_fixed(day["t3b"].pl.diesel) == "1574.95"
    assert sum((c.pl.diesel for c in day.values()), Decimal(0)) == Decimal("3833.20")


def test_reads_only_what_is_a_number() -> None:
    for text in ("12,500", "1e5", "NaN", "Infinity", "", "abc"):
        assert parse_dec(text) is None, text
    assert parse_dec(float("nan")) is None
    assert to_fixed(parse_dec(120.455), 3) == "120.455"  # type: ignore[arg-type]
    assert to_fixed(parse_dec(".5"), 2) == "0.50"  # type: ignore[arg-type]
    assert to_fixed(parse_dec(1e-7), 7) == "0.0000001"  # type: ignore[arg-type]
    assert to_fixed(round_to(Decimal("-0.004"), 2)) == "0.00"

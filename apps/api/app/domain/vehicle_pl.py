"""VEHICLE P&L (LIN-22), as the owner's workbook lays it out, worked out where it is stored.

A port of packages/domain/src/vehicle-pl.ts (and the exact decimal helpers in
packages/domain/src/decimal.ts), kept close enough to read side by side. Both
run over packages/domain/src/vehicle-pl.fixtures.json, the golden figures
worked by hand (tests/test_vehicle_pl_domain.py), so a rule changed on one side
only fails a suite. The screens use the TypeScript to follow the form as it is
typed; this copy decides what the API stores and reports.

A trip sheet is one vehicle and driver from a start date to an end date; its
trips are the loads it carried, each with its purchases and sales. Diesel, km
readings, batta, en-route expenses and payments may sit on either level. The
workbook's columns:

    L   distance        = K end km − J start km
    O   diesel cost     = M litres × N rate
    P   mileage         = L ÷ M
    AB  purchase cost   = Y quantity × AA rate
    AF  purchase GST    = AB × AE% (nothing on a non-GST bill);  AG = AB + AF  (= BD)
    AV  selling price   = AO quantity × AQ rate + AR transport (inside the taxable price)
    AW  sale GST        = AV × AU% (nothing on a non-GST bill);  AX = AV + AW
    BB  customer due    = AX − BA;   BF vendor due = BD − BE
    BH  en-route total  = Σ en-route expenses + O diesel + F batta
    BI  profit          = AV − AB − BH (see `profit`); gross = AV − AB;
                          profit % = BI ÷ AV; GST to pay = AW − AF, on its own line

What sits on the sheet is shared out to its trips by `spread_sheet_costs`, by
trip km when every trip has a reading, otherwise evenly; a payment on the sheet
settles that party's trips oldest first (`settle_sheet_payments`).

Every figure is rounded once, half away from zero (ROUND_HALF_UP, which is what
the TypeScript's BigInt rounding does): money to the paisa, litres to the
millilitre, km to a tenth. Division and splitting are done on integers, so
nothing is rounded twice and a sheet's trips add up to it exactly.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Any, Literal

#: The rules' version, kept on each trip sheet.
PL_RULES_VERSION = "sheet-v1"

DieselSource = Literal["typed", "expense_bill", "fuel_entry"]
PartyRole = Literal["customer", "vendor"]

DIESEL_SOURCES: tuple[str, ...] = ("typed", "expense_bill", "fuel_entry")
#: The workbook's en-route list (column G) and its minor-maintenance sub-list.
EN_ROUTE_KINDS: tuple[str, ...] = ("toll", "police", "maintenance")
MAINTENANCE_KINDS: tuple[str, ...] = (
    "tyre_rotation",
    "wheel_alignment",
    "greasing",
    "engine_oil",
    "coolant",
    "misc",
)

#: Wide enough that adding and multiplying any two stored figures is exact.
_CTX = Context(prec=80, rounding=ROUND_HALF_UP)
_PLAIN = re.compile(r"^([+-]?)(\d+)(?:\.(\d*))?$|^([+-]?)\.(\d+)$")
ZERO = Decimal(0)

Num = Decimal | int | float | str | None


# ---------------------------------------------------------------- decimals


def parse_dec(value: Num) -> Decimal | None:
    """parseDec: a decimal from a string or a JSON number, or None — never a guess.

    A float is read as the shortest decimal that prints back to it, which is
    what JavaScript's String(n) gives, so 120.455 is 120.455 on both sides.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if value != value or abs(value) >= 1e21:
            return None
        text = repr(value)
        if "e" in text or "E" in text:
            text = f"{value:.20f}"
    else:
        text = value.strip()
    if not _PLAIN.match(text):
        return None
    return Decimal(text)


def dec(value: Num) -> Decimal:
    """A figure, or zero when it is empty or unreadable: a line not yet filled in counts nothing."""
    parsed = parse_dec(value)
    return ZERO if parsed is None else parsed


def _units(value: Decimal) -> tuple[int, int]:
    """(integer units, scale) with value = units / 10**scale."""
    sign, digits, exponent = value.as_tuple()
    assert isinstance(exponent, int)
    units = int("".join(map(str, digits)) or "0")
    if sign:
        units = -units
    if exponent >= 0:
        return units * 10**exponent, 0
    return units, -exponent


def _from_units(units: int, scale: int) -> Decimal:
    return Decimal(units).scaleb(-scale, context=_CTX)


def add(a: Decimal, b: Decimal) -> Decimal:
    return _CTX.add(a, b)


def sub(a: Decimal, b: Decimal) -> Decimal:
    return _CTX.subtract(a, b)


def mul(a: Decimal, b: Decimal) -> Decimal:
    return _CTX.multiply(a, b)


def dsum(values: Iterable[Decimal]) -> Decimal:
    total = ZERO
    for v in values:
        total = add(total, v)
    return total


def round_to(value: Decimal, places: int) -> Decimal:
    """`value` to `places` decimals, half away from zero; never a negative zero."""
    rounded = value.quantize(Decimal(1).scaleb(-places), rounding=ROUND_HALF_UP, context=_CTX)
    return rounded.copy_abs() if rounded.is_zero() else rounded


def percent_of(value: Decimal, pct: Decimal, places: int = 2) -> Decimal:
    """value × pct / 100, rounded once: GST on a value."""
    return round_to(mul(value, pct).scaleb(-2, context=_CTX), places)


def div_to(a: Decimal, b: Decimal, places: int) -> Decimal:
    """a / b to `places`, half away from zero, on integers so nothing is rounded twice."""
    au, ascale = _units(a)
    bu, bscale = _units(b)
    if bu == 0:
        raise ZeroDivisionError("division by zero")
    n = au * 10 ** (bscale + places)
    d = bu * 10**ascale
    q, r = divmod(abs(n), abs(d))
    if 2 * r >= abs(d):
        q += 1
    if (n < 0) != (d < 0):
        q = -q
    return round_to(_from_units(q, places), places)


def to_fixed(value: Decimal, places: int = 2) -> str:
    """'7362.48': exactly `places` decimals, never an exponent or a negative zero."""
    return format(round_to(value, places), "f")


def to_number(value: Decimal) -> int | float:
    """A quantity as the JSON number the screens read: 86, 120.5, -12.35."""
    normal = value.normalize(context=_CTX)
    if normal.is_zero():
        return 0
    return int(normal) if normal == normal.to_integral_value() else float(format(normal, "f"))


def allocate(total: Decimal, weights: Sequence[Decimal], places: int) -> list[Decimal]:
    """allocate(): split `total` so the parts add up exactly, largest remainders first.

    Each part is floored and the units left over go one each to the parts with
    the largest remainders, the earlier part first on a tie. Negative weights
    count as zero; when every weight is zero the total is split equally.
    """
    if not weights:
        return []
    t, _ = _units(round_to(total, places).scaleb(places, context=_CTX))
    negative = t < 0
    whole = abs(t)
    pairs = [_units(w) for w in weights]
    scale = max(s for _, s in pairs)
    ws = [max(u * 10 ** (scale - s), 0) for u, s in pairs]
    sum_w = sum(ws)
    if sum_w == 0:
        ws = [1] * len(ws)
        sum_w = len(ws)
    floors = [whole * w // sum_w for w in ws]
    remainders = [whole * w % sum_w for w in ws]
    left = whole - sum(floors)
    for i in sorted(range(len(ws)), key=lambda i: (-remainders[i], i)):
        if left == 0:
            break
        floors[i] += 1
        left -= 1
    return [round_to(_from_units(-f if negative else f, places), places) for f in floors]


# ------------------------------------------------------------------ inputs


@dataclass(frozen=True)
class DieselLine:
    """Typed: M litres × N rate. Linked: an expense bill or fuel entry's own litres and amount."""

    id: str
    source: str
    litres: Num
    rate: Num = None
    amount: Num = None
    expense_bill_id: str | None = None
    fuel_entry_id: str | None = None
    bill_number: str | None = None
    #: A linked bill that was rejected or deleted: it counts nothing.
    void: bool = False


@dataclass(frozen=True)
class EnRoute:
    id: str
    kind: str
    amount: Num


@dataclass(frozen=True)
class Payment:
    id: str
    #: in: received from a customer (BA). out: paid to a vendor (BE).
    direction: str
    party_id: str | None
    amount: Num


@dataclass(frozen=True)
class Purchase:
    id: str
    vendor_id: str | None
    quantity: Num
    rate: Num
    gst_billed: bool
    gst_rate_pct: Num


@dataclass(frozen=True)
class Sale:
    id: str
    customer_id: str | None
    quantity: Num
    rate: Num
    gst_billed: bool
    gst_rate_pct: Num
    transport: Num = None


@dataclass(frozen=True)
class Closure:
    """Accounts confirmed by hand that a customer paid this trip in full, as billed then."""

    party_id: str
    billed: Num


@dataclass(frozen=True)
class Trip:
    id: str
    date: str
    purchases: tuple[Purchase, ...] = ()
    sales: tuple[Sale, ...] = ()
    trip_number: str | None = None
    start_km: Num = None
    end_km: Num = None
    batta: Num = None
    diesel: tuple[DieselLine, ...] = ()
    en_route: tuple[EnRoute, ...] = ()
    payments: tuple[Payment, ...] = ()
    closures: tuple[Closure, ...] = ()


@dataclass(frozen=True)
class Sheet:
    id: str
    vehicle_id: str
    start_date: str
    trips: tuple[Trip, ...] = ()
    sheet_number: str | None = None
    end_date: str | None = None
    start_km: Num = None
    end_km: Num = None
    batta: Num = None
    diesel: tuple[DieselLine, ...] = ()
    en_route: tuple[EnRoute, ...] = ()
    payments: tuple[Payment, ...] = ()


def _costs_from_wire(w: Mapping[str, Any]) -> dict[str, Any]:
    return {
        "start_km": w.get("startKm"),
        "end_km": w.get("endKm"),
        "batta": w.get("batta"),
        "diesel": tuple(
            DieselLine(
                id=d["id"],
                source=d["source"],
                litres=d.get("litres"),
                rate=d.get("rate"),
                amount=d.get("amount"),
                expense_bill_id=d.get("expenseBillId"),
                fuel_entry_id=d.get("fuelEntryId"),
                bill_number=d.get("billNumber"),
                void=bool(d.get("void", False)),
            )
            for d in w.get("diesel") or ()
        ),
        "en_route": tuple(EnRoute(e["id"], e["kind"], e.get("amount")) for e in w.get("enRoute") or ()),
        "payments": tuple(
            Payment(p["id"], p["direction"], p.get("partyId"), p.get("amount"))
            for p in w.get("payments") or ()
        ),
    }


def sheet_from_wire(s: Mapping[str, Any]) -> Sheet:
    """A sheet as the fixtures (and the TypeScript) write it, camelCase."""
    trips = tuple(
        Trip(
            id=t["id"],
            date=t["date"],
            trip_number=t.get("tripNumber"),
            purchases=tuple(
                Purchase(
                    p["id"],
                    p.get("vendorId"),
                    p.get("quantity"),
                    p.get("rate"),
                    p["gstBilled"],
                    p.get("gstRatePct"),
                )
                for p in t.get("purchases") or ()
            ),
            sales=tuple(
                Sale(
                    s_["id"],
                    s_.get("customerId"),
                    s_.get("quantity"),
                    s_.get("rate"),
                    s_["gstBilled"],
                    s_.get("gstRatePct"),
                    s_.get("transport"),
                )
                for s_ in t.get("sales") or ()
            ),
            closures=tuple(Closure(c["partyId"], c["billed"]) for c in t.get("closures") or ()),
            **_costs_from_wire(t),
        )
        for t in s.get("trips") or ()
    )
    return Sheet(
        id=s["id"],
        vehicle_id=s["vehicleId"],
        start_date=s["startDate"],
        end_date=s.get("endDate"),
        sheet_number=s.get("sheetNumber"),
        trips=trips,
        **_costs_from_wire(s),
    )


# ----------------------------------------------------------------- outputs


def _m(value: Decimal) -> str:
    return to_fixed(value, 2)


def _n(value: Decimal | None) -> int | float | None:
    return None if value is None else to_number(value)


@dataclass(frozen=True)
class PurchaseFigures:
    amount: Decimal  # AB: the cost the P&L counts
    gst_amount: Decimal  # AF: input credit
    total: Decimal  # AG = BD

    def wire(self) -> dict[str, str]:
        return {"amount": _m(self.amount), "gstAmount": _m(self.gst_amount), "total": _m(self.total)}


@dataclass(frozen=True)
class SaleFigures:
    amount: Decimal  # AO × AQ
    transport: Decimal  # AR
    taxable: Decimal  # AV: the P&L's income
    gst_amount: Decimal  # AW
    total: Decimal  # AX

    def wire(self) -> dict[str, str]:
        return {
            "amount": _m(self.amount),
            "transport": _m(self.transport),
            "taxable": _m(self.taxable),
            "gstAmount": _m(self.gst_amount),
            "total": _m(self.total),
        }


@dataclass(frozen=True)
class DieselFigures:
    litres: Decimal | None  # M
    rate: Decimal | None  # N
    amount: Decimal  # O
    counted: bool

    def wire(self) -> dict[str, Any]:
        return {
            "litres": _n(self.litres),
            "rate": None if self.rate is None else _m(self.rate),
            "amount": _m(self.amount),
            "counted": self.counted,
        }


@dataclass(frozen=True)
class LevelCosts:
    """What one level wrote down itself; also a trip's share of its sheet's."""

    distance_km: Decimal | None
    diesel_litres: Decimal
    diesel: Decimal
    batta: Decimal
    en_route: Decimal

    def wire(self) -> dict[str, Any]:
        return {
            "distanceKm": _n(self.distance_km),
            "dieselLitres": to_number(self.diesel_litres),
            "diesel": _m(self.diesel),
            "batta": _m(self.batta),
            "enRoute": _m(self.en_route),
        }


@dataclass(frozen=True)
class Spread:
    basis: str  # 'km' | 'even'
    shares: dict[str, LevelCosts]

    def wire(self) -> dict[str, Any]:
        return {"basis": self.basis, "shares": {k: v.wire() for k, v in self.shares.items()}}


_PL_MONEY = (
    ("sales", "sales"),
    ("material_cost", "materialCost"),
    ("gross", "gross"),
    ("diesel", "diesel"),
    ("batta", "batta"),
    ("en_route", "enRoute"),
    ("total_en_route", "totalEnRoute"),
    ("net", "net"),
    ("output_gst", "outputGst"),
    ("input_gst", "inputGst"),
    ("gst_to_pay", "gstToPay"),
    ("customer_billed", "customerBilled"),
    ("received", "received"),
    ("customer_due", "customerDue"),
    ("vendor_billed", "vendorBilled"),
    ("paid", "paid"),
    ("vendor_due", "vendorDue"),
)
#: The money figures of a P&L, as the wire names them.
MONEY_FIELDS: tuple[str, ...] = tuple(wire for _, wire in _PL_MONEY)


@dataclass(frozen=True)
class TripPl:
    distance_km: Decimal | None
    diesel_litres: Decimal
    mileage_kmpl: Decimal | None
    sales: Decimal  # Σ AV
    material_cost: Decimal  # Σ AB
    gross: Decimal
    diesel: Decimal
    batta: Decimal
    en_route: Decimal
    total_en_route: Decimal  # BH
    net: Decimal  # BI
    profit_pct: Decimal | None
    output_gst: Decimal  # Σ AW
    input_gst: Decimal  # Σ AF
    gst_to_pay: Decimal
    customer_billed: Decimal  # Σ AX
    received: Decimal  # BA
    customer_due: Decimal  # BB
    vendor_billed: Decimal  # BD
    paid: Decimal  # BE
    vendor_due: Decimal  # BF

    def wire(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "distanceKm": _n(self.distance_km),
            "dieselLitres": to_number(self.diesel_litres),
            "mileageKmpl": _n(self.mileage_kmpl),
            "profitPct": _n(self.profit_pct),
        }
        for attr, wire in _PL_MONEY:
            out[wire] = _m(getattr(self, attr))
        return out


@dataclass(frozen=True)
class PartyDue:
    party_id: str
    role: str
    billed: Decimal
    settled: Decimal
    due: Decimal
    status: str

    def wire(self) -> dict[str, str]:
        return {
            "partyId": self.party_id,
            "role": self.role,
            "billed": _m(self.billed),
            "settled": _m(self.settled),
            "due": _m(self.due),
            "status": self.status,
        }


@dataclass(frozen=True)
class TripCalc:
    trip_id: str
    pl: TripPl
    own: LevelCosts
    share: LevelCosts | None
    purchases: dict[str, PurchaseFigures]
    sales: dict[str, SaleFigures]
    diesel: dict[str, DieselFigures]
    dues: list[PartyDue]

    def wire(self) -> dict[str, Any]:
        return {
            "tripId": self.trip_id,
            "pl": self.pl.wire(),
            "own": self.own.wire(),
            "share": None if self.share is None else self.share.wire(),
            "purchases": {k: v.wire() for k, v in self.purchases.items()},
            "sales": {k: v.wire() for k, v in self.sales.items()},
            "diesel": {k: v.wire() for k, v in self.diesel.items()},
            "dues": [d.wire() for d in self.dues],
        }


@dataclass(frozen=True)
class SheetCalc:
    sheet_id: str
    #: The sheet's total: its trips added up, or its own costs when it has no trip yet.
    pl: TripPl
    own: LevelCosts
    basis: str | None
    diesel: dict[str, DieselFigures]
    dues: list[PartyDue]
    #: Sheet payments no trip's bill took: an advance, or paid extra.
    unsettled: list[PartyDue]
    trips: dict[str, TripCalc] = field(default_factory=dict)

    def wire(self) -> dict[str, Any]:
        return {
            "sheetId": self.sheet_id,
            "pl": self.pl.wire(),
            "own": self.own.wire(),
            "basis": self.basis,
            "diesel": {k: v.wire() for k, v in self.diesel.items()},
            "dues": [d.wire() for d in self.dues],
            "unsettled": [d.wire() for d in self.unsettled],
            "trips": {k: v.wire() for k, v in self.trips.items()},
        }


# ------------------------------------------------------------------- rules


def _line_value(quantity: Num, rate: Num) -> Decimal:
    return round_to(mul(dec(quantity), dec(rate)), 2)


def distance(start_km: Num, end_km: Num) -> Decimal | None:
    """L = K − J. None until both readings are in, or when the end is below the start."""
    start, end = parse_dec(start_km), parse_dec(end_km)
    if start is None or end is None or end < start:
        return None
    return sub(end, start)


def mileage(km: Decimal | None, litres: Decimal) -> Decimal | None:
    """P = L ÷ M, km per litre to two places."""
    if km is None or litres <= 0:
        return None
    return div_to(km, litres, 2)


def purchase_figures(p: Purchase) -> PurchaseFigures:
    """AB, AF, AG. A non-GST bill carries no GST, whatever rate was picked."""
    amount = _line_value(p.quantity, p.rate)
    gst = percent_of(amount, dec(p.gst_rate_pct)) if p.gst_billed else ZERO
    return PurchaseFigures(amount, gst, add(amount, gst))


def sale_figures(s: Sale) -> SaleFigures:
    """AV = AO × AQ + AR, AW, AX: transport is inside the taxable price, at the sale's rate."""
    amount = _line_value(s.quantity, s.rate)
    transport = round_to(dec(s.transport), 2)
    taxable = add(amount, transport)
    gst = percent_of(taxable, dec(s.gst_rate_pct)) if s.gst_billed else ZERO
    return SaleFigures(amount, transport, taxable, gst, add(taxable, gst))


def diesel_figures(line: DieselLine) -> DieselFigures:
    """O = M × N for a typed line; a linked fill's own amount; nothing for a void bill."""
    litres = parse_dec(line.litres)
    if line.source == "typed":
        rate = parse_dec(line.rate)
        return DieselFigures(litres, rate, _line_value(line.litres, line.rate), True)
    amount = round_to(dec(line.amount), 2)
    rate = div_to(amount, litres, 2) if litres is not None and litres > 0 and amount > 0 else None
    return DieselFigures(litres, rate, ZERO if line.void else amount, not line.void)


def profit(selling_price: Decimal, purchase_cost: Decimal, total_en_route: Decimal) -> Decimal:
    """BI, the profit of a trip or a sheet.

    The workbook says "Total Selling Price − Total Purchase cost − Total Enroute
    Expenses", and its Total Selling Price (AX) includes GST. LIN-22 says GST is
    never profit, so the selling price taken here is AV, without GST, less the
    purchase cost AB, also without GST, less BH; GST is reported apart as GST to
    pay (AW − AF). To follow the sheet's wording to the letter, pass AX instead
    of AV here, and in `profit` of vehicle-pl.ts. tests/test_vehicle_pl_domain.py
    states the choice with figures.
    """
    return sub(sub(selling_price, purchase_cost), total_en_route)


def profit_pct(net: Decimal, sales: Decimal) -> Decimal | None:
    """Profit % = net ÷ selling price × 100, to two places. None when nothing was sold."""
    if sales == 0:
        return None
    return div_to(mul(net, Decimal(100)), sales, 2)


def diesel_link_key(line: DieselLine) -> str | None:
    if line.source == "expense_bill" and line.expense_bill_id:
        return f"bill:{line.expense_bill_id}"
    if line.source == "fuel_entry" and line.fuel_entry_id:
        return f"fuel:{line.fuel_entry_id}"
    return None


@dataclass
class _Costs:
    km: Decimal | None
    litres: Decimal
    diesel: Decimal
    batta: Decimal
    en_route: Decimal
    lines: dict[str, DieselFigures]


def _costs_of(level: Trip | Sheet) -> _Costs:
    lines: dict[str, DieselFigures] = {}
    litres = diesel = ZERO
    for line in level.diesel:
        f = diesel_figures(line)
        lines[line.id] = f
        if not f.counted:
            continue
        litres = add(litres, round_to(dec(line.litres), 3))
        diesel = add(diesel, f.amount)
    return _Costs(
        km=distance(level.start_km, level.end_km),
        litres=litres,
        diesel=diesel,
        batta=round_to(dec(level.batta), 2),
        en_route=dsum(round_to(dec(e.amount), 2) for e in level.en_route),
        lines=lines,
    )


def _level_out(c: _Costs) -> LevelCosts:
    return LevelCosts(
        distance_km=None if c.km is None else round_to(c.km, 1),
        diesel_litres=round_to(c.litres, 3),
        diesel=c.diesel,
        batta=c.batta,
        en_route=c.en_route,
    )


def trip_order(trips: Iterable[Trip]) -> list[Trip]:
    """By date, then number, then id: the order a leftover paisa and a sheet payment go in."""
    return sorted(trips, key=lambda t: (t.date, t.trip_number or "", t.id))


def spread_sheet_costs(sheet: Sheet) -> Spread | None:
    """spreadSheetCosts: share the sheet's own diesel, litres, batta, en-route and km over its trips.

    By each trip's own km when every trip has a reading and they add up to more
    than nothing, otherwise evenly; each figure split on its own with
    `allocate`, so the trips add up to the sheet exactly.
    """
    trips = trip_order(sheet.trips)
    if not trips:
        return None
    own = _costs_of(sheet)
    kms = [distance(t.start_km, t.end_km) for t in trips]
    known = all(k is not None for k in kms) and dsum(k or ZERO for k in kms) > 0
    weights = [k for k in kms if k is not None] if known else [Decimal(1)] * len(trips)
    diesel = allocate(own.diesel, weights, 2)
    litres = allocate(own.litres, weights, 3)
    batta = allocate(own.batta, weights, 2)
    en_route = allocate(own.en_route, weights, 2)
    km = None if own.km is None else allocate(own.km, weights, 1)
    shares = {
        t.id: LevelCosts(
            distance_km=None if km is None else km[i],
            diesel_litres=litres[i],
            diesel=diesel[i],
            batta=batta[i],
            en_route=en_route[i],
        )
        for i, t in enumerate(trips)
    }
    return Spread("km" if known else "even", shares)


def _role_of(direction: str) -> str:
    return "customer" if direction == "in" else "vendor"


@dataclass
class _Due:
    party_id: str
    role: str
    billed: Decimal = ZERO
    settled: Decimal = ZERO
    closed_all: bool = True


def _bills_of(
    trip: Trip, purchases: dict[str, PurchaseFigures], sales: dict[str, SaleFigures]
) -> dict[str, _Due]:
    acc: dict[str, _Due] = {}

    def touch(role: str, party_id: str) -> _Due:
        return acc.setdefault(f"{role}:{party_id}", _Due(party_id, role))

    for s in trip.sales:
        if s.customer_id:
            row = touch("customer", s.customer_id)
            row.billed = add(row.billed, sales[s.id].total)
    for p in trip.purchases:
        if p.vendor_id:
            row = touch("vendor", p.vendor_id)
            row.billed = add(row.billed, purchases[p.id].total)
    for pay in trip.payments:
        if pay.party_id:
            row = touch(_role_of(pay.direction), pay.party_id)
            row.settled = add(row.settled, round_to(dec(pay.amount), 2))
    return acc


def settle_sheet_payments(
    payments: Sequence[Payment], trips: Sequence[tuple[str, Sequence[tuple[str, str, Decimal, Decimal]]]]
) -> tuple[dict[str, dict[str, Decimal]], dict[str, Decimal]]:
    """settleSheetPayments: sheet payments settle each party's trips oldest first.

    `trips` is (trip id, [(party id, role, billed, settled)]) in trip order. A
    trip takes up to what is still due on it; what no trip takes is left on the
    sheet. Returns (taken per trip and party key, left per party key).
    """
    pool: dict[str, Decimal] = {}
    for pay in payments:
        if pay.party_id:
            key = f"{_role_of(pay.direction)}:{pay.party_id}"
            pool[key] = add(pool.get(key, ZERO), round_to(dec(pay.amount), 2))
    taken: dict[str, dict[str, Decimal]] = {}
    for trip_id, dues in trips:
        taken[trip_id] = {}
        for party_id, role, billed, settled in dues:
            key = f"{role}:{party_id}"
            left = pool.get(key)
            if left is None or left <= 0:
                continue
            still = sub(billed, settled)
            if still <= 0:
                continue
            take = left if left < still else still
            taken[trip_id][key] = take
            pool[key] = sub(left, take)
    return taken, {k: v for k, v in pool.items() if v > 0}


def _customer_status(billed: Decimal, settled: Decimal, closed: bool) -> str:
    if sub(billed, settled) > 0:
        return "pending"
    return "closed" if closed else "paid"


def _vendor_status(billed: Decimal, settled: Decimal) -> str:
    if sub(billed, settled) <= 0:
        return "completed"
    return "partial" if settled > 0 else "pending"


def _due_out(row: _Due, status: str) -> PartyDue:
    return PartyDue(row.party_id, row.role, row.billed, row.settled, sub(row.billed, row.settled), status)


def _sorted_dues(dues: Iterable[PartyDue]) -> list[PartyDue]:
    return sorted(dues, key=lambda d: (d.role != "customer", d.party_id))


def _pl_of(
    *,
    km: Decimal | None,
    litres: Decimal,
    sales: Decimal,
    material: Decimal,
    diesel: Decimal,
    batta: Decimal,
    en_route: Decimal,
    output_gst: Decimal,
    input_gst: Decimal,
    dues: Sequence[PartyDue],
) -> TripPl:
    total_en_route = add(add(en_route, diesel), batta)
    net = profit(sales, material, total_en_route)

    def pick(role: str, attr: str) -> Decimal:
        return dsum(getattr(d, attr) for d in dues if d.role == role)

    customer_billed, received = pick("customer", "billed"), pick("customer", "settled")
    vendor_billed, paid = pick("vendor", "billed"), pick("vendor", "settled")
    return TripPl(
        distance_km=None if km is None else round_to(km, 1),
        diesel_litres=round_to(litres, 3),
        mileage_kmpl=mileage(km, litres),
        sales=sales,
        material_cost=material,
        gross=sub(sales, material),
        diesel=diesel,
        batta=batta,
        en_route=en_route,
        total_en_route=total_en_route,
        net=net,
        profit_pct=profit_pct(net, sales),
        output_gst=output_gst,
        input_gst=input_gst,
        gst_to_pay=sub(output_gst, input_gst),
        customer_billed=customer_billed,
        received=received,
        customer_due=sub(customer_billed, received),
        vendor_billed=vendor_billed,
        paid=paid,
        vendor_due=sub(vendor_billed, paid),
    )


def calculate_sheet(sheet: Sheet) -> SheetCalc:
    """calculateSheet: each trip with its part of the sheet's costs and payments, and the sheet's total."""
    own = _costs_of(sheet)
    spread = spread_sheet_costs(sheet)
    ordered = trip_order(sheet.trips)

    staged = []
    for trip in ordered:
        purchases = {p.id: purchase_figures(p) for p in trip.purchases}
        sales = {s.id: sale_figures(s) for s in trip.sales}
        staged.append((trip, purchases, sales, _costs_of(trip), _bills_of(trip, purchases, sales)))

    taken, left = settle_sheet_payments(
        sheet.payments,
        [
            (t.id, [(d.party_id, d.role, d.billed, d.settled) for d in bills.values()])
            for t, _, _, _, bills in staged
        ],
    )

    trips: dict[str, TripCalc] = {}
    for trip, purchases, sales, costs, bills in staged:
        share = spread.shares[trip.id] if spread else None
        took = taken.get(trip.id, {})
        closures = {c.party_id: round_to(dec(c.billed), 2) for c in trip.closures}
        dues = []
        for key, row in bills.items():
            with_sheet = _Due(row.party_id, row.role, row.billed, add(row.settled, took.get(key, ZERO)))
            if row.role == "vendor":
                dues.append(_due_out(with_sheet, _vendor_status(with_sheet.billed, with_sheet.settled)))
            else:
                closed = row.party_id in closures and closures[row.party_id] == row.billed
                dues.append(
                    _due_out(with_sheet, _customer_status(with_sheet.billed, with_sheet.settled, closed))
                )
        dues = _sorted_dues(dues)
        km = share.distance_km if share is not None and share.distance_km is not None else costs.km
        trips[trip.id] = TripCalc(
            trip_id=trip.id,
            pl=_pl_of(
                km=km,
                litres=add(costs.litres, share.diesel_litres if share else ZERO),
                sales=dsum(f.taxable for f in sales.values()),
                material=dsum(f.amount for f in purchases.values()),
                diesel=add(costs.diesel, share.diesel if share else ZERO),
                batta=add(costs.batta, share.batta if share else ZERO),
                en_route=add(costs.en_route, share.en_route if share else ZERO),
                output_gst=dsum(f.gst_amount for f in sales.values()),
                input_gst=dsum(f.gst_amount for f in purchases.values()),
                dues=dues,
            ),
            own=_level_out(costs),
            share=share,
            purchases=purchases,
            sales=sales,
            diesel=costs.lines,
            dues=dues,
        )

    total: dict[str, _Due] = {}
    for calc in trips.values():
        for d in calc.dues:
            row = total.setdefault(f"{d.role}:{d.party_id}", _Due(d.party_id, d.role))
            row.billed = add(row.billed, d.billed)
            row.settled = add(row.settled, d.settled)
            if d.role == "customer" and d.status != "closed":
                row.closed_all = False
    unsettled = []
    for key, amount in left.items():
        role, _, party_id = key.partition(":")
        unsettled.append(
            _due_out(_Due(party_id, role, ZERO, amount), "completed" if role == "vendor" else "paid")
        )
        row = total.setdefault(key, _Due(party_id, role, closed_all=False))
        row.settled = add(row.settled, amount)
        if row.role == "customer" and row.billed == 0:
            row.closed_all = False
    dues = _sorted_dues(
        _due_out(r, _vendor_status(r.billed, r.settled))
        if r.role == "vendor"
        else _due_out(r, _customer_status(r.billed, r.settled, r.closed_all))
        for r in total.values()
    )

    calcs = list(trips.values())
    trip_kms = [c.own.distance_km for c in calcs]
    km = own.km
    if km is None and any(k is not None for k in trip_kms):
        km = dsum(k or ZERO for k in trip_kms)
    litres = add(own.litres, dsum(c.own.diesel_litres for c in calcs))

    def pick(attr: str) -> Decimal:
        return dsum(getattr(c.pl, attr) for c in calcs)

    if not calcs:
        pl = _pl_of(
            km=km,
            litres=litres,
            sales=ZERO,
            material=ZERO,
            diesel=own.diesel,
            batta=own.batta,
            en_route=own.en_route,
            output_gst=ZERO,
            input_gst=ZERO,
            dues=dues,
        )
    else:
        pl = _pl_of(
            km=km,
            litres=litres,
            sales=pick("sales"),
            material=pick("material_cost"),
            diesel=pick("diesel"),
            batta=pick("batta"),
            en_route=pick("en_route"),
            output_gst=pick("output_gst"),
            input_gst=pick("input_gst"),
            dues=dues,
        )
    return SheetCalc(
        sheet_id=sheet.id,
        pl=pl,
        own=_level_out(own),
        basis=spread.basis if spread else None,
        diesel=own.lines,
        dues=dues,
        unsettled=_sorted_dues(unsettled),
        trips=trips,
    )


def calculate_sheets(sheets: Sequence[Sheet]) -> dict[str, SheetCalc]:
    return {s.id: calculate_sheet(s) for s in sheets}


# ----------------------------------------------------------------- reports


@dataclass(frozen=True)
class PlTotals:
    trips: int
    distance_km: Decimal
    diesel_litres: Decimal
    mileage_kmpl: Decimal | None
    money: dict[str, Decimal]
    profit_pct: Decimal | None

    def wire(self) -> dict[str, Any]:
        return {
            "trips": self.trips,
            "distanceKm": to_number(self.distance_km),
            "dieselLitres": to_number(self.diesel_litres),
            "mileageKmpl": _n(self.mileage_kmpl),
            **{wire: _m(self.money[attr]) for attr, wire in _PL_MONEY},
            "profitPct": _n(self.profit_pct),
        }


def sum_pl(pls: Sequence[TripPl], trips: int | None = None) -> PlTotals:
    """sumPl: money summed, mileage and profit % worked out again from the sums."""
    money = {attr: dsum(getattr(p, attr) for p in pls) for attr, _ in _PL_MONEY}
    measured = [p for p in pls if p.distance_km is not None and p.diesel_litres > 0]
    kmpl = mileage(
        dsum(p.distance_km or ZERO for p in measured) if measured else None,
        dsum(p.diesel_litres for p in measured),
    )
    return PlTotals(
        trips=len(pls) if trips is None else trips,
        distance_km=round_to(dsum(p.distance_km or ZERO for p in pls), 1),
        diesel_litres=round_to(dsum(p.diesel_litres for p in pls), 3),
        mileage_kmpl=kmpl,
        money=money,
        profit_pct=profit_pct(money["net"], money["sales"]),
    )


@dataclass(frozen=True)
class PlUnit:
    """plUnits: a trip on its date; a sheet with no trip on its start date; a sheet's unsettled payments."""

    sheet_id: str
    trip_id: str | None
    vehicle_id: str
    date: str
    pl: TripPl
    dues: list[PartyDue]


def _unsettled_pl(dues: Sequence[PartyDue]) -> TripPl:
    """Money that moved with no trip to take it: no profit or loss, only what was received or paid."""
    return _pl_of(
        km=None,
        litres=ZERO,
        sales=ZERO,
        material=ZERO,
        diesel=ZERO,
        batta=ZERO,
        en_route=ZERO,
        output_gst=ZERO,
        input_gst=ZERO,
        dues=dues,
    )


def pl_units(sheets: Sequence[Sheet], calcs: Mapping[str, SheetCalc]) -> list[PlUnit]:
    units: list[PlUnit] = []
    for sheet in sheets:
        calc = calcs.get(sheet.id)
        if calc is None:
            continue
        if not sheet.trips:
            units.append(PlUnit(sheet.id, None, sheet.vehicle_id, sheet.start_date, calc.pl, calc.dues))
            continue
        for trip in trip_order(sheet.trips):
            t = calc.trips[trip.id]
            units.append(PlUnit(sheet.id, trip.id, sheet.vehicle_id, trip.date, t.pl, t.dues))
        if calc.unsettled:
            units.append(
                PlUnit(
                    sheet.id,
                    None,
                    sheet.vehicle_id,
                    sheet.start_date,
                    _unsettled_pl(calc.unsettled),
                    calc.unsettled,
                )
            )
    return units


def total_pl(units: Sequence[PlUnit]) -> PlTotals:
    return sum_pl([u.pl for u in units], sum(1 for u in units if u.trip_id is not None))


def _grouped(units: Sequence[PlUnit], key_of: Any) -> list[tuple[str, PlTotals]]:
    groups: dict[str, list[PlUnit]] = {}
    for u in units:
        groups.setdefault(key_of(u), []).append(u)
    return [(k, total_pl(us)) for k, us in groups.items()]


def pl_by_vehicle(units: Sequence[PlUnit]) -> list[tuple[str, PlTotals]]:
    """One row per vehicle, the most profitable first."""
    return sorted(_grouped(units, lambda u: u.vehicle_id), key=lambda r: (-r[1].money["net"], r[0]))


def pl_by_month(units: Sequence[PlUnit]) -> list[tuple[str, PlTotals]]:
    """One row per calendar month of the trip date (YYYY-MM), oldest first."""
    return sorted(_grouped(units, lambda u: u.date[:7]), key=lambda r: r[0])


@dataclass(frozen=True)
class OutstandingRow:
    party_id: str
    role: str
    trips: int
    billed: Decimal
    settled: Decimal
    due: Decimal
    status: str
    first_date: str
    last_date: str

    def wire(self) -> dict[str, Any]:
        return {
            "partyId": self.party_id,
            "role": self.role,
            "trips": self.trips,
            "billed": _m(self.billed),
            "settled": _m(self.settled),
            "due": _m(self.due),
            "status": self.status,
            "firstDate": self.first_date,
            "lastDate": self.last_date,
        }


def outstanding(units: Sequence[PlUnit], role: str) -> list[OutstandingRow]:
    """Money due per customer (AX − BA) or per vendor (BD − BE), the most due first."""
    rows: dict[str, dict[str, Any]] = {}
    for unit in units:
        for d in unit.dues:
            if d.role != role:
                continue
            row = rows.setdefault(
                d.party_id,
                {
                    "trips": set(),
                    "billed": ZERO,
                    "settled": ZERO,
                    "closed_all": True,
                    "first": unit.date,
                    "last": unit.date,
                },
            )
            if unit.trip_id:
                row["trips"].add(unit.trip_id)
            row["billed"] = add(row["billed"], d.billed)
            row["settled"] = add(row["settled"], d.settled)
            if d.status != "closed":
                row["closed_all"] = False
            row["first"] = min(row["first"], unit.date)
            row["last"] = max(row["last"], unit.date)
    out = [
        OutstandingRow(
            party_id=party_id,
            role=role,
            trips=len(r["trips"]),
            billed=r["billed"],
            settled=r["settled"],
            due=sub(r["billed"], r["settled"]),
            status=_vendor_status(r["billed"], r["settled"])
            if role == "vendor"
            else _customer_status(r["billed"], r["settled"], r["closed_all"]),
            first_date=r["first"],
            last_date=r["last"],
        )
        for party_id, r in rows.items()
    ]
    return sorted(out, key=lambda r: (-r.due, r.party_id))


# --------------------------------------------------------- double counting

_NOT_ALNUM = re.compile(r"[^A-Z0-9]")


def bill_key(bill_number: str | None) -> str:
    """billKey: "BK/4471", "bk 4471" and "BK-4471" are one bill."""
    return _NOT_ALNUM.sub("", (bill_number or "").upper())


@dataclass(frozen=True)
class KnownDieselBill:
    id: str
    bill_number: str
    vehicle_id: str | None


@dataclass(frozen=True)
class OtherSheetDiesel:
    sheet_id: str
    sheet_number: str
    vehicle_id: str
    bill_numbers: tuple[str, ...]


def sheet_diesel_lines(sheet: Sheet) -> list[tuple[str | None, DieselLine]]:
    """Every diesel line of a sheet: its own first, then each trip's in trip order."""
    return [(None, line) for line in sheet.diesel] + [
        (t.id, line) for t in trip_order(sheet.trips) for line in t.diesel
    ]


def find_double_counts(
    sheet: Sheet, bills: Sequence[KnownDieselBill] = (), other_sheets: Sequence[OtherSheetDiesel] = ()
) -> list[dict[str, str]]:
    """findDoubleCounts, the same problems in the same order, as wire dicts."""
    problems: list[dict[str, str]] = []
    links: set[str] = set()
    numbers: set[str] = set()
    lines = [line for _, line in sheet_diesel_lines(sheet)]
    linked_bills = {line.expense_bill_id for line in lines if line.source == "expense_bill"}
    for line in lines:
        link = diesel_link_key(line)
        if link is not None:
            if link in links:
                problems.append({"code": "diesel-linked-twice", "lineId": line.id})
                continue
            links.add(link)
        key = bill_key(line.bill_number)
        if not key:
            continue
        if key in numbers:
            problems.append(
                {"code": "diesel-same-bill", "lineId": line.id, "billNumber": line.bill_number or ""}
            )
            continue
        numbers.add(key)
        if line.source != "typed":
            continue
        bill = next(
            (
                b
                for b in bills
                if bill_key(b.bill_number) == key
                and (b.vehicle_id is None or b.vehicle_id == sheet.vehicle_id)
                and b.id not in linked_bills
            ),
            None,
        )
        if bill is not None:
            problems.append(
                {
                    "code": "diesel-bill-exists",
                    "lineId": line.id,
                    "billNumber": line.bill_number or "",
                    "billId": bill.id,
                }
            )
            continue
        other = next(
            (
                o
                for o in other_sheets
                if o.sheet_id != sheet.id
                and o.vehicle_id == sheet.vehicle_id
                and any(bill_key(n) == key for n in o.bill_numbers)
            ),
            None,
        )
        if other is not None:
            problems.append(
                {
                    "code": "diesel-bill-on-sheet",
                    "lineId": line.id,
                    "billNumber": line.bill_number or "",
                    "sheetNumber": other.sheet_number,
                }
            )
    return problems

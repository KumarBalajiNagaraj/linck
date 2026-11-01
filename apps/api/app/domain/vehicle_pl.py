"""VEHICLE P&L (LIN-22): what one trip of a tipper earned, worked out where it is stored.

A port of packages/domain/src/vehicle-pl.ts (and the exact decimal helpers in
packages/domain/src/decimal.ts), kept close enough to read side by side. Both
run over packages/domain/src/vehicle-pl.fixtures.json, the golden figures
worked by hand (tests/test_vehicle_pl_domain.py), so a rule changed on one side
only fails a suite. The screens use the TypeScript to follow the form as it is
typed; this copy decides what the API stores and reports.

    distance        = end km − start km
    mileage         = distance ÷ the trip's diesel litres
    sales           = Σ (qty × selling rate) + transport charges, without GST
    material cost   = Σ purchase value without GST (GST bill: the tax is input credit)
                      + Σ full amount (non-GST bill: everything paid is cost)
    gross profit    = sales − material cost
    net profit      = gross − diesel − batta − en-route − other costs
    profit %        = net ÷ sales × 100, none when there are no sales
    GST to pay      = GST collected on sales − GST credit on purchases (its own line; never profit)
    money due       = bills with GST − payments, per customer and per vendor

The LIN-22 workbook could not be read yet; each rule is one small function, so
a rule it states differently is a one-function change on each side and a
fixture update.

Every figure is rounded once, half away from zero (ROUND_HALF_UP, which is what
the TypeScript's BigInt rounding does), money to the paisa and litres to the
millilitre. Division and splitting are done on integers, so nothing is rounded
twice and a shared diesel fill's parts add up to its bill exactly.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Context, Decimal
from typing import Any, Literal

#: The rules' version, kept on each vehicle day (the design's allocation_rule_version).
PL_RULES_VERSION = "km-v1"

DieselSource = Literal["typed", "expense_bill", "fuel_entry"]
CostKind = Literal["batta", "en_route", "other"]
PartyRole = Literal["customer", "vendor"]
MoneyDirection = Literal["in", "out"]

COST_KINDS: tuple[str, ...] = ("batta", "en_route", "other")
DIESEL_SOURCES: tuple[str, ...] = ("typed", "expense_bill", "fuel_entry")

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
    """Typed: litres and rate for this trip alone. Linked: an expense bill or a
    fuel entry, whose `litres` and `amount` are the WHOLE fill, read from it."""

    id: str
    source: str
    litres: Num = None
    rate: Num = None
    amount: Num = None
    expense_bill_id: str | None = None
    fuel_entry_id: str | None = None
    bill_number: str | None = None
    #: A linked bill that was rejected or deleted: it counts nothing.
    void: bool = False


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
    transport_gst_rate_pct: Num = None


@dataclass(frozen=True)
class Cost:
    id: str
    kind: str
    amount: Num


@dataclass(frozen=True)
class Payment:
    id: str
    direction: str
    party_id: str | None
    amount: Num


@dataclass(frozen=True)
class Trip:
    id: str
    vehicle_id: str
    #: YYYY-MM-DD.
    date: str
    start_km: Num
    end_km: Num
    diesel: tuple[DieselLine, ...] = ()
    purchases: tuple[Purchase, ...] = ()
    sales: tuple[Sale, ...] = ()
    costs: tuple[Cost, ...] = ()
    payments: tuple[Payment, ...] = ()
    #: Orders the trips that share a fill: the earlier trip takes a leftover paisa.
    trip_number: str | None = None


def trip_from_wire(t: Mapping[str, Any]) -> Trip:
    """A trip as the fixtures (and the TypeScript) spell it, camelCase."""
    return Trip(
        id=str(t["id"]),
        vehicle_id=str(t["vehicleId"]),
        date=str(t["date"]),
        start_km=t.get("startKm"),
        end_km=t.get("endKm"),
        trip_number=t.get("tripNumber"),
        diesel=tuple(
            DieselLine(
                id=str(d["id"]),
                source=str(d["source"]),
                litres=d.get("litres"),
                rate=d.get("rate"),
                amount=d.get("amount"),
                expense_bill_id=d.get("expenseBillId"),
                fuel_entry_id=d.get("fuelEntryId"),
                bill_number=d.get("billNumber"),
                void=bool(d.get("void", False)),
            )
            for d in t.get("diesel") or []
        ),
        purchases=tuple(
            Purchase(
                id=str(p["id"]),
                vendor_id=p.get("vendorId"),
                quantity=p.get("quantity"),
                rate=p.get("rate"),
                gst_billed=bool(p.get("gstBilled")),
                gst_rate_pct=p.get("gstRatePct"),
            )
            for p in t.get("purchases") or []
        ),
        sales=tuple(
            Sale(
                id=str(s["id"]),
                customer_id=s.get("customerId"),
                quantity=s.get("quantity"),
                rate=s.get("rate"),
                gst_billed=bool(s.get("gstBilled")),
                gst_rate_pct=s.get("gstRatePct"),
                transport=s.get("transport"),
                transport_gst_rate_pct=s.get("transportGstRatePct"),
            )
            for s in t.get("sales") or []
        ),
        costs=tuple(
            Cost(id=str(c["id"]), kind=str(c["kind"]), amount=c.get("amount")) for c in t.get("costs") or []
        ),
        payments=tuple(
            Payment(
                id=str(m["id"]),
                direction=str(m["direction"]),
                party_id=m.get("partyId"),
                amount=m.get("amount"),
            )
            for m in t.get("payments") or []
        ),
    )


# ----------------------------------------------------------------- outputs


def _m(value: Decimal) -> str:
    return to_fixed(value, 2)


def _n(value: Decimal | None) -> int | float | None:
    return None if value is None else to_number(value)


@dataclass(frozen=True)
class PurchaseFigures:
    amount: Decimal
    gst_amount: Decimal
    total: Decimal
    cost: Decimal
    input_credit: Decimal

    def wire(self) -> dict[str, object]:
        return {
            "amount": _m(self.amount),
            "gstAmount": _m(self.gst_amount),
            "total": _m(self.total),
            "cost": _m(self.cost),
            "inputCredit": _m(self.input_credit),
        }


@dataclass(frozen=True)
class SaleFigures:
    amount: Decimal
    gst_amount: Decimal
    transport: Decimal
    transport_gst: Decimal
    taxable: Decimal
    gst_total: Decimal
    total: Decimal

    def wire(self) -> dict[str, object]:
        return {
            "amount": _m(self.amount),
            "gstAmount": _m(self.gst_amount),
            "transport": _m(self.transport),
            "transportGst": _m(self.transport_gst),
            "taxable": _m(self.taxable),
            "gstTotal": _m(self.gst_total),
            "total": _m(self.total),
        }


@dataclass(frozen=True)
class DieselFigures:
    #: Typed: litres × rate. Linked: the whole fill, as on its bill.
    amount: Decimal
    share_litres: Decimal
    share_amount: Decimal
    #: How many trips the fill is split across (1 for a typed line).
    shared_by: int

    def wire(self) -> dict[str, object]:
        return {
            "amount": _m(self.amount),
            "shareLitres": to_number(self.share_litres),
            "shareAmount": _m(self.share_amount),
            "sharedBy": self.shared_by,
        }


#: TripPl's money fields, wire name and attribute, in the TypeScript's order.
MONEY_FIELDS: tuple[tuple[str, str], ...] = (
    ("sales", "sales"),
    ("materialCost", "material_cost"),
    ("gross", "gross"),
    ("diesel", "diesel"),
    ("batta", "batta"),
    ("enRoute", "en_route"),
    ("other", "other"),
    ("net", "net"),
    ("outputGst", "output_gst"),
    ("inputGst", "input_gst"),
    ("gstToPay", "gst_to_pay"),
    ("customerBilled", "customer_billed"),
    ("received", "received"),
    ("customerDue", "customer_due"),
    ("vendorBilled", "vendor_billed"),
    ("paid", "paid"),
    ("vendorDue", "vendor_due"),
)


@dataclass(frozen=True)
class TripPl:
    distance_km: Decimal | None
    diesel_litres: Decimal
    mileage_kmpl: Decimal | None
    sales: Decimal
    material_cost: Decimal
    gross: Decimal
    diesel: Decimal
    batta: Decimal
    en_route: Decimal
    other: Decimal
    net: Decimal
    profit_pct: Decimal | None
    output_gst: Decimal
    input_gst: Decimal
    gst_to_pay: Decimal
    customer_billed: Decimal
    received: Decimal
    customer_due: Decimal
    vendor_billed: Decimal
    paid: Decimal
    vendor_due: Decimal

    def wire(self) -> dict[str, object]:
        out: dict[str, object] = {
            "distanceKm": _n(self.distance_km),
            "dieselLitres": to_number(self.diesel_litres),
            "mileageKmpl": _n(self.mileage_kmpl),
        }
        for name, attr in MONEY_FIELDS:
            out[name] = _m(getattr(self, attr))
        out["profitPct"] = _n(self.profit_pct)
        return out


@dataclass(frozen=True)
class PartyDue:
    party_id: str
    role: str
    billed: Decimal
    settled: Decimal

    @property
    def due(self) -> Decimal:
        return sub(self.billed, self.settled)

    def wire(self) -> dict[str, object]:
        return {
            "partyId": self.party_id,
            "role": self.role,
            "billed": _m(self.billed),
            "settled": _m(self.settled),
            "due": _m(self.due),
        }


@dataclass(frozen=True)
class TripCalc:
    trip_id: str
    pl: TripPl
    purchases: dict[str, PurchaseFigures]
    sales: dict[str, SaleFigures]
    diesel: dict[str, DieselFigures]
    dues: list[PartyDue]


# ------------------------------------------------------------------- lines


def _line_value(quantity: Num, rate: Num) -> Decimal:
    return round_to(mul(dec(quantity), dec(rate)), 2)


def trip_distance(start_km: Num, end_km: Num) -> Decimal | None:
    """Distance = end km − start km. None until both are read, or when the end is below the start."""
    start, end = parse_dec(start_km), parse_dec(end_km)
    if start is None or end is None or end < start:
        return None
    return sub(end, start)


def mileage(distance: Decimal | None, litres: Decimal) -> Decimal | None:
    """Mileage = distance ÷ litres, in km per litre to two places."""
    if distance is None or litres <= 0:
        return None
    return div_to(distance, litres, 2)


def purchase_figures(p: Purchase) -> PurchaseFigures:
    amount = _line_value(p.quantity, p.rate)
    gst = percent_of(amount, dec(p.gst_rate_pct)) if p.gst_billed else ZERO
    total = add(amount, gst)
    return PurchaseFigures(
        amount=amount,
        gst_amount=gst,
        total=total,
        # GST bill: the tax is claimed back, so the cost is the value without it.
        # Non-GST bill: there is nothing to claim, so everything paid is cost.
        cost=amount if p.gst_billed else total,
        input_credit=gst if p.gst_billed else ZERO,
    )


def sale_figures(s: Sale) -> SaleFigures:
    amount = _line_value(s.quantity, s.rate)
    transport = round_to(dec(s.transport), 2)
    gst = percent_of(amount, dec(s.gst_rate_pct)) if s.gst_billed else ZERO
    transport_gst = percent_of(transport, dec(s.transport_gst_rate_pct)) if s.gst_billed else ZERO
    taxable = add(amount, transport)
    gst_total = add(gst, transport_gst)
    return SaleFigures(
        amount=amount,
        gst_amount=gst,
        transport=transport,
        transport_gst=transport_gst,
        taxable=taxable,
        gst_total=gst_total,
        total=add(taxable, gst_total),
    )


def typed_diesel_amount(litres: Num, rate: Num) -> Decimal:
    """A typed diesel line: litres × rate, to the paisa."""
    return _line_value(litres, rate)


def diesel_link_key(line: DieselLine) -> str | None:
    if line.source == "expense_bill" and line.expense_bill_id:
        return f"expense_bill:{line.expense_bill_id}"
    if line.source == "fuel_entry" and line.fuel_entry_id:
        return f"fuel_entry:{line.fuel_entry_id}"
    return None


# ------------------------------------------------------------ shared diesel


@dataclass(frozen=True)
class DieselShare:
    litres: Decimal
    amount: Decimal
    shared_by: int


def diesel_shares(trips: Sequence[Trip]) -> dict[str, dict[str, DieselShare]]:
    """Each linked fill split across the trips that link it, by km (equally when
    none has km yet), the trips in trip-number order (then id), so a leftover
    paisa lands on the earlier trip of the day. Keyed by trip id, then line id."""
    groups: dict[str, list[tuple[Trip, DieselLine]]] = {}
    for trip in trips:
        seen: set[str] = set()
        for line in trip.diesel:
            key = diesel_link_key(line)
            # The same fill twice on one trip is refused when saved; if it
            # gets here, only its first line takes a part.
            if key is None or key in seen:
                continue
            seen.add(key)
            groups.setdefault(key, []).append((trip, line))
    out: dict[str, dict[str, DieselShare]] = {}
    for group in groups.values():
        group.sort(key=lambda g: (g[0].trip_number or "", g[0].id))
        first = group[0][1]
        voided = any(line.void for _, line in group)
        total_amount = ZERO if voided else dec(first.amount)
        total_litres = ZERO if voided else dec(first.litres)
        weights = [trip_distance(t.start_km, t.end_km) or ZERO for t, _ in group]
        amounts = allocate(total_amount, weights, 2)
        litres = allocate(total_litres, weights, 3)
        for i, (trip, line) in enumerate(group):
            out.setdefault(trip.id, {})[line.id] = DieselShare(
                litres=litres[i], amount=amounts[i], shared_by=len(group)
            )
    return out


# ------------------------------------------------------------------- trips


def _dues(trip: Trip, purchases: dict[str, PurchaseFigures], sales: dict[str, SaleFigures]) -> list[PartyDue]:
    rows: dict[tuple[str, str], list[Decimal]] = {}

    def row(role: str, party_id: str) -> list[Decimal]:
        return rows.setdefault((role, party_id), [ZERO, ZERO])

    for s in trip.sales:
        if s.customer_id:
            r = row("customer", s.customer_id)
            r[0] = add(r[0], sales[s.id].total)
    for p in trip.purchases:
        if p.vendor_id:
            r = row("vendor", p.vendor_id)
            r[0] = add(r[0], purchases[p.id].total)
    for m in trip.payments:
        if m.party_id:
            r = row("customer" if m.direction == "in" else "vendor", m.party_id)
            r[1] = add(r[1], round_to(dec(m.amount), 2))
    ordered = [k for k in rows if k[0] == "customer"] + [k for k in rows if k[0] == "vendor"]
    return [
        PartyDue(party_id=p, role=role, billed=rows[(role, p)][0], settled=rows[(role, p)][1])
        for role, p in ordered
    ]


def profit_pct(net: Decimal, sales: Decimal) -> Decimal | None:
    """Profit % = net ÷ sales × 100, to two places. None when nothing was sold."""
    if sales.is_zero():
        return None
    return div_to(mul(net, Decimal(100)), sales, 2)


def calculate_trip(trip: Trip, shares: Mapping[str, DieselShare] | None = None) -> TripCalc:
    """One trip's P&L. `shares` is its part of each linked fill (diesel_shares over
    every trip that links one of its fills); left out, the trip is taken alone."""
    if shares is None:
        shares = diesel_shares([trip]).get(trip.id, {})
    purchases = {p.id: purchase_figures(p) for p in trip.purchases}
    sales = {s.id: sale_figures(s) for s in trip.sales}

    diesel: dict[str, DieselFigures] = {}
    diesel_litres = ZERO
    diesel_amount = ZERO
    for line in trip.diesel:
        if line.source == "typed":
            whole = amount = _line_value(line.litres, line.rate)
            litres = round_to(dec(line.litres), 3)
            shared_by = 1
        else:
            share = shares.get(line.id)
            whole = round_to(dec(line.amount), 2)
            litres = share.litres if share else ZERO
            amount = share.amount if share else ZERO
            shared_by = share.shared_by if share else 0
        diesel[line.id] = DieselFigures(
            amount=whole, share_litres=litres, share_amount=amount, shared_by=shared_by
        )
        diesel_litres = add(diesel_litres, litres)
        diesel_amount = add(diesel_amount, amount)

    def cost_of(kind: str) -> Decimal:
        return dsum(round_to(dec(c.amount), 2) for c in trip.costs if c.kind == kind)

    def paid_of(direction: str) -> Decimal:
        return dsum(round_to(dec(m.amount), 2) for m in trip.payments if m.direction == direction)

    batta, en_route, other = cost_of("batta"), cost_of("en_route"), cost_of("other")
    sales_total = dsum(s.taxable for s in sales.values())
    material_cost = dsum(p.cost for p in purchases.values())
    gross = sub(sales_total, material_cost)
    net = sub(sub(sub(sub(gross, diesel_amount), batta), en_route), other)
    output_gst = dsum(s.gst_total for s in sales.values())
    input_gst = dsum(p.input_credit for p in purchases.values())
    customer_billed = dsum(s.total for s in sales.values())
    vendor_billed = dsum(p.total for p in purchases.values())
    received, paid = paid_of("in"), paid_of("out")
    distance = trip_distance(trip.start_km, trip.end_km)

    return TripCalc(
        trip_id=trip.id,
        purchases=purchases,
        sales=sales,
        diesel=diesel,
        dues=_dues(trip, purchases, sales),
        pl=TripPl(
            distance_km=distance,
            diesel_litres=round_to(diesel_litres, 3),
            mileage_kmpl=mileage(distance, diesel_litres),
            sales=sales_total,
            material_cost=material_cost,
            gross=gross,
            diesel=diesel_amount,
            batta=batta,
            en_route=en_route,
            other=other,
            net=net,
            profit_pct=profit_pct(net, sales_total),
            output_gst=output_gst,
            input_gst=input_gst,
            gst_to_pay=sub(output_gst, input_gst),
            customer_billed=customer_billed,
            received=received,
            customer_due=sub(customer_billed, received),
            vendor_billed=vendor_billed,
            paid=paid,
            vendor_due=sub(vendor_billed, paid),
        ),
    )


def calculate_trips(trips: Sequence[Trip]) -> dict[str, TripCalc]:
    """Every trip's P&L, each shared fill split across the trips given (pass every
    trip of the vehicle days involved, or a fill is split too few ways)."""
    shares = diesel_shares(trips)
    return {t.id: calculate_trip(t, shares.get(t.id, {})) for t in trips}


# ------------------------------------------------------------------ reports


@dataclass(frozen=True)
class PlTotals:
    trips: int
    distance_km: Decimal
    diesel_litres: Decimal
    mileage_kmpl: Decimal | None
    money: dict[str, Decimal]
    profit_pct: Decimal | None

    def wire(self) -> dict[str, object]:
        out: dict[str, object] = {
            "trips": self.trips,
            "distanceKm": to_number(self.distance_km),
            "dieselLitres": to_number(self.diesel_litres),
            "mileageKmpl": _n(self.mileage_kmpl),
        }
        for name, _ in MONEY_FIELDS:
            out[name] = _m(self.money[name])
        out["profitPct"] = _n(self.profit_pct)
        return out


def sum_pl(pls: Sequence[TripPl]) -> PlTotals:
    """Trips added up: money summed, mileage and profit % worked out again from the sums."""
    money = {name: dsum(getattr(p, attr) for p in pls) for name, attr in MONEY_FIELDS}
    measured = [p for p in pls if p.distance_km is not None and p.diesel_litres > 0]
    kmpl = mileage(
        dsum(p.distance_km or ZERO for p in measured) if measured else None,
        dsum(p.diesel_litres for p in measured),
    )
    return PlTotals(
        trips=len(pls),
        distance_km=dsum(p.distance_km or ZERO for p in pls),
        diesel_litres=round_to(dsum(p.diesel_litres for p in pls), 3),
        mileage_kmpl=kmpl,
        money=money,
        profit_pct=profit_pct(money["net"], money["sales"]),
    )


def _grouped(
    trips: Sequence[Trip], calcs: Mapping[str, TripCalc], key_of: Callable[[Trip], str]
) -> dict[str, list[TripPl]]:
    groups: dict[str, list[TripPl]] = {}
    for trip in trips:
        calc = calcs.get(trip.id)
        if calc is not None:
            groups.setdefault(key_of(trip), []).append(calc.pl)
    return groups


def pl_by_vehicle(trips: Sequence[Trip], calcs: Mapping[str, TripCalc]) -> list[tuple[str, PlTotals]]:
    """One row per vehicle, the most profitable first."""
    rows = [(v, sum_pl(pls)) for v, pls in _grouped(trips, calcs, lambda t: t.vehicle_id).items()]
    return sorted(rows, key=lambda r: (-r[1].money["net"], r[0]))


def pl_by_month(trips: Sequence[Trip], calcs: Mapping[str, TripCalc]) -> list[tuple[str, PlTotals]]:
    """One row per calendar month of the trip date, oldest first."""
    rows = [(m, sum_pl(pls)) for m, pls in _grouped(trips, calcs, lambda t: t.date[:7]).items()]
    return sorted(rows, key=lambda r: r[0])


@dataclass(frozen=True)
class OutstandingRow:
    party_id: str
    role: str
    trips: int
    billed: Decimal
    settled: Decimal
    first_date: str
    last_date: str

    @property
    def due(self) -> Decimal:
        return sub(self.billed, self.settled)

    def wire(self) -> dict[str, object]:
        return {
            "partyId": self.party_id,
            "role": self.role,
            "trips": self.trips,
            "billed": _m(self.billed),
            "settled": _m(self.settled),
            "due": _m(self.due),
            "firstDate": self.first_date,
            "lastDate": self.last_date,
        }


def outstanding(trips: Sequence[Trip], calcs: Mapping[str, TripCalc], role: str) -> list[OutstandingRow]:
    """Money due per customer (billed with GST − received) or per vendor (− paid), the most due first."""

    @dataclass
    class Acc:
        trips: set[str] = field(default_factory=set)
        billed: Decimal = ZERO
        settled: Decimal = ZERO
        first: str = ""
        last: str = ""

    rows: dict[str, Acc] = {}
    for trip in trips:
        calc = calcs.get(trip.id)
        if calc is None:
            continue
        for d in calc.dues:
            if d.role != role:
                continue
            acc = rows.setdefault(d.party_id, Acc(first=trip.date, last=trip.date))
            acc.trips.add(trip.id)
            acc.billed = add(acc.billed, d.billed)
            acc.settled = add(acc.settled, d.settled)
            acc.first = min(acc.first, trip.date)
            acc.last = max(acc.last, trip.date)
    out = [
        OutstandingRow(
            party_id=party_id,
            role=role,
            trips=len(a.trips),
            billed=a.billed,
            settled=a.settled,
            first_date=a.first,
            last_date=a.last,
        )
        for party_id, a in rows.items()
    ]
    return sorted(out, key=lambda r: (-r.due, r.party_id))


# --------------------------------------------------------- double counting

_NOT_ALNUM = re.compile(r"[^A-Z0-9]")


def bill_key(bill_number: str | None) -> str:
    """A bill number as people write it: 'BK/4471', 'bk 4471' and 'BK-4471' are one bill."""
    return _NOT_ALNUM.sub("", (bill_number or "").upper())


@dataclass(frozen=True)
class KnownDieselBill:
    id: str
    bill_number: str
    vehicle_id: str | None


@dataclass(frozen=True)
class OtherTripDiesel:
    trip_id: str
    trip_number: str
    vehicle_id: str
    bill_numbers: tuple[str, ...]


def find_double_counts(
    trip: Trip,
    bills: Sequence[KnownDieselBill] = (),
    other_trips: Sequence[OtherTripDiesel] = (),
) -> list[dict[str, str]]:
    """findDoubleCounts: every way this trip's diesel would count a fill twice, as problems
    the web words — the same fill linked twice, two lines with one bill number, a
    typed line repeating a diesel bill already in Linck, or one on another trip."""
    problems: list[dict[str, str]] = []
    links: set[str] = set()
    numbers: set[str] = set()
    linked_bills = {line.expense_bill_id for line in trip.diesel if line.source == "expense_bill"}
    for line in trip.diesel:
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
                and (b.vehicle_id is None or b.vehicle_id == trip.vehicle_id)
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
                for o in other_trips
                if o.trip_id != trip.id
                and o.vehicle_id == trip.vehicle_id
                and any(bill_key(n) == key for n in o.bill_numbers)
            ),
            None,
        )
        if other is not None:
            problems.append(
                {
                    "code": "diesel-bill-on-trip",
                    "lineId": line.id,
                    "billNumber": line.bill_number or "",
                    "tripNumber": other.trip_number,
                }
            )
    return problems

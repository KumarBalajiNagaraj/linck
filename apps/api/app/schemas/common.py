"""What every response and request in the desk APIs shares.

Responses use the field names, nesting and enum values of the mock shapes in
packages/mock/src/types.ts, so the web app swaps an import path and nothing
else. That fixes the encodings:

- Money is a decimal STRING with exactly two places ("41277.60"), and every
  sum is done in Decimal. A JSON number would put a float between the ledger
  and the screen.
- Litres and units are JSON numbers, as the mocks have them; they are stored
  as numeric and only become a number on the way out.
- Instants are ISO-8601 UTC.

Requests are strict: unknown fields are refused rather than ignored, so a
client cannot believe it set a status, a provenance or who corrected a field.
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Annotated

from pydantic import AfterValidator, BaseModel, ConfigDict, StringConstraints
from pydantic.alias_generators import to_camel

CENT = Decimal("0.01")
MILLI = Decimal("0.001")


class CamelModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class CamelIn(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


def money(value: Decimal) -> str:
    """'41277.60': two places, never an exponent."""
    return format(value.quantize(CENT), "f")


def number(value: Decimal | None) -> float | int | None:
    """A stored quantity as the JSON number the screens expect: 432 or 120.455."""
    if value is None:
        return None
    normal = value.normalize()
    return int(normal) if normal == normal.to_integral_value() else float(normal)


def _to_money(text: str) -> Decimal:
    return Decimal(text)


#: A rupee amount as the screens send it: digits, at most two decimals, positive.
MoneyIn = Annotated[
    str,
    StringConstraints(strip_whitespace=True, pattern=r"^\d{1,16}(\.\d{1,2})?$"),
    AfterValidator(_to_money),
]


def _to_quantity(value: float | int) -> Decimal:
    """A JSON number into numeric(12,3), refusing what the column would round."""
    try:
        quantity = Decimal(str(value))
    except InvalidOperation as exc:  # pragma: no cover - pydantic has already parsed a number
        raise ValueError("not a number") from exc
    if not quantity.is_finite() or quantity <= 0:
        raise ValueError("must be more than zero")
    if quantity != quantity.quantize(MILLI):
        raise ValueError("at most three decimal places")
    if quantity >= Decimal("1000000000"):
        raise ValueError("too large")
    return quantity


#: Litres or units: a positive JSON number with at most three decimals.
QuantityIn = Annotated[float | int, AfterValidator(_to_quantity)]


def parse_instant(value: str) -> datetime:
    """An ISO-8601 instant that says which timezone it is in."""
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError("not an ISO-8601 date-time") from exc
    if parsed.tzinfo is None:
        raise ValueError("needs a timezone, e.g. 'Z'")
    return parsed


def parse_day(value: str, timezone) -> date:  # type: ignore[no-untyped-def]
    """A calendar date, from 'YYYY-MM-DD' or from an instant read in the tenant's timezone."""
    if len(value) == 10:
        return date.fromisoformat(value)
    return parse_instant(value).astimezone(timezone).date()

"""BreakdownRecord from packages/mock/src/types.ts, field for field, plus `siteId`.

`siteId` is the one addition: the mock finds a breakdown's site through the
mock vehicle, and the API has no vehicles table to find it through.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import AwareDatetime, StringConstraints

from app.schemas.common import CamelIn, CamelModel, MoneyIn
from app.schemas.expenses import Ref

LiveStatus = Literal["open", "in_workshop"]
BreakdownStatus = Literal["open", "in_workshop", "resolved"]

Line = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Cause = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)]
Who = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=120)]


class BreakdownOut(CamelModel):
    id: uuid.UUID
    number: str
    vehicle_id: str
    driver_id: str | None
    reported_at: datetime
    reported_by: str
    location: str
    cause: str
    status: str
    resolved_at: datetime | None
    #: Hours off the road. Open breakdowns count to now.
    downtime_hours: float | int
    repair_cost: str | None
    site_id: uuid.UUID


class BreakdownIn(CamelIn):
    #: The vehicle's home site: where the register is read and written.
    site_id: uuid.UUID
    vehicle_id: Ref
    driver_id: Ref | None = None
    #: When it broke down; now, if not given.
    reported_at: AwareDatetime | None = None
    #: Who reported it, as told; the signed-in person, if not given.
    reported_by: Who | None = None
    location: Line
    cause: Cause
    status: LiveStatus = "open"


class BreakdownPatch(CamelIn):
    """Omitted fields stay as they are. Resolving is its own move: POST .../resolve."""

    driver_id: Ref | None = None
    reported_at: AwareDatetime | None = None
    reported_by: Who | None = None
    location: Line | None = None
    cause: Cause | None = None
    status: LiveStatus | None = None
    repair_cost: MoneyIn | None = None


class ResolveIn(CamelIn):
    #: Back on the road; now, if not given.
    resolved_at: AwareDatetime | None = None
    repair_cost: MoneyIn | None = None

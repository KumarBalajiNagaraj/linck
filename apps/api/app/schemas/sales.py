"""Customer and PurchaseOrder from packages/mock/src/types.ts, field for field."""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import AwareDatetime, Field, StringConstraints

from app.schemas.common import CamelIn, CamelModel, MoneyIn, QuantityIn

PurchaseOrderStatus = Literal["pending_approval", "approved", "part_dispatched", "fulfilled", "rejected"]

Name = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Short = Annotated[str, StringConstraints(strip_whitespace=True, max_length=200)]
Gstin = Annotated[str, StringConstraints(strip_whitespace=True, to_upper=True, min_length=15, max_length=15)]
Reason = Annotated[str, StringConstraints(max_length=1000)]


class CustomerOut(CamelModel):
    id: uuid.UUID
    name: str
    #: The default delivery site named on orders.
    site: str
    #: Null for walk-in counter sales, which are billed as B2C.
    gstin: str | None
    contact_name: str
    phone: str
    credit_limit: str
    payment_terms_days: int
    #: Primary site we serve them from.
    served_from_site_id: uuid.UUID


class CustomerIn(CamelIn):
    name: Name
    site: Short = ""
    gstin: Gstin | None = None
    contact_name: Short = ""
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] = ""
    credit_limit: MoneyIn = Decimal("0")
    payment_terms_days: Annotated[int, Field(ge=0, le=365)] = 0
    served_from_site_id: uuid.UUID


class CustomerPatch(CamelIn):
    """Omitted fields stay as they are; `gstin: null` makes a customer walk-in."""

    name: Name | None = None
    site: Short | None = None
    gstin: Gstin | None = None
    contact_name: Short | None = None
    phone: Annotated[str, StringConstraints(strip_whitespace=True, max_length=20)] | None = None
    credit_limit: MoneyIn | None = None
    payment_terms_days: Annotated[int, Field(ge=0, le=365)] | None = None
    served_from_site_id: uuid.UUID | None = None


class PurchaseOrderOut(CamelModel):
    id: uuid.UUID
    number: str
    #: The customer's own reference, as written on their PO.
    customer_po_ref: str
    received_on: datetime
    deliver_by: datetime
    customer_id: uuid.UUID
    customer_name: str
    delivery_site: str
    site_id: uuid.UUID
    product_code: str
    ordered_units: float | int
    dispatched_units: float | int
    rate_per_unit: str
    value: str
    status: str
    taken_by: str


class PurchaseOrderIn(CamelIn):
    customer_po_ref: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=60)]
    #: When the order came in; now, if not given.
    received_on: AwareDatetime | None = None
    deliver_by: AwareDatetime
    customer_id: uuid.UUID
    #: Where the tipper goes; the customer's default delivery site if not given.
    delivery_site: Short | None = None
    site_id: uuid.UUID
    product_code: Annotated[str, StringConstraints(pattern=r"^[A-Z0-9_-]{1,32}$")]
    ordered_units: QuantityIn
    rate_per_unit: MoneyIn


class DecisionIn(CamelIn):
    #: Required to reject; optional to approve.
    reason: Reason | None = None

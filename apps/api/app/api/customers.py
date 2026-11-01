"""The customer database: the parties the sales desk sells to.

Customers are rows of master.parties whose roles include `customer`, not a
table of their own: the same firm is often a vendor too, and one master is
what keeps its ledger in one piece.

The customer master is read org-wide, as the screen reads it: "served from"
is a fact about the customer, not a filter. Writes are checked at the site
the customer is served from.
"""

from __future__ import annotations

import re
import uuid

from fastapi import APIRouter, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.access import Access, access_for
from app.api.deps import CurrentSessionDep
from app.api.problems import gone, invalid, needs_permission, refuse
from app.models.core import Site
from app.models.master import Party
from app.schemas.common import money
from app.schemas.sales import CustomerIn, CustomerOut, CustomerPatch

router = APIRouter(prefix="/customers", tags=["sales"])

READ = "sales.customer.read"
WRITE = "sales.customer.write"

_GSTIN_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"


def gstin_is_valid(value: str) -> bool:
    """isValidGstin from packages/domain/src/gstin.ts: the right shape AND the right check character."""
    if not re.fullmatch(r"\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]", value):
        return False
    total = 0
    for i, ch in enumerate(value[:14]):
        product = _GSTIN_ALPHABET.index(ch) * (1 if i % 2 == 0 else 2)
        total += product // 36 + product % 36
    return _GSTIN_ALPHABET[(36 - total % 36) % 36] == value[14]


def customer_out(party: Party) -> CustomerOut:
    return CustomerOut(
        id=party.id,
        name=party.display_name,
        site=party.default_delivery_site,
        gstin=party.gstin,
        contact_name=party.contact_name,
        phone=party.phone,
        credit_limit=money(party.credit_limit),
        payment_terms_days=party.payment_terms_days,
        served_from_site_id=party.served_from_site_id,
    )


def _may_read(access: Access) -> None:
    if not access.can(READ):
        raise needs_permission(READ)


async def _site(db: AsyncSession, access: Access, site_id: uuid.UUID) -> None:
    if not access.can(WRITE, site_id):
        raise needs_permission(WRITE)
    if await db.get(Site, site_id) is None:
        raise invalid("servedFromSiteId", "no such site")


async def _flush(db: AsyncSession, gstin: str | None) -> None:
    try:
        await db.flush()
    except IntegrityError as exc:
        if "uq_parties_organization_id_gstin" in str(exc.orig):
            raise refuse({"code": "gstin-used", "gstin": gstin}) from exc
        raise


async def get_customer_row(db: AsyncSession, customer_id: uuid.UUID) -> Party:
    party = await db.get(Party, customer_id)
    if party is None or "customer" not in party.party_roles:
        raise gone()
    return party


@router.get("", response_model=list[CustomerOut])
async def list_customers(current: CurrentSessionDep) -> list[CustomerOut]:
    _may_read(await access_for(current))
    parties = await current.db.scalars(
        select(Party).where(Party.party_roles.any("customer")).order_by(Party.display_name, Party.id)
    )
    return [customer_out(p) for p in parties]


@router.get("/{customer_id}", response_model=CustomerOut)
async def get_customer(customer_id: uuid.UUID, current: CurrentSessionDep) -> CustomerOut:
    _may_read(await access_for(current))
    return customer_out(await get_customer_row(current.db, customer_id))


@router.post("", response_model=CustomerOut, status_code=status.HTTP_201_CREATED)
async def create_customer(body: CustomerIn, current: CurrentSessionDep) -> CustomerOut:
    access = await access_for(current)
    await _site(current.db, access, body.served_from_site_id)
    if body.gstin is not None and not gstin_is_valid(body.gstin):
        raise invalid("gstin", "not a valid GSTIN")
    party = Party(
        organization_id=current.organization_id,
        display_name=body.name,
        legal_name=body.name,
        party_roles=["customer"],
        gstin=body.gstin,
        contact_name=body.contact_name,
        phone=body.phone,
        default_delivery_site=body.site,
        served_from_site_id=body.served_from_site_id,
        credit_limit=body.credit_limit,
        payment_terms_days=body.payment_terms_days,
    )
    current.db.add(party)
    await _flush(current.db, body.gstin)
    return customer_out(party)


@router.patch("/{customer_id}", response_model=CustomerOut)
async def update_customer(
    customer_id: uuid.UUID, body: CustomerPatch, current: CurrentSessionDep
) -> CustomerOut:
    db = current.db
    access = await access_for(current)
    party = await get_customer_row(db, customer_id)
    if not access.can(WRITE, party.served_from_site_id):
        raise needs_permission(WRITE)
    given = body.model_fields_set
    for field in (
        "name",
        "credit_limit",
        "payment_terms_days",
        "served_from_site_id",
        "site",
        "contact_name",
        "phone",
    ):
        if field in given and getattr(body, field) is None:
            raise invalid(field, "cannot be emptied")
    if body.served_from_site_id is not None and body.served_from_site_id != party.served_from_site_id:
        # Moving a customer to another plant needs the key at both ends.
        await _site(db, access, body.served_from_site_id)
        party.served_from_site_id = body.served_from_site_id
    if "gstin" in given:
        if body.gstin is not None and not gstin_is_valid(body.gstin):
            raise invalid("gstin", "not a valid GSTIN")
        party.gstin = body.gstin
    if body.name is not None:
        party.display_name = body.name
        party.legal_name = body.name
    if body.site is not None:
        party.default_delivery_site = body.site
    if body.contact_name is not None:
        party.contact_name = body.contact_name
    if body.phone is not None:
        party.phone = body.phone
    if body.credit_limit is not None:
        party.credit_limit = body.credit_limit
    if body.payment_terms_days is not None:
        party.payment_terms_days = body.payment_terms_days
    await _flush(db, party.gstin)
    await db.refresh(party)
    return customer_out(party)

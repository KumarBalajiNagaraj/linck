"""Who may do what, where, and the tenant's calendar, for one request.

`require()` in deps.py answers "does this person hold the key anywhere"; the
routes here also need "at THIS site", because site scoping is a property of
the row being touched. `Access.can` is `can()` from
packages/domain/src/permissions.ts, so the screens and the API agree on it.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import UTC, date, datetime, time
from zoneinfo import ZoneInfo

from sqlalchemy import ColumnElement, false, select, text, true, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import CurrentSession, Grant, load_grants
from app.models.core import Organization
from app.models.sales import InvoiceSeries


@dataclass(frozen=True)
class Scope:
    """The sites a set of keys reaches: everywhere, or these."""

    org_wide: bool
    site_ids: frozenset[uuid.UUID]

    @property
    def empty(self) -> bool:
        return not self.org_wide and not self.site_ids

    def covers(self, site_id: uuid.UUID | str) -> bool:
        return self.org_wide or uuid.UUID(str(site_id)) in self.site_ids

    def clause(self, column: ColumnElement[uuid.UUID]) -> ColumnElement[bool]:
        if self.org_wide:
            return true()
        return column.in_(self.site_ids) if self.site_ids else false()


@dataclass(frozen=True)
class Access:
    organization_id: uuid.UUID
    user_id: uuid.UUID
    name: str
    grants: dict[str, Grant]

    @property
    def actor_id(self) -> str:
        """How the four-eyes rule names a signed-in person."""
        return f"user:{self.user_id}"

    def can(self, permission: str, site_id: uuid.UUID | str | None = None) -> bool:
        grant = self.grants.get(permission)
        if grant is None:
            return False
        if grant.org_wide:
            return True
        if site_id is None:
            # No site named: holding the key at ANY site is enough.
            return bool(grant.site_ids)
        return uuid.UUID(str(site_id)) in grant.site_ids

    def scope(self, *permissions: str) -> Scope:
        org_wide = False
        sites: set[uuid.UUID] = set()
        for permission in permissions:
            grant = self.grants.get(permission)
            if grant is None:
                continue
            org_wide = org_wide or grant.org_wide
            sites.update(grant.site_ids)
        return Scope(org_wide=org_wide, site_ids=frozenset(sites))


async def access_for(current: CurrentSession) -> Access:
    return Access(
        organization_id=current.organization_id,
        user_id=current.user.id,
        name=current.user.full_name,
        grants=await load_grants(current.db, current.user.id),
    )


@dataclass(frozen=True)
class TenantCalendar:
    """The tenant settings the records here depend on."""

    timezone: ZoneInfo
    fiscal_year_start_month: int
    #: Segregation of duties enforced as a hard block rather than a review
    #: queue (docs/DATABASE.md): a second signature is refused even with a note.
    hard_block: bool

    def today(self) -> date:
        return datetime.now(tz=self.timezone).date()

    def business_date(self, at: datetime) -> date:
        return at.astimezone(self.timezone).date()

    def midnight(self, day: date) -> datetime:
        """The instant a calendar date starts here, in UTC, as the screens carry a bill date."""
        return datetime.combine(day, time(0), tzinfo=self.timezone).astimezone(UTC)

    def financial_year(self, day: date) -> str:
        """'26-27' for any date in April 2026 to March 2027 (for an April start)."""
        if self.fiscal_year_start_month == 1:
            return f"{day.year % 100:02d}"
        start = day.year if day.month >= self.fiscal_year_start_month else day.year - 1
        return f"{start % 100:02d}-{(start + 1) % 100:02d}"


async def calendar_for(current: CurrentSession) -> TenantCalendar:
    org = (
        await current.db.scalars(select(Organization).where(Organization.id == current.organization_id))
    ).one()
    return TenantCalendar(
        timezone=ZoneInfo(org.timezone),
        fiscal_year_start_month=org.fiscal_year_start_month,
        hard_block=org.segregation_enforcement == "hard_block",
    )


async def next_serial(db: AsyncSession, table: str, organization_id: uuid.UUID, financial_year: str) -> int:
    """The next number in a per-tenant, per-year internal series (SO/26-27/007).

    A transaction-scoped advisory lock serialises the two people raising an
    order at the same moment; the UNIQUE (organization_id, financial_year,
    serial) behind it is the backstop. `table` is one of ours, never input.
    """
    await db.execute(
        text("select pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"{table}:{organization_id}:{financial_year}"},
    )
    current = (
        await db.execute(
            text(f"select coalesce(max(serial), 0) from {table} where financial_year = :fy"),
            {"fy": financial_year},
        )
    ).scalar_one()
    return int(current) + 1


async def next_invoice_serial(
    db: AsyncSession, organization_id: uuid.UUID, gst_registration_id: uuid.UUID, financial_year: str
) -> tuple[uuid.UUID, int]:
    """The next number of a GSTIN's statutory series for a financial year (LIN-27): (series id, serial).

    next_serial's sibling, for the series GST keeps per GSTIN rather than per
    tenant. The same transaction-scoped advisory lock serialises two people
    issuing at once, with UNIQUE (series, serial) on sales.invoices behind it.
    The count lives on the series row, not in max(serial), so a number once
    taken is never handed out again, and it is taken inside the transaction
    that issues the invoice, so an issue that fails gives its number back: no
    gap and no duplicate.
    """
    await db.execute(
        text("select pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": f"sales.invoice_series:{organization_id}:{gst_registration_id}:{financial_year}"},
    )
    await db.execute(
        insert(InvoiceSeries)
        .values(
            organization_id=organization_id,
            gst_registration_id=gst_registration_id,
            financial_year=financial_year,
        )
        .on_conflict_do_nothing(index_elements=["organization_id", "gst_registration_id", "financial_year"])
    )
    row = (
        await db.execute(
            update(InvoiceSeries)
            .where(
                InvoiceSeries.gst_registration_id == gst_registration_id,
                InvoiceSeries.financial_year == financial_year,
            )
            .values(last_serial=InvoiceSeries.last_serial + 1)
            .returning(InvoiceSeries.id, InvoiceSeries.last_serial)
        )
    ).one()
    return row.id, int(row.last_serial)

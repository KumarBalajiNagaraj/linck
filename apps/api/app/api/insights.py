"""The owner's industry news (LIN-10): read the newest digest, or build a new one.

    GET  /insights/industry           the newest digest, and whether it is stale (older than 7 days)
    POST /insights/industry/refresh   build and keep a new one; at most once an hour per organization

Both under executive.dashboard.read: the screen sits in the Overview workspace
beside the owner's dashboard. A refresh is the one thing here that costs
something — eight feed fetches and, with a model configured, a call that uses
up a free tier's quota — so it is limited per organization, not per person,
and a second refresh while one is still running is turned away, not queued.

Refusals are codes the screen words (see app/api/problems.py):

    429 {"problem": {"code": "too-soon", "retryAfterSeconds": n, "nextRefreshAt": t}}, with Retry-After
    429 {"problem": {"code": "refresh-running", "retryAfterSeconds": n}}, with Retry-After
    502 {"problem": {"code": "news-unavailable"}}      no news feed could be read
"""

from __future__ import annotations

import logging
import math
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import ValidationError
from sqlalchemy import text

from app.api.deps import CurrentSession, require
from app.core.settings import get_settings
from app.integrations.news import NewsUnavailable
from app.models.ai import IndustryDigest
from app.schemas.insights import DigestItem, IndustryDigestOut, IndustryNewsOut
from app.services.industry_digest import (
    REFRESH_EVERY,
    STALE_AFTER,
    build_digest,
    latest_digest,
    save_digest,
)

log = logging.getLogger("linck.insights")

router = APIRouter(prefix="/insights", tags=["insights"])

READ = "executive.dashboard.read"
ReadDep = Annotated[CurrentSession, Depends(require(READ))]

# Held until the request's transaction ends: one refresh at a time per organization.
REFRESH_LOCK = text("select pg_try_advisory_xact_lock(hashtextextended('linck.industry_digest:' || :org, 0))")
# What a refresh that is still running is given to finish.
RUNNING_RETRY_SECONDS = 60


def http_transport() -> httpx.AsyncBaseTransport | None:
    """The network a refresh reads from: None is the real one. Tests put httpx.MockTransport here."""
    return None


TransportDep = Annotated[httpx.AsyncBaseTransport | None, Depends(http_transport)]


@router.get("/industry", response_model=IndustryNewsOut)
async def industry_news(current: ReadDep) -> IndustryNewsOut:
    latest = await latest_digest(current.db, current.organization_id)
    return news_out(latest, datetime.now(UTC))


@router.post("/industry/refresh", response_model=IndustryNewsOut)
async def refresh_industry_news(current: ReadDep, transport: TransportDep) -> IndustryNewsOut:
    db = current.db
    if not (await db.execute(REFRESH_LOCK, {"org": str(current.organization_id)})).scalar_one():
        raise _too_soon("refresh-running", RUNNING_RETRY_SECONDS)

    now = datetime.now(UTC)
    latest = await latest_digest(db, current.organization_id)
    if latest is not None and now < latest.created_at + REFRESH_EVERY:
        next_at = latest.created_at + REFRESH_EVERY
        raise _too_soon("too-soon", math.ceil((next_at - now).total_seconds()), next_at)

    try:
        async with httpx.AsyncClient(transport=transport) as http:
            digest = await build_digest(get_settings(), http, now=now)
    except NewsUnavailable as exc:
        log.warning("industry news for %s: %s", current.organization_id, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail={"problem": {"code": "news-unavailable"}}
        ) from exc
    row = await save_digest(db, current.organization_id, digest, requested_by=current.user.id)
    return news_out(row, datetime.now(UTC))


def _too_soon(code: str, seconds: int, next_at: datetime | None = None) -> HTTPException:
    problem: dict[str, Any] = {"code": code, "retryAfterSeconds": seconds}
    if next_at is not None:
        problem["nextRefreshAt"] = next_at.isoformat()
    return HTTPException(
        status_code=status.HTTP_429_TOO_MANY_REQUESTS,
        detail={"problem": problem},
        headers={"Retry-After": str(seconds)},
    )


def news_out(row: IndustryDigest | None, now: datetime) -> IndustryNewsOut:
    if row is None:
        return IndustryNewsOut(digest=None, stale=True, next_refresh_at=None)
    next_at = row.created_at + REFRESH_EVERY
    return IndustryNewsOut(
        digest=IndustryDigestOut(
            id=row.id,
            created_at=row.created_at,
            status=row.status,
            model=row.model,
            headlines_read=len(row.headlines),
            items=_items(row),
        ),
        stale=now - row.created_at > STALE_AFTER,
        next_refresh_at=next_at if next_at > now else None,
    )


def _items(row: IndustryDigest) -> list[DigestItem]:
    items = []
    for raw in row.items:
        try:
            items.append(DigestItem.model_validate(raw))
        except ValidationError:
            log.warning("industry digest %s holds an item this version cannot read; skipped", row.id)
    return items

"""The industry news digest on the wire (LIN-10), camelCase like every other shape.

    {"digest": {"id", "createdAt", "status", "model", "headlinesRead",
                "items": [{"title", "source", "publishedAt", "link",
                           "summary": {"en", "ta"} | null, "why": {"en", "ta"} | null}]} | null,
     "stale": bool, "nextRefreshAt": instant | null}

`DigestItem` is also what `ai.industry_digests.items` holds, by field name.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from app.schemas.common import CamelModel

DigestStatus = Literal["summarised", "ai_off", "ai_failed"]


class Both(CamelModel):
    """One line in each of the screen's two languages."""

    en: str
    ta: str


class DigestItem(CamelModel):
    """One piece of news. `link` is always one the feed gave.

    `summary` and `why` are null when no model wrote them; then `title`, the
    headline as the paper printed it, is the whole item.
    """

    title: str
    source: str
    published_at: datetime
    link: str
    summary: Both | None = None
    why: Both | None = None


class IndustryDigestOut(CamelModel):
    id: uuid.UUID
    created_at: datetime
    status: DigestStatus
    #: The model that wrote the lines; null when none did.
    model: str | None
    #: How many headlines the items were picked from.
    headlines_read: int
    items: list[DigestItem]


class IndustryNewsOut(CamelModel):
    digest: IndustryDigestOut | None
    #: True when there is no digest from the last 7 days.
    stale: bool
    #: When a refresh will next be accepted; null means now.
    next_refresh_at: datetime | None

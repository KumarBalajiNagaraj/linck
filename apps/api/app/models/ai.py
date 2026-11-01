"""What a model wrote, kept so it can be traced (docs/DATABASE.md, the `ai` schema).

Only the industry news digest so far (LIN-10).
"""

import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, Index, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, created_at, org_fk, pk, tenant_fk

SCHEMA = "ai"

#: summarised — a model picked the items and wrote their lines.
#: ai_off     — no model is configured; the items are the top headlines by keyword.
#: ai_failed  — the model was asked and gave nothing usable; the same keyword fallback.
DIGEST_STATUSES = ("summarised", "ai_off", "ai_failed")


class IndustryDigest(Base):
    """One build of a tenant's industry news digest.

    Kept whole, so a line on the screen can be traced back to what produced it:
    the headlines the model was given (`headlines`, numbered as in the prompt),
    its reply as it came back (`reply`), what survived checking (`items`), the
    model and the prompt version, and when. `model` is set only when a model
    wrote the items.
    """

    __tablename__ = "industry_digests"
    __table_args__ = (
        UniqueConstraint("organization_id", "id"),
        tenant_fk("requested_by", "core.users"),
        # The screen reads the newest digest; the refresh limit reads its time.
        Index("ix_industry_digests_latest", "organization_id", "created_at"),
        CheckConstraint(
            "status in (" + ", ".join(f"'{s}'" for s in DIGEST_STATUSES) + ")", name="status_known"
        ),
        # A model's name on the row means a model wrote these items, and only then.
        CheckConstraint("(model IS NOT NULL) = (status = 'summarised')", name="model_only_when_summarised"),
        CheckConstraint(
            "(prompt_version IS NULL) = (status = 'ai_off')", name="prompt_when_a_model_was_asked"
        ),
        CheckConstraint("jsonb_typeof(items) = 'array'", name="items_is_array"),
        CheckConstraint("jsonb_typeof(headlines) = 'array'", name="headlines_is_array"),
        {"schema": SCHEMA},
    )

    id: Mapped[uuid.UUID] = pk()
    organization_id: Mapped[uuid.UUID] = org_fk()
    status: Mapped[str] = mapped_column(Text, nullable=False)
    model: Mapped[str | None] = mapped_column(Text)
    prompt_version: Mapped[str | None] = mapped_column(Text)
    items: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    headlines: Mapped[list] = mapped_column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    reply: Mapped[str | None] = mapped_column(Text)
    error: Mapped[str | None] = mapped_column(Text)
    # Who pressed Refresh. NULL for a build nobody asked for, such as a scheduled one.
    requested_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True))
    created_at: Mapped[datetime] = created_at()

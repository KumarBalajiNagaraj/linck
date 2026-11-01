import uuid
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, MetaData, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

#: Every schema docs/DATABASE.md names. The boot-time RLS posture check, the
#: invariant lint and Alembic's autogenerate scope all read this one tuple, so a
#: table in a schema nobody migrated yet is still covered the day it appears.
#: `reporting` holds views only; a table there is checked like any other.
BUSINESS_SCHEMAS = (
    "core",
    "master",
    "fleet",
    "inventory",
    "production",
    "procurement",
    "logistics",
    "sales",
    "finance",
    "compliance",
    "ai",
    "reporting",
)

# Naming convention so Alembic autogenerate produces stable, readable object
# names instead of anonymous ones it later fails to drop.
NAMING = {
    "ix": "ix_%(column_0_N_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_N_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING)


def pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))


def created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


def updated_at() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


def org_fk(nullable: bool = False) -> Mapped[uuid.UUID]:
    """Every business table carries this. RLS resolves on it, and the invariant
    lint in CI fails any table in a business schema that lacks it."""
    return mapped_column(
        UUID(as_uuid=True),
        ForeignKey("core.organizations.id", ondelete="RESTRICT"),
        nullable=nullable,
        index=True,
    )


def tenant_fk(column: str, target: str) -> ForeignKeyConstraint:
    """`(organization_id, column) -> target (organization_id, id)`.

    The composite key is what makes a cross-tenant reference unrepresentable: a
    row in one tenant cannot point at another tenant's site, user or bill, even
    by a bug that knows the other row's id. Every target carries
    `UNIQUE (organization_id, id)` for this. A nullable `column` is simply not
    checked while it is NULL (MATCH SIMPLE).
    """
    return ForeignKeyConstraint(
        ["organization_id", column],
        [f"{target}.organization_id", f"{target}.id"],
        ondelete="RESTRICT",
    )

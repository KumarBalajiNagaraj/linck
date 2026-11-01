"""ai.industry_digests: the industry news digest, kept so it can be traced

LIN-10. The owner's "Industry news" screen says what is happening in the
customers' trade: building and real estate near Chennai, road and highway work
and tenders, M-Sand and cement prices, quarry and sand-mining rules, the
monsoon. Each refresh reads Google News headlines, has a model pick up to six
and write one plain line about each in English and in Tamil, and keeps the
result here, with what makes it traceable: the headlines the model read, its
reply as given, the items that survived checking, which model wrote them, with
which prompt version, and when. With no model configured the items are the top
headlines by keyword, and `model` is NULL.

The first table in the `ai` schema docs/DATABASE.md names. The schema gets
what 0011 gave master, sales, fleet and finance: USAGE for linck_app, and DML
on its tables through default privileges, also granted on the table itself so
it holds where the migration runs as a role other than linck_migrator. The
table is a tenant table like core's: organization_id, RLS enabled AND forced
with the same tenant_isolation policy, UNIQUE (organization_id, id), a
composite tenant FK to the user who asked, and the generic audit trigger.

Revision ID: 0020_industry_news
Revises: 0012_whatsapp_names
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0020_industry_news"
down_revision: str | None = "0012_whatsapp_names"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SCHEMA = "ai"
TABLE = "industry_digests"


def _if_app_role(statements: str) -> None:
    """Grants to linck_app, skipped where the role does not exist, as 0002 and 0011 do."""
    op.execute(
        f"""
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'linck_app') THEN
                {statements}
            END IF;
        END
        $$
        """
    )


def _check(name: str, sql: str) -> sa.CheckConstraint:
    return sa.CheckConstraint(sql, name=op.f(f"ck_{TABLE}_{name}"))


def upgrade() -> None:
    # Default privileges before the table, as in 0011, so later ai tables made
    # by the same role are granted on creation too.
    op.execute(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")
    _if_app_role(
        f"""
            GRANT USAGE ON SCHEMA {SCHEMA} TO linck_app;
            ALTER DEFAULT PRIVILEGES IN SCHEMA {SCHEMA}
                GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO linck_app;
            ALTER DEFAULT PRIVILEGES IN SCHEMA {SCHEMA}
                GRANT USAGE, SELECT ON SEQUENCES TO linck_app;
        """
    )

    op.create_table(
        TABLE,
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), nullable=False),
        sa.Column("model", sa.Text(), nullable=True),
        sa.Column("prompt_version", sa.Text(), nullable=True),
        sa.Column(
            "items",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column(
            "headlines",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("reply", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("requested_by", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        _check("status_known", "status in ('summarised', 'ai_off', 'ai_failed')"),
        # A model's name on the row means a model wrote these items, and only then.
        _check("model_only_when_summarised", "(model IS NOT NULL) = (status = 'summarised')"),
        _check("prompt_when_a_model_was_asked", "(prompt_version IS NULL) = (status = 'ai_off')"),
        _check("items_is_array", "jsonb_typeof(items) = 'array'"),
        _check("headlines_is_array", "jsonb_typeof(headlines) = 'array'"),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f(f"fk_{TABLE}_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "requested_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f(f"fk_{TABLE}_organization_id_requested_by"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{TABLE}")),
        sa.UniqueConstraint("organization_id", "id", name=op.f(f"uq_{TABLE}_organization_id_id")),
        schema=SCHEMA,
    )
    op.create_index(
        op.f(f"ix_{SCHEMA}_{TABLE}_organization_id"), TABLE, ["organization_id"], unique=False, schema=SCHEMA
    )
    op.create_index("ix_industry_digests_latest", TABLE, ["organization_id", "created_at"], schema=SCHEMA)

    table = f"{SCHEMA}.{TABLE}"
    # FORCE is the part that matters: without it the table's owner bypasses
    # every policy, silently.
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"""
        CREATE POLICY tenant_isolation ON {table}
            USING (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
            WITH CHECK (organization_id = nullif(current_setting('app.current_org_id', true), '')::uuid)
        """
    )
    op.execute(
        f"""
        CREATE TRIGGER audit_{TABLE}
        AFTER INSERT OR UPDATE OR DELETE ON {table}
        FOR EACH ROW EXECUTE FUNCTION core.write_audit_log()
        """
    )
    _if_app_role(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO linck_app;")


def downgrade() -> None:
    # Dropping the table drops its policy, trigger, indexes and grants with it.
    op.execute(f"DROP TABLE {SCHEMA}.{TABLE}")
    _if_app_role(
        f"""
            ALTER DEFAULT PRIVILEGES IN SCHEMA {SCHEMA}
                REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM linck_app;
            ALTER DEFAULT PRIVILEGES IN SCHEMA {SCHEMA}
                REVOKE USAGE, SELECT ON SEQUENCES FROM linck_app;
        """
    )
    # Not CASCADE, as in 0011: anything else living in `ai` by now should stop this.
    op.execute(f"DROP SCHEMA {SCHEMA}")

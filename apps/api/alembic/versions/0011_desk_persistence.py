"""customers, orders, breakdowns, expense bills, files and WhatsApp imports

LIN-20. The customer, purchase-order, breakdown and expense screens ran on
seeded mock data, so a refresh lost every upload, correction, approval and
payment. These tables keep them, each in the schema docs/DATABASE.md names:

    core.files                       a stored upload (bill scans), bytes on disk by SHA-256
    master.parties                   one party master; customers are role 'customer'
    sales.purchase_orders            customer orders, with the approval decision
    fleet.breakdowns                 the breakdown register
    finance.payments                 money out; UTR unique per tenant          APPEND-ONLY
    finance.whatsapp_import_batches  one row per import of driver slips
    finance.whatsapp_import_claims   one row per imported message; claim_key unique
    finance.expense_bills            the bill and where it is in the chain
    finance.expense_bill_fields      capture record: read vs final value, who corrected it
    finance.expense_bill_events      every move along the chain                APPEND-ONLY

Every one of them is a tenant table like core's: organization_id, RLS enabled
AND forced with the same tenant_isolation policy, UNIQUE (organization_id, id)
with composite tenant foreign keys, and the generic audit trigger. Money is
numeric(18,2), litres numeric(12,3), times timestamptz.

The four new schemas get exactly what init-roles.sql gives linck_app on core:
USAGE, and DML on tables (USAGE, SELECT on sequences) through default
privileges. The grants are also made explicitly per table, so they hold even
where the migration runs as a role other than linck_migrator. The two
append-only tables then lose UPDATE and DELETE, like core.audit_logs.

Two permission keys are added because no existing key covers the write:
sales.customer.write (add and edit customers) and sales.order.write (record a
customer order). Breakdowns are written under the existing fleet.vehicle.write.
Downgrade refuses (foreign-key violation) while any role still holds one.

Revision ID: 0011_desk_persistence
Revises: 0010_expense_approval
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011_desk_persistence"
down_revision: str | None = "0010_expense_approval"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_SCHEMAS = ("master", "sales", "fleet", "finance")

# Parents before children; downgrade walks it backwards.
TENANT_TABLES = (
    "core.files",
    "master.parties",
    "sales.purchase_orders",
    "fleet.breakdowns",
    "finance.payments",
    "finance.whatsapp_import_batches",
    "finance.whatsapp_import_claims",
    "finance.expense_bills",
    "finance.expense_bill_fields",
    "finance.expense_bill_events",
)

# INSERT and SELECT only, for the app role: a payment and a signature, once
# recorded, are corrected by a further row, never by editing this one.
APPEND_ONLY = ("finance.payments", "finance.expense_bill_events")

KEYS = ("sales.customer.write", "sales.order.write")

STATUSES = "('submitted', 'validated', 'approved', 'passed', 'paid', 'rejected', 'deleted')"


def _if_app_role(statements: str) -> None:
    """Grants to linck_app, skipped where the role does not exist (a Homebrew
    database before init-roles.sql), exactly as 0002 does it."""
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


def _id_and_org() -> list[sa.Column]:
    return [
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
    ]


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
    ]


def _tenant_keys(table: str) -> list[sa.Constraint]:
    """The primary key, the organization FK and the UNIQUE (organization_id, id)
    that every composite tenant FK targets."""
    return [
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f(f"fk_{table}_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f(f"pk_{table}")),
        sa.UniqueConstraint("organization_id", "id", name=op.f(f"uq_{table}_organization_id_id")),
    ]


def _tenant_fk(table: str, column: str, target: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["organization_id", column],
        [f"{target}.organization_id", f"{target}.id"],
        name=op.f(f"fk_{table}_organization_id_{column}"),
        ondelete="RESTRICT",
    )


def _check(table: str, name: str, sql: str) -> sa.CheckConstraint:
    return sa.CheckConstraint(sql, name=op.f(f"ck_{table}_{name}"))


def _org_index(schema: str, table: str) -> None:
    op.create_index(
        op.f(f"ix_{schema}_{table}_organization_id"), table, ["organization_id"], unique=False, schema=schema
    )


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Schemas, and what the app role may do in them
    # ------------------------------------------------------------------
    # Default privileges come BEFORE the tables, so every table created below
    # (and by later migrations, by the same role) is granted on creation.
    for schema in NEW_SCHEMAS:
        op.execute(f"CREATE SCHEMA IF NOT EXISTS {schema}")
        _if_app_role(
            f"""
                GRANT USAGE ON SCHEMA {schema} TO linck_app;
                ALTER DEFAULT PRIVILEGES IN SCHEMA {schema}
                    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO linck_app;
                ALTER DEFAULT PRIVILEGES IN SCHEMA {schema}
                    GRANT USAGE, SELECT ON SEQUENCES TO linck_app;
            """
        )

    # ------------------------------------------------------------------
    # core.files
    # ------------------------------------------------------------------
    op.create_table(
        "files",
        *_id_and_org(),
        sa.Column("purpose", sa.Text(), nullable=False),
        sa.Column("sha256", sa.Text(), nullable=False),
        sa.Column("mime_type", sa.Text(), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("original_name", sa.Text(), nullable=False),
        sa.Column("uploaded_by", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        _check("files", "purpose_known", "purpose in ('expense_bill')"),
        _check("files", "sha256_hex", "sha256 ~ '^[0-9a-f]{64}$'"),
        _check(
            "files",
            "mime_type_allowed",
            "mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')",
        ),
        _check("files", "size_positive", "size_bytes > 0"),
        _tenant_fk("files", "uploaded_by", "core.users"),
        *_tenant_keys("files"),
        schema="core",
    )
    _org_index("core", "files")

    # ------------------------------------------------------------------
    # master.parties
    # ------------------------------------------------------------------
    op.create_table(
        "parties",
        *_id_and_org(),
        sa.Column("display_name", sa.Text(), nullable=False),
        sa.Column("legal_name", sa.Text(), nullable=False),
        sa.Column("party_roles", postgresql.ARRAY(sa.Text()), nullable=False),
        sa.Column("gstin", sa.String(length=15), nullable=True),
        sa.Column("contact_name", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("phone", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("default_delivery_site", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("served_from_site_id", sa.UUID(), nullable=False),
        sa.Column(
            "credit_limit", sa.Numeric(precision=18, scale=2), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("credit_enforcement", sa.Text(), server_default=sa.text("'warn'"), nullable=False),
        sa.Column("payment_terms_days", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'active'"), nullable=False),
        *_timestamps(),
        _check(
            "parties",
            "party_roles_known",
            "cardinality(party_roles) > 0 AND party_roles <@ ARRAY['customer', 'vendor', 'transporter', "
            "'lender', 'statutory_authority', 'broker', 'employee_payee']::text[]",
        ),
        _check(
            "parties",
            "gstin_shape",
            "gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'",
        ),
        _check("parties", "credit_limit_not_negative", "credit_limit >= 0"),
        _check(
            "parties",
            "credit_enforcement_known",
            "credit_enforcement in ('warn','block','block_with_override')",
        ),
        _check("parties", "payment_terms_not_negative", "payment_terms_days >= 0"),
        _check("parties", "status_known", "status in ('active','inactive')"),
        _tenant_fk("parties", "served_from_site_id", "core.sites"),
        *_tenant_keys("parties"),
        schema="master",
    )
    _org_index("master", "parties")
    op.create_index(
        "uq_parties_organization_id_gstin",
        "parties",
        ["organization_id", "gstin"],
        unique=True,
        schema="master",
        postgresql_where=sa.text("gstin IS NOT NULL"),
    )

    # ------------------------------------------------------------------
    # sales.purchase_orders
    # ------------------------------------------------------------------
    op.create_table(
        "purchase_orders",
        *_id_and_org(),
        sa.Column("financial_year", sa.Text(), nullable=False),
        sa.Column("serial", sa.Integer(), nullable=False),
        sa.Column("number", sa.Text(), nullable=False),
        sa.Column("customer_po_ref", sa.Text(), nullable=False),
        sa.Column("customer_party_id", sa.UUID(), nullable=False),
        sa.Column("site_id", sa.UUID(), nullable=False),
        sa.Column("delivery_site", sa.Text(), nullable=False),
        sa.Column("product_code", sa.Text(), nullable=False),
        sa.Column("ordered_units", sa.Numeric(precision=12, scale=3), nullable=False),
        sa.Column(
            "dispatched_units", sa.Numeric(precision=12, scale=3), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("rate_per_unit", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("value", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("received_on", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deliver_by", sa.DateTime(timezone=True), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'pending_approval'"), nullable=False),
        sa.Column("taken_by", sa.UUID(), nullable=False),
        sa.Column("taken_by_name", sa.Text(), nullable=False),
        sa.Column("decided_by", sa.UUID(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("decision_reason", sa.Text(), nullable=True),
        *_timestamps(),
        _check(
            "purchase_orders",
            "status_known",
            "status in ('pending_approval', 'approved', 'part_dispatched', 'fulfilled', 'rejected')",
        ),
        _check("purchase_orders", "serial_positive", "serial > 0"),
        _check("purchase_orders", "ordered_units_positive", "ordered_units > 0"),
        _check(
            "purchase_orders",
            "dispatched_within_order",
            "dispatched_units >= 0 AND dispatched_units <= ordered_units",
        ),
        _check("purchase_orders", "rate_positive", "rate_per_unit > 0"),
        _check(
            "purchase_orders", "value_is_units_times_rate", "value = round(ordered_units * rate_per_unit, 2)"
        ),
        _check(
            "purchase_orders",
            "decision_recorded",
            "(status = 'pending_approval') = (decided_at IS NULL) "
            "AND (decided_at IS NULL) = (decided_by IS NULL)",
        ),
        _check(
            "purchase_orders", "rejection_has_reason", "status <> 'rejected' OR decision_reason IS NOT NULL"
        ),
        _tenant_fk("purchase_orders", "customer_party_id", "master.parties"),
        _tenant_fk("purchase_orders", "site_id", "core.sites"),
        _tenant_fk("purchase_orders", "taken_by", "core.users"),
        _tenant_fk("purchase_orders", "decided_by", "core.users"),
        *_tenant_keys("purchase_orders"),
        sa.UniqueConstraint(
            "organization_id", "number", name=op.f("uq_purchase_orders_organization_id_number")
        ),
        sa.UniqueConstraint(
            "organization_id",
            "financial_year",
            "serial",
            name=op.f("uq_purchase_orders_organization_id_financial_year_serial"),
        ),
        schema="sales",
    )
    _org_index("sales", "purchase_orders")
    op.create_index(
        "ix_purchase_orders_status",
        "purchase_orders",
        ["organization_id", "status"],
        unique=False,
        schema="sales",
    )

    # ------------------------------------------------------------------
    # fleet.breakdowns
    # ------------------------------------------------------------------
    op.create_table(
        "breakdowns",
        *_id_and_org(),
        sa.Column("financial_year", sa.Text(), nullable=False),
        sa.Column("serial", sa.Integer(), nullable=False),
        sa.Column("number", sa.Text(), nullable=False),
        sa.Column("site_id", sa.UUID(), nullable=False),
        sa.Column("vehicle_ref", sa.Text(), nullable=False),
        sa.Column("driver_ref", sa.Text(), nullable=True),
        sa.Column("reported_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("reported_by", sa.Text(), nullable=False),
        sa.Column("location", sa.Text(), nullable=False),
        sa.Column("cause", sa.Text(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'open'"), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_by", sa.UUID(), nullable=True),
        sa.Column("repair_cost", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("recorded_by", sa.UUID(), nullable=False),
        *_timestamps(),
        _check("breakdowns", "status_known", "status in ('open', 'in_workshop', 'resolved')"),
        _check("breakdowns", "serial_positive", "serial > 0"),
        _check(
            "breakdowns",
            "resolution_recorded",
            "(status = 'resolved') = (resolved_at IS NOT NULL) "
            "AND (resolved_at IS NULL) = (resolved_by IS NULL)",
        ),
        _check("breakdowns", "resolved_after_reported", "resolved_at IS NULL OR resolved_at >= reported_at"),
        _check("breakdowns", "repair_cost_not_negative", "repair_cost IS NULL OR repair_cost >= 0"),
        _tenant_fk("breakdowns", "site_id", "core.sites"),
        _tenant_fk("breakdowns", "recorded_by", "core.users"),
        _tenant_fk("breakdowns", "resolved_by", "core.users"),
        *_tenant_keys("breakdowns"),
        sa.UniqueConstraint("organization_id", "number", name=op.f("uq_breakdowns_organization_id_number")),
        sa.UniqueConstraint(
            "organization_id",
            "financial_year",
            "serial",
            name=op.f("uq_breakdowns_organization_id_financial_year_serial"),
        ),
        schema="fleet",
    )
    _org_index("fleet", "breakdowns")
    # A vehicle is down at most once at a time.
    op.create_index(
        "uq_breakdowns_one_open_per_vehicle",
        "breakdowns",
        ["organization_id", "vehicle_ref"],
        unique=True,
        schema="fleet",
        postgresql_where=sa.text("status <> 'resolved'"),
    )

    # ------------------------------------------------------------------
    # finance.payments
    # ------------------------------------------------------------------
    op.create_table(
        "payments",
        *_id_and_org(),
        sa.Column("direction", sa.Text(), server_default=sa.text("'outbound'"), nullable=False),
        sa.Column("payment_date", sa.Date(), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("reference_no", sa.Text(), nullable=True),
        sa.Column("status", sa.Text(), server_default=sa.text("'recorded'"), nullable=False),
        sa.Column("recorded_by", sa.UUID(), nullable=False),
        sa.Column("recorded_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        _check("payments", "direction_known", "direction in ('inbound','outbound')"),
        _check("payments", "method_known", "method in ('neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash')"),
        _check(
            "payments",
            "status_known",
            "status in ('draft', 'pending_approval', 'approved', 'issued', 'recorded', "
            "'pending_verification', 'verified', 'cleared', 'bounced', 'reversed', 'cancelled')",
        ),
        _check("payments", "amount_positive", "amount > 0"),
        _check("payments", "reference_unless_cash", "(method = 'cash') = (reference_no IS NULL)"),
        _check("payments", "reference_no_shape", "reference_no IS NULL OR reference_no ~ '^[A-Z0-9]{6,22}$'"),
        _tenant_fk("payments", "recorded_by", "core.users"),
        *_tenant_keys("payments"),
        schema="finance",
    )
    _org_index("finance", "payments")
    # The same UTR may never be claimed twice.
    op.create_index(
        "uq_payments_organization_id_reference_no",
        "payments",
        ["organization_id", "reference_no"],
        unique=True,
        schema="finance",
        postgresql_where=sa.text("reference_no IS NOT NULL"),
    )

    # ------------------------------------------------------------------
    # finance.whatsapp_import_batches and finance.whatsapp_import_claims
    # ------------------------------------------------------------------
    op.create_table(
        "whatsapp_import_batches",
        *_id_and_org(),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("via", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("claims_received", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("claims_imported", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("claims_skipped", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("imported_by", sa.UUID(), nullable=False),
        sa.Column("imported_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        _check("whatsapp_import_batches", "source_known", "source in ('inbox', 'export')"),
        _check(
            "whatsapp_import_batches",
            "counts_add_up",
            "claims_imported >= 0 AND claims_skipped >= 0 "
            "AND claims_received = claims_imported + claims_skipped",
        ),
        _tenant_fk("whatsapp_import_batches", "imported_by", "core.users"),
        *_tenant_keys("whatsapp_import_batches"),
        schema="finance",
    )
    _org_index("finance", "whatsapp_import_batches")

    op.create_table(
        "whatsapp_import_claims",
        *_id_and_org(),
        sa.Column("batch_id", sa.UUID(), nullable=False),
        sa.Column("claim_key", sa.Text(), nullable=False),
        sa.Column("sender", sa.Text(), nullable=False),
        sa.Column("posted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("message", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("attachments", postgresql.ARRAY(sa.Text()), server_default=sa.text("'{}'"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        _tenant_fk("whatsapp_import_claims", "batch_id", "finance.whatsapp_import_batches"),
        *_tenant_keys("whatsapp_import_claims"),
        # The de-duplication: the same message is never imported twice.
        sa.UniqueConstraint(
            "organization_id", "claim_key", name=op.f("uq_whatsapp_import_claims_organization_id_claim_key")
        ),
        schema="finance",
    )
    _org_index("finance", "whatsapp_import_claims")

    # ------------------------------------------------------------------
    # finance.expense_bills
    # ------------------------------------------------------------------
    op.create_table(
        "expense_bills",
        *_id_and_org(),
        sa.Column("desk", sa.Text(), nullable=False),
        sa.Column("site_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("bill_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("bill_date", sa.Date(), nullable=False),
        sa.Column("vendor", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("description", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("vehicle_ref", sa.Text(), nullable=True),
        sa.Column("driver_ref", sa.Text(), nullable=True),
        sa.Column("litres", sa.Numeric(precision=12, scale=3), nullable=True),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'submitted'"), nullable=False),
        sa.Column("provenance", sa.Text(), nullable=False),
        sa.Column("submitted_by_ref", sa.Text(), nullable=False),
        sa.Column("submitted_by_name", sa.Text(), nullable=False),
        sa.Column(
            "submitted_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column("attachment_file_id", sa.UUID(), nullable=True),
        sa.Column("capture_engine", sa.Text(), nullable=True),
        sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "capture_warnings",
            postgresql.JSONB(astext_type=sa.Text()),
            server_default=sa.text("'[]'::jsonb"),
            nullable=False,
        ),
        sa.Column("whatsapp_claim_id", sa.UUID(), nullable=True),
        sa.Column("payment_id", sa.UUID(), nullable=True),
        *_timestamps(),
        _check("expense_bills", "desk_known", "desk in ('fleet', 'stores')"),
        _check(
            "expense_bills", "kind_known", "kind in ('diesel', 'repair', 'tyre', 'spares', 'toll', 'other')"
        ),
        _check(
            "expense_bills", "stores_kinds", "desk = 'fleet' OR kind in ('spares', 'tyre', 'repair', 'other')"
        ),
        _check("expense_bills", "status_known", f"status in {STATUSES}"),
        _check(
            "expense_bills",
            "provenance_known",
            "provenance in ('human', 'proposed', 'confirmed', 'overridden', 'device')",
        ),
        _check("expense_bills", "amount_positive", "amount > 0"),
        _check("expense_bills", "litres_on_diesel", "litres IS NULL OR (litres > 0 AND kind = 'diesel')"),
        _check(
            "expense_bills",
            "stores_has_no_vehicle",
            "desk = 'fleet' OR (vehicle_ref IS NULL AND driver_ref IS NULL)",
        ),
        _check("expense_bills", "capture_complete", "(capture_engine IS NULL) = (captured_at IS NULL)"),
        _check("expense_bills", "warnings_are_a_list", "jsonb_typeof(capture_warnings) = 'array'"),
        _check("expense_bills", "paid_has_payment", "(status = 'paid') = (payment_id IS NOT NULL)"),
        _check(
            "expense_bills",
            "whatsapp_is_fleet_diesel",
            "whatsapp_claim_id IS NULL OR (desk = 'fleet' AND kind = 'diesel')",
        ),
        _check("expense_bills", "submitter_is_an_actor", "submitted_by_ref ~ '^(user|driver|wa):.+$'"),
        _tenant_fk("expense_bills", "site_id", "core.sites"),
        _tenant_fk("expense_bills", "created_by", "core.users"),
        _tenant_fk("expense_bills", "attachment_file_id", "core.files"),
        _tenant_fk("expense_bills", "whatsapp_claim_id", "finance.whatsapp_import_claims"),
        _tenant_fk("expense_bills", "payment_id", "finance.payments"),
        *_tenant_keys("expense_bills"),
        # One scan, one bill; one WhatsApp claim, one bill.
        sa.UniqueConstraint(
            "organization_id",
            "attachment_file_id",
            name=op.f("uq_expense_bills_organization_id_attachment_file_id"),
        ),
        sa.UniqueConstraint(
            "organization_id",
            "whatsapp_claim_id",
            name=op.f("uq_expense_bills_organization_id_whatsapp_claim_id"),
        ),
        schema="finance",
    )
    _org_index("finance", "expense_bills")
    op.create_index(
        "ix_expense_bills_queue",
        "expense_bills",
        ["organization_id", "desk", "status"],
        unique=False,
        schema="finance",
    )
    op.create_index(
        "ix_expense_bills_vehicle",
        "expense_bills",
        ["organization_id", "vehicle_ref"],
        unique=False,
        schema="finance",
    )

    # ------------------------------------------------------------------
    # finance.expense_bill_fields
    # ------------------------------------------------------------------
    op.create_table(
        "expense_bill_fields",
        *_id_and_org(),
        sa.Column("bill_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("key", sa.Text(), nullable=False),
        sa.Column("label", sa.Text(), nullable=False),
        sa.Column("captured_value", sa.Text(), nullable=True),
        sa.Column("confidence", sa.SmallInteger(), nullable=True),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("overridden", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("overridden_by", sa.UUID(), nullable=True),
        sa.Column("overridden_by_name", sa.Text(), nullable=True),
        _check(
            "expense_bill_fields",
            "key_known",
            "key in ('kind', 'billNumber', 'billDate', 'vendor', 'gstin', 'vehicle', "
            "'litres', 'rate', 'amount')",
        ),
        _check("expense_bill_fields", "confidence_range", "confidence IS NULL OR confidence BETWEEN 1 AND 3"),
        _check(
            "expense_bill_fields",
            "no_confidence_without_reading",
            "captured_value IS NOT NULL OR confidence IS NULL",
        ),
        _check(
            "expense_bill_fields",
            "override_names_who",
            "overridden = (overridden_by IS NOT NULL) "
            "AND (overridden_by IS NULL) = (overridden_by_name IS NULL) "
            "AND (NOT overridden OR captured_value IS NOT NULL)",
        ),
        _tenant_fk("expense_bill_fields", "bill_id", "finance.expense_bills"),
        _tenant_fk("expense_bill_fields", "overridden_by", "core.users"),
        *_tenant_keys("expense_bill_fields"),
        sa.UniqueConstraint(
            "organization_id",
            "bill_id",
            "key",
            name=op.f("uq_expense_bill_fields_organization_id_bill_id_key"),
        ),
        schema="finance",
    )
    _org_index("finance", "expense_bill_fields")

    # ------------------------------------------------------------------
    # finance.expense_bill_events
    # ------------------------------------------------------------------
    op.create_table(
        "expense_bill_events",
        *_id_and_org(),
        sa.Column("bill_id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.Integer(), nullable=False),
        sa.Column("action", sa.Text(), nullable=False),
        sa.Column("from_status", sa.Text(), nullable=False),
        sa.Column("to_status", sa.Text(), nullable=False),
        sa.Column("actor_user_id", sa.UUID(), nullable=False),
        sa.Column("actor_name", sa.Text(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("note", sa.Text(), nullable=True),
        sa.Column("exception", sa.Boolean(), server_default=sa.text("false"), nullable=False),
        sa.Column("payment_id", sa.UUID(), nullable=True),
        _check(
            "expense_bill_events",
            "action_known",
            "action in ('validate', 'approve', 'pass', 'pay', 'reject', 'send_back', 'delete', 'restore')",
        ),
        _check("expense_bill_events", "from_status_known", f"from_status in {STATUSES}"),
        _check("expense_bill_events", "to_status_known", f"to_status in {STATUSES}"),
        _check("expense_bill_events", "seq_positive", "seq > 0"),
        _check("expense_bill_events", "payment_on_pay", "(action = 'pay') = (payment_id IS NOT NULL)"),
        _check(
            "expense_bill_events",
            "reason_given",
            "note IS NOT NULL OR (NOT exception AND action NOT IN ('reject', 'delete', 'send_back'))",
        ),
        _tenant_fk("expense_bill_events", "bill_id", "finance.expense_bills"),
        _tenant_fk("expense_bill_events", "actor_user_id", "core.users"),
        _tenant_fk("expense_bill_events", "payment_id", "finance.payments"),
        *_tenant_keys("expense_bill_events"),
        sa.UniqueConstraint(
            "organization_id",
            "bill_id",
            "seq",
            name=op.f("uq_expense_bill_events_organization_id_bill_id_seq"),
        ),
        schema="finance",
    )
    _org_index("finance", "expense_bill_events")

    # ------------------------------------------------------------------
    # Row level security, audit, grants
    # ------------------------------------------------------------------
    for table in TENANT_TABLES:
        name = table.split(".")[1]
        # FORCE is the part that matters: without it the table's owner
        # bypasses every policy, silently.
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
            CREATE TRIGGER audit_{name}
            AFTER INSERT OR UPDATE OR DELETE ON {table}
            FOR EACH ROW EXECUTE FUNCTION core.write_audit_log()
            """
        )
        if table in APPEND_ONLY:
            # Targeted at the table by name, never through default
            # privileges, which are schema-wide (see init-roles.sql).
            op.execute(f"REVOKE UPDATE, DELETE ON {table} FROM PUBLIC")
            _if_app_role(
                f"""
                GRANT SELECT, INSERT ON {table} TO linck_app;
                REVOKE UPDATE, DELETE ON {table} FROM linck_app;
                """
            )
        else:
            _if_app_role(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO linck_app;")

    # ------------------------------------------------------------------
    # Permission keys
    # ------------------------------------------------------------------
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('sales.customer.write', 'sales', 'Add and edit customers'),
            ('sales.order.write',    'sales', 'Record customer purchase orders')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM core.permissions WHERE key IN ({', '.join(repr(k) for k in KEYS)})")

    # Dropping a table drops its policy, trigger and grants with it.
    for table in reversed(TENANT_TABLES):
        op.execute(f"DROP TABLE {table}")

    for schema in reversed(NEW_SCHEMAS):
        _if_app_role(
            f"""
                ALTER DEFAULT PRIVILEGES IN SCHEMA {schema}
                    REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLES FROM linck_app;
                ALTER DEFAULT PRIVILEGES IN SCHEMA {schema}
                    REVOKE USAGE, SELECT ON SEQUENCES FROM linck_app;
            """
        )
        # Not CASCADE: anything else living here by now should stop this.
        op.execute(f"DROP SCHEMA {schema}")

"""party invoices: GST tax invoices made from Vehicle P&L trips, their numbers, and the money matched to them

LIN-27, the owner's workbook column AZ: "Invoice should be generated at the
click of a button for the party ... for each trip or for a set of trips.
Provision to cancel the invoice(s). Provision to delete the invoice(s). All the
invoices should be retrievable." Four tables, each in the schema
docs/DATABASE.md names for it:

    sales.invoice_series      one GSTIN's numbers in one financial year: the last one taken
    sales.invoices            a draft, then issued with a number, perhaps cancelled
    sales.invoice_lines       the trip sale lines (LIN-22) an invoice bills, as billed
    finance.invoice_receipts  the trip payments (LIN-22, column BA) matched to an issued invoice

and three changes to older tables: core.gst_registrations takes a UNIQUE
(organization_id, id) for the invoices' composite key and the prefix its
numbers start with; master.parties takes the billing address an invoice
prints; master.party_locations takes the address and state of a delivery
location, the state being the place of supply.

Every new table is a tenant table like the rest: organization_id, RLS enabled
AND forced with the tenant_isolation policy, UNIQUE (organization_id, id)
under composite tenant foreign keys, the audit trigger, and the app role's
grants. Money is numeric(18,2), quantities numeric(12,3).

What GST asks of an invoice is held here, not only in the API:

- A sale line is on at most one live invoice. Each line carries its invoice's
  status through a composite key with ON UPDATE CASCADE, and a partial unique
  index counts the lines of drafts and issued invoices; cancelling an invoice
  cascades its lines out of the index, which frees its trips to be invoiced
  again.
- An issued invoice never changes and is never deleted. A guard trigger
  refuses any change to what an issued invoice prints (its number, date,
  parties, place of supply, lines, amounts), any status but draft -> issued ->
  cancelled, and the deletion of anything but a draft and its lines.
- A number is never reused. A series only counts up and is never deleted
  (another guard), and UNIQUE (series, serial) and (GSTIN, number) back it.
- Only an issued invoice receives money: a receipt carries its invoice's
  status too, and a check allows only 'issued', so cancelling must first let
  the money go.

e-invoicing (IRN, QR code) and e-way bills are left out on purpose; the
invoice keeps nullable columns for an IRN and its acknowledgement.

One permission key, sales.invoice.cancel: cancelling is accounts' work.
Making, issuing and deleting a draft are the existing sales.invoice.write,
seeing invoices sales.invoice.read, and matching money finance.receipt.verify.

Downgrade refuses (a failed check) while any invoice exists, issued or not:
an issued invoice is a statutory record, and dropping one is not a schema
change. It refuses too (a foreign-key violation) while any role holds the new
key. It drops the addresses, location states and prefixes it added.

Revision ID: 0031_party_invoices
Revises: 0030_vehicle_pl
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0031_party_invoices"
down_revision: str | None = "0030_vehicle_pl"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Parents before children; downgrade walks it backwards.
TENANT_TABLES = (
    "sales.invoice_series",
    "sales.invoices",
    "sales.invoice_lines",
    "finance.invoice_receipts",
)

KEYS = ("sales.invoice.cancel",)

GSTIN_SHAPE = "^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$"


def _if_app_role(statements: str) -> None:
    """Grants to linck_app, skipped where the role does not exist, as 0002, 0011 and 0030 do it."""
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


#: What an issued invoice prints, which the guard holds still. Its status, the
#: cancellation and the IRN are what may still move, each in its own way.
INVOICE_FROZEN = (
    "id",
    "organization_id",
    "site_id",
    "gst_registration_id",
    "customer_party_id",
    "series_id",
    "financial_year",
    "serial",
    "invoice_number",
    "invoice_date",
    "seller_legal_name",
    "seller_trade_name",
    "seller_gstin",
    "seller_state_code",
    "seller_address",
    "buyer_name",
    "buyer_gstin",
    "buyer_address",
    "ship_to_name",
    "ship_to_address",
    "place_of_supply",
    "pos_basis",
    "supply_type",
    "taxable_total",
    "cgst_total",
    "sgst_total",
    "igst_total",
    "round_off",
    "total",
    "rules_version",
    "notes",
    "created_by",
    "created_by_name",
    "created_at",
    "issued_at",
    "issued_by",
    "issued_by_name",
)
INVOICE_CANCELLED_FROZEN = (
    "cancelled_at",
    "cancelled_by",
    "cancelled_by_name",
    "cancel_reason",
    "irn",
    "irn_ack_number",
    "irn_ack_date",
)
LINE_FROZEN = (
    "id",
    "organization_id",
    "invoice_id",
    "position",
    "sheet_number",
    "trip_number",
    "trip_date",
    "registration_number",
    "challan_number",
    "location",
    "description",
    "hsn_code",
    "unit",
    "quantity",
    "rate",
    "amount",
    "transport",
    "taxable",
    "gst_rate_pct",
    "cgst",
    "sgst",
    "igst",
    "total",
    "created_at",
)


def _row(prefix: str, columns: Sequence[str]) -> str:
    return "ROW(" + ", ".join(f"{prefix}.{c}" for c in columns) + ")"


GUARD_INVOICE = f"""
CREATE FUNCTION sales.guard_invoice() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.status <> 'draft' THEN
            RAISE EXCEPTION 'invoice % is %: only a draft that was never issued may be deleted',
                OLD.invoice_number, OLD.status
                USING ERRCODE = 'integrity_constraint_violation', HINT = 'cancel it instead';
        END IF;
        RETURN OLD;
    END IF;
    IF NOT ((OLD.status = 'draft' AND NEW.status IN ('draft', 'issued'))
            OR (OLD.status = 'issued' AND NEW.status IN ('issued', 'cancelled'))
            OR (OLD.status = 'cancelled' AND NEW.status = 'cancelled')) THEN
        RAISE EXCEPTION 'an invoice does not go from % to %', OLD.status, NEW.status
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status <> 'draft'
       AND {_row("OLD", INVOICE_FROZEN)} IS DISTINCT FROM {_row("NEW", INVOICE_FROZEN)} THEN
        RAISE EXCEPTION 'invoice % is issued: what it says never changes', OLD.invoice_number
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD.status = 'cancelled'
       AND {_row("OLD", INVOICE_CANCELLED_FROZEN)} IS DISTINCT FROM {_row("NEW", INVOICE_CANCELLED_FROZEN)} THEN
        RAISE EXCEPTION 'invoice % is cancelled: it stays as it was', OLD.invoice_number
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$
"""

GUARD_LINE = f"""
CREATE FUNCTION sales.guard_invoice_line() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.invoice_status <> 'draft' THEN
            RAISE EXCEPTION 'a line is added to a draft invoice only'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF OLD.invoice_status <> 'draft' THEN
            RAISE EXCEPTION 'a line of an issued invoice is never deleted'
                USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN OLD;
    END IF;
    -- Once issued, only the invoice's own status comes down the key, and a
    -- cancelled invoice may let go of a sale line deleted from its trip.
    IF OLD.invoice_status <> 'draft' AND (
        {_row("OLD", LINE_FROZEN)} IS DISTINCT FROM {_row("NEW", LINE_FROZEN)}
        OR (NEW.trip_sale_id IS DISTINCT FROM OLD.trip_sale_id
            AND NOT (NEW.invoice_status = 'cancelled' AND NEW.trip_sale_id IS NULL))
    ) THEN
        RAISE EXCEPTION 'a line of an issued invoice never changes'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$
"""

GUARD_SERIES = """
CREATE FUNCTION sales.guard_invoice_series() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'an invoice series is never deleted: its numbers are never reused'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF NEW.last_serial < OLD.last_serial
       OR ROW(NEW.id, NEW.organization_id, NEW.gst_registration_id, NEW.financial_year)
          IS DISTINCT FROM ROW(OLD.id, OLD.organization_id, OLD.gst_registration_id, OLD.financial_year) THEN
        RAISE EXCEPTION 'an invoice series only counts up'
            USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    RETURN NEW;
END
$$
"""

GUARD_TRIGGERS = (
    "CREATE TRIGGER guard_invoices BEFORE UPDATE OR DELETE ON sales.invoices"
    " FOR EACH ROW EXECUTE FUNCTION sales.guard_invoice()",
    "CREATE TRIGGER guard_invoice_lines BEFORE INSERT OR UPDATE OR DELETE ON sales.invoice_lines"
    " FOR EACH ROW EXECUTE FUNCTION sales.guard_invoice_line()",
    "CREATE TRIGGER guard_invoice_series BEFORE UPDATE OR DELETE ON sales.invoice_series"
    " FOR EACH ROW EXECUTE FUNCTION sales.guard_invoice_series()",
)


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Older tables: the seller's registration, the buyer's address, where it went
    # ------------------------------------------------------------------
    op.add_column(
        "gst_registrations",
        sa.Column("invoice_prefix", sa.Text(), server_default=sa.text("'INV'"), nullable=False),
        schema="core",
    )
    op.create_unique_constraint(
        "uq_gst_registrations_organization_id_id",
        "gst_registrations",
        ["organization_id", "id"],
        schema="core",
    )
    op.create_check_constraint(
        op.f("ck_gst_registrations_invoice_prefix_shape"),
        "gst_registrations",
        "invoice_prefix ~ '^[A-Z0-9]{1,4}$'",
        schema="core",
    )
    op.add_column(
        "parties",
        sa.Column("address", sa.Text(), server_default=sa.text("''"), nullable=False),
        schema="master",
    )
    op.create_check_constraint(
        op.f("ck_parties_address_length"), "parties", "char_length(address) <= 300", schema="master"
    )
    op.add_column(
        "party_locations",
        sa.Column("address", sa.Text(), server_default=sa.text("''"), nullable=False),
        schema="master",
    )
    op.add_column(
        "party_locations", sa.Column("state_code", sa.String(length=2), nullable=True), schema="master"
    )
    op.create_check_constraint(
        op.f("ck_party_locations_address_length"),
        "party_locations",
        "char_length(address) <= 300",
        schema="master",
    )
    op.create_check_constraint(
        op.f("ck_party_locations_state_code_shape"),
        "party_locations",
        "state_code IS NULL OR state_code ~ '^[0-9]{2}$'",
        schema="master",
    )

    # ------------------------------------------------------------------
    # The tables, in the order their keys need
    # ------------------------------------------------------------------
    op.create_table(
        "invoice_series",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("gst_registration_id", sa.UUID(), nullable=False),
        sa.Column("financial_year", sa.Text(), nullable=False),
        sa.Column("last_serial", sa.Integer(), server_default=sa.text("0"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "financial_year ~ '^[0-9]{2}(-[0-9]{2})?$'", name=op.f("ck_invoice_series_financial_year_shape")
        ),
        sa.CheckConstraint("last_serial >= 0", name=op.f("ck_invoice_series_last_serial_not_negative")),
        sa.ForeignKeyConstraint(
            ["organization_id", "gst_registration_id"],
            ["core.gst_registrations.organization_id", "core.gst_registrations.id"],
            name=op.f("fk_invoice_series_organization_id_gst_registration_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_invoice_series_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_series")),
        sa.UniqueConstraint(
            "organization_id",
            "gst_registration_id",
            "financial_year",
            name=op.f("uq_invoice_series_organization_id_gst_registration_id_financial_year"),
        ),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_invoice_series_organization_id_id")),
        schema="sales",
    )
    op.create_index(
        op.f("ix_sales_invoice_series_organization_id"),
        "invoice_series",
        ["organization_id"],
        unique=False,
        schema="sales",
    )
    op.create_table(
        "invoices",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("site_id", sa.UUID(), nullable=False),
        sa.Column("gst_registration_id", sa.UUID(), nullable=False),
        sa.Column("customer_party_id", sa.UUID(), nullable=False),
        sa.Column("status", sa.Text(), server_default=sa.text("'draft'"), nullable=False),
        sa.Column("series_id", sa.UUID(), nullable=True),
        sa.Column("financial_year", sa.Text(), nullable=True),
        sa.Column("serial", sa.Integer(), nullable=True),
        sa.Column("invoice_number", sa.Text(), nullable=True),
        sa.Column("invoice_date", sa.Date(), nullable=True),
        sa.Column("seller_legal_name", sa.Text(), nullable=False),
        sa.Column("seller_trade_name", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("seller_gstin", sa.String(length=15), nullable=False),
        sa.Column("seller_state_code", sa.String(length=2), nullable=False),
        sa.Column("seller_address", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("buyer_name", sa.Text(), nullable=False),
        sa.Column("buyer_gstin", sa.String(length=15), nullable=True),
        sa.Column("buyer_address", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("ship_to_name", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("ship_to_address", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("place_of_supply", sa.String(length=2), nullable=False),
        sa.Column("pos_basis", sa.Text(), nullable=False),
        sa.Column("supply_type", sa.Text(), nullable=False),
        sa.Column("taxable_total", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("cgst_total", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("sgst_total", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("igst_total", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("round_off", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("total", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("rules_version", sa.Text(), server_default=sa.text("'invoice-v1'"), nullable=False),
        sa.Column("notes", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("irn", sa.Text(), nullable=True),
        sa.Column("irn_ack_number", sa.Text(), nullable=True),
        sa.Column("irn_ack_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column("created_by_name", sa.Text(), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("issued_by", sa.UUID(), nullable=True),
        sa.Column("issued_by_name", sa.Text(), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by", sa.UUID(), nullable=True),
        sa.Column("cancelled_by_name", sa.Text(), nullable=True),
        sa.Column("cancel_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "(status = 'cancelled') = (cancelled_at IS NOT NULL) AND (cancelled_at IS NULL) = (cancelled_by IS NULL) AND (cancelled_at IS NULL) = (cancelled_by_name IS NULL) AND (cancelled_at IS NULL) = (cancel_reason IS NULL)",
            name=op.f("ck_invoices_cancel_recorded"),
        ),
        sa.CheckConstraint(
            "(status = 'draft') = (invoice_number IS NULL) AND (status = 'draft') = (series_id IS NULL) AND (status = 'draft') = (financial_year IS NULL) AND (status = 'draft') = (serial IS NULL) AND (status = 'draft') = (invoice_date IS NULL) AND (status = 'draft') = (issued_at IS NULL) AND (status = 'draft') = (issued_by IS NULL) AND (status = 'draft') = (issued_by_name IS NULL)",
            name=op.f("ck_invoices_numbered_once_issued"),
        ),
        sa.CheckConstraint(
            "(supply_type = 'inter') = (place_of_supply <> seller_state_code)",
            name=op.f("ck_invoices_supply_type_follows"),
        ),
        sa.CheckConstraint(
            "(supply_type = 'intra' AND igst_total = 0 AND cgst_total = sgst_total) OR (supply_type = 'inter' AND cgst_total = 0 AND sgst_total = 0)",
            name=op.f("ck_invoices_tax_split"),
        ),
        sa.CheckConstraint(
            f"buyer_gstin IS NULL OR buyer_gstin ~ '{GSTIN_SHAPE}'",
            name=op.f("ck_invoices_buyer_gstin_shape"),
        ),
        sa.CheckConstraint(
            "invoice_number IS NULL OR invoice_number ~ '^[A-Za-z0-9/-]{1,16}$'",
            name=op.f("ck_invoices_invoice_number_shape"),
        ),
        sa.CheckConstraint("irn IS NULL OR status <> 'draft'", name=op.f("ck_invoices_irn_once_issued")),
        sa.CheckConstraint("place_of_supply ~ '^[0-9]{2}$'", name=op.f("ck_invoices_place_of_supply_shape")),
        sa.CheckConstraint(
            "pos_basis in ('delivery_location', 'buyer_gstin', 'seller_state', 'chosen')",
            name=op.f("ck_invoices_pos_basis_known"),
        ),
        sa.CheckConstraint(f"seller_gstin ~ '{GSTIN_SHAPE}'", name=op.f("ck_invoices_seller_gstin_shape")),
        sa.CheckConstraint(
            "status in ('draft', 'issued', 'cancelled')", name=op.f("ck_invoices_status_known")
        ),
        sa.CheckConstraint("supply_type in ('intra', 'inter')", name=op.f("ck_invoices_supply_type_known")),
        sa.CheckConstraint(
            "cancel_reason IS NULL OR char_length(btrim(cancel_reason)) BETWEEN 1 AND 200",
            name=op.f("ck_invoices_cancel_reason_said"),
        ),
        sa.CheckConstraint("char_length(notes) <= 500", name=op.f("ck_invoices_notes_length")),
        sa.CheckConstraint(
            "irn_ack_number IS NULL OR irn IS NOT NULL", name=op.f("ck_invoices_irn_ack_has_irn")
        ),
        sa.CheckConstraint(
            "round_off BETWEEN -0.50 AND 0.50", name=op.f("ck_invoices_round_off_within_half_a_rupee")
        ),
        sa.CheckConstraint(
            "seller_state_code = left(seller_gstin, 2)", name=op.f("ck_invoices_seller_state_is_the_gstins")
        ),
        sa.CheckConstraint("serial IS NULL OR serial > 0", name=op.f("ck_invoices_serial_positive")),
        sa.CheckConstraint(
            "taxable_total >= 0 AND cgst_total >= 0 AND sgst_total >= 0 AND igst_total >= 0",
            name=op.f("ck_invoices_amounts_not_negative"),
        ),
        sa.CheckConstraint("total = round(total)", name=op.f("ck_invoices_total_in_rupees")),
        sa.CheckConstraint(
            "total = taxable_total + cgst_total + sgst_total + igst_total + round_off",
            name=op.f("ck_invoices_total_adds_up"),
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "cancelled_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f("fk_invoices_organization_id_cancelled_by"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "created_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f("fk_invoices_organization_id_created_by"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "customer_party_id"],
            ["master.parties.organization_id", "master.parties.id"],
            name=op.f("fk_invoices_organization_id_customer_party_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "gst_registration_id"],
            ["core.gst_registrations.organization_id", "core.gst_registrations.id"],
            name=op.f("fk_invoices_organization_id_gst_registration_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "issued_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f("fk_invoices_organization_id_issued_by"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "series_id"],
            ["sales.invoice_series.organization_id", "sales.invoice_series.id"],
            name=op.f("fk_invoices_organization_id_series_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "site_id"],
            ["core.sites.organization_id", "core.sites.id"],
            name=op.f("fk_invoices_organization_id_site_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_invoices_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoices")),
        sa.UniqueConstraint(
            "organization_id",
            "gst_registration_id",
            "invoice_number",
            name=op.f("uq_invoices_organization_id_gst_registration_id_invoice_number"),
        ),
        sa.UniqueConstraint(
            "organization_id", "id", "status", name=op.f("uq_invoices_organization_id_id_status")
        ),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_invoices_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id",
            "series_id",
            "serial",
            name=op.f("uq_invoices_organization_id_series_id_serial"),
        ),
        schema="sales",
    )
    op.create_index(
        "ix_invoices_customer",
        "invoices",
        ["organization_id", "customer_party_id"],
        unique=False,
        schema="sales",
    )
    op.create_index(
        "ix_invoices_invoice_date",
        "invoices",
        ["organization_id", "invoice_date"],
        unique=False,
        schema="sales",
    )
    op.create_index(
        "ix_invoices_status", "invoices", ["organization_id", "status"], unique=False, schema="sales"
    )
    op.create_index(
        op.f("ix_sales_invoices_organization_id"),
        "invoices",
        ["organization_id"],
        unique=False,
        schema="sales",
    )
    op.create_table(
        "invoice_lines",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("invoice_id", sa.UUID(), nullable=False),
        sa.Column("invoice_status", sa.Text(), server_default=sa.text("'draft'"), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("trip_sale_id", sa.UUID(), nullable=True),
        sa.Column("sheet_number", sa.Text(), nullable=False),
        sa.Column("trip_number", sa.Text(), nullable=False),
        sa.Column("trip_date", sa.Date(), nullable=False),
        sa.Column("registration_number", sa.Text(), nullable=False),
        sa.Column("challan_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("location", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("hsn_code", sa.Text(), nullable=False),
        sa.Column("unit", sa.Text(), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=12, scale=3), nullable=False),
        sa.Column("rate", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column(
            "transport", sa.Numeric(precision=18, scale=2), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("taxable", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("gst_rate_pct", sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column("cgst", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("sgst", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("igst", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("total", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("hsn_code ~ '^[0-9]{4,8}$'", name=op.f("ck_invoice_lines_hsn_shape")),
        sa.CheckConstraint(
            "invoice_status = 'cancelled' OR trip_sale_id IS NOT NULL",
            name=op.f("ck_invoice_lines_live_line_names_its_sale"),
        ),
        sa.CheckConstraint(
            "invoice_status in ('draft', 'issued', 'cancelled')",
            name=op.f("ck_invoice_lines_invoice_status_known"),
        ),
        sa.CheckConstraint(
            "amount = round(quantity * rate, 2)", name=op.f("ck_invoice_lines_amount_is_quantity_times_rate")
        ),
        sa.CheckConstraint(
            "cgst >= 0 AND sgst >= 0 AND igst >= 0", name=op.f("ck_invoice_lines_tax_not_negative")
        ),
        sa.CheckConstraint("char_length(unit) BETWEEN 1 AND 20", name=op.f("ck_invoice_lines_unit_shape")),
        sa.CheckConstraint(
            "gst_rate_pct >= 0 AND gst_rate_pct <= 100", name=op.f("ck_invoice_lines_gst_rate_range")
        ),
        sa.CheckConstraint("position >= 0", name=op.f("ck_invoice_lines_position_not_negative")),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_invoice_lines_quantity_positive")),
        sa.CheckConstraint("rate > 0", name=op.f("ck_invoice_lines_rate_positive")),
        sa.CheckConstraint("taxable = amount + transport", name=op.f("ck_invoice_lines_taxable_adds_up")),
        sa.CheckConstraint(
            "total = taxable + cgst + sgst + igst", name=op.f("ck_invoice_lines_total_adds_up")
        ),
        sa.CheckConstraint("transport >= 0", name=op.f("ck_invoice_lines_transport_not_negative")),
        sa.ForeignKeyConstraint(
            ["organization_id", "invoice_id", "invoice_status"],
            ["sales.invoices.organization_id", "sales.invoices.id", "sales.invoices.status"],
            name=op.f("fk_invoice_lines_organization_id_invoice_id_invoice_status"),
            onupdate="CASCADE",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sale_id"],
            ["sales.trip_sales.organization_id", "sales.trip_sales.id"],
            name=op.f("fk_invoice_lines_organization_id_trip_sale_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_invoice_lines_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_lines")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_invoice_lines_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id",
            "invoice_id",
            "position",
            name=op.f("uq_invoice_lines_organization_id_invoice_id_position"),
        ),
        schema="sales",
    )
    op.create_index(
        op.f("ix_sales_invoice_lines_organization_id"),
        "invoice_lines",
        ["organization_id"],
        unique=False,
        schema="sales",
    )
    # A sale line on at most one live invoice: the database's own rule, not only the API's.
    op.create_index(
        "uq_invoice_lines_live_trip_sale",
        "invoice_lines",
        ["organization_id", "trip_sale_id"],
        unique=True,
        schema="sales",
        postgresql_where=sa.text("invoice_status <> 'cancelled'"),
    )
    op.create_table(
        "invoice_receipts",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("invoice_id", sa.UUID(), nullable=False),
        sa.Column("invoice_status", sa.Text(), server_default=sa.text("'issued'"), nullable=False),
        sa.Column("trip_payment_id", sa.UUID(), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("matched_by", sa.UUID(), nullable=False),
        sa.Column("matched_by_name", sa.Text(), nullable=False),
        sa.Column("matched_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "invoice_status = 'issued'", name=op.f("ck_invoice_receipts_only_on_issued_invoices")
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_invoice_receipts_amount_positive")),
        sa.ForeignKeyConstraint(
            ["organization_id", "invoice_id", "invoice_status"],
            ["sales.invoices.organization_id", "sales.invoices.id", "sales.invoices.status"],
            name=op.f("fk_invoice_receipts_organization_id_invoice_id_invoice_status"),
            onupdate="CASCADE",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "matched_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f("fk_invoice_receipts_organization_id_matched_by"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_payment_id"],
            ["finance.trip_payments.organization_id", "finance.trip_payments.id"],
            name=op.f("fk_invoice_receipts_organization_id_trip_payment_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_invoice_receipts_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invoice_receipts")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_invoice_receipts_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id",
            "invoice_id",
            "trip_payment_id",
            name=op.f("uq_invoice_receipts_organization_id_invoice_id_trip_payment_id"),
        ),
        schema="finance",
    )
    op.create_index(
        op.f("ix_finance_invoice_receipts_organization_id"),
        "invoice_receipts",
        ["organization_id"],
        unique=False,
        schema="finance",
    )
    op.create_index(
        "ix_invoice_receipts_trip_payment",
        "invoice_receipts",
        ["organization_id", "trip_payment_id"],
        unique=False,
        schema="finance",
    )

    # ------------------------------------------------------------------
    # Row level security, audit, grants
    # ------------------------------------------------------------------
    for table in TENANT_TABLES:
        name = table.split(".")[1]
        # FORCE is the part that matters: without it the owner bypasses every policy.
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
        _if_app_role(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO linck_app;")

    # ------------------------------------------------------------------
    # What GST asks: an issued invoice never changes, a number is never reused
    # ------------------------------------------------------------------
    for statement in (GUARD_INVOICE, GUARD_LINE, GUARD_SERIES, *GUARD_TRIGGERS):
        op.execute(statement)

    # ------------------------------------------------------------------
    # Permission keys
    # ------------------------------------------------------------------
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('sales.invoice.cancel', 'sales', 'Cancel an issued invoice: it stays on record, marked cancelled, and its trips can be invoiced again')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    # A check every row must pass, which no row can: it fails exactly when an
    # invoice exists. Row level security hides every row from a query here, so
    # counting them would always find none; a constraint's validation sees all.
    op.execute(
        "ALTER TABLE sales.invoices ADD CONSTRAINT invoices_exist_so_0031_cannot_be_undone CHECK (false)"
    )
    op.execute(f"DELETE FROM core.permissions WHERE key IN ({', '.join(repr(k) for k in KEYS)})")

    # Dropping a table drops its policy, triggers, indexes and grants with it.
    for table in reversed(TENANT_TABLES):
        op.execute(f"DROP TABLE {table}")
    for function in ("guard_invoice_series", "guard_invoice_line", "guard_invoice"):
        op.execute(f"DROP FUNCTION sales.{function}()")

    op.drop_constraint(
        op.f("ck_party_locations_state_code_shape"), "party_locations", schema="master", type_="check"
    )
    op.drop_constraint(
        op.f("ck_party_locations_address_length"), "party_locations", schema="master", type_="check"
    )
    op.drop_column("party_locations", "state_code", schema="master")
    op.drop_column("party_locations", "address", schema="master")
    op.drop_constraint(op.f("ck_parties_address_length"), "parties", schema="master", type_="check")
    op.drop_column("parties", "address", schema="master")
    op.drop_constraint(
        op.f("ck_gst_registrations_invoice_prefix_shape"), "gst_registrations", schema="core", type_="check"
    )
    op.drop_constraint(
        "uq_gst_registrations_organization_id_id", "gst_registrations", schema="core", type_="unique"
    )
    op.drop_column("gst_registrations", "invoice_prefix", schema="core")

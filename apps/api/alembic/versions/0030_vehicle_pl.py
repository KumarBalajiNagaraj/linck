"""vehicle P&L: trip sheets with their trips, diesel, en-route expenses, purchases, sales and payments

LIN-22, as the owner's workbook ("Vehicle Trip Entry Form") lays it out. A
trip sheet is one vehicle and its driver from a start date to an end date;
its trips are the loads it carried, each bought from a vendor and delivered to
a customer. Diesel, km readings, batta, en-route expenses and payments may sit
on the sheet or on a trip. Each table is in the schema docs/DATABASE.md names
for it:

    master.items                     the Material DB: name, HSN, unit, default GST rate
    master.party_locations           where a vendor sells from, where a customer takes delivery
    master.gst_rates                 the GST rates a line may be billed at
    logistics.trip_sheets            one vehicle and driver, start date to end date
    logistics.trips                  the loads it carried, numbered as each is added
    logistics.diesel_lines           diesel on the sheet or a trip: typed, or a bill or fuel entry linked
    logistics.enroute_expenses       toll, police and minor maintenance
    procurement.trip_purchases       material bought for a trip
    procurement.trip_purchase_files  the vendor's bill, photographed
    sales.trip_sales                 material sold; transport inside the taxable price
    sales.trip_closures              accounts' confirmation that a customer paid a trip in full
    finance.trip_payments            money in from customers, out to vendors, on a trip or its sheet

and changes two LIN-20 tables: master.parties takes vendors (a firm that only
sells to us is served from no site of ours, so served_from_site_id is null for
it, and still required of every customer), and core.files takes a trip sheet's
papers as well as an expense bill.

Every new table is a tenant table like the rest: organization_id, RLS enabled
AND forced with the tenant_isolation policy, UNIQUE (organization_id, id) under
composite tenant foreign keys, and the audit trigger. A line of a sheet or of
one of its trips names the trip through the sheet (a three-column key), so it
cannot name another sheet's trip. Money is numeric(18,2), litres
numeric(12,3), km numeric(10,1), times timestamptz. No figure the rules derive
(a line's cost, GST, total, a trip's share of its sheet's costs, a profit) is
stored: app/domain/vehicle_pl.py works them out on every read.

Three permission keys: fleet.trip_pl.read and fleet.trip_pl.write for whoever
enters trip sheets (each sees the P&L of the sheets they may read), and
finance.pl_report.read for the trip-wise, vehicle-wise and monthly reports and
the money-due lists, which are the director's and accounts'. Closing a trip a
customer paid in full is accounts' existing finance.receipt.verify.

Downgrade refuses (foreign-key violation or a failed check) while any role
holds one of the keys, any party is a vendor with no site, or any upload is a
trip sheet's paper: silently dropping a grant or a party is not a schema change.

Revision ID: 0030_vehicle_pl
Revises: 0021_harden_access
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030_vehicle_pl"
down_revision: str | None = "0021_harden_access"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_SCHEMAS = ("logistics", "procurement")

# Parents before children; downgrade walks it backwards.
TENANT_TABLES = (
    "master.gst_rates",
    "master.items",
    "logistics.trip_sheets",
    "logistics.trips",
    "master.party_locations",
    "finance.trip_payments",
    "logistics.diesel_lines",
    "logistics.enroute_expenses",
    "procurement.trip_purchases",
    "sales.trip_closures",
    "sales.trip_sales",
    "procurement.trip_purchase_files",
)

KEYS = ("fleet.trip_pl.read", "fleet.trip_pl.write", "finance.pl_report.read")


def _if_app_role(statements: str) -> None:
    """Grants to linck_app, skipped where the role does not exist, as 0002 and 0011 do it."""
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


def upgrade() -> None:
    # ------------------------------------------------------------------
    # Schemas, and what the app role may do in them (before any table, so
    # default privileges grant every table made here on creation)
    # ------------------------------------------------------------------
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
    # LIN-20 tables: vendors in the party master, trip papers among the uploads
    # ------------------------------------------------------------------
    op.alter_column("parties", "served_from_site_id", existing_type=sa.UUID(), nullable=True, schema="master")
    op.create_check_constraint(
        op.f("ck_parties_customer_has_site"),
        "parties",
        "NOT ('customer' = ANY (party_roles)) OR served_from_site_id IS NOT NULL",
        schema="master",
    )
    op.drop_constraint(op.f("ck_files_purpose_known"), "files", schema="core", type_="check")
    op.create_check_constraint(
        op.f("ck_files_purpose_known"),
        "files",
        "purpose in ('expense_bill', 'trip_document')",
        schema="core",
    )

    # ------------------------------------------------------------------
    # The tables, in the order their keys need
    # ------------------------------------------------------------------
    op.create_table(
        "gst_rates",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("rate_pct", sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("rate_pct >= 0 AND rate_pct <= 100", name=op.f("ck_gst_rates_rate_range")),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_gst_rates_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_gst_rates")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_gst_rates_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id", "rate_pct", name=op.f("uq_gst_rates_organization_id_rate_pct")
        ),
        schema="master",
    )
    op.create_index(
        op.f("ix_master_gst_rates_organization_id"),
        "gst_rates",
        ["organization_id"],
        unique=False,
        schema="master",
    )
    op.create_table(
        "items",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("code", sa.Text(), nullable=True),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("hsn_code", sa.Text(), nullable=True),
        sa.Column(
            "gst_rate_pct", sa.Numeric(precision=5, scale=2), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("unit", sa.Text(), server_default=sa.text("'unit'"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("code IS NULL OR code ~ '^[A-Z0-9_-]{1,32}$'", name=op.f("ck_items_code_shape")),
        sa.CheckConstraint("hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'", name=op.f("ck_items_hsn_shape")),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 120", name=op.f("ck_items_name_length")),
        sa.CheckConstraint("char_length(unit) BETWEEN 1 AND 20", name=op.f("ck_items_unit_shape")),
        sa.CheckConstraint("gst_rate_pct >= 0 AND gst_rate_pct <= 100", name=op.f("ck_items_gst_rate_range")),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_items_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_items")),
        sa.UniqueConstraint("organization_id", "code", name=op.f("uq_items_organization_id_code")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_items_organization_id_id")),
        schema="master",
    )
    op.create_index(
        op.f("ix_master_items_organization_id"), "items", ["organization_id"], unique=False, schema="master"
    )
    op.create_table(
        "trip_sheets",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("financial_year", sa.Text(), nullable=False),
        sa.Column("serial", sa.Integer(), nullable=False),
        sa.Column("sheet_number", sa.Text(), nullable=False),
        sa.Column("site_id", sa.UUID(), nullable=False),
        sa.Column("vehicle_ref", sa.Text(), nullable=False),
        sa.Column("registration_number", sa.Text(), nullable=False),
        sa.Column("vehicle_model", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("driver_ref", sa.Text(), nullable=True),
        sa.Column("driver_name", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("driver_phone", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("start_date", sa.Date(), nullable=False),
        sa.Column("end_date", sa.Date(), nullable=True),
        sa.Column("start_km", sa.Numeric(precision=10, scale=1), nullable=True),
        sa.Column("end_km", sa.Numeric(precision=10, scale=1), nullable=True),
        sa.Column("batta", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("notes", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("rules_version", sa.Text(), server_default=sa.text("'sheet-v1'"), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column("created_by_name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "(start_km IS NULL OR start_km >= 0) AND (end_km IS NULL OR end_km >= 0) AND (start_km IS NULL OR end_km IS NULL OR end_km >= start_km)",
            name=op.f("ck_trip_sheets_km_in_order"),
        ),
        sa.CheckConstraint("batta IS NULL OR batta >= 0", name=op.f("ck_trip_sheets_batta_not_negative")),
        sa.CheckConstraint(
            "end_date IS NULL OR end_date >= start_date", name=op.f("ck_trip_sheets_dates_in_order")
        ),
        sa.CheckConstraint("serial > 0", name=op.f("ck_trip_sheets_serial_positive")),
        sa.ForeignKeyConstraint(
            ["organization_id", "created_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f("fk_trip_sheets_organization_id_created_by"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "site_id"],
            ["core.sites.organization_id", "core.sites.id"],
            name=op.f("fk_trip_sheets_organization_id_site_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_trip_sheets_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trip_sheets")),
        sa.UniqueConstraint(
            "organization_id",
            "financial_year",
            "serial",
            name=op.f("uq_trip_sheets_organization_id_financial_year_serial"),
        ),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_trip_sheets_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id", "sheet_number", name=op.f("uq_trip_sheets_organization_id_sheet_number")
        ),
        schema="logistics",
    )
    op.create_index(
        op.f("ix_logistics_trip_sheets_organization_id"),
        "trip_sheets",
        ["organization_id"],
        unique=False,
        schema="logistics",
    )
    op.create_index(
        "ix_trip_sheets_start_date",
        "trip_sheets",
        ["organization_id", "start_date"],
        unique=False,
        schema="logistics",
    )
    op.create_index(
        "ix_trip_sheets_vehicle_start_date",
        "trip_sheets",
        ["organization_id", "vehicle_ref", "start_date"],
        unique=False,
        schema="logistics",
    )
    op.create_table(
        "trips",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("trip_sheet_id", sa.UUID(), nullable=False),
        sa.Column("financial_year", sa.Text(), nullable=False),
        sa.Column("serial", sa.Integer(), nullable=False),
        sa.Column("trip_number", sa.Text(), nullable=False),
        sa.Column("trip_date", sa.Date(), nullable=False),
        sa.Column("start_km", sa.Numeric(precision=10, scale=1), nullable=True),
        sa.Column("end_km", sa.Numeric(precision=10, scale=1), nullable=True),
        sa.Column("batta", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("notes", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "(start_km IS NULL OR start_km >= 0) AND (end_km IS NULL OR end_km >= 0) AND (start_km IS NULL OR end_km IS NULL OR end_km >= start_km)",
            name=op.f("ck_trips_km_in_order"),
        ),
        sa.CheckConstraint("batta IS NULL OR batta >= 0", name=op.f("ck_trips_batta_not_negative")),
        sa.CheckConstraint("serial > 0", name=op.f("ck_trips_serial_positive")),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id"],
            ["logistics.trip_sheets.organization_id", "logistics.trip_sheets.id"],
            name=op.f("fk_trips_organization_id_trip_sheet_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_trips_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trips")),
        sa.UniqueConstraint(
            "organization_id",
            "financial_year",
            "serial",
            name=op.f("uq_trips_organization_id_financial_year_serial"),
        ),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_trips_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id", "trip_number", name=op.f("uq_trips_organization_id_trip_number")
        ),
        sa.UniqueConstraint(
            "organization_id", "trip_sheet_id", "id", name=op.f("uq_trips_organization_id_trip_sheet_id_id")
        ),
        schema="logistics",
    )
    op.create_index(
        op.f("ix_logistics_trips_organization_id"),
        "trips",
        ["organization_id"],
        unique=False,
        schema="logistics",
    )
    op.create_index(
        "ix_trips_date", "trips", ["organization_id", "trip_date"], unique=False, schema="logistics"
    )
    op.create_table(
        "party_locations",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("party_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "char_length(name) BETWEEN 1 AND 120", name=op.f("ck_party_locations_name_length")
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "party_id"],
            ["master.parties.organization_id", "master.parties.id"],
            name=op.f("fk_party_locations_organization_id_party_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_party_locations_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_party_locations")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_party_locations_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id",
            "party_id",
            "name",
            name=op.f("uq_party_locations_organization_id_party_id_name"),
        ),
        schema="master",
    )
    op.create_index(
        op.f("ix_master_party_locations_organization_id"),
        "party_locations",
        ["organization_id"],
        unique=False,
        schema="master",
    )
    op.create_table(
        "trip_payments",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("trip_sheet_id", sa.UUID(), nullable=False),
        sa.Column("trip_id", sa.UUID(), nullable=True),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("party_id", sa.UUID(), nullable=False),
        sa.Column("paid_on", sa.Date(), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("reference_no", sa.Text(), nullable=True),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("note", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("recorded_by", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("direction in ('in', 'out')", name=op.f("ck_trip_payments_direction_known")),
        sa.CheckConstraint(
            "method in ('neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash')",
            name=op.f("ck_trip_payments_method_known"),
        ),
        sa.CheckConstraint(
            "reference_no IS NULL OR reference_no ~ '^[A-Z0-9/-]{3,40}$'",
            name=op.f("ck_trip_payments_reference_shape"),
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_trip_payments_amount_positive")),
        sa.CheckConstraint("position >= 0", name=op.f("ck_trip_payments_position_not_negative")),
        sa.ForeignKeyConstraint(
            ["organization_id", "party_id"],
            ["master.parties.organization_id", "master.parties.id"],
            name=op.f("fk_trip_payments_organization_id_party_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "recorded_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f("fk_trip_payments_organization_id_recorded_by"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.trip_sheet_id", "logistics.trips.id"],
            name=op.f("fk_trip_payments_organization_id_trip_sheet_id_trip_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id"],
            ["logistics.trip_sheets.organization_id", "logistics.trip_sheets.id"],
            name=op.f("fk_trip_payments_organization_id_trip_sheet_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_trip_payments_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trip_payments")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_trip_payments_organization_id_id")),
        schema="finance",
    )
    op.create_index(
        op.f("ix_finance_trip_payments_organization_id"),
        "trip_payments",
        ["organization_id"],
        unique=False,
        schema="finance",
    )
    op.create_index(
        "uq_trip_payments_organization_id_trip_sheet_id_reference_no",
        "trip_payments",
        ["organization_id", "trip_sheet_id", "reference_no"],
        unique=True,
        schema="finance",
        postgresql_where=sa.text("reference_no IS NOT NULL"),
    )
    op.create_table(
        "diesel_lines",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("trip_sheet_id", sa.UUID(), nullable=False),
        sa.Column("trip_id", sa.UUID(), nullable=True),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("litres", sa.Numeric(precision=12, scale=3), nullable=True),
        sa.Column("rate", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("vendor_party_id", sa.UUID(), nullable=True),
        sa.Column("vendor", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("bill_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("expense_bill_id", sa.UUID(), nullable=True),
        sa.Column("fuel_entry_ref", sa.Text(), nullable=True),
        sa.Column("filled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("file_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "(source = 'expense_bill') = (expense_bill_id IS NOT NULL) AND (source = 'fuel_entry') = (fuel_entry_ref IS NOT NULL)",
            name=op.f("ck_diesel_lines_source_named"),
        ),
        sa.CheckConstraint(
            "CASE source WHEN 'typed' THEN litres > 0 AND rate > 0 AND amount IS NULL WHEN 'expense_bill' THEN litres IS NULL AND rate IS NULL AND amount IS NULL ELSE litres > 0 AND amount > 0 AND rate IS NULL END",
            name=op.f("ck_diesel_lines_figures_typed_once"),
        ),
        sa.CheckConstraint(
            "source in ('typed', 'expense_bill', 'fuel_entry')", name=op.f("ck_diesel_lines_source_known")
        ),
        sa.CheckConstraint("position >= 0", name=op.f("ck_diesel_lines_position_not_negative")),
        sa.ForeignKeyConstraint(
            ["organization_id", "expense_bill_id"],
            ["finance.expense_bills.organization_id", "finance.expense_bills.id"],
            name=op.f("fk_diesel_lines_organization_id_expense_bill_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "file_id"],
            ["core.files.organization_id", "core.files.id"],
            name=op.f("fk_diesel_lines_organization_id_file_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.trip_sheet_id", "logistics.trips.id"],
            name=op.f("fk_diesel_lines_organization_id_trip_sheet_id_trip_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id"],
            ["logistics.trip_sheets.organization_id", "logistics.trip_sheets.id"],
            name=op.f("fk_diesel_lines_organization_id_trip_sheet_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "vendor_party_id"],
            ["master.parties.organization_id", "master.parties.id"],
            name=op.f("fk_diesel_lines_organization_id_vendor_party_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_diesel_lines_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_diesel_lines")),
        sa.UniqueConstraint(
            "organization_id", "expense_bill_id", name=op.f("uq_diesel_lines_organization_id_expense_bill_id")
        ),
        sa.UniqueConstraint(
            "organization_id", "fuel_entry_ref", name=op.f("uq_diesel_lines_organization_id_fuel_entry_ref")
        ),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_diesel_lines_organization_id_id")),
        schema="logistics",
    )
    op.create_index(
        op.f("ix_logistics_diesel_lines_organization_id"),
        "diesel_lines",
        ["organization_id"],
        unique=False,
        schema="logistics",
    )
    op.create_table(
        "enroute_expenses",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("trip_sheet_id", sa.UUID(), nullable=False),
        sa.Column("trip_id", sa.UUID(), nullable=True),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("maintenance_kind", sa.Text(), nullable=True),
        sa.Column("description", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("spent_on", sa.Date(), nullable=True),
        sa.Column("location", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("reference", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("file_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "(kind = 'maintenance') = (maintenance_kind IS NOT NULL) AND (maintenance_kind IS NULL OR maintenance_kind in ('tyre_rotation', 'wheel_alignment', 'greasing', 'engine_oil', 'coolant', 'misc'))",
            name=op.f("ck_enroute_expenses_maintenance_kind_known"),
        ),
        sa.CheckConstraint(
            "kind in ('toll', 'police', 'maintenance')", name=op.f("ck_enroute_expenses_kind_known")
        ),
        sa.CheckConstraint(
            "maintenance_kind IS DISTINCT FROM 'misc' OR description <> ''",
            name=op.f("ck_enroute_expenses_misc_described"),
        ),
        sa.CheckConstraint("amount > 0", name=op.f("ck_enroute_expenses_amount_positive")),
        sa.CheckConstraint("position >= 0", name=op.f("ck_enroute_expenses_position_not_negative")),
        sa.ForeignKeyConstraint(
            ["organization_id", "file_id"],
            ["core.files.organization_id", "core.files.id"],
            name=op.f("fk_enroute_expenses_organization_id_file_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.trip_sheet_id", "logistics.trips.id"],
            name=op.f("fk_enroute_expenses_organization_id_trip_sheet_id_trip_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_sheet_id"],
            ["logistics.trip_sheets.organization_id", "logistics.trip_sheets.id"],
            name=op.f("fk_enroute_expenses_organization_id_trip_sheet_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_enroute_expenses_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_enroute_expenses")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_enroute_expenses_organization_id_id")),
        schema="logistics",
    )
    op.create_index(
        op.f("ix_logistics_enroute_expenses_organization_id"),
        "enroute_expenses",
        ["organization_id"],
        unique=False,
        schema="logistics",
    )
    op.create_table(
        "trip_purchases",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("vendor_party_id", sa.UUID(), nullable=False),
        sa.Column("location", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("hsn_code", sa.Text(), nullable=True),
        sa.Column("unit", sa.Text(), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=12, scale=3), nullable=False),
        sa.Column("rate", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("gst_billed", sa.Boolean(), nullable=False),
        sa.Column("gst_rate_pct", sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column("vendor_gstin", sa.String(length=15), nullable=True),
        sa.Column("invoice_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("invoice_date", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'", name=op.f("ck_trip_purchases_hsn_shape")
        ),
        sa.CheckConstraint(
            "vendor_gstin IS NULL OR vendor_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'",
            name=op.f("ck_trip_purchases_vendor_gstin_shape"),
        ),
        sa.CheckConstraint(
            "NOT gst_billed OR vendor_gstin IS NOT NULL", name=op.f("ck_trip_purchases_gst_bill_has_gstin")
        ),
        sa.CheckConstraint("char_length(unit) BETWEEN 1 AND 20", name=op.f("ck_trip_purchases_unit_shape")),
        sa.CheckConstraint(
            "gst_rate_pct >= 0 AND gst_rate_pct <= 100", name=op.f("ck_trip_purchases_gst_rate_range")
        ),
        sa.CheckConstraint("position >= 0", name=op.f("ck_trip_purchases_position_not_negative")),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_trip_purchases_quantity_positive")),
        sa.CheckConstraint("rate > 0", name=op.f("ck_trip_purchases_rate_positive")),
        sa.ForeignKeyConstraint(
            ["organization_id", "item_id"],
            ["master.items.organization_id", "master.items.id"],
            name=op.f("fk_trip_purchases_organization_id_item_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.id"],
            name=op.f("fk_trip_purchases_organization_id_trip_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "vendor_party_id"],
            ["master.parties.organization_id", "master.parties.id"],
            name=op.f("fk_trip_purchases_organization_id_vendor_party_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_trip_purchases_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trip_purchases")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_trip_purchases_organization_id_id")),
        schema="procurement",
    )
    op.create_index(
        op.f("ix_procurement_trip_purchases_organization_id"),
        "trip_purchases",
        ["organization_id"],
        unique=False,
        schema="procurement",
    )
    op.create_table(
        "trip_closures",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("customer_party_id", sa.UUID(), nullable=False),
        sa.Column("billed", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("closed_by", sa.UUID(), nullable=False),
        sa.Column("closed_by_name", sa.Text(), nullable=False),
        sa.Column("closed_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("billed > 0", name=op.f("ck_trip_closures_billed_positive")),
        sa.ForeignKeyConstraint(
            ["organization_id", "closed_by"],
            ["core.users.organization_id", "core.users.id"],
            name=op.f("fk_trip_closures_organization_id_closed_by"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "customer_party_id"],
            ["master.parties.organization_id", "master.parties.id"],
            name=op.f("fk_trip_closures_organization_id_customer_party_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.id"],
            name=op.f("fk_trip_closures_organization_id_trip_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_trip_closures_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trip_closures")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_trip_closures_organization_id_id")),
        sa.UniqueConstraint(
            "organization_id",
            "trip_id",
            "customer_party_id",
            name=op.f("uq_trip_closures_organization_id_trip_id_customer_party_id"),
        ),
        schema="sales",
    )
    op.create_index(
        op.f("ix_sales_trip_closures_organization_id"),
        "trip_closures",
        ["organization_id"],
        unique=False,
        schema="sales",
    )
    op.create_table(
        "trip_sales",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("customer_party_id", sa.UUID(), nullable=False),
        sa.Column("location", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("purchase_order_id", sa.UUID(), nullable=True),
        sa.Column("po_ref", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("hsn_code", sa.Text(), nullable=True),
        sa.Column("unit", sa.Text(), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=12, scale=3), nullable=False),
        sa.Column("rate", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column(
            "transport_amount", sa.Numeric(precision=18, scale=2), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("gst_billed", sa.Boolean(), nullable=False),
        sa.Column("gst_rate_pct", sa.Numeric(precision=5, scale=2), nullable=False),
        sa.Column("party_gstin", sa.String(length=15), nullable=True),
        sa.Column("challan_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("invoice_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("po_file_id", sa.UUID(), nullable=True),
        sa.Column("dc_file_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint(
            "hsn_code IS NULL OR hsn_code ~ '^[0-9]{4,8}$'", name=op.f("ck_trip_sales_hsn_shape")
        ),
        sa.CheckConstraint(
            "party_gstin IS NULL OR party_gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'",
            name=op.f("ck_trip_sales_party_gstin_shape"),
        ),
        sa.CheckConstraint("char_length(unit) BETWEEN 1 AND 20", name=op.f("ck_trip_sales_unit_shape")),
        sa.CheckConstraint(
            "gst_rate_pct >= 0 AND gst_rate_pct <= 100", name=op.f("ck_trip_sales_gst_rate_range")
        ),
        sa.CheckConstraint("position >= 0", name=op.f("ck_trip_sales_position_not_negative")),
        sa.CheckConstraint("quantity > 0", name=op.f("ck_trip_sales_quantity_positive")),
        sa.CheckConstraint("rate > 0", name=op.f("ck_trip_sales_rate_positive")),
        sa.CheckConstraint("transport_amount >= 0", name=op.f("ck_trip_sales_transport_not_negative")),
        sa.ForeignKeyConstraint(
            ["organization_id", "customer_party_id"],
            ["master.parties.organization_id", "master.parties.id"],
            name=op.f("fk_trip_sales_organization_id_customer_party_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "dc_file_id"],
            ["core.files.organization_id", "core.files.id"],
            name=op.f("fk_trip_sales_organization_id_dc_file_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "item_id"],
            ["master.items.organization_id", "master.items.id"],
            name=op.f("fk_trip_sales_organization_id_item_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "po_file_id"],
            ["core.files.organization_id", "core.files.id"],
            name=op.f("fk_trip_sales_organization_id_po_file_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "purchase_order_id"],
            ["sales.purchase_orders.organization_id", "sales.purchase_orders.id"],
            name=op.f("fk_trip_sales_organization_id_purchase_order_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.id"],
            name=op.f("fk_trip_sales_organization_id_trip_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_trip_sales_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trip_sales")),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_trip_sales_organization_id_id")),
        schema="sales",
    )
    op.create_index(
        op.f("ix_sales_trip_sales_organization_id"),
        "trip_sales",
        ["organization_id"],
        unique=False,
        schema="sales",
    )
    op.create_table(
        "trip_purchase_files",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
        sa.Column("purchase_id", sa.UUID(), nullable=False),
        sa.Column("file_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["organization_id", "file_id"],
            ["core.files.organization_id", "core.files.id"],
            name=op.f("fk_trip_purchase_files_organization_id_file_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "purchase_id"],
            ["procurement.trip_purchases.organization_id", "procurement.trip_purchases.id"],
            name=op.f("fk_trip_purchase_files_organization_id_purchase_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id"],
            ["core.organizations.id"],
            name=op.f("fk_trip_purchase_files_organization_id"),
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_trip_purchase_files")),
        sa.UniqueConstraint(
            "organization_id", "file_id", name=op.f("uq_trip_purchase_files_organization_id_file_id")
        ),
        sa.UniqueConstraint("organization_id", "id", name=op.f("uq_trip_purchase_files_organization_id_id")),
        schema="procurement",
    )
    op.create_index(
        op.f("ix_procurement_trip_purchase_files_organization_id"),
        "trip_purchase_files",
        ["organization_id"],
        unique=False,
        schema="procurement",
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
    # Permission keys
    # ------------------------------------------------------------------
    op.execute(
        """
        INSERT INTO core.permissions (key, module, description) VALUES
            ('fleet.trip_pl.read',     'fleet',   'See trip sheets, their trips and their profit and loss'),
            ('fleet.trip_pl.write',    'fleet',   'Add, edit and delete trip sheets with their trips, diesel, en-route expenses, purchases, sales and payments'),
            ('finance.pl_report.read', 'finance', 'See the trip-wise, vehicle-wise and monthly P&L and the money-due lists')
        ON CONFLICT (key) DO UPDATE
            SET module = EXCLUDED.module, description = EXCLUDED.description
        """
    )


def downgrade() -> None:
    op.execute(f"DELETE FROM core.permissions WHERE key IN ({', '.join(repr(k) for k in KEYS)})")

    # Dropping a table drops its policy, trigger, indexes and grants with it.
    for table in reversed(TENANT_TABLES):
        op.execute(f"DROP TABLE {table}")

    op.drop_constraint(op.f("ck_files_purpose_known"), "files", schema="core", type_="check")
    op.create_check_constraint(
        op.f("ck_files_purpose_known"), "files", "purpose in ('expense_bill')", schema="core"
    )
    op.drop_constraint(op.f("ck_parties_customer_has_site"), "parties", schema="master", type_="check")
    op.alter_column(
        "parties", "served_from_site_id", existing_type=sa.UUID(), nullable=False, schema="master"
    )

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

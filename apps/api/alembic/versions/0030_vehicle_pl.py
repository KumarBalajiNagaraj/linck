"""vehicle P&L: trips with their diesel, purchases, sales, costs and payments

LIN-22. A tipper buys material from a vendor, delivers it to a customer, and the
trip's profit is the sale less the material, the diesel, the batta and the
costs on the road. These tables keep a trip and its lines, each in the schema
docs/DATABASE.md names for it:

    master.items                     materials: name, HSN code, GST rate, unit
    logistics.vehicle_duty_logs      one vehicle, one day: the cost container
    logistics.trips                  a leg of that day, with its km
    logistics.duty_fuel_links        a diesel bill or fuel entry posted to the day
    logistics.trip_diesel            a trip's diesel: typed, or its part of a fill
    logistics.trip_costs             batta, en-route and other costs
    procurement.trip_purchases       material bought for the trip
    procurement.trip_purchase_files  the vendor's invoice, photographed
    sales.trip_sales                 material sold, with transport as its own line
    finance.trip_payments            money in from customers, out to vendors, as reported

and changes two LIN-20 tables: master.parties takes vendors (a firm that only
sells to us is served from no site of ours, so served_from_site_id is null for
it, and still required of every customer), and core.files takes a vendor's
invoice as well as an expense bill.

Every new table is a tenant table like the rest: organization_id, RLS enabled
AND forced with the tenant_isolation policy, UNIQUE (organization_id, id) under
composite tenant foreign keys, and the audit trigger. Money is numeric(18,2),
litres numeric(12,3), times timestamptz. No figure the rules derive (a line's
value, GST, total, a trip's profit) is stored: app/domain/vehicle_pl.py works
them out on every read, so a correction or a changed rule shows at once.

Three permission keys: fleet.trip_pl.read and fleet.trip_pl.write for whoever
enters trips (each sees the P&L of the trips they may read), and
finance.pl_report.read for the vehicle-wise and monthly reports and the
money-due lists, which are the director's and accounts'.

Downgrade refuses (foreign-key violation or a failed check) while any role
holds one of the keys, any party is a vendor with no site, or any upload is a
vendor's invoice: silently dropping a grant or a party is not a schema change.

Revision ID: 0030_vehicle_pl
Revises: 0020_industry_news
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0030_vehicle_pl"
down_revision: str | None = "0020_industry_news"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

NEW_SCHEMAS = ("logistics", "procurement")

# Parents before children; downgrade walks it backwards.
TENANT_TABLES = (
    "master.items",
    "logistics.vehicle_duty_logs",
    "logistics.trips",
    "logistics.duty_fuel_links",
    "logistics.trip_diesel",
    "logistics.trip_costs",
    "procurement.trip_purchases",
    "procurement.trip_purchase_files",
    "sales.trip_sales",
    "finance.trip_payments",
)

KEYS = ("fleet.trip_pl.read", "fleet.trip_pl.write", "finance.pl_report.read")

UNITS = "('unit', 'tonne', 'cft', 'cum', 'load')"
HSN = "hsn_code ~ '^[0-9]{4,8}$'"


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


def _id_and_org() -> list[sa.Column]:
    return [
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("organization_id", sa.UUID(), nullable=False),
    ]


def _timestamps(updated: bool = True) -> list[sa.Column]:
    columns = [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False)
    ]
    if updated:
        columns.append(
            sa.Column(
                "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
            )
        )
    return columns


def _tenant_keys(table: str) -> list[sa.Constraint]:
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


def _line_columns() -> list[sa.Column]:
    """What a purchase and a sale line share: the material, as billed."""
    return [
        sa.Column("item_id", sa.UUID(), nullable=False),
        sa.Column("hsn_code", sa.Text(), nullable=False),
        sa.Column("unit", sa.Text(), nullable=False),
        sa.Column("quantity", sa.Numeric(precision=12, scale=3), nullable=False),
        sa.Column("rate", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("gst_billed", sa.Boolean(), nullable=False),
        sa.Column("gst_rate_pct", sa.Numeric(precision=5, scale=2), nullable=False),
    ]


def _line_checks(table: str) -> list[sa.CheckConstraint]:
    return [
        _check(table, "hsn_shape", HSN),
        _check(table, "unit_known", f"unit in {UNITS}"),
        _check(table, "gst_rate_range", "gst_rate_pct >= 0 AND gst_rate_pct <= 100"),
        _check(table, "position_not_negative", "position >= 0"),
        _check(table, "quantity_positive", "quantity > 0"),
        _check(table, "rate_positive", "rate > 0"),
    ]


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
    # LIN-20 tables: vendors in the party master, invoices among the uploads
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
        "purpose in ('expense_bill', 'purchase_invoice')",
        schema="core",
    )

    # ------------------------------------------------------------------
    # master.items
    # ------------------------------------------------------------------
    op.create_table(
        "items",
        *_id_and_org(),
        sa.Column("code", sa.Text(), nullable=False),
        sa.Column("name", sa.Text(), nullable=False),
        sa.Column("hsn_code", sa.Text(), nullable=False),
        sa.Column(
            "gst_rate_pct", sa.Numeric(precision=5, scale=2), server_default=sa.text("0"), nullable=False
        ),
        sa.Column("unit", sa.Text(), server_default=sa.text("'unit'"), nullable=False),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        *_timestamps(),
        _check("items", "code_shape", "code ~ '^[A-Z0-9_-]{1,32}$'"),
        _check("items", "hsn_shape", HSN),
        _check("items", "unit_known", f"unit in {UNITS}"),
        _check("items", "gst_rate_range", "gst_rate_pct >= 0 AND gst_rate_pct <= 100"),
        *_tenant_keys("items"),
        sa.UniqueConstraint("organization_id", "code", name=op.f("uq_items_organization_id_code")),
        schema="master",
    )
    _org_index("master", "items")

    # ------------------------------------------------------------------
    # logistics.vehicle_duty_logs
    # ------------------------------------------------------------------
    op.create_table(
        "vehicle_duty_logs",
        *_id_and_org(),
        sa.Column("vehicle_ref", sa.Text(), nullable=False),
        sa.Column("duty_date", sa.Date(), nullable=False),
        sa.Column("allocation_rule_version", sa.Text(), server_default=sa.text("'km-v1'"), nullable=False),
        *_timestamps(),
        *_tenant_keys("vehicle_duty_logs"),
        sa.UniqueConstraint(
            "organization_id",
            "vehicle_ref",
            "duty_date",
            name=op.f("uq_vehicle_duty_logs_organization_id_vehicle_ref_duty_date"),
        ),
        sa.UniqueConstraint(
            "organization_id",
            "id",
            "vehicle_ref",
            "duty_date",
            name=op.f("uq_vehicle_duty_logs_organization_id_id_vehicle_ref_duty_date"),
        ),
        schema="logistics",
    )
    _org_index("logistics", "vehicle_duty_logs")

    # ------------------------------------------------------------------
    # logistics.trips
    # ------------------------------------------------------------------
    op.create_table(
        "trips",
        *_id_and_org(),
        sa.Column("financial_year", sa.Text(), nullable=False),
        sa.Column("serial", sa.Integer(), nullable=False),
        sa.Column("trip_number", sa.Text(), nullable=False),
        sa.Column("duty_log_id", sa.UUID(), nullable=False),
        sa.Column("site_id", sa.UUID(), nullable=False),
        sa.Column("vehicle_ref", sa.Text(), nullable=False),
        sa.Column("registration_number", sa.Text(), nullable=False),
        sa.Column("vehicle_model", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("driver_ref", sa.Text(), nullable=True),
        sa.Column("driver_name", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("driver_phone", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("trip_date", sa.Date(), nullable=False),
        sa.Column("start_km", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column("end_km", sa.Numeric(precision=12, scale=2), nullable=True),
        sa.Column("notes", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=False),
        sa.Column("created_by_name", sa.Text(), nullable=False),
        *_timestamps(),
        _check(
            "trips",
            "km_in_order",
            "(start_km IS NULL OR start_km >= 0) AND (end_km IS NULL OR end_km >= 0) "
            "AND (start_km IS NULL OR end_km IS NULL OR end_km >= start_km)",
        ),
        _check("trips", "serial_positive", "serial > 0"),
        # A trip's vehicle and date are its day's.
        sa.ForeignKeyConstraint(
            ["organization_id", "duty_log_id", "vehicle_ref", "trip_date"],
            [
                "logistics.vehicle_duty_logs.organization_id",
                "logistics.vehicle_duty_logs.id",
                "logistics.vehicle_duty_logs.vehicle_ref",
                "logistics.vehicle_duty_logs.duty_date",
            ],
            name=op.f("fk_trips_organization_id_duty_log_id_vehicle_ref_trip_date"),
            ondelete="RESTRICT",
        ),
        _tenant_fk("trips", "site_id", "core.sites"),
        _tenant_fk("trips", "created_by", "core.users"),
        *_tenant_keys("trips"),
        sa.UniqueConstraint(
            "organization_id", "trip_number", name=op.f("uq_trips_organization_id_trip_number")
        ),
        sa.UniqueConstraint(
            "organization_id",
            "financial_year",
            "serial",
            name=op.f("uq_trips_organization_id_financial_year_serial"),
        ),
        sa.UniqueConstraint(
            "organization_id", "duty_log_id", "id", name=op.f("uq_trips_organization_id_duty_log_id_id")
        ),
        schema="logistics",
    )
    _org_index("logistics", "trips")
    op.create_index(
        "ix_trips_date", "trips", ["organization_id", "trip_date"], unique=False, schema="logistics"
    )
    op.create_index(
        "ix_trips_vehicle_date",
        "trips",
        ["organization_id", "vehicle_ref", "trip_date"],
        unique=False,
        schema="logistics",
    )

    # ------------------------------------------------------------------
    # logistics.duty_fuel_links
    # ------------------------------------------------------------------
    op.create_table(
        "duty_fuel_links",
        *_id_and_org(),
        sa.Column("duty_log_id", sa.UUID(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("expense_bill_id", sa.UUID(), nullable=True),
        sa.Column("fuel_entry_ref", sa.Text(), nullable=True),
        sa.Column("litres", sa.Numeric(precision=12, scale=3), nullable=True),
        sa.Column("rate", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("bill_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("vendor", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("filled_at", sa.DateTime(timezone=True), nullable=True),
        *_timestamps(updated=False),
        _check("duty_fuel_links", "source_known", "source in ('expense_bill', 'fuel_entry')"),
        _check(
            "duty_fuel_links",
            "source_named",
            "(source = 'expense_bill') = (expense_bill_id IS NOT NULL) "
            "AND (source = 'fuel_entry') = (fuel_entry_ref IS NOT NULL)",
        ),
        _check(
            "duty_fuel_links",
            "figures_from_the_source",
            "CASE WHEN source = 'expense_bill' THEN litres IS NULL AND rate IS NULL AND amount IS NULL "
            "ELSE litres > 0 AND amount > 0 AND (rate IS NULL OR rate > 0) END",
        ),
        _tenant_fk("duty_fuel_links", "duty_log_id", "logistics.vehicle_duty_logs"),
        _tenant_fk("duty_fuel_links", "expense_bill_id", "finance.expense_bills"),
        *_tenant_keys("duty_fuel_links"),
        sa.UniqueConstraint(
            "organization_id",
            "duty_log_id",
            "id",
            name=op.f("uq_duty_fuel_links_organization_id_duty_log_id_id"),
        ),
        sa.UniqueConstraint(
            "organization_id",
            "expense_bill_id",
            name=op.f("uq_duty_fuel_links_organization_id_expense_bill_id"),
        ),
        sa.UniqueConstraint(
            "organization_id",
            "fuel_entry_ref",
            name=op.f("uq_duty_fuel_links_organization_id_fuel_entry_ref"),
        ),
        schema="logistics",
    )
    _org_index("logistics", "duty_fuel_links")

    # ------------------------------------------------------------------
    # logistics.trip_diesel
    # ------------------------------------------------------------------
    op.create_table(
        "trip_diesel",
        *_id_and_org(),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("source", sa.Text(), nullable=False),
        sa.Column("litres", sa.Numeric(precision=12, scale=3), nullable=True),
        sa.Column("rate", sa.Numeric(precision=18, scale=2), nullable=True),
        sa.Column("vendor", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("bill_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("link_id", sa.UUID(), nullable=True),
        sa.Column("duty_log_id", sa.UUID(), nullable=True),
        *_timestamps(),
        _check("trip_diesel", "source_known", "source in ('typed', 'expense_bill', 'fuel_entry')"),
        _check(
            "trip_diesel",
            "typed_or_linked",
            "(source = 'typed') = (link_id IS NULL) AND (link_id IS NULL) = (duty_log_id IS NULL)",
        ),
        _check(
            "trip_diesel",
            "figures_typed_once",
            "CASE WHEN source = 'typed' THEN litres > 0 AND rate > 0 ELSE litres IS NULL AND rate IS NULL END",
        ),
        _check("trip_diesel", "position_not_negative", "position >= 0"),
        _tenant_fk("trip_diesel", "trip_id", "logistics.trips"),
        # Both through duty_log_id: a link names a fill of the trip's own day.
        sa.ForeignKeyConstraint(
            ["organization_id", "duty_log_id", "trip_id"],
            ["logistics.trips.organization_id", "logistics.trips.duty_log_id", "logistics.trips.id"],
            name=op.f("fk_trip_diesel_organization_id_duty_log_id_trip_id"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["organization_id", "duty_log_id", "link_id"],
            [
                "logistics.duty_fuel_links.organization_id",
                "logistics.duty_fuel_links.duty_log_id",
                "logistics.duty_fuel_links.id",
            ],
            name=op.f("fk_trip_diesel_organization_id_duty_log_id_link_id"),
            ondelete="RESTRICT",
        ),
        *_tenant_keys("trip_diesel"),
        sa.UniqueConstraint(
            "organization_id",
            "trip_id",
            "link_id",
            name=op.f("uq_trip_diesel_organization_id_trip_id_link_id"),
        ),
        schema="logistics",
    )
    _org_index("logistics", "trip_diesel")

    # ------------------------------------------------------------------
    # logistics.trip_costs
    # ------------------------------------------------------------------
    op.create_table(
        "trip_costs",
        *_id_and_org(),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("kind", sa.Text(), nullable=False),
        sa.Column("description", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        *_timestamps(),
        _check("trip_costs", "kind_known", "kind in ('batta', 'en_route', 'other')"),
        _check("trip_costs", "amount_positive", "amount > 0"),
        _check("trip_costs", "position_not_negative", "position >= 0"),
        _tenant_fk("trip_costs", "trip_id", "logistics.trips"),
        *_tenant_keys("trip_costs"),
        schema="logistics",
    )
    _org_index("logistics", "trip_costs")

    # ------------------------------------------------------------------
    # procurement.trip_purchases, procurement.trip_purchase_files
    # ------------------------------------------------------------------
    op.create_table(
        "trip_purchases",
        *_id_and_org(),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("vendor_party_id", sa.UUID(), nullable=False),
        *_line_columns(),
        sa.Column("invoice_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("invoice_date", sa.Date(), nullable=True),
        *_timestamps(),
        *_line_checks("trip_purchases"),
        _tenant_fk("trip_purchases", "trip_id", "logistics.trips"),
        _tenant_fk("trip_purchases", "vendor_party_id", "master.parties"),
        _tenant_fk("trip_purchases", "item_id", "master.items"),
        *_tenant_keys("trip_purchases"),
        schema="procurement",
    )
    _org_index("procurement", "trip_purchases")

    op.create_table(
        "trip_purchase_files",
        *_id_and_org(),
        sa.Column("purchase_id", sa.UUID(), nullable=False),
        sa.Column("file_id", sa.UUID(), nullable=False),
        *_timestamps(updated=False),
        _tenant_fk("trip_purchase_files", "purchase_id", "procurement.trip_purchases"),
        _tenant_fk("trip_purchase_files", "file_id", "core.files"),
        *_tenant_keys("trip_purchase_files"),
        sa.UniqueConstraint(
            "organization_id", "file_id", name=op.f("uq_trip_purchase_files_organization_id_file_id")
        ),
        schema="procurement",
    )
    _org_index("procurement", "trip_purchase_files")

    # ------------------------------------------------------------------
    # sales.trip_sales
    # ------------------------------------------------------------------
    op.create_table(
        "trip_sales",
        *_id_and_org(),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("customer_party_id", sa.UUID(), nullable=False),
        sa.Column("purchase_order_id", sa.UUID(), nullable=True),
        sa.Column("po_ref", sa.Text(), server_default=sa.text("''"), nullable=False),
        *_line_columns(),
        sa.Column(
            "transport_amount", sa.Numeric(precision=18, scale=2), server_default=sa.text("0"), nullable=False
        ),
        sa.Column(
            "transport_gst_rate_pct",
            sa.Numeric(precision=5, scale=2),
            server_default=sa.text("0"),
            nullable=False,
        ),
        sa.Column("challan_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("invoice_number", sa.Text(), server_default=sa.text("''"), nullable=False),
        *_timestamps(),
        *_line_checks("trip_sales"),
        _check("trip_sales", "transport_not_negative", "transport_amount >= 0"),
        _check(
            "trip_sales",
            "transport_gst_rate_range",
            "transport_gst_rate_pct >= 0 AND transport_gst_rate_pct <= 100",
        ),
        _tenant_fk("trip_sales", "trip_id", "logistics.trips"),
        _tenant_fk("trip_sales", "customer_party_id", "master.parties"),
        _tenant_fk("trip_sales", "purchase_order_id", "sales.purchase_orders"),
        _tenant_fk("trip_sales", "item_id", "master.items"),
        *_tenant_keys("trip_sales"),
        schema="sales",
    )
    _org_index("sales", "trip_sales")

    # ------------------------------------------------------------------
    # finance.trip_payments
    # ------------------------------------------------------------------
    op.create_table(
        "trip_payments",
        *_id_and_org(),
        sa.Column("trip_id", sa.UUID(), nullable=False),
        sa.Column("position", sa.SmallInteger(), nullable=False),
        sa.Column("direction", sa.Text(), nullable=False),
        sa.Column("party_id", sa.UUID(), nullable=False),
        sa.Column("paid_on", sa.Date(), nullable=False),
        sa.Column("method", sa.Text(), nullable=False),
        sa.Column("reference_no", sa.Text(), nullable=True),
        sa.Column("amount", sa.Numeric(precision=18, scale=2), nullable=False),
        sa.Column("note", sa.Text(), server_default=sa.text("''"), nullable=False),
        sa.Column("recorded_by", sa.UUID(), nullable=False),
        *_timestamps(),
        _check("trip_payments", "direction_known", "direction in ('in', 'out')"),
        _check(
            "trip_payments", "method_known", "method in ('neft', 'rtgs', 'imps', 'upi', 'cheque', 'cash')"
        ),
        _check("trip_payments", "amount_positive", "amount > 0"),
        _check(
            "trip_payments", "reference_shape", "reference_no IS NULL OR reference_no ~ '^[A-Z0-9/-]{3,40}$'"
        ),
        _check("trip_payments", "position_not_negative", "position >= 0"),
        _tenant_fk("trip_payments", "trip_id", "logistics.trips"),
        _tenant_fk("trip_payments", "party_id", "master.parties"),
        _tenant_fk("trip_payments", "recorded_by", "core.users"),
        *_tenant_keys("trip_payments"),
        schema="finance",
    )
    _org_index("finance", "trip_payments")
    op.create_index(
        "uq_trip_payments_organization_id_trip_id_reference_no",
        "trip_payments",
        ["organization_id", "trip_id", "reference_no"],
        unique=True,
        schema="finance",
        postgresql_where=sa.text("reference_no IS NOT NULL"),
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
            ('fleet.trip_pl.read',     'fleet',   'See trips and their profit and loss'),
            ('fleet.trip_pl.write',    'fleet',   'Add, edit and delete trips with their diesel, purchases, sales, costs and payments'),
            ('finance.pl_report.read', 'finance', 'See the vehicle-wise and monthly P&L and the money-due lists')
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

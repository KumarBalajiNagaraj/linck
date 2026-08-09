### `core.organizations`
Tenant root. Every RLS policy resolves to this id. Holds the org-level policy switches (segregation enforcement, tolerance bands, AI auto-accept threshold) that the adversarial review showed must be configuration, not hard-coded constraints.

```
id uuid pk default gen_random_uuid()
legal_name text not null
display_name text not null
slug text not null unique (lower)
pan text
base_currency text not null default 'INR'
timezone text not null default 'Asia/Kolkata'
fiscal_year_start_month int not null default 4
status organization_status not null default 'active'
segregation_enforcement text not null default 'review_queue' -- review_queue | hard_block; single-person accounts teams cannot use hard_block
google_hosted_domains text[] not null default '{}'
settings jsonb not null default '{}' -- feature flags, AI confidence thresholds, tolerance bands, quiet hours
created_at timestamptz not null default now()
updated_at timestamptz not null default now()
```

**Constraints**
- the only table without organization_id; its id IS the tenant key
- CHECK fiscal_year_start_month between 1 and 12

### `core.sites`
Single winner over the three competing site concepts. This is OUR physical locations only; customer ship-to addresses live in sales.customer_sites and are deliberately NOT rows here. It is the primary RBAC scope, the stock-location parent, and the GST place-of-business anchor.

```
id uuid pk
organization_id uuid fk->core.organizations not null
code text not null
name text not null
site_type site_type not null -- head_office|quarry|crusher_plant|stockyard|depot|workshop|weighbridge_point|fuel_point
parent_site_id uuid fk->core.sites null
materialized_path text not null -- '/root/quarry-a/plant-1/', trigger-maintained
gst_registration_id uuid fk->compliance.gst_registrations null -- which registration this place of business belongs to
state_code text not null -- 2-digit GST state code
address jsonb not null default '{}'
geo_lat numeric(9,6) null
geo_lng numeric(9,6) null
geofence_radius_m int null
cost_center_id uuid fk->core.cost_centers null
is_stock_location boolean not null default false
is_active boolean not null default true
created_at/updated_at/created_by/updated_by
```

**Constraints**
- UNIQUE (organization_id, code)
- UNIQUE (organization_id, id) -- target of every composite tenant-safe FK
- index (organization_id, materialized_path text_pattern_ops)
- CHECK parent_site_id <> id

### `core.role_assignments`
The only place access is granted. It is flattened by trigger into core.user_scope_grants (organization_id, user_id, permission_key, org_wide, site_ids uuid[]), which is what both the FastAPI check and every site-scoped RLS policy read — one index lookup instead of a four-table join per request.

```
id uuid pk
organization_id uuid fk->core.organizations not null
user_id uuid fk->core.users not null
role_id uuid fk->core.roles not null
scope_level scope_level not null -- organization|team|site
team_id uuid fk->core.teams null
site_id uuid fk->core.sites null
include_descendant_sites boolean not null default true
valid_from timestamptz not null default now()
valid_to timestamptz null
granted_by uuid fk->core.users not null
grant_reason text null
revoked_at timestamptz null
revoked_by uuid null
```

**Constraints**
- CHECK (scope_level='organization' AND team_id IS NULL AND site_id IS NULL) OR (scope_level='team' AND team_id IS NOT NULL AND site_id IS NULL) OR (scope_level='site' AND site_id IS NOT NULL)
- UNIQUE (organization_id,user_id,role_id,coalesce(team_id,uuid_nil),coalesce(site_id,uuid_nil)) WHERE revoked_at IS NULL
- trigger: at least one live org_owner assignment must remain
- trigger: rebuild core.user_scope_grants for the affected user

### `core.audit_logs`
Written by one generic row trigger attached to every business table, so nothing escapes it — not background workers, not psql, not Alembic data fixes. In a business replacing paper this is the control that makes the system trustworthy. Service layer additionally writes semantic rows (action='approve') that a row trigger cannot infer.

```
id uuid pk
organization_id uuid not null
occurred_at timestamptz not null default now() -- PARTITION KEY
actor_type actor_type not null -- user|system_job|ai_agent|api_client|migration
actor_user_id uuid null
impersonated_by_user_id uuid null
action audit_action not null
entity_schema text not null
entity_type text not null
entity_id uuid null
entity_label text null -- snapshot, survives deletion
before jsonb null
after jsonb null
changed_fields text[] null
reason text null -- mandatory for void/override/backdate
request_id text null
session_id uuid null
ip inet null
agent_action_id uuid fk->ai.agent_actions null
```

**Constraints**
- REVOKE UPDATE, DELETE FROM linck_app + BEFORE UPDATE/DELETE trigger that raises
- PARTITION BY RANGE (occurred_at) monthly
- index (organization_id, entity_type, entity_id, occurred_at desc); BRIN (occurred_at); GIN (changed_fields)
- sensitive columns redacted to '[redacted]' in-trigger via a seeded exclusion registry

### `core.obligations`
The owner's stated need — 'permit dates and insurance end dates must alert before expiry' — becomes one indexed query instead of five module-specific reminder tables. Replaces fleet.document_reminders and finance.financial_obligations entirely. exposure_amount exists because the adversarial review is right that an MD acts on a rupee figure, not a red dot.

```
id uuid pk
organization_id uuid not null
obligation_type obligation_type not null -- insurance_renewal|fitness|permit|road_tax|puc|licence|loan_emi|vendor_payment|msme_deadline|tds_deposit|gst_return|payroll|lease_royalty|mineral_permit_expiry|weighbridge_calibration
source_schema text not null
source_table text not null
source_id uuid not null
title text not null
due_date date not null
amount numeric(18,2) null
estimated_amount numeric(18,2) null -- prior-year actual, for cash forecast when amount unknown
exposure_amount numeric(18,2) null -- quantified penalty/seizure exposure if missed
party_id uuid fk->master.parties null
vehicle_id uuid fk->fleet.vehicles null
site_id uuid fk->core.sites null
cost_center_id uuid null
status obligation_status not null -- upcoming|due|overdue|paid|waived|cancelled
severity smallint not null default 3 -- 1..5; expired insurance on a running tipper is forced to 5
blocks_operation boolean not null default false -- true => fleet dispatch gate honours it
alert_offsets_days int[] not null default '{60,30,14,7,1,0}'
assigned_to_user_id uuid null
acknowledged_by uuid null; acknowledged_at timestamptz null; snoozed_until date null
settled_by_payment_id uuid fk->finance.payments null; settled_on date null
```

**Constraints**
- UNIQUE (organization_id, source_table, source_id, obligation_type)
- index (organization_id, due_date, status) WHERE status IN ('upcoming','due','overdue')
- index (organization_id, severity desc, due_date) WHERE status <> 'paid'
- maintained by AFTER triggers on compliance.documents, finance.loan_installments, finance.purchase_invoices, compliance.mineral_permits, finance.withholding_deductions

### `master.parties`
Collapses four proposed masters — vendors, customers, hired_transporters, business_partners — into one. The same crusher-spares dealer is routinely also a material customer and sometimes a lorry owner. Duplicate party masters are the number one cause of wrong ageing, and without a merge tool you accumulate orphaned ledger fragments within a year.

```
id uuid pk
organization_id uuid not null
code text not null
legal_name text not null
display_name text not null
party_roles party_role[] not null -- {customer,vendor,transporter,lender,statutory_authority,broker,employee_payee}
is_walk_in boolean not null default false -- counter cash buyers; excluded from AR ageing and credit exposure
gstin text null
gst_registration_type gst_registration_type not null default 'unregistered'
pan text null
state_code text null
is_msme boolean not null default false; msme_category msme_category not null default 'unknown'; udyam_no text null; has_written_payment_agreement boolean not null default false
withholding_code text null -- numeric payment code under ITA 2025 (s.393); NOT a legacy section string
withholding_statute_version text not null default 'ITA2025'
transporter_small_fleet_declaration_fy text null -- <=10 goods carriages declaration, per FY, with PAN
gta_gst_regime text null -- rcm_5|fcm_5_no_itc|fcm_18_with_itc|not_gta|na
issues_consignment_note boolean not null default false
lower_deduction_cert jsonb null
credit_limit numeric(18,2) not null default 0
credit_days int not null default 0
credit_enforcement text not null default 'warn' -- warn|block|block_with_override
payment_terms_days int null
allocation_policy text not null default 'oldest_first' -- oldest_first|manual|by_site|by_po
rating_score numeric(4,2) null
status party_status not null default 'active'
```

**Constraints**
- UNIQUE (organization_id, code); UNIQUE (organization_id, id)
- UNIQUE (organization_id, gstin) WHERE gstin IS NOT NULL
- CHECK gstin format + checksum; CHECK pan = substring(gstin,3,10) when gstin present
- CHECK (gst_registration_type='unregistered') = (gstin IS NULL)
- fuzzy-duplicate block at creation on (phone, pan, normalised name) + a merge tool

### `master.items`
Merges products and store_items into one master. The boundary question the domain architects could not settle — do tyres and diesel live in stores or fleet — dissolves: they are items, procured and stocked through one ledger, with fleet holding the serial-level fitment history. statutory_uqc exists because the entire business bills in CFT and CFT is not an accepted GST Unit Quantity Code; every e-invoice line needs a second, statutory quantity.

```
id uuid pk
organization_id uuid not null
code text not null
name text not null
item_class item_class not null -- raw_boulder|finished_good|byproduct|waste|spare|consumable|lubricant|tyre|wear_part|fuel|tool|ppe
item_category_id uuid fk->master.item_categories null
stock_uom uom not null -- canonical; 'mt' for bulk, 'nos'/'litre' for stores
sales_default_uom uom null -- 'unit' (=100 cft) for sand, 'mt' for aggregate
hsn_code text fk->compliance.hsn_master null
gst_rate_pct numeric(5,2) null
statutory_uqc text null -- CBM or MTS; CFT is NOT a valid UQC and cannot go on an e-invoice line
bulk_density_loose_t_per_cum numeric(10,4) null -- stockpile survey
bulk_density_trade_t_per_cum numeric(10,4) null -- billing convention (~1.766 for M-sand)
nominal_size_mm_min/max numeric(6,2) null
is_saleable/is_produced/is_purchased boolean not null default false
is_serialised boolean not null default false -- tyres, major assemblies
applicable_asset_types text[] not null default '{}' -- blocks a jaw plate being issued to a tipper
valuation_method valuation_method not null default 'weighted_average'
shrinkage_tolerance_pct numeric(5,2) null
expected_life_mt numeric(18,3) null -- wear parts
abc_class abc_class null; ved_class ved_class null
reorder_level/reorder_qty/min_qty/max_qty numeric(18,3) null; lead_time_days int null
default_vendor_party_id uuid fk->master.parties null
allow_negative_stock boolean not null default false
attributes jsonb not null default '{}' -- fineness modulus, IS 383 zone, OEM part no, alternates
is_active boolean not null default true
```

**Constraints**
- UNIQUE (organization_id, code); UNIQUE (organization_id, id)
- CHECK (item_class IN ('finished_good','byproduct','raw_boulder') implies statutory_uqc IS NOT NULL AND bulk_density_trade_t_per_cum IS NOT NULL)
- GIN trigram on name and attributes->>'oem_part_no'

### `master.uom_conversions`
The single largest revenue-leak surface in this business, and the two source proposals disagreed by ~15% on the same conversion (22-24 cft/tonne vs 20 cft/tonne). This table is the ONLY conversion authority; sales.cft_per_tonne is deleted. Every quantity-bearing row must persist qty_entered, uom_entered, conversion_factor_used and uom_conversion_id so a later density revision never rewrites history.

```
id uuid pk
organization_id uuid not null
item_id uuid fk->master.items null -- NULL = global dimensional identity
from_uom uom not null
to_uom uom not null
factor numeric(24,12) not null -- to_qty = from_qty * factor
basis uom_conversion_basis not null -- dimensional|density|trade_convention
density_basis density_basis null -- loose|compacted|as_loaded_trade
applies_to text not null default 'all' -- all|sales|production|stock_take|statutory
effective_from date not null
effective_to date null
source_note text null -- 'IS 2386 test 2026-03-11' or 'contract cl.4'
approved_by uuid null
```

**Constraints**
- UNIQUE (organization_id, coalesce(item_id,uuid_nil), from_uom, to_uom, applies_to, effective_from)
- EXCLUDE USING gist over (org, item, from_uom, to_uom, applies_to, daterange(effective_from,effective_to)) — no ambiguous lookup
- CHECK (basis='dimensional' implies item_id IS NULL); dimensional rows immutable after creation
- seeded exact: 1 cum = 35.314666721 cft; 1 unit = 100 cft = 2.831684659 cum

### `master.employees`
Resolves the users/employees/drivers three-way overlap. Login identity (core.users) is global and optional; employment is tenant-scoped; driver-specific licence and competence facts are a 1:1 extension. Deleting the standalone drivers table removes a duplicate person record that would otherwise diverge from payroll within a month.

```
id uuid pk
organization_id uuid not null
employee_code text not null
full_name text not null
user_id uuid fk->core.users null -- NULLABLE: most drivers and operators will never have a login
mobile_e164 text null -- the OTP and WhatsApp identity
employment_type employment_type not null
wage_basis wage_basis not null -- monthly|daily|hourly|per_trip|per_tonne|per_km|piece_rate
designation text not null
date_of_joining date not null; date_of_leaving date null
home_site_id uuid fk->core.sites null
department_cost_center_id uuid fk->core.cost_centers null
reporting_to_employee_id uuid fk->master.employees null
pan text null; aadhaar_last4 text null -- full Aadhaar is never stored here
uan text null; esic_ip_no text null
pf_applicable/esi_applicable/pt_applicable/gratuity_applicable boolean not null default false
pt_state text null -- KA is monthly, TN is half-yearly; the logic is not interchangeable
bank_details jsonb null
is_driver boolean not null default false
is_active boolean not null default true
```

**Constraints**
- UNIQUE (organization_id, employee_code); UNIQUE (organization_id, id)
- UNIQUE (organization_id, uan) WHERE uan IS NOT NULL
- UNIQUE (organization_id, user_id) WHERE user_id IS NOT NULL
- 1:1 optional extension fleet.driver_profiles (licence, classes, badge, blood group, emergency contact)

### `fleet.vehicles`
The fleet's identity row and the anchor of the cost-centre dimension. Hired and own vehicles are one table with an ownership discriminator, so cost per tonne is comparable; the separate hired_vehicles table from the sales proposal is deleted and its document-expiry fields move to compliance.documents.

```
id uuid pk
organization_id uuid not null
registration_number text not null -- stored normalised upper, no separators
vehicle_model_id uuid fk->fleet.vehicle_models not null
category vehicle_category not null
ownership_type vehicle_ownership_type not null -- owned|hired|leased|attached|customer_supplied
owner_party_id uuid fk->master.parties null -- for hired/attached
chassis_number text null; engine_number text null
home_site_id uuid fk->core.sites null
cost_center_id uuid fk->core.cost_centers not null -- one cost centre per tipper; this is what makes per-vehicle P&L work
fixed_asset_id uuid fk->finance.fixed_assets null
current_status vehicle_status not null -- CACHE of latest fleet.vehicle_status_events; trigger-only
current_status_since timestamptz null
current_usage_km numeric(14,2) null -- CACHE of max normalised fleet.usage_readings
current_driver_employee_id uuid null -- CACHE
rated_capacity_tonnes numeric(10,3) null
rated_capacity_cft numeric(14,2) null
standing_tare_kg numeric(12,3) null; standing_tare_weighed_at timestamptz null
fuel_tank_capacity_litres numeric(10,2) null; def_tank_capacity_litres numeric(10,2) null
overload_threshold_pct numeric(5,2) not null default 115 -- configurable; 103% fires on most loads and gets switched off
registration_date date null; purchase_date date null
is_active boolean not null default true; disposal_date date null
```

**Constraints**
- UNIQUE (organization_id, registration_number); UNIQUE (organization_id, id)
- UNIQUE (organization_id, chassis_number) WHERE chassis_number IS NOT NULL
- registration format validated in the service layer with a warning, NOT a CHECK — a BH-series or defence plate must never stop a load at 11pm
- dispatch gate reads core.obligations WHERE vehicle_id = this AND blocks_operation AND status='overdue'

### `fleet.fuel_issues`
Diesel is the largest operating cost and the largest leak. Per-trip cost lines catch neither of the two real thefts — the attendant issuing 90L against a 100L record, and the driver siphoning on the highway. The totalizer reading plus a daily inventory.stock_ledger reconciliation against fleet.fuel_tank_dips catches the first; km/L trended per (vehicle, driver, lane) catches the second.

```
id uuid pk
organization_id uuid not null
vehicle_id uuid fk->fleet.vehicles null -- null for plant/genset issues
duty_log_id uuid fk->logistics.vehicle_duty_logs null
driver_employee_id uuid fk->master.employees null
stock_location_id uuid fk->inventory.stock_locations not null -- own bunk, bowser, or a virtual location for an outside bunk
item_id uuid fk->master.items not null -- diesel | adblue_def
fuel_source fuel_source not null -- own_bunk|outside_bunk|mobile_bowser|barrel|customer_supplied
issued_at timestamptz not null
quantity_litres numeric(12,3) not null
pump_totalizer_before numeric(14,2) null; pump_totalizer_after numeric(14,2) null -- non-negotiable for own bunk: this is what catches the attendant, not the driver
usage_reading_id uuid fk->fleet.usage_readings not null -- created in the same transaction; no fuel without an odometer
rate_per_litre numeric(18,4) not null; amount numeric(18,2) not null
tank_fill_type tank_fill_type not null -- only full_tank pairs close a mileage segment
bill_number text null; bill_date date null
payment_mode payment_mode not null
paid_by cost_bearer not null default 'company'
party_id uuid fk->master.parties null -- outside bunk vendor
stock_ledger_id uuid fk->inventory.stock_ledger null -- own-bunk issues must move stock
purchase_invoice_id uuid fk->finance.purchase_invoices null
entry_source data_source not null default 'manual'; confidence numeric(4,3) null; extraction_job_id uuid null
is_suspect boolean not null default false; suspect_reason text[] null
approved_by uuid null; approved_at timestamptz null
```

**Constraints**
- CHECK quantity_litres > 0 AND rate_per_litre > 0
- CHECK abs(amount - round(quantity_litres*rate_per_litre,2)) <= 1.00
- CHECK (fuel_source='own_bunk' implies stock_ledger_id IS NOT NULL AND pump_totalizer_after IS NOT NULL)
- reject quantity_litres > vehicles.fuel_tank_capacity_litres * 1.15 on a diesel full_tank
- UNIQUE (organization_id, party_id, bill_number) WHERE bill_number IS NOT NULL

### `compliance.documents`
Collapses vehicle_documents, driver_documents, compliance_documents, weighbridge stamping and lease validity into one register with one renewal-chain discipline. Renewals are new rows, so annual premium and permit-fee drift per vehicle becomes a query. It is the single input to the alert engine the owner explicitly asked for.

```
id uuid pk
organization_id uuid not null
doc_type compliance_document_type not null -- insurance|fitness_certificate|permit_national|permit_state|permit_authorization|road_tax|puc|rc|hypothecation|driving_licence|transport_badge|medical|police_verification|mining_lease|consent_to_operate|factory_licence|explosive_licence|weighbridge_calibration|vltd_certificate|gst_registration|trade_licence
subject_type text not null -- vehicle|employee|site|asset|weighbridge|organization|gst_registration
subject_id uuid not null
document_number text null
issuing_authority text null
party_id uuid fk->master.parties null -- insurer, agent, RTO
issue_date date null; valid_from date null; valid_to date null
fee_amount numeric(18,2) null; taxable_value numeric(18,2) null; gst_amount numeric(18,2) null
purchase_invoice_id uuid fk->finance.purchase_invoices null; payment_id uuid fk->finance.payments null
amortise_over_months int null -- 12 for insurance; spreads premium instead of spiking one month
details jsonb not null default '{}' -- insurance{idv,ncb_pct}; permit{states[],gvw}; lease{area_ha,royalty_rate,sanctioned_qty_mt}; licence{classes[]}
alert_lead_days int[] not null default '{60,30,15,7,1}'
blocks_operation boolean not null default false -- insurance, fitness, permit, road tax on an active vehicle
status document_status not null -- active|in_renewal|expired|superseded|cancelled|not_applicable
is_current boolean not null default true
supersedes_document_id uuid fk->compliance.documents null
verified_at timestamptz null; verification_response jsonb null -- VAHAN/Sarathi cross-check
entry_source data_source not null default 'manual'; extraction_job_id uuid null
```

**Constraints**
- UNIQUE (organization_id, subject_type, subject_id, doc_type) WHERE is_current
- CHECK valid_to >= valid_from AND valid_from >= issue_date
- CHECK (doc_type NOT IN ('rc','hypothecation') implies valid_to IS NOT NULL)
- index (organization_id, valid_to) WHERE is_current -- the expiry dashboard
- AFTER trigger upserts core.obligations; renewal chains via supersedes_document_id, never edits

### `compliance.gst_registrations`
Absent from every domain proposal and structurally required. Invoice numbering, place of supply and return filing are GSTIN-level facts; e-invoicing applicability is a PAN-level fact. Conflating both into a bare supplier_gstin text column on the invoice makes duplicate serials possible inside a GSTIN and makes the Rule 138E filing block — the commonest real-world cause of 'we cannot generate e-way bills today' — invisible to the yard.

```
id uuid pk
organization_id uuid not null
gstin text not null
legal_name text not null; trade_name text null
state_code text not null
registration_type text not null -- regular|composition|sez|casual
pan text not null
aato_by_fy jsonb not null default '{}' -- {'2023-24': 62000000} ; PAN-level aggregation drives e-invoicing
e_invoice_applicable boolean not null default false
e_invoice_30day_window_applicable boolean not null default false -- AATO >= 10 cr, effective 2025-04-01
hsn_digits smallint not null default 6
gstr3b_filed_upto text null -- '2026-06'; two consecutive unfiled periods blocks e-way bill generation under Rule 138E
ewb_generation_blocked boolean not null default false
is_gta boolean not null default false -- a GTA is exempt from e-invoicing entity-wide
gsp_provider text null; credentials_secret_ref text not null -- key name only, never the credential
effective_from date not null; cancelled_on date null
```

**Constraints**
- UNIQUE (organization_id, gstin); UNIQUE (organization_id, id)
- every invoice, e-way bill, document series and return period hangs off this row, not off organization_id
- index (organization_id, ewb_generation_blocked) surfaced on the dispatch board

### `compliance.eway_bills`
Correctly researched in the source proposals but wrongly prioritised. At Tamil Nadu's Rs 1,00,000 intra-state threshold most single-tipper loads do not need one, so 'not_required' is the fast default and e-way bill generation is a child record, NOT a stage in the trip status machine. It becomes load-bearing for inter-state movement and for multi-drop consolidated bills.

```
id uuid pk
organization_id uuid not null
gst_registration_id uuid fk->compliance.gst_registrations not null
trip_id uuid fk->logistics.trips not null
source_document_type document_type not null -- tax_invoice|delivery_challan|bill_of_supply
source_document_id uuid not null; source_document_no text not null; source_document_date date not null
ewb_number text null; ewb_date timestamptz null
valid_until timestamptz null -- ALWAYS taken verbatim from the NIC response; the local computation only pre-warns
part_b_first_entered_at timestamptz null -- validity starts here, not at Part A
transaction_type smallint not null default 1 -- 1 regular, 2 bill-to/ship-to, 3 bill-from/dispatch-from, 4 combination
from_gstin/from_state_code/from_pincode text
to_gstin/to_state_code/to_pincode text
transport_distance_km numeric(8,2) not null
nic_distance_km numeric(8,2) null -- NIC auto-populates PIN-to-PIN and rejects outside tolerance; quarry lanes routinely diverge
consignment_value numeric(18,2) not null -- s.15 value including tax, excluding exempt supplies
transporter_gstin text null; transporter_id_transin text null
current_vehicle_number text null -- denormalised from the newest part_b row
status eway_bill_status not null -- not_required|pending|part_a_generated|part_b_pending|active|expired|expired_unextendable|extended|cancelled|rejected|failed
part_a_expires_at timestamptz null -- Part A is valid 15 days for Part B completion
api_request_payload/api_response_payload jsonb
error_code text null; gsp_txn_id text null
```

**Constraints**
- UNIQUE (organization_id, ewb_number) WHERE ewb_number IS NOT NULL
- 1:N per trip with a partial unique index on the single active row — cancel-and-regenerate and breakdown reloads legitimately produce several
- CHECK (current_date - source_document_date) <= 180 before generation
- cancellation only where (now() - ewb_date) < 24h; extension only within [valid_until - 8h, valid_until + 8h] and new_valid_until <= ewb_date + 360 days
- child append-only tables: eway_bill_part_b_updates, eway_bill_extensions

### `inventory.stock_locations`
Unifies stockpiles, store bins and the diesel bunk into one location concept, which is what allows a single stock ledger. Making the fuel tank a stock location deletes fuel_station_stock_ledger as a separate table and gives bunk shrinkage the same dip-versus-book reconciliation discipline as an aggregate pile.

```
id uuid pk
organization_id uuid not null
site_id uuid fk->core.sites not null
code text not null; name text not null
location_kind stock_location_kind not null -- open_stockpile|bin|hopper|silo|store_rack|fuel_tank|bowser|virtual_transit|quarantine|vendor_retreader
item_id uuid fk->master.items null -- pinned for single-product piles and fuel tanks; NULL for a multi-item store rack
capacity_qty numeric(18,3) null; capacity_uom uom null
is_default_for_item boolean not null default false
custodian_employee_id uuid null
geo_point jsonb null -- drone/photo volume survey
is_active boolean not null default true
```

**Constraints**
- UNIQUE (organization_id, code); UNIQUE (organization_id, id)
- UNIQUE (organization_id, site_id, item_id) WHERE is_default_for_item
- CHECK (location_kind IN ('open_stockpile','fuel_tank','bowser') implies item_id IS NOT NULL)

### `inventory.stock_ledger`
One ledger for boulders, finished aggregate, spares, tyres and diesel. Every balance anywhere in the ERP is derived from it; inventory.stock_balances is an explicitly rebuildable cache with a nightly drift alarm. Frozen conversion factors on every row are what make the produced-versus-sold reconciliation defensible when a density is later revised.

```
id uuid pk
organization_id uuid not null
site_id uuid not null; stock_location_id uuid fk->inventory.stock_locations not null
item_id uuid fk->master.items not null
movement_type stock_movement_type not null -- opening|purchase_receipt|production_output|production_input|sales_dispatch|sales_return|transfer_out|transfer_in|issue_to_asset|return_from_asset|grn_receipt|return_to_vendor|adjustment_gain|adjustment_shrinkage|stock_take_variance|scrap|free_issue|own_use
qty_signed numeric(18,4) not null -- canonical stock_uom, signed, never zero
qty_entered numeric(18,4) not null; uom_entered uom not null
conversion_factor_used numeric(24,12) not null; uom_conversion_id uuid fk->master.uom_conversions not null
unit_cost numeric(18,6) not null; total_value numeric(18,2) not null -- signed
moving_avg_cost_after numeric(18,6) not null -- makes valuation auditable without replay
effective_at timestamptz not null -- BUSINESS time
posted_at timestamptz not null default now() -- SYSTEM time; the pair explains every backdated entry
accounting_period_id uuid fk->finance.accounting_periods not null
source_schema/source_table text not null; source_doc_id uuid not null; source_doc_line_id uuid null
cost_object_type cost_object_type null -- vehicle|crusher_machine|crusher_plant|site|department (mandatory on issues)
cost_object_id uuid null
serial_no text null -- serialised items (tyres)
counterparty_location_id uuid null; transfer_group_id uuid null
weighbridge_ticket_id uuid fk->logistics.weighbridge_tickets null
reversal_of_id uuid fk->inventory.stock_ledger null; is_reversed boolean not null default false
created_by uuid not null; remarks text null
```

**Constraints**
- REVOKE UPDATE, DELETE FROM linck_app; only is_reversed mutable via a SECURITY DEFINER function
- CHECK qty_signed <> 0 and sign matches movement_type
- CHECK (movement_type LIKE 'issue%' implies cost_object_type IS NOT NULL AND cost_object_id IS NOT NULL)
- negative-stock guard: SELECT FOR UPDATE the balance row, then assert min(running balance) >= 0 over the FORWARD tail from effective_at (backdating revalidates the tail, not just today)
- transfers: deferred trigger asserts sum(qty_signed)=0 and sum(total_value)=0 per transfer_group_id
- PARTITION BY RANGE (effective_at) yearly, declared from day one
- UNIQUE (reversal_of_id) — a movement may be reversed at most once

### `production.production_runs`
The crusher operator log the owner asked for, and the joint-costing anchor. One run fans out to 8-11 simultaneous co-products, so this is a disassembly BOM, not an assembly one. Where output is only measured at dispatch, measurement_method='estimate' must widen the mass-balance tolerance rather than silently asserting precision the yard does not have.

```
id uuid pk
organization_id uuid not null
crusher_plant_id uuid fk->production.crusher_plants not null
site_id uuid not null -- denormalised for RLS and reporting
run_no text not null
production_date date not null -- business date; a night shift spans midnight
shift shift not null
started_at/ended_at timestamptz not null
operator_employee_id uuid null; operator_name text not null -- snapshot; operators are often not app users
yield_recipe_id uuid fk->production.yield_recipes null
config_snapshot jsonb not null default '{}' -- actual CSS, deck mesh, VSI on/off
gross_hours numeric(8,2); downtime_minutes numeric(10,2); run_hours numeric(8,2)
total_input_mt numeric(18,3); total_output_mt numeric(18,3); waste_mt numeric(18,3)
actual_tph numeric(12,3)
power_kwh numeric(14,3) null; diesel_litres numeric(14,3) null
conversion_cost_amount numeric(18,2) not null default 0 -- the joint cost pool
measurement_method text not null -- weighbridge|belt_scale|stockpile_survey|estimate; drives a confidence flag
status production_run_status not null -- draft|submitted|approved|posted|cancelled
posted_at timestamptz null; approved_by uuid null
```

**Constraints**
- UNIQUE (organization_id, run_no); UNIQUE (organization_id, crusher_plant_id, production_date, shift) WHERE status <> 'cancelled'
- CHECK ended_at > started_at; run_hours >= 0; total_input_mt > 0 when posting
- mass balance: abs(total_input - (total_output + waste))/total_input*100 <= crusher_plants.mass_balance_tolerance_pct; breach blocks posting and needs supervisor approval with a reason
- posting is atomic: one inventory.stock_ledger row per input and per output, plus one finance.accounting_events row, in one transaction
- posted runs are immutable; cancellation writes reversals

### `production.production_run_outputs`
This is where 'boulders in, MSAND/PSAND/aggregate out, how much' becomes data, and where product margin is either honest or fictional. Freezing the expected yield at post time means a later recipe revision does not retroactively make last quarter look good.

```
id uuid pk
organization_id uuid not null
production_run_id uuid fk->production.production_runs on delete restrict not null
item_id uuid fk->master.items not null
stock_location_id uuid fk->inventory.stock_locations not null
qty_mt numeric(18,3) not null
qty_entered numeric(18,3) not null; uom_entered uom not null -- operators enter sand in units/CFT
conversion_factor_used numeric(24,12) not null; uom_conversion_id uuid not null
actual_yield_pct numeric(7,3) not null -- qty_mt / run.total_input_mt * 100
expected_yield_pct numeric(7,3) null -- snapshot from the recipe line at post time
yield_variance_pct numeric(7,3) null
is_byproduct boolean not null default false
allocated_cost numeric(18,2) not null -- NRV share of the run's joint cost pool at split-off
unit_cost numeric(18,6) not null
stock_ledger_id uuid fk->inventory.stock_ledger null
```

**Constraints**
- UNIQUE (organization_id, production_run_id, item_id, stock_location_id)
- joint cost allocated by Net Realisable Value at split-off, NEVER by physical tonnage — physical allocation prices crusher dust identically to 20mm and makes every downstream margin report wrong
- byproduct lines take the NRV-credit treatment: their value is deducted from the pool before allocation; waste absorbs zero
- assertion: sum(allocated_cost) = cost pool within Rs 0.01, residue pushed to the largest-value output

### `logistics.weighbridge_tickets`
Merges the two competing weighbridge tables (one in kg, one in MT) that would have shared a physical printer and a consecutive paper series. Canonical unit is MT. This is the single most disputed number in the aggregate trade and the commonest fraud site, so the plate photo on manual entries and the tare_source discriminator are controls, not metadata.

```
id uuid pk
organization_id uuid not null
weighbridge_id uuid fk->logistics.weighbridges not null
site_id uuid not null
ticket_no text not null
financial_year text not null
direction text not null -- inward|outward
weigh_type text not null -- outbound_loaded|inbound_empty|boulder_inbound|site_reweigh|third_party
weighed_at timestamptz not null
vehicle_number text not null -- free text; may be a third-party lorry
vehicle_id uuid fk->fleet.vehicles null
item_id uuid fk->master.items null
gross_wt_mt numeric(14,3) not null; tare_wt_mt numeric(14,3) not null
net_wt_mt numeric(14,3) GENERATED ALWAYS AS (gross_wt_mt - tare_wt_mt) STORED
tare_source text not null -- weighed_this_trip|standing_tare|rc_ulw
source weighbridge_source not null -- integrated_scale|manual_entry|third_party_slip|estimated
operator_employee_id uuid not null -- a real person, not a shared plant login
slip_photo_file_id uuid fk->core.files null; display_photo_file_id uuid null; plate_photo_file_id uuid null
reference_type text null; reference_id uuid null -- boulder_receipt | trip | transfer
overload_flag boolean not null default false
calibration_valid boolean not null -- snapshot of the bridge's legal-metrology stamping validity at weigh time
supersedes_ticket_id uuid fk->logistics.weighbridge_tickets null; correction_reason text null; approved_by uuid null
entry_source data_source not null; confidence numeric(4,3) null
```

**Constraints**
- UNIQUE (organization_id, weighbridge_id, financial_year, ticket_no)
- immutable: BEFORE UPDATE/DELETE trigger raises; corrections insert a superseding row with a reason and an approver who is not the original operator
- CHECK gross > tare; gross <= weighbridge capacity
- CHECK (source='manual_entry' implies plate_photo_file_id IS NOT NULL)
- CHECK (supersedes_ticket_id IS NOT NULL) = (correction_reason IS NOT NULL AND approved_by IS NOT NULL)
- PARTITION BY RANGE (weighed_at) monthly

### `logistics.vehicle_duty_logs`
The deepest structural correction from the operational review. Diesel is filled once a day, batta is paid per day, toll is per crossing, and a tipper runs 4-6 legs plus a boulder backhaul. Making the trip the cost container forces either empty cost fields or invented per-trip allocations. The vehicle-day is the real container; the trip is a leg.

```
id uuid pk
organization_id uuid not null
vehicle_id uuid fk->fleet.vehicles not null
driver_employee_id uuid fk->master.employees null
duty_date date not null -- Asia/Kolkata business date
shift text not null default 'general'
odometer_start numeric(14,2) null; odometer_end numeric(14,2) null
km_run numeric(12,2) GENERATED ALWAYS AS (odometer_end - odometer_start) STORED
engine_hours_start/engine_hours_end numeric(12,2) null -- machinery
diesel_issued_litres numeric(12,3) not null default 0
def_issued_litres numeric(12,3) not null default 0
batta_amount numeric(18,2) not null default 0
toll_amount numeric(18,2) not null default 0
cash_advance_to_driver numeric(18,2) not null default 0
other_cash_expense numeric(18,2) not null default 0
allocation_rule_version text not null -- named, versioned rule distributing day costs to legs
status text not null -- open|closed|settled
closed_by uuid null; closed_at timestamptz null
```

**Constraints**
- UNIQUE (organization_id, vehicle_id, duty_date, shift)
- index (organization_id, driver_employee_id, duty_date)
- trips are children of a duty log; day-level costs post here and are allocated to legs pro-rata by loaded-km with an empty-km weighting

### `logistics.trips`
The operational spine, and the join point between fleet, production and sales. Collapsing the 14-state machine to 8 and moving e-way bill generation out of the status chain is what makes it usable at 300 loads a day. dispatch_purpose exists so own-use, free issues and samples reduce stock without being sales — otherwise every one of them lands in shrinkage and the plant supervisor is blamed for theft he did not commit.

```
id uuid pk
organization_id uuid not null
trip_no text not null -- internal series, NOT a statutory gapless series
duty_log_id uuid fk->logistics.vehicle_duty_logs not null
vehicle_source vehicle_source not null -- own_fleet|hired|customer_arranged
vehicle_id uuid fk->fleet.vehicles null
vehicle_number text not null -- denormalised; survives master edits and goes on EWB Part B
driver_employee_id uuid null; driver_name/driver_licence_no/driver_phone text null -- snapshot
hired_party_id uuid fk->master.parties null
from_site_id uuid fk->core.sites not null
dispatch_purpose dispatch_purpose not null -- sale|own_use|sample|free_issue|internal_transfer|boulder_inbound|rework_return
qty_basis qty_basis not null -- loader_buckets|plant_weighbridge|customer_weighbridge|third_party_weighbridge|agreed_units
governing_weighbridge_ticket_id uuid fk->logistics.weighbridge_tickets null
distance_km numeric(8,2) null
loaded_at/departed_at/delivered_at/returned_at timestamptz null
status trip_status not null -- planned|loaded|in_transit|delivered|returned_to_plant|diverted|completed|cancelled|aborted_breakdown
return_reason_code text null; return_attributed_to text null -- customer|us|force_majeure
broker_party_id uuid fk->master.parties null
pod_status pod_status not null default 'not_captured' -- includes not_applicable for ex-plant lifts
margin_provisional boolean not null default true
entry_source data_source not null default 'manual'
```

**Constraints**
- UNIQUE (organization_id, trip_no)
- CHECK ownership: own_fleet requires vehicle_id; hired requires hired_party_id
- 1:N logistics.trip_legs (delivery_order_id, customer_site_id, item_id, qty, drop_sequence) — part loads and multi-drop are Tuesday, not an edge case
- CHECK (status IN ('returned_to_plant','diverted') implies return_reason_code IS NOT NULL)
- returned loads must write a sales_return / transfer_in stock movement — otherwise the material silently vanishes from the ledger
- status derived where possible: a weighbridge ticket implies weighed, an active EWB implies compliant; every state a human must click is a state that will be wrong

### `sales.invoices`
Carries the owner's hard rule — an invoice does not close until money is confirmed — while the three statutory withholdings (GST TDS u/s 51, income-tax deduction, contractual retention) are modelled as separate reductions rather than as a shortfall. Without them a government or large-builder invoice would sit open forever and someone would start clearing it with fictitious credit notes.

```
id uuid pk
organization_id uuid not null
gst_registration_id uuid fk->compliance.gst_registrations not null
document_type document_type not null -- tax_invoice|bill_of_supply
invoice_no text null -- allocated ONLY at draft->issued, from core.document_series
financial_year text not null
invoice_date date not null
customer_party_id uuid fk->master.parties not null
customer_site_id uuid fk->sales.customer_sites null
buyer_gstin/buyer_legal_name text; buyer_address jsonb -- snapshot at issue
ship_to_gstin text null; ship_to_address jsonb null
place_of_supply_state_code text not null
pos_basis text not null -- s10_1_a_movement | s10_1_b_third_person_direction | s10_1_c | b2c_unregistered
tax_treatment tax_treatment not null -- DERIVED: igst iff supplier_state <> pos
taxable_value/cgst_amount/sgst_amount/igst_amount/cess_amount numeric(18,2) not null default 0
round_off numeric(18,2) not null default 0
invoice_total numeric(18,2) not null
gst_tds_51_amount numeric(18,2) not null default 0 -- 2% deducted by government buyers; arrives as a cash-ledger credit, not bank cash
withholding_expected_amount numeric(18,2) not null default 0 -- buyer's income-tax deduction
retention_withheld_amount numeric(18,2) not null default 0
due_date date not null
status invoice_status not null -- draft|issued|irn_generated|irn_failed|permanently_unreportable|delivered|partially_paid|payment_reported|payment_verified|closed|cancelled|credit_noted
return_locked boolean not null default false -- set when the GSTR-1 period is filed; immutability keys to this, not to 'issued'
amount_paid_reported/amount_paid_verified numeric(18,2) not null default 0
credit_note_adjusted numeric(18,2) not null default 0
balance_due numeric(18,2) GENERATED ALWAYS AS (invoice_total - amount_paid_verified - credit_note_adjusted - gst_tds_51_amount - withholding_expected_amount) STORED
closed_at timestamptz null; closed_by uuid null
```

**Constraints**
- UNIQUE (gst_registration_id, financial_year, invoice_no) — NOT (organization_id, ...); a tenant with two GSTINs must not be able to duplicate a serial inside one
- CHECK rendered invoice_no length <= 16 (computed with padding, not on the raw number)
- CHECK (intra implies igst=0 and cgst=sgst) AND (inter implies cgst=0 and sgst=0)
- CHECK abs(round_off) <= 1.00 -- the IRP tolerance is Rs 1, not 50 paise
- no tcs_206c_1h column at all — the levy does not apply to any collection on or after 2025-04-01
- a cancelled IRN kills the invoice number permanently: a new invoices row with a NEW number is required, never a retry against the same row
- closure requires balance_due = 0 AND every contributing payment status='cleared' AND non-cash payments matched to a bank transaction

### `sales.invoice_lines`
Holds three quantities where the naive design held one. The business sells in units (100 cft), the weighbridge reads tonnes, and GST demands a Unit Quantity Code that has no cubic-feet member. Every one of the three must be frozen on the line with the factor that produced it, or the HSN summary will not reconcile across periods and the produced-versus-sold report will never balance.

```
id uuid pk
organization_id uuid not null
invoice_id uuid fk->sales.invoices on delete restrict not null
line_no int not null
line_type text not null -- material|freight|loading|unloading|other_charge|discount
item_id uuid fk->master.items null
description text not null
hsn_code text fk->compliance.hsn_master not null -- FK, not free text; Table 12 is a fixed dropdown
trade_quantity numeric(18,3) not null; trade_uom uom not null -- 'unit' (=100 cft) or 'cft'
statutory_quantity numeric(18,3) not null; statutory_uqc text not null -- CBM or MTS; what actually goes on the e-invoice
conversion_factor_used numeric(24,12) not null; uom_conversion_id uuid fk->master.uom_conversions not null
weighed_quantity_mt numeric(18,3) null -- reconciliation trail on the invoice itself
unit_rate numeric(18,4) not null
discount_amount numeric(18,2) not null default 0
taxable_value numeric(18,2) not null
gst_rate_pct numeric(5,2) not null
cgst_amount/sgst_amount/igst_amount/cess_amount numeric(18,2) not null default 0
trip_id uuid fk->logistics.trips null; trip_leg_id uuid null
delivery_challan_id uuid fk->sales.delivery_challans null
rate_override_id uuid fk->logistics.trip_rate_overrides null
```

**Constraints**
- UNIQUE (invoice_id, line_no)
- CHECK taxable_value = round(trade_quantity*unit_rate - discount_amount, 2)
- a trip leg may appear on at most one non-cancelled invoice line (partial unique index over a status-denormalised column)
- freight, loading, unloading and detention are APPORTIONED across material lines pro rata to taxable value and taxed at each line's own rate — not attached wholesale to the highest rate
- index (organization_id, hsn_code, gst_rate_pct) for the GSTR-1 HSN summary

### `finance.journal_entries`
Every financial fact in the whole ERP — sales invoice, purchase bill, fuel issue, tyre fitment, production output, payslip, depreciation, EMI — lands here exactly once. Corrections are reverse-and-repost, never edit. Sales invoices, purchase invoices and payments post synchronously in the document's own transaction; high-volume operator-entered events (fuel, stock, production, trip costing) post via finance.accounting_events so an unmapped ledger can never stop a driver recording diesel at a quarry gate.

```
id uuid pk
organization_id uuid not null
entry_no text not null -- per org per fiscal year, allocated inside the posting transaction
posting_date date not null
period_id uuid fk->finance.accounting_periods not null
source journal_source not null
source_schema/source_table text not null; source_id uuid not null
idempotency_key text not null -- source_table:source_id:event_version
status journal_status not null -- draft|posted|reversed
reversal_of_entry_id uuid fk->finance.journal_entries null
narration text null
total_debit numeric(18,2) not null; total_credit numeric(18,2) not null
posted_at timestamptz null; posted_by uuid null
```

**Constraints**
- UNIQUE (organization_id, entry_no)
- UNIQUE (organization_id, source_table, source_id, idempotency_key) WHERE status <> 'reversed' — the anti-double-post guard for an at-least-once outbox worker
- posted entries immutable: trigger allows only status posted->reversed, and only with a matching reversal entry
- no posting into a period with status='closed', or where module_locks->>module = 'closed'

### `finance.journal_lines`
The single most important table in the system, and the reason sales.customer_ledger_entries is deleted: the AR subledger IS journal_lines filtered on the control account. Because the profitability dimensions are real typed columns rather than jsonb tags, per-tipper P&L, per-plant cost per tonne and per-product margin are one indexed aggregate each — and the natural-language query layer has a closed, safe vocabulary to compile against.

```
id uuid pk
journal_entry_id uuid fk->finance.journal_entries not null
organization_id uuid not null
line_no int not null
ledger_account_id uuid fk->finance.ledger_accounts not null
debit numeric(18,2) not null default 0; credit numeric(18,2) not null default 0
posting_date date not null -- denormalised from the header by trigger; never trusted from the caller
cost_center_id uuid null
site_id uuid null
vehicle_id uuid null
driver_employee_id uuid null; employee_id uuid null
customer_party_id uuid null; vendor_party_id uuid null
item_id uuid null
trip_id uuid null; duty_log_id uuid null
crusher_plant_id uuid null
asset_id uuid null; loan_id uuid null
quantity numeric(18,3) null; uom text null -- litres, MT, KM, CFT: unit economics derivable straight from the ledger
tax_code_id uuid null; hsn_sac text null
dimensions jsonb not null default '{}' -- escape hatch before a dimension earns a column
narration text null
```

**Constraints**
- CHECK (debit >= 0 AND credit >= 0 AND (debit = 0) <> (credit = 0))
- DEFERRABLE INITIALLY DEFERRED constraint trigger: sum(debit)=sum(credit) per entry and both equal the header totals
- dimension enforcement by trigger from ledger_accounts flags: requires_cost_center / requires_vehicle / requires_item / requires_party
- control-account rule: a line on the Sundry Debtors account must carry customer_party_id; Sundry Creditors must carry vendor_party_id — AR/AP versus GL reconciliation is then a GROUP BY and cannot disagree by construction
- partial indexes: (organization_id, vehicle_id, posting_date) WHERE vehicle_id IS NOT NULL, and the same shape for cost_center, item, customer, vendor, crusher_plant
- PARTITION BY RANGE (posting_date) yearly once past ~20M rows

### `finance.payments`
One table for money in and money out, replacing the separate payment_receipts proposal, because receipts and payments share allocation, approval and bank-reconciliation behaviour exactly. The gap between amount_paid_reported and amount_paid_verified on the invoice is the owner's cross-verification control made visible, and cash custody is tracked further by finance.cash_custody_transfers with a running per-employee balance.

```
id uuid pk
organization_id uuid not null
voucher_no text not null
direction payment_direction not null -- inbound (receipt) | outbound
payment_date date not null
party_id uuid fk->master.parties null
bank_account_id uuid fk->finance.bank_accounts null
cash_float_id uuid fk->finance.cash_floats null
method payment_method not null -- cash|upi|neft|rtgs|imps|cheque|dd|card|nach|adjustment|book_transfer
amount numeric(18,2) not null
withholding_amount numeric(18,2) not null default 0
net_amount numeric(18,2) not null
allocated_amount numeric(18,2) not null default 0 -- trigger-maintained
unallocated_amount numeric(18,2) not null default 0 -- advance / on-account balance
is_advance boolean not null default false
reference_no text null -- UTR, cheque no, UPI ref
instrument_date date null
status payment_status not null -- draft|pending_approval|approved|issued|recorded|pending_verification|verified|cleared|bounced|reversed|cancelled
recorded_by uuid not null; recorded_at timestamptz not null
verified_by uuid null; verified_at timestamptz null; verification_method text null
bank_transaction_id uuid fk->finance.bank_transactions null
collected_by_employee_id uuid null; deposited_at timestamptz null; deposit_ref text null
bounce_reason text null; bounced_at timestamptz null
proof_file_id uuid fk->core.files null
journal_entry_id uuid fk->finance.journal_entries null
```

**Constraints**
- UNIQUE (organization_id, voucher_no)
- UNIQUE (organization_id, reference_no) WHERE reference_no IS NOT NULL — the same UTR may never be claimed twice
- status='cleared' requires bank_transaction_id for every non-cash method; a cash receipt clears only after a deposit contra into a bank ledger, or a countersigned physical count
- verified_by <> recorded_by enforced by SERVICE POLICY plus a daily exec-visible exception queue, not by a CHECK — a three-person accounts office with one person on leave will otherwise create a shared login, which is strictly worse than no control
- allocated_amount <= amount - withholding_amount, deferred constraint trigger
- a bounce auto-inserts reversing payment_allocations rows and re-opens the affected invoices

### `finance.payment_allocations`
One cheque settles six invoices and one invoice is settled by four part payments — that is the normal shape here, and builders pay lump sums against balances rather than documents. The allocation_policy on the party drives automatic oldest-first application, and short payments route to sales.customer_deductions with an owner and an ageing clock rather than into an unowned write-off bucket where reconciliation goes to die.

```
id uuid pk
organization_id uuid not null
payment_id uuid fk->finance.payments on delete restrict not null
target_type allocation_target not null -- sales_invoice|purchase_invoice|credit_debit_note|expense_claim|employee_advance|loan_installment|on_account|gst_tds_51|withholding_credit|retention|deduction_claim|write_off
target_id uuid null -- null for on_account
amount numeric(18,2) not null
allocated_on date not null; allocated_by uuid not null
auto_matched boolean not null default false; match_confidence numeric(5,4) null
is_verified boolean not null default false -- denormalised from the parent payment status by trigger
is_reversal boolean not null default false; reverses_allocation_id uuid null; reversal_reason text null
```

**Constraints**
- CHECK amount <> 0; negative only when is_reversal
- UNIQUE (payment_id, target_type, target_id) WHERE NOT is_reversal AND reversed_at IS NULL
- assertion: sum of reversals against an allocation <= the original amount (partial reversal is real — Rs 20,000 of a Rs 50,000 allocation applied to the wrong invoice)
- append-only; corrections append offsetting rows
- withholding and GST-TDS allocations count toward closure ONLY after matching against Form 26AS / GSTR-7 credit


# Linck — database design

PostgreSQL 16, multi-tenant, twelve schemas. Alembic owns the DDL.

The column-level detail for the load-bearing tables is in [schema-core-tables.md](schema-core-tables.md).

## Why it is shaped this way

Five domain models were drafted independently — fleet, production/stores, sales/compliance, finance, platform — and produced 171 tables with heavy overlap. Two adversarial reviews then attacked them: one on Indian GST and e-way-bill law, one from the point of view of somebody who has run a crusher and a 60-tipper fleet. The corrections that survived are the reason several tables look unusual, and each is noted where it applies.

The three that changed the shape most:

**The vehicle-day is the cost container, not the trip.** Diesel is filled once a day. Batta is paid per day or per trip depending on the driver. Toll is per crossing. A tipper does four to six short-lane trips a day, or one long haul plus a boulder backhaul. Demanding a per-trip rupee figure for every cost means either the fields stay empty and every trip margin is wrong, or somebody invents an allocation on the spot and the number is unauditable. So `logistics.vehicle_duty_logs` is the parent and `trips` are legs of it; day-level costs post to the duty log and a named, versioned rule distributes them.

**Quantity has four sources and the weighbridge is not the authoritative one.** On a real load there is what the loader operator put in, what the bridge said, what was *sold*, and what the site signed for. In this trade the sold quantity is primary — often decided by eye and by argument — and the bridge is a control. Hence `qty_basis` on every trip leg, and a variance band that flags a trend rather than blocking an invoice. A 2% hard block fires on most loads once monsoon moisture moves apparent density 8–15%, and a control that fires 300 times a day is dead inside a fortnight.

**The e-way bill is a child record, not a workflow stage.** Tamil Nadu's intra-state exemption runs to ₹1,00,000 of consignment value. A 35-tonne tipper of M-sand is about 7 units; ex-plant that is nearer ₹30,000. Most intra-state loads never need one. Modelling EWB generation as a mandatory stage between "weighed" and "in transit" would have produced a permanent compliance-exception list that was entirely correct behaviour, and roughly 30% of a build nobody needed.

## Schemas

| Schema | Holds |
|---|---|
| `core` | Tenancy, identity, scoped RBAC, org structure, audit, files, alerting, approvals, statutory document numbering. Depends on nothing. |
| `master` | Reference data three or more modules would otherwise each invent: one party master, one item master, one conversion authority, one employment record. |
| `fleet` | Vehicles and machinery as physical assets — identity, status lifecycle, usage, fuel, tyres, preventive maintenance, incidents, telematics. |
| `inventory` | One append-only ledger for every physical quantity — boulders, finished aggregate, spares, tyres, diesel — with locations, cached balances and physical counts. |
| `production` | Quarry lease, crusher lines, wear-part life, expected-yield recipes, and the shift run that turns boulders into co-products. |
| `procurement` | Demand to receipt: indents, purchase orders, goods receipt with three-way match, issues to a cost object. |
| `logistics` | Physical movement, shared by fleet, production and sales. Weighment lives here because one bridge serves inbound boulders and outbound product. |
| `sales` | Order to cash on the customer side: sites, negotiated rates, load bookings, tax invoices, credit and debit notes, challans, deduction claims. |
| `finance` | Double-entry core plus payables, banking, expenses, loans, payroll, fixed assets. Every module posts here through one outbox; nothing keeps a parallel ledger. |
| `compliance` | GST registrations and returns, e-invoicing, e-way bills, the expiring-document register, mineral permits and royalty. Separate because these regimes change on their own schedule. See [COMPLIANCE.md](COMPLIANCE.md) for the rules themselves. |
| `ai` | Extraction with human correction as a first-class dataset, a curated semantic layer, anomalies, predictions, embeddings, and an approval gate on every AI write. |
| `reporting` | Read-only views, and materialized views only once measured latency demands them. No business table lives here. |

## Invariants, and where each is enforced

The ones that are not obvious:

- **No row is readable outside its organization.** `ENABLE` *and* `FORCE ROW LEVEL SECURITY` on every business table. FORCE is not optional — a table owner bypasses RLS by default and every policy silently evaporates. The app connects as `linck_app`, which owns nothing and has no `BYPASSRLS`; migrations run as `linck_migrator`.
- **No cross-tenant foreign key can exist.** Composite FK `(organization_id, child_id) → parent (organization_id, id)`, backed by a `UNIQUE (organization_id, id)` on every parent.
- **Stock never goes negative, including when backdated.** A service-layer assertion inside the transaction takes `SELECT … FOR UPDATE` on the balance row, then runs a windowed sum over the *forward* tail from the new row's `effective_at` asserting `min(running) >= 0`. Backdating revalidates the tail, not just today.
- **Every quantity entered in a non-canonical unit persists its conversion.** `(qty_entered, uom_entered, conversion_factor_used, uom_conversion_id)` are all `NOT NULL` on the stock ledger, production outputs, invoice lines and stock-take lines. Historic rows are never recomputed when a density is revised. Any report that recomputes tonnes from CFT with a current factor is a bug.
- **Conversion lookup is never ambiguous.** `EXCLUDE USING gist` over (org, item, from_uom, to_uom, applies_to, daterange), and a hard reject when nothing resolves — never a silent fallback to 1.0 or a hardcoded density. This is the fix for the 15%-of-revenue disagreement between two modules about how many cubic feet are in a tonne of M-sand.
- **Joint production cost is allocated by net realisable value at split-off, never by tonnage.** Byproducts are credited out of the pool before allocation; waste absorbs zero.
- **A weighbridge ticket is never edited.** Corrections insert a superseding row with a reason and an approver who is not the original operator.
- **An invoice closes only when the money is real.** A trigger rejects any transition to `closed` where `balance_due <> 0` or any contributing payment is not `cleared`. Statutory withholdings reduce the balance only once matched against GSTR-7 or Form 26AS credit — otherwise every 2% government-customer shortfall becomes a silent write-off and the invoice hangs open forever.
- **Segregation of duties is recorded in data but enforced by review, not by a row constraint.** `recorded_by`/`verified_by` are mandatory columns; the different-person rule is a service policy with a daily exec-visible exception queue, and hard blocking is opt-in per organization. A `CHECK` constraint on a three-person accounts office produces shared logins — which satisfies the constraint and destroys the audit trail.
- **Credit control warns by default.** `parties.credit_enforcement` is `warn | block | block_with_override`. A hard block at order confirmation, in a business where the MD is both the approver and the person telling sales to send the load at 6am, results in every credit limit being set to 999999999 within a fortnight.
- **Mineral quantity is drawn down exactly once** — at boulder receipt, where the mineral actually leaves the lease. The outbound transit pass is a per-trip document with validity but no quantity draw-down.
- **Every AI-written value is traceable and gated.** No AI code path holds write access to a business table. Agents insert `ai.agent_actions` rows; execution requires an approver who independently holds the permission.
- **Audit capture cannot be circumvented.** One generic row trigger on every auditable table, so background jobs, data-fix scripts and stray `psql` sessions are all captured. The log is INSERT-only at the grant level.

## Alembic and Drizzle

**Alembic is the single source of truth for DDL. Drizzle is a generated, read-mostly type artefact produced by introspecting the Alembic-built database.** There is no second write path and no hand-authored Drizzle schema file.

Drizzle-owns-DDL was rejected because the schema's load-bearing behaviour — RLS policies, `FORCE RLS`, the audit trigger, deferred balance-check constraint triggers, `EXCLUDE USING gist`, range partitioning, generated columns, composite tenant-safe FKs, grant-level append-only enforcement — is either unrepresentable or unreliable in drizzle-kit, and the FastAPI service layer needs SQLAlchemy models regardless. Two migration tools against one database is worse still: whichever runs second sees the other's objects as drift and proposes to drop them.

The pipeline:

1. Edit SQLAlchemy models under `apps/api/app/models/`.
2. `alembic revision --autogenerate`. Autogenerate covers tables, columns, indexes and FKs. It does **not** cover RLS, policies, triggers, partitions, `EXCLUDE` constraints or grants — those are hand-written `op.execute()` in the same revision with matching downgrade drops. A revision that creates a business table without enabling and forcing RLS fails CI.
3. `alembic upgrade head`.
4. `pnpm --filter @linck/db generate` → `drizzle-kit pull`, writing `packages/db/src/schema/*.ts`.
5. Types flow to `packages/types`, consumed by the web app today and the React Native app later. **Money is typed as `string`, never `number`** — `numeric(18,2)` through a JS number is a rounding defect waiting for a large invoice.

Four CI gates, all blocking:

- **A — model/DB drift.** `alembic check` against a fresh `postgres:16`. A non-empty autogenerate diff means a model changed without a migration.
- **B — Drizzle drift.** Re-pull into a scratch directory and `git diff --exit-code` against the committed schema.
- **C — reverse safety.** `drizzle-kit generate` against the Alembic-built database must produce an *empty* migration. A non-empty one proves the committed TS schema would try to alter the database.
- **D — invariant lint.** A pytest over `pg_class`/`pg_policy` asserting every business table has `relrowsecurity` *and* `relforcerowsecurity`, has `organization_id`, has at least one policy, and has the audit trigger — plus that no column is `float`, `double precision` or `money`.

One honest caveat: gating on a byte-exact diff of generated code is noisy, and drizzle-kit's version must be pinned exactly (no caret) or Job B fails on unrelated PRs and the team starts bypassing it. If that proves unmanageable in month one, drop B to a nightly job — but never drop C, which is the one that catches real divergence.

**The runtime boundary matters more than the type generation.** The web and mobile apps do not query Postgres with Drizzle. They call FastAPI, which sets `app.current_org_id` transaction-locally and applies the RBAC check. Letting a browser hold a database connection would put the RLS tenant GUC under client control, which is the one thing this design cannot allow.

## Phasing

**Phase 1 — the platform spine and the capture surfaces that replace paper.** No ledger, no invoicing. Six screens, not twenty-four: load booking, plant loading and weighbridge capture, today's trip list, diesel entry, the expiry calendar, the alert inbox. The goal is that within eight weeks the fleet and plant teams have stopped using notebooks for those three things.

**Phase 2 — money.** Production runs with joint costing, the full stock and stores flow, GST invoicing with e-invoicing and e-way bills where the threshold is actually crossed, receipts with the cross-verification rule, and the double-entry ledger that makes the executive P&L real. Includes the produced-vs-dispatched-vs-invoiced reconciliation, which should be the second screen built, not the twenty-third.

**Phase 3 — depth.** Maintenance forecasting, tyre cost per km, payroll, fixed assets, telematics, and the AI models that need twelve months of history to be worth anything. Telematics is deliberately last: the fleet must work fully on manual entry first, and every integration column is nullable and additive.

## Decisions that were open, and how they were answered

1. **Legal entity structure** — resolved as *configuration*, not a fixed answer. Crusher and fleet are verticals a client buys separately or together, so `core.organization_modules` carries the enabled set and `core.legal_entities` is `1..N` per tenant. The inter-company GTA branch fires by comparing the material's entity to the vehicle's entity, so single-entity clients never reach it.
2. **Google-only sign-in** — confirmed by the owner, who can enforce Google accounts across the workforce. Implemented as pre-registration plus verified-email matching with the `sub` claim pinned on first sign-in. The residual risk is recorded rather than argued: if shared plant terminals ever end up on one login, `operator_id` stops identifying a person and the per-operator anomaly models lose their signal. Nothing in the schema needs to change to add a per-user PIN on shared devices later — `user_identities` already supports several identities per user.
3. **Inter-state movement is material**, so the e-Way Bill console is P0 and shipped. The ₹50,000 inter-state threshold versus Tamil Nadu's ₹1,00,000 intra-state exemption is the asymmetry the console is built around.

## What is actually built

`core` is migrated and running: organizations, modules, legal entities, GST registrations, sites, users, identities, sessions, scoped RBAC and the audit log. RLS is enabled **and forced** on every table, with tenant isolation proven by tests rather than asserted — including that the tenant GUC is transaction-local, which is what makes the design safe behind a transaction-pooling connection pooler.

Two lessons from building it are worth carrying into Phase 2, because both cost real debugging time:

- **`SECURITY DEFINER` does not escape RLS.** It escapes the *caller's* privileges; `FORCE ROW LEVEL SECURITY` still applies to the function's owner. Any function that must read across tenants — identity resolution — or write without tenant context — the audit trigger — needs an owner with an explicit role-targeted policy. Both worked in development purely because a superuser happened to own them, and both broke the moment ownership moved to a normal role.
- **Prefer a role-targeted policy to `BYPASSRLS`.** `BYPASSRLS` is one word and grants unlimited read of every table forever, recorded nowhere. A `TO some_role` policy is scoped to named tables and named commands, and shows up in the same `pg_policy` query that audits everything else.

The remaining eleven schemas are designed but not migrated.

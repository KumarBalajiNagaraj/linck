# Linck

An AI-native ERP for a heavy-machinery, quarry and tipper-fleet business in India.

Three operations, currently held together by spreadsheets, paper and WhatsApp: a fleet of 35T and 48T tippers, stone crusher plants turning boulders into M-Sand and graded aggregate, and a sales operation that dispatches to builder sites and collects over weeks.

The problem is not "we need software". It is that **the same fact is written down three times in three places and reconciled by memory**. A diesel bill exists on paper, in a notebook, and in an accountant's spreadsheet, and nobody can answer "what did TN 29 AB 1001 cost us per kilometre last month" without a day's work.

Linck's job is to make each fact enter the system once — ideally by photographing the slip rather than typing it — and derive everything else.

## Deploying

The web app deploys to Vercel as a static SPA — `vercel.json` at the repo root wires the pnpm monorepo build (`pnpm --filter @linck/web build` → `apps/web/dist`).

```bash
vercel deploy --prod --yes
```

Two things in that config are load-bearing and easy to delete by accident:

- **The catch-all rewrite to `/index.html`.** TanStack Router owns `/fleet/board` and every other path, so without it a refresh or a shared link on any route but `/` returns 404. Vercel checks the filesystem *before* applying rewrites, so `/assets/*` and `/favicon.svg` still serve the real files and never reach the rule.
- **A year of immutable caching on `/assets/*` only.** Vite fingerprints those filenames, so a changed file is a changed URL. `favicon.svg` is not fingerprinted and gets an hour instead.

Note `vercel.json` permits no comment keys — the schema rejects unknown properties — which is why this reasoning lives here.

Only the frontend deploys. The API needs a Postgres with row-level security and is not a serverless target; the deployed site runs entirely on seeded mock data.

## Running it

**Web app** — runs on seeded mock data, no backend required:

```bash
pnpm install && pnpm dev
```

Open http://localhost:5173. The two selectors in the top right are not demo toys. The role selector drives the real permission-filtered navigation, and the tenant-shape selector drives real module gating: a Stores clerk genuinely cannot see the executive dashboard, and a fleet-only tenant has no Production workspace at all.

**API** — needs Postgres. One-time setup:

```bash
psql -d linck_dev -f apps/api/scripts/init-roles.sql
```

```bash
cp apps/api/.env.example apps/api/.env && cd apps/api && uv sync && .venv/bin/alembic upgrade head && .venv/bin/python -m scripts.seed_dev
```

Then run it:

```bash
cd apps/api && .venv/bin/uvicorn app.main:app --port 8000
```

The seed prints the emails you can sign in as, across three tenants of deliberately different shapes. With no Google credentials configured, `POST /auth/dev-login {"email": "..."}` runs the same identity-resolution path without contacting Google; the route 404s in any non-local environment.

```bash
pnpm typecheck && pnpm test && pnpm build
```

```bash
cd apps/api && .venv/bin/python -m pytest tests
```

**The API refuses to start when connected as a superuser.** Postgres exempts superusers from row level security, so such a connection leaves every tenant-isolation policy inert while everything appears to work. That is the one failure this design cannot tolerate, so it is asserted at boot in *every* environment — including local, where a default Postgres install hands you a superuser and would otherwise make inert RLS the normal path.

## What is here

| | |
|---|---|
| `packages/tokens` | The design system's tokens and the seven status families. CSS variables plus the TS source of truth. |
| `packages/domain` | Platform-neutral: Indian money formatting, the UOM/CFT conversion authority, IST and financial-year dates, scoped RBAC. No DOM, no React — the React Native app will consume it unchanged. |
| `packages/ui` | The ERP composites: `DataTable`, `StatusStamp`, `Rail`, `KpiTile`, `Provisional`, cells. |
| `packages/mock` | A seeded Tamil Nadu quarry-and-fleet dataset shaped like the eventual API responses. Deleted at cutover. |
| `apps/web` | Vite + React 19 + TypeScript. Eleven screens across seven personas. |
| `docs/DATABASE.md` | The Postgres design — twelve schemas, the invariants, and the Alembic/Drizzle arrangement. |
| `docs/PERSONAS.md` | Who uses Linck, what is built for each of them, where it falls short of the brief, and what to build next. |
| `docs/COMPLIANCE.md` | The Indian statutory surface — e-way bill, GST, e-invoicing, returns, withholding, mineral permits — with what is built against each and what is missing. |

## The design

"Quiet Paper — ink on warm stock." It won a scored comparison against two other directions on the two criteria that mattered most: surviving a 40-row × 12-column screen for eight hours a day, and signalling AI-native without gimmicks.

Four laws, and they are enforced, not aspirational:

1. **Nothing below 4.5:1 for text**, on any surface it is allowed to sit on. Colour comes from `var(--…)` only — there is no raw hex outside `tokens.css`.
2. **Status is never carried by hue.** Every state ships four redundant channels — glyph, word, rail pattern, fill — and hue is the fourth. Strip all colour and the screen still reads, which matters because roughly 1 in 12 Indian men has a red-green deficiency and the fleet supervisor is not exempt.
3. **Dashed or hatched means asserted but not yet true.** One achromatic texture marks every unconfirmed value in the system. The owner's rule — an invoice does not close until payment is cross-verified — stops being policy documentation and becomes the border style of the application. A receivables screen full of hatch is a screen full of money that is not really yours yet, visible from across the room.
4. **`--brand` means "you are here / this is pressable".** Never a status.

Three signature moves carry it: the **five-line rule** (no zebra; every fifth row gets a faintly stronger separator, like a ruled accounting pad), **the rail** (a 3px left-edge primitive doing provenance, lifecycle, proportional quantity and selection at once, with zero extra DOM), and the **as-of stamp** on every derived figure — the smallest type on the screen and the most trust-bearing thing on it.

## What "AI-native" means here

Not a chatbot in the corner. There is deliberately no chat drawer: if it cannot be shown as a field, a ranking or a flag, it does not ship.

**The AI is a very fast clerk with excellent handwriting and no authority.** It may write in pencil on onionskin. It may never write in ink, and it may never post to the ledger. Concretely:

- It reads the diesel bill, the weighbridge slip and the vendor invoice, and proposes values a human confirms in one tap. Proposed values render at **full contrast** — dimming them to signal provenance would be a design failure, because the operator's whole job is reading that number against the paper.
- Confidence is a shape, not a colour. Three achromatic segments, never red/amber/green: a 62%-confident *correct* reading is not a problem.
- Tab order follows uncertainty, not layout. Worst field first, because that is where a human's attention is worth most.
- Overrides are kept, not discarded — they are the only way to measure extraction quality per document type per vendor over time.
- Where two-person control applies, the AI's match counts as **neither person**. It ranks candidates and states its reason ("UTR exact, amount exact, date +1d").

## Where the domain model came from

Five domain models were drafted independently and produced 171 tables. Two adversarial reviews then attacked them — one on Indian GST and e-way-bill law, one from the perspective of somebody who has actually run a crusher and a 60-tipper fleet. Several corrections changed the shape of the product, and they are visible in the UI:

- **The unit is 100 CFT, and the trade density is ~4.95 t/unit, not the loose stockpile figure.** Two modules disagreed by 15% of billed quantity on every load. There is now one conversion authority, in `packages/domain/src/uom.ts`.
- **Weighbridge variance is a trend, not a block.** Monsoon moisture moves apparent density 8–15%. A 2% hard block would fire on most loads, an operator would pick the first dropdown reason 300 times a day, and the control would be dead inside a fortnight.
- **The e-way bill is not a workflow stage.** Tamil Nadu's intra-state exemption runs to ₹1,00,000; most tipper loads never need one. "Not required" is the calm default.
- **A returned load earns zero and costs full.** It is shown that way, because that is the number the business needs to see.
- **Rate renegotiated at the gate is normal, not an exception** — and the running count of it is a revenue-leakage report the business does not currently have.

See [docs/DATABASE.md](docs/DATABASE.md) for the rest.

## The tenancy model

Linck is a product, and crusher and fleet are **verticals a client may buy separately or together**. That is data, not a build flag:

- `core.organization_modules` decides which verticals a tenant has switched on. A fleet-only tenant has no Production workspace, no stores, and no permission grant can conjure one.
- `core.legal_entities` is `1..N` per tenant. In this trade the tippers commonly sit in a proprietorship and the crusher in a partnership, but plenty of clients run one entity. Both work.
- When a trip moves entity A's material on entity B's vehicle, the transport leg is an **inter-company GTA supply** with its own invoice, reverse-charge treatment and SAC 9965 — not a freight line. Single-entity clients never reach that branch.

The dev seed creates all three shapes on purpose, because a single seeded tenant would hide exactly the bug this model exists to prevent.

## Sign-in

Google for everyone, and **sign-in never creates a user**. An admin pre-registers the person; Google only proves the human at the keyboard is that person. The match is on the *verified* Google email, and the account's stable `sub` claim is pinned on first successful sign-in — matching on display name would hand one Murugan S the other's grants.

Two roles exist purely so that RLS is never bypassed:

- `linck_identity` owns the two identity-resolution functions. Sign-in has to read `core.users` *before* it knows the tenant, which is precisely the lookup RLS forbids. Rather than granting `BYPASSRLS`, it holds explicit role-targeted `SELECT` policies on three named tables — so the blast radius is written down in `pg_policy` instead of being an invisible property of a role.
- `linck_audit` owns the audit trigger and may only *append*. The audit log is the one table that must never refuse a write: auditing that fails closed turns a missing session variable into an outage.

Both exist because `SECURITY DEFINER` escapes the caller's privileges but **not** row level security — `FORCE` applies to the owner too. Each function looked fine while a superuser happened to own it and broke the moment ownership moved to a normal role, which is what a correct deployment does.

## Not built yet

No screen is wired to the API yet — the web app still runs on mock data, and `apps/web/src/auth/session.ts` is written but deliberately unimported (a half-wired session that fails at boot would take down all twelve screens). The cutover steps are in that file's header.

Beyond `core`, the eleven business schemas in `docs/DATABASE.md` are designed but not migrated. Phase 2 is the money: production costing, GST invoicing, receipts with the cross-verification rule, and the double-entry ledger.

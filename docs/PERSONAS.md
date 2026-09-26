# Linck — who uses it, what they have, what they need next

Nine people use this product. This document says, for each of them, what their job actually is, what is built for them today, where it falls short of what was asked for, and what to build next.

It is written from an audit of the code, not from memory. Where something is half-built, it says which half.

## How to read the status labels

| Label | Means |
|---|---|
| **Built** | Exists, runs, and is enforced where it needs to be — including in Postgres. |
| **Mock only** | The screen works and the reasoning is real, but it reads seeded fixture data. |
| **Partial** | Some of it exists. The entry says which part. |
| **Designed** | Specified in [DATABASE.md](DATABASE.md) with column-level detail, not migrated. |
| **Not started** | Nothing. |

**One caveat applies to every screen: nothing in the web app is wired to the API.** All twelve screens read `@linck/mock`. Every action that appears to save something writes React state and loses it on reload. The session contract is written in `apps/web/src/auth/session.ts` and deliberately unimported — a half-wired session that failed at boot would take down all twelve screens.

What *is* real: Google sign-in, tenancy, scoped RBAC and row-level security all run against Postgres and are proven by tests. Everything else is a working interface over fixtures.

Counting the individual asks in the original brief: **15 built, 16 mock-only, 38 partial, 31 not started, 3 designed-not-built.**

---

## At a glance

| Persona | Screens they can open | State of their job |
|---|---|---|
| Executive | 10 — all of them | Can see the business. Cannot see a P&L, because there is no ledger. |
| Accounts | 5 | The receivables half is the strongest thing in the product. The expenses half does not exist. |
| Fleet | 6 | Status, diesel and documents are solid. Tyres, services and attendance are not built. |
| Maintenance | 7 (borrowed) | No role of their own, and nowhere to record a repair. |
| Stores | 3 | Approves indents. Cannot raise one, receive goods, or see an item or a vendor. |
| Production | 3 | The joint-production model is the best-served thing here. Boulder receipt is missing. |
| Sales | 5 | Can run the yard. Cannot take an order or raise an invoice. |
| Driver | 1 (plus one 404) | Effectively not built. |
| Team admin | 1 | Backend finished, frontend absent. |

---

## Executive — the Managing Director

**The job.** He owns the plants and the fleet and is the only person who sees all three sites at once. His job on this system is to spot where money, material or paperwork has quietly gone missing. He is also routinely the second pair of eyes on cash.

**Built for him.** The executive dashboard is his landing screen: cash position, receivables, reported-but-unverified money, and fleet uptime, then a fourteen-day revenue and margin trend, the material reconciliation, receivables ageing, a downtime Pareto, product mix, and compliance exposure. He can open all ten screens.

Three things on it are sharper than a normal ERP dashboard:

- **The material reconciliation is two objects, not one.** A stock waterfall, and separately a bar of invoiced against uninvoiced dispatched units. They cannot be merged: a load dispatched and not yet billed has already left stock, so folding invoicing into the waterfall would double-count the same units.
- **Reported money and verified money are different data everywhere** — its own tile, its own hatched column, its own dashed status, and an ageing toggle labelled "If every claim were true" that recomputes the whole profile.
- **The downtime Pareto puts "no load allotted" in the same chart as tyre bursts**, and gives it the only coloured bar — a selling problem wearing a maintenance costume.

**Gaps.**

| Asked for | State |
|---|---|
| Executive dashboard | Mock only |
| **Profit and loss** | **Not started** — there is no general ledger migrated. Contribution margin per trip is the closest thing, and it is generated, not computed from cost rows. |
| Cash position | Mock only — the hero tile is a hardcoded literal with a fabricated week-on-week delta, stamped with a source view that does not exist |
| All-sites scope | Partial — receivables ignore site scope entirely, and the stock table silently falls back to one site when he picks "All sites" |
| Approvals and exception handling | Partial — the alert drawer is read-only |
| Member and role administration | Not started — he holds the permission, nothing consumes it |

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Make the dashboard honest about site scope, and either wire or remove the dead Today / This-FY chips | S |
| 2 | Replace the hardcoded cash tile with a real figure or an explicit "not connected" state | S |
| 3 | Per-site comparison view — he is the only persona with all-sites scope and nothing puts the plants side by side | M |
| 4 | Make the alert drawer actionable: acknowledge, assign, drill through | M |
| 5 | Derive contribution margin from real cost rows via the vehicle-day duty log | M |
| 6 | **Migrate finance and build a real P&L** — the explicit ask, genuinely not started | L |

---

## Accounts

**The job.** She decides whether money is real: watches the receivables book, confirms a reported payment actually landed before an invoice may close, and keeps the vehicle paperwork as a dated obligation list with a cost against each date.

**Built for her.** The payment verification queue, the invoice ledger, the document and expiry register, the e-way bill console, and the extraction review queue.

This is the strongest persona in the product, and the reasons are specific:

- **The two-person control is printed and disabled, not hidden.** The reason sits next to the dead button — "You recorded this one — it needs someone else." A button that vanishes teaches a three-person office to share a login.
- **The ageing counter is the control, not the block.** Measured in rupees rather than row count, because nine small cash receipts and one ₹7 L RTGS are not the same backlog.
- **The document register is drawn as cash flow, not as a compliance count** — renewal money falling due month by month, with "already lapsed" as its own leading bar, and expired-stops-the-truck separated from expired-and-just-a-fine.

**Gaps.** The receivables half of her job is well served. The expenses half is missing entirely.

| Asked for | State |
|---|---|
| Invoice management — is the amount received or not | **Built** (the rule, as UI convention) |
| Fitness certification costs and other costs | Built |
| Insurance, road tax, insurance end date, permit dates — manually entered | Partial — the register displays them; **there is nowhere to enter them** |
| The hard rule: invoice does not close until cross-verified | Partial — enforced in the UI, not yet in the database, and a page refresh erases it |
| Billing | Partial — read-only; the permission exists, no screen writes |
| Expense management | Not started |
| Ad-hoc expenses | Not started |
| Vehicle EMI | Not started |
| Employee salary | Not started |

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Seed the missing finance permission keys — only `receipt.read` and `receipt.verify` exist, so no expense or payable screen can even be gated | S |
| 2 | Close the cross-verify hole: the invoice ledger's verify button calls no permission check and no recorded-by check, so one person can verify and close alone | S |
| 3 | Make verification a shared fact — the two screens hold separate state, so the same receipt reads differently on each | M |
| 4 | A data-entry form for the document register — the owner said these are manually entered and there is nowhere to enter them | M |
| 5 | Vehicle EMI and loan schedule — usually the largest fixed monthly number in a tipper fleet | M |
| 6 | Migrate the finance slice so the close rule becomes a database trigger rather than a convention | L |
| 7 | Vendor payables and expense capture — the extraction queue already promises them in prose | L |
| 8 | Payroll — correctly deferred to Phase 3, but should be stated as deferred rather than quietly missing | L |

---

## Fleet

**The job.** Keeps 58 tippers earning. Knows which are on trip, ready, idle, in service or broken down; chases the paperwork and the service that would stop one at the gate; and polices diesel, the largest operating cost and the largest leak.

**Built for them.** The fleet command board, vehicle status, the driver list, the breakdown register, the expenses register, diesel and DEF entry, the document register, the dispatch board, the indent queue, and extraction review.

- **The fleet command board** (`/fleet/board`, their landing page) links to the seven databases the desk works in: Vehicles, Driver List, Delivery Order & Dispatch, Breakdown Register, Expenses Approval, Maintenance Stores and Vehicle Documents. Below the links are seven urgent counts: breakdown, documents expired, due for service, drivers absent, expenses awaiting approval, open store requests, and idle. Each count opens its pre-filtered list via `?view=`. The uptime tiles, status bar, uptime trend and diesel scatter moved unchanged to **Vehicle status** (`/fleet/vehicles`).

- **Idle is an attention state and uptime forgives planned service.** Uptime is on-trip plus ready over total, with under-service excluded from downtime — counting a planned service as a failure teaches the team to skip services to protect the number.
- **Diesel is policed against each vehicle's own benchmark and own tank**, not a fleet average. One threshold — 82% of benchmark — is applied identically in the table cell, the sparkline, the scatter flag and the exception filter.
- **The fuel screen refuses almost nothing.** The only hard stop is an odometer running backwards. An off-benchmark fill posts as keyed and carries a review flag, because a screen that refuses entries is a screen people stop using.

**Gaps.**

| Asked for | State |
|---|---|
| Vehicle status: ready / active / breakdown | Mock only |
| Vehicle mileage, diesel bill entries | Mock only |
| **Tyre mileage** | **Not started** — no type, no field, no screen. Also the largest single downtime cause in our own data. |
| Exhaust fluid (DEF) | Partial — the field is on screen and validated, and the save silently discards it |
| Driver attendance | Partial — the data generator and the heat-grid chart both exist and are wired to nothing |
| Regular scheduled services / expected for maintenance | Partial — one bare "service due in km" integer with no history and no schedule |
| How many services and expenses | Not started |
| Telematics APIs for 35T/48T tippers | Not started — correctly last; manual entry must work first |

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Persist DEF litres — we collect the number and throw it away | S |
| 2 | Make "raise an indent" actually raise one — the button has no handler and the palette advertises it | S |
| 3 | Reconcile the frontend fleet persona with the seeded backend role — they disagree on three permissions | S |
| 4 | Driver attendance screen — the generator and the chart exist; only the marking action is missing | M |
| 5 | Breakdown lifecycle: reason code, repair job, downtime hours, per-vehicle Pareto | M |
| 6 | Service records and schedule — three of the brief's asks rest on this | L |
| 7 | **Tyre register** — serialised fitment by axle position, km at fit and removal, cost per km | L |
| 8 | Per-vehicle cost view: diesel, DEF, tyres, services and renewals in one place, per km and per tonne | L |
| 9 | Telematics ingest — odometer and status only. It should replace odometer keying, never the diesel bill, because the bill is where the theft is caught | L |

---

## Maintenance

**The job.** Swap jaw plates, cone liners and belts before they part; get a broken machine back on the road; raise the spares indent that makes either possible.

**This persona has no role of its own.** There is no `maintenance` entry in the seeded roles or the demo personas — only a dead label in a constants file. Today you give a workshop person either Fleet (which also grants dispatch and e-way bills, and cannot see crusher stock) or Stores (which grants approval over every indent, and cannot see the fleet board). No role grants both the fleet board and the crusher's stock.

**What exists.** Breakdown is a first-class urgency on the indent queue, and the queue sorts urgency above age. Crusher stoppage capture on the shift form is wear-part specific — jaw plate change, cone liner wear, belt slip — and downtime hours without a reason is the only thing that blocks a save on that screen.

**What does not.** Job cards. Service history. Any asset record for the work to hang off — "Jaw + VSI — KRP 250TPH" exists only as text on three indent rows, and the sheet's "also queued against this asset" works by string equality. "Report breakdown" on the fleet board is one-way: there is no way to set under-service, no way to clear a breakdown, and no record of what was done.

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Seed a maintenance role and persona with its own grant set, and give it a landing rule | S |
| 2 | A crusher downtime Pareto from the reason codes already captured on every shift | S |
| 3 | An asset record shared by fleet and production; repoint the indent's asset from free text to a foreign key | M |
| 4 | Wear-part life: fitment date, hours and tonnes since fitment, expected life — turns a ₹2.12 L cone mantle from a surprise into a forecast | M |
| 5 | Service schedule and a return-to-service action that clears under-service | M |
| 6 | Job card: open on breakdown, close on return to service, carrying parts, labour and downtime | L |
| 7 | Spares as a real ledger — item master, on-hand by location, receipt, issue booked to an asset | L |

---

## Stores

**The job.** The man at the counter who decides whether a requested spare is approved and handed out, judged on how long a stopped crusher waited on his desk.

**Built for him.** The indent queue, the live stock board, and extraction review.

- **The queue is ordered by what is stopped**, not by date or amount, and says so: "a plant or a tipper is stopped until these are approved."
- **Reject is a decision with a physical consequence.** On a breakdown indent you must type the indent number, under a sentence that refuses to flatter: rejecting does not restart the plant, it only takes the line off your list.
- **The spend chart separates money committed from decision latency** — the bar is approved value, the dashed tick is value still waiting on a decision. A short bar with a long tick is a desk that has stopped deciding.

**Gaps.** His built job is much narrower than his real job. He approves indents. He does not keep stock, receive goods, or hold a vendor list.

| Asked for | State |
|---|---|
| Spares stock — consumables | Partial — `stockOnHand` and `reorderLevel` are copied onto each indent row, so nobody can look at an *item* |
| Details for the crushers | Partial — "consumables" exists only because the UI reads a two-letter code prefix |
| **Material storage handling** | **Not started** |
| **List of vendors** | **Not started** |
| Raising an indent | Not started — he holds the permission, the button has no handler |
| Goods receipt | Not started — though the AI queue tells him in plain words that confirming an invoice "posts a GRN into Karapakkam Workshop stores" |
| Purchase order | Not started |

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Build the raise-an-indent form — the cheapest gap between what the product claims and what it does | S |
| 2 | Fix the site-scoping of the indent badge, and give him a cross-site view of his own queue | S |
| 3 | Vendor list — one of three things explicitly asked for, and the party master is already column-designed | M |
| 4 | Make "mark issued" post a real stock movement against the asset | M |
| 5 | Item master and a real stores stock screen — including which asset types an item may be issued to, which is what stops a jaw plate going to a tipper | L |
| 6 | Goods receipt, and make the extraction queue's vendor-invoice path actually post one | L |
| 7 | Purchase order and three-way match — last, because unlike the others it has no column-level design yet | L |

---

## Production

**The job.** Runs the crusher and turns each shift into a record: boulder fed in, the co-products that came off it, and the hours the plant stood still and why.

**Built for him.** Shift production entry, the live stock board, and the indent queue.

This is the best-served domain model in the product:

- **Joint production is drawn as a split, not entered as a quantity.** One boulder trunk, one sized ribbon per co-product, the unaccounted remainder drawn as its own explicit loss ribbon rather than omitted. It redraws live as he types.
- **The mass-balance control never blocks the save.** Outside ±8% he gets a confirm that restates the gap in tonnes, in percent, and in tipper-load equivalents — "roughly 3.2 tipper loads is not in any pile" — with a different wording when output exceeds input. The confirm button says "Record it as keyed."
- **The conversion factor rides on the row and is shown as arithmetic.** A grade with no configured density renders an en dash everywhere rather than an assumed number.

**Gaps.**

| Asked for | State |
|---|---|
| What it converts to and how much | **Built** |
| Stock at hand | Built |
| **Boulder received** | **Not started** — the entire mass-balance control rests on one hand-typed total with no document behind it |
| Product management / categories | Designed — adding a grade or correcting a density is a code edit today, and the two lists already disagree |
| Invoice generation | Not started |

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | A run history screen — the MD holds `production.run.read` and literally cannot see a production run anywhere, because the table is embedded in a create screen | S |
| 2 | Operators and downtime reasons from master data, site-scoped | S |
| 3 | Boulder receipt capture — an inbound weighbridge ticket, the missing half of the owner's first sentence | M |
| 4 | Product master with categories, densities, HSN and effective-dated conversion factors | M |
| 5 | Per-plant yield recipe and tolerance — today the Thiruvallur cone is scored against the Karapakkam jaw-and-VSI mix, so every "vs usual" figure on a second plant is wrong | M |
| 6 | Physical count entry with a variance posting — the board warns about count age and gives nobody a way to clear it | M |
| 7 | Make "record shift" actually post to the stock ledger — today the run entry and the stock board are two unconnected datasets | L |

---

## Sales

**The job.** Turns a phone call into a loaded tipper and eventually into money.

**Built for them.** The dispatch board, the invoice ledger, the stock board, the e-way bill console, and the fleet board.

- **The sales command board** (`/sales/board`, their landing page) — five urgent-action counts (unraised invoices, orders pending approval, dispatches unconfirmed or delayed, invoices overdue, stock below safety level), each opening its own pre-filtered list via `?view=`, over a row of links to Material Stock, Customers, Purchase Orders, Material Dispatch and Invoices.
- **Customer and purchase-order databases** (`/sales/customers`, `/sales/orders`) on seeded mock data, with approve / reject on an order awaiting sign-off.

- **The trip cost sheet** — revenue and cash cost on one page per load, with named handling for the three kinds of load that earn nothing: returned, cancelled, own-use. A returned load shows zero revenue against full cost, which is exactly the number the business needs to see.
- **Quantity basis rides beside every quantity**, and weighbridge variance is drawn as a trend rather than an invoice block. Moisture alone moves apparent density 8–15%.
- **The e-way bill console's threshold asymmetry** — ₹50,000 inter-state against Tamil Nadu's ₹1,00,000 intra-state — with two independent clocks and Rule 138E as a registration-level banner. The rules behind it, and everything else statutory, are in [COMPLIANCE.md](COMPLIANCE.md).

**Gaps.**

| Asked for | State |
|---|---|
| Invoice does not close until cross-verified | **Built** |
| Unit / CFT conversion | Partial |
| Transport costing in detail | Partial — the numbers are pre-computed, not derived from a duty log |
| e-Way bill after loading | Partial — Part B can be keyed; **Part A cannot be raised**, which is literally the ask |
| Coordinate with production on loading | Partial |
| **Receives orders** | **Not started** — the dispatch board can only move pre-seeded trips |
| **Orders drivers to do the transport** | **Not started** — the driver is inherited from the vehicle and rendered read-only |
| Generates invoices | Not started — and neither the persona nor the backend role grants invoice-write to sales |
| Payment type flexibility | Partial — only a method field |

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Permission-gate the write actions that are currently ungated — invoice close, e-way bill Part B and cancel all check nothing | S |
| 2 | ~~Fix the landing route — this persona lands on the fleet board, not their own dispatch board~~ — done: they land on the sales command board | S |
| 3 | Give sales `compliance.ewb.write` in the frontend persona, matching the backend role | S |
| 4 | Move the e-way bill console into its own Compliance workspace — a crusher-only tenant loses it entirely today | S |
| 5 | Join the console to the dispatch board, add a movement field, and add Generate Part A. A cross-border load currently reads "not required" against the wrong threshold | M |
| 6 | Customer rate card, so "rate overridden at the gate" has something to be overridden against — today the tile can show the count and never the rupees | M |
| 7 | Payment terms, credit limit, advances. Credit control warns by default; a hard block at 6am produces limits set to 999999999 within a fortnight | M |
| 8 | **Load booking / order intake** — the first of the six paper-replacing screens | L |
| 9 | Invoice creation, and a decision on whether sales raises invoices at all | L |
| 10 | Vehicle-day duty log with a versioned cost-allocation rule behind the trip cost sheet | L |

---

## Driver

**The job.** Takes the tipper out, drives the load, fills diesel, gets marked present.

**This persona is effectively not built.** He can key a diesel fill. That is all. His landing route is `/field`, which is in the home-resolver and *not in the route tree* — so a driver signing in and clicking the logo gets a bare "Not Found" inside a desk shell built for a 27-inch monitor.

He also currently reads the whole site's fuel ledger — colleagues' names, amounts, flags — without holding the read permission, and the alert drawer shows him receivables alerts that route to screens he cannot open.

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Make `/field` exist — at minimum stop the driver landing on a 404 | S |
| 2 | Scope "recent fills" to his own vehicle when he holds only create | S |
| 3 | Filter the alert drawer by permission, the way the nav rail already is | S |
| 4 | The real `/field` home on mock data: today's trips, the vehicle, the odometer, a shortcut into diesel entry | M |
| 5 | A mobile layout for `/field` and `/fleet/fuel/new` only — two routes is tractable, twelve is not, and the driver needs two | M |
| 6 | Photograph-the-bill capture feeding the extraction queue — removes the need to type at a bunk at 6am, which is where the odometer is least reliable | M |
| 7 | Driver attendance capture | M |
| 8 | Phone + OTP as a second identity provider. No migration needed — `provider` is free text with a unique key on (provider, subject) | M |
| 9 | Trip assignment that actually reaches a driver — the loop that closes the fleet vertical | L |

---

## Team admin — the cross-cutting layer

**The job.** Register the people who work in the business before they can sign in, decide which sites each may act on, and keep the tenant's shape correct.

**This is the inverse of the driver: the backend is finished and the frontend does not exist.**

Built and running against Postgres:

- **Google sign-in** with Authorization Code + PKCE, the stable `sub` pinned on first sign-in, email treated as mutable profile data, a hosted-domain gate at two levels, one indistinguishable 403 for every not-registered case, and rotating refresh tokens where a replay revokes the whole chain. Sign-in never creates a user.
- **Scope is a column, not a boolean** — `site_id` nullable, null meaning org-wide, collapsed in one SQL pass and re-implemented as a pure unit-tested function the nav rail, the router and the palette all share. No component contains `if (role === 'accounts')`.
- **Two independent gates** — module (did this tenant buy the vertical) and permission (may this person use it). A crusher-only tenant's admin cannot mis-assign Fleet Manager, because the role does not exist in their tenant.
- **Tenant isolation enforced by Postgres**, with the app refusing to start if the posture is wrong.

**What is missing is everything a human touches.** There is no member directory, no invitation screen, no role assignment UI, and no admin API — the entire surface is auth plus one session read. Adding a person to a tenant means editing the seed script and re-running it.

And the delegation the owner actually asked for — "admins in *their* team" — is enforced nowhere. There is no team entity, and nothing stops a site-scoped admin granting any role at any site including org-wide.

**Next, in order.**

| | Item | Effort |
|---|---|---|
| 1 | Suspend / reactivate a member — half already works; nothing can set a user's status, so a leaver cannot be removed | S |
| 2 | Extend the audit trigger beyond its five tables. Creating a role, changing permissions, linking an identity and opening a session are all unaudited | S |
| 3 | Give compliance its own workspace — a crusher-only admin currently sees an empty rail | S |
| 4 | Add a landing rule for `admin.member.manage` — a pure admin falls through every rule and is shown Forbidden on login | S |
| 5 | **Collapse the three divergent role lists into one generated source** | S |
| 6 | Member directory screen, gated on the permission that already exists | M |
| 7 | The admin API behind it — `require()` is written and used by zero routes | M |
| 8 | Scope-limited delegation, and write `granted_by` | M |
| 9 | Org settings: legal entities, GST registrations, sites, modules, hosted domains | M |

---

## The three things that block everything else

**1. Wire the web app to the API.** Every roadmap item above is a mock until this happens. The cutover is four steps, already written in the header of `apps/web/src/auth/session.ts`: ship the endpoint, await it before mounting the router, feed the mapper into the store while deleting both demo switchers in the same commit, then migrate screens off mock data one at a time. Diesel entry is the right first screen — highest frequency, and named in Phase 1 as a paper-replacing surface.

**2. Migrate the finance slice.** The owner's hard rule — an invoice does not close until payment is cross-verified — is currently a UI convention that a page refresh erases. It becomes real as a database trigger. The same migration is what makes the P&L possible.

**3. Settle the role model.** Three lists disagree today: the backend seed (9 roles, the real one), the frontend personas (7, drifting on at least three permissions), and a constants file naming three roles that exist nowhere. For the person whose job is granting access, that is the defect most likely to produce a wrong grant.

## Defects found during this audit

Worth fixing regardless of roadmap, because each one quietly misleads:

- The executive dashboard's **cash tile is a hardcoded number** with a fabricated delta, stamped with a source view that does not exist. A wrong number that looks sourced is worse than a blank one.
- The dashboard's **Today / This-FY chips are a dead control** — they set state nothing reads, so the MD toggles between two periods and watches nothing change.
- **Average days to collect is a hardcoded 41.2** on the invoice ledger.
- The **contribution-margin trend is generated**, not computed from cost rows.
- **Invoice close, e-way bill Part B and cancel are ungated** — they check no permission at all, so a persona with read access can close invoices, defeating the two-person rule on the screen built around it.
- **DEF litres are collected and discarded** on save.
- **"Raise an indent" has no handler**, on a button the command palette advertises as a startable action.
- The **`/field` route does not exist**, though the home resolver sends drivers to it.

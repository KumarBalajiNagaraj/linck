# Linck — Indian statutory surface

What the law requires of a crusher-and-fleet business, what Linck does about it today, and what is still missing.

This exists because the compliance reasoning was scattered across code comments and research notes. It is the reference for anyone building the sales, invoicing or dispatch modules.

> **This is engineering research, not tax advice.** Every threshold, rate and rule below was researched with sources (listed at the end) and then attacked by an adversarial review that found eleven claims wrong or materially imprecise. It is good enough to build against and **not** good enough to file against. Have your CA confirm anything marked ⚠️ before go-live, and re-confirm every threshold annually — these move.

## Status labels

| Label | Means |
|---|---|
| **Built** | Implemented and visible in the product, on mock data |
| **Designed** | Specified in [DATABASE.md](DATABASE.md), not migrated |
| **Missing** | Not modelled anywhere |

---

# 1. e-Way Bill

The single most operationally important regime for this business, because it stops lorries.

## 1.1 The threshold asymmetry — the thing to get right first

| Movement | Threshold | Effect on a typical tipper |
|---|---|---|
| **Intra-state, Tamil Nadu** | ₹1,00,000 | A 35T tipper of M-Sand is about 7 units; ex-plant that is ₹28,000–45,000. **Most intra-TN loads need no e-way bill at all.** |
| **Inter-state** | ₹50,000 | The same load crossing into Karnataka almost always needs one. |

The same lorry carrying the same material is paperwork-free one way and a detention risk the other. This is why Linck models `movement` as a first-class field rather than deriving a single threshold.

**Status: Built.** `EWB_INTRA_STATE_THRESHOLD` and `EWB_INTER_STATE_THRESHOLD` in `packages/mock/src/selectors.ts`, applied per row by `ewbThreshold()`. The console renders "not required" as a calm default with the headroom stated, rather than flagging every compliant load as missing paper.

**Two refinements to apply before go-live** ⚠️
- "Consignment value" is the section 15 value **including** CGST/SGST/IGST/cess but **excluding** exempt-supply value on a mixed invoice. It is not the invoice total.
- Tamil Nadu's ₹1 lakh relaxation carries a **commodity carve-out list**. Confirm aggregates are inside it before relying on the higher threshold.

## 1.2 Part A and Part B are two facts with two clocks

**Part A** is the consignment — invoice, value, HSN, from and to. It stands alone for **15 days** waiting for Part B, then silently dies.

**Part B** is the vehicle number. **Entering Part B is what starts the validity clock** — not Part A generation.

**Part B is not required at all** within 50 km in the same state, between the consignor's place of business and the transporter's (and the mirror leg to the consignee). A blank Part B is therefore sometimes entirely correct, and must not read as a failure.

**Status: Built.** Both clocks are modelled and derived rather than stored — a stored "expired" flag is wrong the moment the dataset is read a day later. The console shows the Part A window with days remaining, and renders an under-50 km blank Part B as "Not required — 42 km, same state".

## 1.3 Validity

| Cargo | Rate |
|---|---|
| Normal | 1 day per **200 km** |
| Over-dimensional | 1 day per **20 km** |

**A "day" ends at midnight of the last day.** It is not 24 hours from generation. Any board that computes "expiring in 4 hours" locally from a 24-hour assumption will mis-rank every row.

**Status: Built.** `ewbValidityDays()` and `ewbValidUntil()` compute to midnight of the day following the counted day, on the IST calendar.

**Extension** is permitted only in the window **[expiry − 8h, expiry + 8h]**, only by the transporter (or the generator acting as transporter), and only while the consignment is still in transit with current place, state, PIN and remaining distance. Beyond +8 hours there is **no remedy** — the movement is illegal, and the options are stop-and-regenerate against a fresh document or accept section 129 exposure.

**Status: Missing.** No extension flow, and no terminal "expired, unextendable" state. That state is a penalty event the MD should see.

Also effective 1 January 2025: a **180-day source-document age limit** (you cannot raise an e-way bill against an invoice older than 180 days) and a **360-day total extension cap**. **Status: Missing.**

## 1.4 Rule 138E — the blocker that stops the whole yard

**e-Way bill generation is blocked for a GSTIN that has not filed GSTR-3B for two consecutive tax periods.**

This is the most common real-world cause of "why can't we generate e-way bills today", and its shape is vicious: a filing failure at the accounts desk silently stops every tipper in the yard, and nothing at the gate explains why.

**Status: Built.** `GstinStanding` carries the standing per registration, and the console renders it as a banner naming the unfiled periods and the rupee value of stock standing behind the block — not as a repeated per-row error, because it is a registration-level fact.

## 1.5 Cancellation and rejection

| Action | Window | Status |
|---|---|---|
| **Cancellation** | Within **24 hours** of generation, and not if verified in transit (Rule 138(9)) | **Built** — confirm modal requires typing the 12-digit number, states hours elapsed, and refuses outside the window |
| **Recipient rejection** | Within **72 hours** of generation or before delivery, whichever is earlier (Rule 138(12)) | **Missing** — no window, no actor, no consequence |

## 1.6 One trip can have several bills

A cancel-and-regenerate, or a breakdown-and-reload, legitimately produces more than one e-way bill against one trip. Modelling this 1:1 is wrong.

**Status: Built.** `attempt` and `supersedes` on the bill, with at most one live; the console shows the generation-attempt history so a cancel-and-regenerate stops looking like two unrelated bills.

## 1.7 What is not built

| | Why it matters |
|---|---|
| **Generating Part A** | The console can key Part B but cannot raise a bill. This is literally what the brief asks Sales to do. |
| **GSP integration** | ⚠️ **2FA/MFA is mandatory on both portals from 1 April 2025.** An unattended ERP integration therefore cannot use portal login — it must go through a GSP with API credentials. NIC auth tokens expire in roughly 6 hours; a token-refresh failure presents as random 3 a.m. e-way bill failures. This needs an integration-credentials table with expiry, not a `gsp_provider` text column. |
| **Portal failover** | **e-Way Bill 2.0** (`ewaybill2.gst.gov.in`) has been live since 1 July 2025, real-time synced with the primary portal. Treat EWB1/EWB2 the way the IRP is treated — portal-agnostic with automatic failover. |
| **NIC distance reconciliation** | NIC auto-populates PIN-to-PIN distance and accepts your figure only within a tolerance of it. Quarry lanes routinely diverge — a quarry and a suburb can share a PIN — so a governed distance will be rejected. Store `nic_distance_km` alongside your own and reconcile, or your freight slab and your e-way bill will disagree with nobody knowing which is authoritative. |
| **Quantified penalty exposure** | Section 129 detention: **200% of tax payable, or 50% of the value of the goods, whichever is higher**, where the owner does not come forward. Section 122(1)(xiv): ₹10,000 or the tax sought to be evaded. Overload exposure sits on top under the Motor Vehicles Act. An exception list with no rupee figure is a list nobody acts on. |
| **EWB-vs-GSTR-1 reconciliation** | The department runs this. You should run it first. |

---

# 2. GST invoicing

## 2.1 Our products

| HSN | Covers | Rate |
|---|---|---|
| **2505** | Natural sands | 5% |
| **2517** | Pebbles, gravel, crushed stone for concrete aggregate, road metalling, ballast | 5% |

Unchanged through the 22 September 2025 rationalisation.

**The M-Sand question is genuinely unsettled** — 2517 is the better-supported view, since M-Sand is crushed rock rather than natural sand. Both are 5%, so the rate risk is nil and only the HSN string matters. Pick per product, get it in writing from the CA, version it, and understand that changing it later re-opens every prior Table 12 summary.

**HSN digits:** 4 at AATO ≤ ₹5 crore, 6 above. Since that is the same number as the e-invoicing threshold, in practice anyone e-invoicing is on 6 digits.

## 2.2 Invoice numbering

16 characters, consecutive and unique **per GSTIN per financial year** — not per organization. A tenant with two GSTINs under one org can otherwise produce a duplicate serial inside a GSTIN.

**Status: Designed.** `core.gst_registrations` is migrated; the document series is designed and not built.

## 2.3 Place of supply

IGST if and only if supplier state ≠ place of supply.

**The bill-to/ship-to rule is the one most often got wrong.** Section 10(1)(b) IGST Act applies **only where a third person directs delivery** to someone else. One builder with many sites is plain section 10(1)(a) — place of supply is where movement terminates, i.e. the site. A rule that keys off "ship-to GSTIN differs from bill-to GSTIN" fires wrongly whenever the same legal entity holds a second registration in another state.

POS is the single field GST audits pick on. Persist the reasoning, not just the answer.

## 2.4 Freight on a delivered sale

Delivered-basis freight is a **composite supply** at the goods rate (sections 2(30), 8(a), value inclusion under 15(2)(c)).

**But apportion it, do not attach it to the highest rate.** On an invoice carrying goods at two rates, putting all the freight on the highest is mixed-supply logic applied to the wrong thing. Apportion across material lines pro rata to taxable value, each portion at that line's rate — or fold freight into the delivered unit rate.

On a genuine ex-plant sale where the customer independently engages the transporter, the freight is not your supply at all.

## 2.5 Delivery challans — do not make this routine

Section 31(1)(a) requires the tax invoice **before or at the time of removal** where the supply involves movement. Rule 55 permits a challan only for specific cases: liquid gas of unknown quantity, job work, transport for reasons other than supply, and other notified supplies.

The tempting rationale — "quantity is only final after weighment" — collapses on its own facts, because **the weighbridge is at the plant, before removal**. Quantity *is* known. Site acceptance is a credit-note matter, not an invoicing matter.

**Correct flow: weigh → invoice → move.** Keep challans for the real cases: inter-plant transfer, job work, customer-arranged vehicle loaded before weighment, sales returns.

There is a second reason this matters. If the e-way bill is generated against a challan and the IRN arrives days later against a different document number, you lose the auto-EWB-from-IRP path *and* you generate your own audit trigger — the department data-mines EWB-vs-GSTR-1 mismatches, and every outward movement on a challan with no matching invoice number is a flag.

**Monthly consolidated invoicing** for credit builders is real and needs a bulk challan→invoice conversion plus a per-customer `invoicing_mode`. At 300 loads a day, a month end otherwise leaves ~4,500 open challans. **Status: Missing.**

## 2.6 Round-off

The IRP validates total invoice value against the sum of line values within **±1 rupee**. A stricter check (±0.50) will reject valid invoices and produce NIC rejections nobody can diagnose.

---

# 3. e-Invoicing and IRN

## 3.1 Applicability

| Rule | Value |
|---|---|
| Threshold | **₹5 crore** AATO (Notification 10/2023-CT, from 1 Aug 2023) |
| Tested on | AATO in **any** FY from 2017-18 onward — **permanent once crossed** |
| Scope | **PAN level** — all GSTINs under the same PAN aggregated |
| Reporting window | **30 days**, for AATO ≥ ₹10 crore, effective 1 April 2025 |

Note the two different keys, which are easy to conflate: **e-invoicing applicability is PAN-level; filing, numbering and place of supply are GSTIN-level.**

**B2C is out of scope for IRN** — derive `not_applicable` from the recipient type, not only from the org's turnover.

**A GTA is exempt from e-invoicing entirely** (Rule 48(4) with Notification 13/2020-CT), and the exemption is read as entity-wide. So the question "is the transport entity a GTA" changes e-invoicing applicability for that **whole entity**, not just its transport lines. Linck models `is_goods_transport_agency` on `core.legal_entities` for exactly this reason.

## 3.2 The 30-day window is a hard block

The IRP disallows reporting after 30 days. No grace, no retry. A retry counter past T+30 is meaningless.

You need a terminal **`permanently_unreportable`** state: the supply happened, the invoice is valid under section 31, but it has no IRN and is therefore not a valid document under Rule 48(5) — which puts the customer's ITC at risk. That is the situation that generates the ugliest customer disputes, and there is currently no state for it. **Status: Missing.**

## 3.3 Cancellation retires the number permanently

Once an IRN is cancelled, **that invoice number is permanently dead**. A fresh document with a **new number** must be issued. Any model that allows a second IRN attempt against the same invoice row will be rejected by the IRP.

## 3.4 Fields that will fail at the IRP

- **`DispDtls`** — dispatch-from name, address, PIN, state. **Mandatory when goods leave an address other than the one on the GSTIN, which is exactly a crusher plant.**
- `ShipDtls`, `PayDtls`, `RefDtls` (the customer PO number needs somewhere to map to), `EwbDtls` for the auto-EWB call, and per-line `IsServc`.

**Signature:** Rule 46 requires the invoice signed or digitally signed, **except** where an e-invoice is issued under Rule 48(4). So B2C invoices from an e-invoicing taxpayer still need a DSC. Nothing models the authorised signatory. **Status: Missing.**

---

# 4. The unit problem — and it is a build-breaker

**CFT is not a valid Unit Quantity Code.**

The GST UQC list — used by GSTR-1 and enforced by the e-invoice schema — contains CBM, MTS, TON, NOS, UNT, SQF and others. **There is no cubic-feet code.**

This business bills in units of 100 CFT. Every e-invoice line and every Table 12 HSN summary line must therefore carry a statutory unit that is *not* the trade unit.

**The consequence: every invoice line needs three quantities frozen, not one.**

| | |
|---|---|
| **Trade quantity + trade UOM** | What the customer agreed to pay for — units, or CFT |
| **Statutory quantity + UQC** | What GSTR-1 and the IRP will accept — CBM or MTS |
| **Conversion factor used** | Persisted on the row, never recomputed |

Decide CBM or MTS **now** and never change it, or the HSN summary will not reconcile across periods.

**Status: Partly built.** `packages/domain/src/uom.ts` is the single conversion authority and already freezes trade quantity, statutory quantity, UQC and the factor used — it exists because two independent domain models disagreed about sand density by 15% of billed quantity on every load. `freezeQuantity()` returns all four. What is missing is the invoice line that consumes it, because invoicing is not built.

The rule that makes this safe: **historic rows are never recomputed when a density is revised.** Any report that recomputes tonnes from CFT using a current factor is a bug.

---

# 5. Returns, IMS and filing locks

Three regimes the design did not originally know about. All ⚠️ — confirm current status with your CA.

## 5.1 Invoice Management System

Your customer now **accepts, rejects or holds** each of your outward documents. A credit note can sit pending for only one tax period, after which it is deemed accepted. A **rejected credit note pushes the liability straight back to you** in the next GSTR-3B.

Meaning: **your AR subledger and your GST liability now diverge based on what your customer clicks.** Without modelling the IMS outcome, the MD's cash position and the GST liability will never tie and nobody will be able to explain why.

## 5.2 Section 34(2), as amended

Effective 1 October 2025, the supplier **cannot reduce output tax liability** unless the registered recipient has reversed the corresponding ITC, or the tax incidence was not passed on. A credit-note model with no recipient-acceptance state cannot support this.

Separately, the credit-note cut-off remains 30 November following the FY end, or the annual return date, whichever is earlier.

## 5.3 Filing locks

- Once GSTR-1 is filed for a period, invoices are **not amendable** — corrections go through GSTR-1A (same month) or a B2BA amendment later, both requiring the original document key.
- **GSTR-3B has been hard-locked** (non-editable auto-populated liability) from the July 2025 period. Whatever the ERP reports *is* the liability.
- Returns **cannot be filed at all after 3 years** from the due date, enforced from the July 2025 period. A "we'll fix it later" invoice becomes permanently unfixable.

Invoice immutability must therefore key to the **return lock**, not merely to `status = 'issued'`.

## 5.4 GSTR-1 Tables 12 and 13

Mandatory since the May 2025 period. HSN in Table 12 must be selected from a **fixed dropdown** — free-text HSN will fail validation — and Table 12 is bifurcated B2B/B2C. **Table 13 (documents issued: serial ranges, total issued, cancelled) is mandatory**, and the document series table is its natural source.

**Status: Missing** across all of section 5.

---

# 6. Withholding

## 6.1 GST TDS under section 51 — this one deadlocks the invoice-close rule

Government departments, PSUs and entities with ≥51% government equity must deduct **2% GST TDS** on taxable value where a single contract exceeds ₹2.5 lakh excluding GST, and file GSTR-7. The supplier receives it as an **electronic cash ledger credit, not as cash in the bank**.

So for every government customer — highway and municipal contractors, which this business has — **the bank receipt is short by 2%, that shortfall is not a receivable, and a close rule that demands `balance_due = 0` from verified receipts holds the invoice open forever.**

This interacts directly with the owner's hard rule. Any withholding must reduce the balance **only once matched** against GSTR-7 or Form 26AS credit — otherwise every unpaid 2% quietly becomes a write-off.

Same shape applies to income-tax TDS (buyer pays 99.9%) and builder retention clauses (95%).

**Status: Missing.**

## 6.2 Income-tax withholding ⚠️

The **Income-tax Act 2025 replaced the 1961 Act with effect from 1 April 2026.** The 192–194T structure collapsed into section 392 (salary), **section 393** (all other resident/non-resident withholding, absorbing 194A, 194C, 194H, 194I, 194J, 194Q, 194R, 194S) and section 394 (TCS, absorbing all of 206C). Challans and returns now use **numeric payment codes** — old 194C is code 1017.

**Never bake a section number into a column name or an enum value.** Use `withholding_provision_code` plus `statute_version` with effective dating, and a mapping table from old sections to new codes.

Two specifics for this business:

- **Carriage versus hire.** If the arrangement is a *hire of the vehicle* — you direct it, you bear fuel, you pay per day or month — it is rent of plant and machinery at **2%**, not a contractor payment at 1%/2%. Heavy-machinery businesses routinely hire tippers monthly. This is a live assessment-litigation area; model the contract character explicitly and derive the code from it.
- **The 194C(6) transporter exemption has a reporting obligation.** Even where nothing is deducted on a valid declaration, the payer must still report those payments in the TDS return. A boolean with no PAN capture, no declaration validity year and no ≤10-goods-carriages attestation will not survive an assessment.

**TCS on quarry leases** (old 206C(1C), now 394(1)): anyone granting a lease or licence transferring a right in a **mine or quarry** must collect **2% TCS** from the lessee. If the group holds quarry leases, that 2% is an advance-tax credit to track via Form 27D. **Status: Missing.**

**Two things not to build:** TCS under 206C(1H) ceased to apply from 1 April 2025, and the higher-rate-for-non-filers provisions (206AB/206CCA) were omitted from the same date. Any "check whether the vendor filed returns" logic is dead code.

---

# 7. GTA and hired transport

Issuing a **consignment note** is what makes a road transporter a GTA. Without one, it is plain goods transport by road.

Rates from 22 September 2025:

| Option | Rate |
|---|---|
| Reverse charge (default) | 5% RCM |
| Forward charge without ITC | 5% |
| Forward charge with full ITC | 18% (the old 12% option was rationalised) |

**Annexure V** is the annual opt-in to forward charge, due by 15 March for the following FY; **Annexure VI** is the opt-out. Model both with the FY they bind.

GTA reverse charge applies only where the recipient is a **specified person** under Notification 13/2017-CT(R). That flag belongs on the GST registration, not in an assumption.

**Where the transporter is unregistered** — owner-operators, which this trade is full of — section 31(3)(f) requires the **recipient** to issue a **self-invoice**, now within **30 days**, and 31(3)(g) requires a **payment voucher** for the RCM payment. Both are document types with their own series. **Status: Missing.**

**A hired owner-operator with neither GSTIN nor TRANSIN cannot legally be entered in the e-way bill transporter field at all.** That is a dispatch-blocking condition and belongs as validation on the hired-vehicle picker.

**When you move goods in your own conveyance,** Part B carries the vehicle number and the transporter fields are left blank. Putting your own GSTIN there creates a phantom transporter relationship.

## Why this matters structurally

If the crusher and the tipper fleet are **separate legal entities** — the common shape, and one Linck supports — the transport leg between them is an **inter-company GTA supply** with its own invoice, its own reverse-charge treatment and SAC 9965. The freight line on the customer invoice then belongs to a different entity's books.

**Status: Designed.** `core.legal_entities` is migrated with `is_goods_transport_agency`, and the invoicing code is specified to branch by comparing the material's entity against the vehicle's. Single-entity clients never reach that branch.

---

# 8. Mineral permits, seigniorage and transit passes

⚠️ **All of this is state-specific and district-specific.** Seigniorage rates, permit forms, portals, transit-pass validity and even *which authority issues the pass* vary — in Tamil Nadu, minor-mineral administration is partly entrusted to local bodies. Either build a permit engine with per-state rule packs, or scope v1 to one state and say so out loud.

**Tamil Nadu, current position** ⚠️
- Seigniorage on rough stone / boulders / metal jelly / ballast revised **₹60 → ₹33 per MT** by notification dated 20 May 2025.
- TNMMCR 1959 amended 19 January 2026: application fee **₹1,500 → ₹5,000**, plus a new **refundable security deposit equal to twice the applicable seigniorage** for the quantity applied for.

This needs an **effective-dated rate schedule** with a gazette reference, plus security-deposit and deposit-refund tracking. A bare `seigniorage_rate` column will be wrong within a year.

## Draw down the quantity exactly once

The mineral permit governs removal of mineral **from the lease**. So the draw-down happens at **boulder receipt**, not on outbound dispatch. The outbound transit pass is a per-trip document with validity but **no quantity draw-down**.

An earlier design drew down at both ends. That double-counts the same statutory sanctioned quantity and would have halted loading at the busiest plant for a reason that does not exist.

## The transit pass is the tighter constraint

Transit-pass validity is usually a few hours — **shorter than the e-way bill**. An expired transit pass makes the vehicle seizable under state rules **irrespective of GST compliance**.

It deserves the same pre-flight check and expiry alerting the e-way bill gets, and the driver's screen should show `least(ewb_valid_until, transit_pass_valid_until)`.

**Status: Designed, not built.**

---

# 9. Two things that are money, not paperwork

## 9.1 Inverted duty refund

Output at 5% on HSN 2505/2517, against 18% RCM on royalty and 18% on spares and wear parts, **guarantees ITC accumulation**. The section 54(3)(ii) refund is real cash for a crusher business.

The catch: **Rule 89(5) restricts the formula to ITC on inputs (goods) only.** So the 18% RCM on royalty — an input *service* — is **not** refundable, while 18% on spares, wear parts and consumables **is**. The formula's numerator is the turnover of inverted-rated supplies, which only the sales module can produce.

**Status: Missing.** Worth quantifying before it is scheduled.

## 9.2 Weighbridge legal metrology

Under the Legal Metrology Act 2009, a weighbridge must be periodically verified and stamped. A ticket from an out-of-stamp bridge is challengeable by **both the customer and the department** — and it is the number the invoice quantity derives from.

A disputed weighment on an out-of-stamp bridge is an argument you cannot win. The warning belongs on the invoice, not only on the ticket.

---

# 10. Decisions still open

1. **Is the transport entity a GTA?** It changes e-invoicing applicability for the entire entity, and it decides whether the inter-company transport leg is a freight line or its own invoice.
2. **CBM or MTS as the statutory unit?** Pick once. Changing it later re-opens every prior HSN summary.
3. **2505 or 2517 for M-Sand?** Both are 5%, so get it in writing and version it.
4. **Which states?** The permit engine question. Scoping v1 to Tamil Nadu is a legitimate answer, but it should be a stated decision rather than an accident.
5. **Which GSP?** Needed before any portal integration, and it comes with a commercial contract and sandbox testing.

---

# 11. Where this lands in the build

| Regime | Now | Next |
|---|---|---|
| e-Way Bill thresholds, clocks, 138E, cancellation | **Built** on mock data | Part A generation, then GSP integration |
| UOM conversion authority | **Built** | Consume it from an invoice line |
| Multi-entity, GTA flag, GST registrations | **Migrated** | Invoicing that branches on it |
| GST invoicing, IRN, challans | **Designed** | Phase 2 |
| Returns, IMS, filing locks | **Missing** | Phase 2, and it is larger than it looks |
| Withholding, GST TDS | **Missing** | Phase 2 — it blocks the invoice-close rule |
| Mineral permits, transit passes | **Designed** | Phase 2 |
| Inverted duty refund | **Missing** | Phase 3, after the ledger |

See [DATABASE.md](DATABASE.md) for the `compliance` schema — deliberately kept separate from business logic, because these regimes change on their own schedule and must be versioned independently.

---

## Sources

Researched with web search and adversarially reviewed. Statutory positions as understood at the time of writing — verify before filing.

**e-Way Bill** — [Rule 138, CGST E-Way Rules (NIC PDF)](https://docs.ewaybillgst.gov.in/documents/EWBRules.pdf) · [E-Way Bill rules, applicability, limits (ClearTax)](https://cleartax.in/s/eway-bill-gst-rules-compliance) · [State-wise threshold limits (Busy)](https://busy.in/gst/state-wise-threshold-limits-for-e-way-bills/) · [Key validations effective January 2025 (TaxGuru)](https://taxguru.in/corporate-law/e-way-bill-updates-key-validations-effective-january-2025.html) · [Blocking and unblocking under Rule 138E (TaxGuru)](https://taxguru.in/goods-and-service-tax/blocking-unblocking-e-way-bill-generation-gst.html) · [E-Way Bill 2.0 portal (IndiaFilings)](https://www.indiafilings.com/learn/e-way-bill-2-0-portal) · [Mandatory 2FA (CAclubindia)](https://www.caclubindia.com/news/mandatory-2fa-for-e-way-bill-e-invoice-system-24722.asp)

**e-Invoicing** — [₹5 crore threshold (IndiaFilings)](https://www.indiafilings.com/learn/mandatory-gst-e-invoicing-for-taxpayers-exceeds-threshold-limit-of-inr-5-crore) · [30-day reporting window, AATO ₹10 cr+ (NIC IRP)](https://einvoice6.gst.gov.in/content/revised-time-limit-for-e-invoice-reporting-for-businesses-with-aato-of-%E2%82%B910-crores-above/) · [Amendment and cancellation (ClearTax)](https://cleartax.in/s/gst-e-invoice-amend-cancellation) · [e-Invoicing applicability for GTA (TaxTMI)](https://www.taxtmi.com/forum/issue?id=118308)

**Invoicing and documents** — [Section 31, CGST Act (CBIC)](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/acts/2017_CGST_act/active/chapter7/section31_v1.00.html) · [Rule 55, CGST Rules (CBIC)](https://taxinformation.cbic.gov.in/content/html/tax_repository/gst/rules/cgst_rules/active/chapter6/rule55_v1.00.html) · [UQC under GST (ClearTax)](https://cleartax.in/s/gst-unit-quantity-code-uqc) · [HSN dropdown and Table 13 from May 2025 (Taxmann)](https://www.taxmann.com/post/blog/hsn-dropdown-table-13-mandatory-in-gstr-1)

**Returns and IMS** — [Revised advisory on IMS (GSTN)](https://tutorial.gst.gov.in/downloads/news/revised_advisory_on_ims.pdf) · [Credit note rejection and IMS impact (Taxilla)](https://www.taxilla.com/blogs/gst-credit-note-rejection-ims) · [Section 34(2) amendment, Finance Act 2025 (TaxGuru)](https://taxguru.in/goods-and-service-tax/analysis-amendment-section-34-2-cgst-act-2017-finance-bill-2025.html) · [GSTR-3B hard lock and 3-year time bar (ClearTax)](https://cleartax.in/s/gst-return-filing-rule-changes-from-july-2025)

**Withholding** — [TDS under GST section 51, GSTR-7 (DisyTax)](https://disytax.com/tds-under-gst-section-51-applicability-gstr7/) · [TDS/TCS changes from April 2026, new sections (ClearTax)](https://cleartax.in/s/tds-and-tcs-changes-from-april-2026) · [Old vs new TDS sections, Income Tax Act 2025 (Binary Semantics)](https://www.binarysemantics.com/blogs/tds-section-changes-old-vs-new-income-tax-act-2025/) · [TCS on mining and quarrying, 206C(1C)](https://incometaxmanagement.com/Pages/Tax-Ready-Reckoner/TCS/TCS-in-case-of-Parking-Lot-Toll-Plaza-Mining-Quarrying-Section-206C-1C.html) · [206AB/206CCA abolished (SAG Infotech)](https://blog.saginfotech.com/budget-2025-higher-tds-tcs-rates-non-filers-abolished-us-206ab-206cca)

**GTA and freight** — [GST on freight charges, RCM (Vakilsearch)](https://vakilsearch.com/article/gst-on-freight-charges/) · [GTA rates from September 2025 (ATMS Advisors)](https://atmsadvisors.com/how-gst-rate-changes-impact-goods-transport-agencies-gta-atms-advisors-insights/)

**Minerals and rates** — [TN seigniorage revision, ₹60 → ₹33/MT (Complinity)](https://complinity.com/legal-update/government-of-tamil-nadu-revises-the-rate-of-seigniorage-fee-for-rough-stones-18709/) · [TNMMCR amendment, 19 Jan 2026 (TeamLease RegTech)](https://www.teamleaseregtech.com/updates/article/52193/tamil-nadu-amendment-to-minor-mineral-concession-rules/) · [GST on mining royalties (TaxGuru)](https://taxguru.in/goods-and-service-tax/supreme-court-revives-gst-mining-royalties.html) · [Inverted duty refund (Taxmann)](https://www.taxmann.com/post/blog/inverted-duty-refund-under-gst-a-comprehensive-guide/) · [GST on sand and aggregates, HSN 2505/2517 (Busy)](https://busy.in/gst-rates/sand/)

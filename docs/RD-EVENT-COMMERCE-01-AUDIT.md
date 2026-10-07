# RD-EVENT-COMMERCE-01 — Event Commerce Architecture Audit & Plan

**Date:** 2026-09-28 · **Scope:** event creation/editing, licensing & capacity, optional services,
payments, communication wallet, revenue settlement, usage, event completion, refunds/credits.
**Status:** Phase A (audit) and Phase B (plan) complete. Phase C is split: the defect fixes in §9.1
that need no business decision are implemented; the prepaid-services / credit work in §9.2–9.5 is
**blocked on the decisions in §8**.

Method: five parallel read-only code traces (wizard, service billing, wallets/closure, capacity &
edit flows, legacy classification), then the critical defects were **reproduced against real
Firestore through the real route handlers** (emulator). File references are to the working tree.

---

## 0. Baseline facts that frame everything

* **The capacity model is not in production.** `HEAD` is `b7e5fdf` (2026-08-22). The entire
  capacity pay-as-you-go implementation (`lib/licensing/capacity*.ts`, `app/api/licensing/capacity/*`,
  the wizard capacity step, every licensing fix of 2026-09-23…25) is **uncommitted** (≈1,124 changed
  paths in the tree, much of it from other workstreams). Production still runs the **tier** model with
  **wallet-first** activation. "Legacy behaviour" for live events therefore means the committed code.
* **Unit baseline (2026-09-28):** 404 files, **11,018 passed, 5 failed, 1 skipped**. All five failures
  are in areas changed by a concurrent session on 2026-09-26/27 (Cashfree / refund-authority work):
  `analyticsFinancialTruth`, `analyticsUnavailable`, `emailProviderRouting`, `noAutomaticRefund`,
  `refundAuthorization`. Not touched by this task.

---

## 1. Current flows

### 1.1 Event creation (standard flow — 8 steps; event_plus_donation adds Fundraising = 9)

```
0 Event Type ─► 1 Visibility ─(first Firestore write)─► 2 Access ─► 3 Passes & Pricing* ─► 4 Form* ─► 5 Details*
      │                                                                   (*autosave)            │
      └ fundraising + donation_only ─► separate DonationCampaignWizard (campaignDrafts)          │
                                            [event_plus_donation] 6 Fundraising ◄────────────────┘
─► License (capacity; CapacitySelector) ─► Review
      Review = readiness + ReviewSummary + Fee collection + Communication toggles (WhatsApp/SMS/Certificates)
               + FinalCostSummary (activation quote) + agreement + ONE button:
      handlePayAndSubmit ─┬─ free  ─► PublishConfirmModal ─► POST /api/events/publish
                          └─ paid ─► POST /api/licensing/purchase ─► Razorpay ─► /checkout/confirm ─► /api/events/publish
```

* Steps 1–6 live in `components/event-builder/steps/Step{1..6}View.tsx`; License, Review, the donation
  wizard and the orchestrator live in `app/(dashboard)/dashboard/events/new/page.tsx`.
* Draft: deferred creation at Visibility, immediate/debounced write queue with retry + offline replay,
  single-slot crash snapshot (`rd_event_draft_snapshot`) with conflict prompt; `currentStep` is persisted
  **only on Continue**, and `completedValues` is **positional**.
* Event-type branching: 10 types; subtype configs drive pass templates, sport details, form templates
  and a 6th Details tab (conference, expo, sports variants, workshop, meetup variants, community,
  cultural, awards, fundraising; `custom` none).

### 1.2 Published-event editing

* Wizard re-entry (`/dashboard/events/new/visibility?draftId=`) → Review → **Save Changes** →
  `POST /api/organizer/events/[eventId]/save-changes`: copies the draft's `eventDetails`, `pricing`,
  `registrationForm`, `accessControl` onto `events/{slug}`. Only guard: pass quantity ≥ sold.
* `PATCH /api/organizer/events/[eventId]/edit` enforces `fieldClassification` (prices, tier, licence,
  slug are RESTRICTED) — **save-changes does not**.
* Capacity: Settings tab → `EventCapacityManager` → `/api/licensing/capacity/{quote,order,confirm}`.

### 1.3 Money paths

| Money | Payer → payee | Engine | Ledger / record |
|---|---|---|---|
| Activation (capacity) | organizer → platform, **Razorpay full amount** | `capacityPricing.ts` | `licenseOrders/lic_{draftId}` (+ `capacityChange` snapshot), `eventLicenses/{slug}`, `licenseHistory` |
| Capacity change | organizer → platform, Razorpay full amount | `capacityPricing.ts` | `licenseOrders/cap_{eventId}_{seq}` |
| WhatsApp (attendee confirmation, retry, certificate-ready, broadcast) | **communication wallet** debit | `communication.whatsapp.pricePaise` (default 50 p) | `walletTransactions/whatsapp_{regId}`, `cert_whatsapp_{certId}`, `broadcast_{campaignId}` |
| Certificates | communication wallet debit | `communication.certificates.pricePaise` (default 200 p) | `walletTransactions/certificate_{certId}` |
| SMS | none — **no transport** (route 501) | 25 p configured, unreachable | — |
| Media | separate **media-credit wallet** (Razorpay-bought credits), **disabled by default** | `mediaStudio.creditUnitPricePaise` 100 p "PLACEHOLDER" | `mediaCredit*` collections |
| Ticket revenue | attendee → organizer | `lib/fees/engine.ts` (platform fee + GST netted) | `platformTransactions/ptx_*` → `organizerRevenueWallets` |

---

## 2. Confirmed root cause — capacity increase

**Reproduced** (emulator, real handlers; event published as slug `tech-summit-…`, draft id `C01Draft…`,
enforced capacity 1,206):

| Call | Result |
|---|---|
| `POST /api/licensing/capacity/quote {eventId: <draftId>}` — what the Settings tab sends | **404 "Event not found."** |
| same with `<slug>` | 200 — correct delta quote (1206→2000: 794 × ₹1.50 = ₹1,191 + ₹214.38 GST) |
| `GET /api/organizer/events/<draftId>` — the capacity the tab is given | **`totalCapacity: null`** (enforced: 1,206) |

**D1 (Critical).** The organizer dashboard route param is the **draft id**; `SettingsTab.tsx:717` passes
it to `EventCapacityManager`; every capacity route and `capacityChange.ts:52-53` reads
`events/{eventId}` / `eventLicenses/{eventId}` directly (live docs are keyed by **slug**). ⇒ capacity
cannot be changed for any event whose slug ≠ draft id (i.e. essentially all). Tests hid it: the
emulator suite seeds `events/{EVENT}` with `draftId: EVENT`.

**D2 (High) — must ship with D1.** "Current capacity" comes from the draft-derived formula
(`app/api/organizer/events/[eventId]/route.ts:572-576`: free ⇒ `getFreeEventCapacity()`, paid ⇒ Σ pass
quantities or `null` if any pass is unlimited), not `events/{slug}.totalCapacity`. Once D1 is fixed this
would (a) label a server-priced **decrease** as "Increase capacity" and hide the not-a-refund warning,
(b) strand events with an unlimited pass ("nothing to change"), (c) never refresh after a purchase.

---

## 3. Defect register (severity-ordered)

| # | Sev | Defect | Evidence | Plan |
|---|---|---|---|---|
| D1 | **Critical** | Capacity manager uses draft id; all capacity routes 404 | §2 | **Fixed** (§9.1) |
| X1 | **High** | Legacy **tier purchase** still live: `/api/licensing/purchase` with `tier` and no `capacity` sells a tier; organizer can set `licenseTier` + delete `registrationCapacity` on its own draft (rules allow) ⇒ Enterprise ₹7,999 ⇒ **unlimited** capacity (vs ≈₹3.5 lakh at the 200,000 cap). E2E-03's "paid legacy licence" exception is therefore purchasable, not just historical | `purchase/route.ts:146-219`, `firestore.rules:396-402`, `publish/route.ts:142-163,358-361` | **Fixed** (§9.1) |
| D2 | High | Dashboard capacity ≠ enforced capacity | §2 | **Fixed** (§9.1) |
| D3 | High | Licence detail API throws `ReferenceError` on **every** request (TDZ: `isCapacityModel` used in a `.map` before its `const`) — reproduced | `organizer/licenses/[eventId]/route.ts:116,127` | **Fixed** |
| D4 | High | `getEventBySlug` backfill overwrites a numeric `totalCapacity` with 100/unlimited when `capacityPlan` is absent ⇒ a legacy event that buys capacity is still blocked at 100 by the gate/public page (transaction would allow it) | `lib/firebase/firestore/events.ts:63-68` | **Fixed** |
| D5 | High | Admin **grant / upgrade / downgrade / reissue** call `syncEventCapacity(tier limit)` and overwrite a **purchased** capacity (capacity licences are stamped `free` ⇒ reset to the free-tier limit) | `lib/admin/licenseAdminService.ts:509,596-600,623` | **Fixed** (skip for `commercialModel: 'capacity'`) |
| M1 | High | **Tier still gates a feature**: Media Studio photo cap resolves from licence tier; every capacity event is `free` ⇒ **50 photos** (below the 500 global default) | `lib/config/resolveMediaConfig.ts:54-107`, `businessConfig.ts:842-848` | **Fixed** (capacity licences resolve to the global layer) |
| S1 | High | Wizard promises "charged from **event settlement** … nothing upfront" for paid events — **no settlement deduction exists**; comms are wallet-only for all events; a paid event with an empty wallet silently skips WhatsApp and issues certificates **free** | `new/page.tsx:565-578,3104`, `FinalCostSummary.tsx:21,233`, `publish/route.ts:364-367` | Decision §8-D1 (copy is replaced by the prepaid model) |
| S2 | High | Broadcasts billed **upfront for recipientCount**, no true-up/refund for failed/undelivered/invalid recipients | `lib/communications/billing.ts`, `lib/broadcasts/*` | **Fixed (RD-INTEG, 2026-10-05)** — settled at campaign end: unaccepted recipients refunded / units released (`settleBroadcastBilling`) |
| S3 | Med | WhatsApp charged on Meta **accept**, copy says "per **delivered** message"; failed-delivery webhooks never reverse | `sendWhatsAppConfirmation.ts:218`, `whatsappStatus.ts` | **Decided: charge on accept** — a later failed-delivery webhook does not reverse (D3) |
| S4 | Med | Wallet-short sends absorbed by platform (debit silently skipped after pre-check); certificates issued unpaid when wallet short; `charged` result unread | `billing.ts:111-113`, `sendWhatsAppConfirmation.ts:108` | §9.3 (prepaid gate) |
| S5 | Med | Broadcasts ignore `whatsappEnabled`; certificates ignore `certEnabled`; WhatsApp ignores `billingMode/freeAllowance/walletBilling`; `dailyLimit/hourlyLimit/minimumRequiredBalance/frozen` never enforced on spend | billing audit | §9.3 |
| E1 | High | **save-changes bypasses RESTRICTED keys**: pushes pass **prices**, free↔paid `eventType`, fee model live | `save-changes/route.ts:145-152` | §9.4 (next batch; behaviour change needs sign-off §8-D7) |
| E2 | Med | Wizard License step editable after publish, silently ignored; Review shows activation fee/coupon on a published event | `new/page.tsx:4381-4400` | §9.2 |
| E3 | Med | `pending_review`/unpublished drafts show the *publish* flow ⇒ `LICENSE_ALREADY_EXISTS` 409 | publish route :512-517 | §9.2 |
| C1 | Med | Commercial terms not frozen per event at activation ⇒ a later global rate/free-allowance change reprices increases for already-activated events (path-independence breaks) | `resolveCommercialTerms.ts:5-6` vs publish | §9.4 |
| C2 | Med | Licence list / dashboard tile show tier limit (200) and **"Upgrade to Starter"** on capacity events | `organizer/dashboard/route.ts:1901-1941`, `LicenseTile.tsx`, `organizer/licenses/route.ts:113` | §9.4 |
| C3 | Med | Capacity routes have no server lifecycle check (UI-only), `events` permission can spend money, history records organizer not caller | capacity routes | §9.4 |
| C4 | Low | Stale capacity order whose refund failed can be applied later | `capacityChange.ts:410-416` | §9.4 |
| W1 | Med | License failed refunds written `status:'pending'`; admin queue shows/retries only `open` ⇒ invisible | `finalizeLicensePurchase.ts`, `capacityChange.ts`, `admin/failed-refunds` | §9.4 |
| W2 | Med | Revenue-wallet reconciliation sums wrong clawback field (`outstandingPaise` vs `outstandingAmountPaise`) and counts refunded registrations ⇒ false mismatches | `lib/reconciliation/wallets.ts:26-37` | out of scope (settlement); reported |
| W3 | Low | `license_refund` ledger type not in the union; UI renders it as a debit with no label; `adjustment` sign disagrees UI vs reports | `lib/wallet/types.ts`, `TransactionsClient.tsx:43` | §9.4 |
| L1 | Low | Lifecycle: `registration_closed → completed` not allowed; no auto-completion; no financial closure hook | `lifecycleStateMachine.ts` | §9.5 |
| F-* | Low | Wizard: Details step ungated; publish/purchase don't `flushNow()`; stale-flow render after type change; registry key mismatches; copy "goes live immediately" vs default manual approval | wizard audit F1,F8,F10,F13,F14 | §9.2 |

---

## 4. Wallets and ledgers

```
 (A) organizerWallets/{uid}  { balancePaise }  ── ONE bucket; walletTransactions (type-signed, amount always +)
      debited by: WhatsApp confirm/retry/cert-ready, broadcasts, certificates
      credited by: Razorpay top-up (+ webhook + 10-min reconciliation), admin legacy-licence refund
 (B) organizerRevenueWallets/{uid} pending → available(T+48h, daily cron) → inTransit → settled
      credited by ticket/donation net; debited by refunds/disputes; clawbacks on shortfall
 (C) mediaCreditWallets/{uid}  integer CREDITS, lots/reservations/sessions/refunds (disabled by default)
 Licensing: Razorpay only — touches none of A/B/C (RD-LICENSE-PAYMENT-01, enforced by tests)
```

**Can the communication wallet host service credits?** **No.** It is a single `balancePaise` that every
comms debit reads and blindly decrements; health checks, reminders, top-up max-balance, the deletion
guard and reports all treat it as prepaid cash. Credits placed there would be spent on WhatsApp
immediately and become indistinguishable. A service-credit balance must be a **separate ledger**
(modelled on media-credits: wallet cache + append-only signed ledger + deterministic ids + optional
lots + report-only reconciler), surfaced as its own labelled balance category.

---

## 5. Optional-service billing today (per service)

| Service | Rate (default) | Charged when | From | Idempotency | Exhaustion |
|---|---|---|---|---|---|
| WhatsApp confirmation | 50 p (`communication.whatsapp.pricePaise`) | after Meta accepts | comm wallet | `whatsapp_{regId}` (retry shares id) | pre-check skips send; in-txn short ⇒ platform absorbs |
| WhatsApp certificate-ready | 50 p | after send | comm wallet | `cert_whatsapp_{certId}` | platform absorbs |
| WhatsApp broadcast | 50 p × recipientCount | **upfront** at start | comm wallet | `broadcast_{campaignId}` + status guard | blocked (campaign failed) |
| Certificate | 200 p | on create (not regenerate) | comm wallet | `certificate_{certId}` (random id; delete+reissue re-bills) | **issued free** |
| SMS | 25 p | never (no transport) | — | — | — |
| Media | 100 p/credit placeholder, **disabled** | session settlement | media-credit wallet | deterministic ledger ids | 402 at session open |
| Email / organizer WhatsApp | free | — | — | — | — |

Usage records: `communicationUsage` (over-reports: written even when the debit was skipped),
`emailLogs.costPaise` (records price regardless of debit), `certificateIssuanceLedger` (only when a free
allowance is configured). **Delivery status and financial status are not linked by any field** — only
the presence of a `walletTransactions` doc proves a debit.

---

## 6. Legacy / duplicate commercial code (classification)

| Group | Class | Note |
|---|---|---|
| V1/V2 tier catalogs (`eventLicense.ts`, `resolveCatalog.ts`, `licenseCatalogShared.ts`) | 2+3, partly 1 | still read by publish legacy gate, purchase/confirm tier path, webhook, admin actions, displays |
| Tier purchase path (`purchase` without capacity) | **1 → closed** (X1) | no UI caller; exploitable |
| `publishValidation` Starter one-active-event rule (publish :241-277) | 5 (unreachable since E2E-03) | left in place; removal candidate after X1 |
| `useLicenseCatalog*`, `useCurrentLicenseCatalogView`, `buildLicenseCatalogView`, `buildCurrentLicenseCatalogView` | 5 (test-only) | removal candidates |
| `getEffectivePurchasableTiers`, `/api/licensing/verify`, `lib/licensing/service.ts` upgrade methods, `lib/billing/feeEngine.ts licenseTierToFeeTier`, `lib/events/completeCommunicationPayment.ts`, `lib/communications/pricing.ts COMM_PRICING` (only a fallback), `suggestedPrice` pass templates | 5 | removal candidates (§10) |
| `workspaceEntitlements requireFeature/requireLimit` | 5 | guarded by `capacityFeatureGatesRemoved.test.ts` |
| `CAPACITY_PLANS` / `capacityPlan` | 3 | fallback when `totalCapacity` absent; keep |
| Media tier caps (`mediaStudio.tierLimits`) | **1 — a live tier gate** (M1) | capacity licences now resolve to global |
| Admin tier Upgrade/Downgrade/Grant/Reissue, V2 tier price editor | 1 (admin) | D5 guarded; UI still offers tier actions — §9.4 |
| Dashboard LicenseTile / licence detail upgrade CTAs, media "Upgrade your licence" copy | 1 (UI selling tiers) | §9.4 |
| `lib/platform/pricing/*` licensing layer, pricing-override routes | 6 / dormant (`pricingEngineEnabled` off) | keep; no client callers |
| Wallet-first licensing remnants (`walletTransactions/license_*` reads/refunds) | 2/3 | historical; keep |
| `orderIntegration.ts` writes a V1 `starter` licence block into every order snapshot | 2 (stale data in audit records) | report only |

---

## 7. Recommended target flow

```
Event Details (Type · Visibility · Details)  →  Registration Setup (Access · Passes · Form [· Fundraising])
 →  Activation & Services (capacity + WhatsApp / Certificates / Media allowances; SMS "Unavailable now")
 →  Review (read-only; explicit loading/error states; no entitlement created)
 →  Payment (server-authoritative itemised order; ONE Razorpay order for activation + add-ons)
 →  Submit (existing lifecycle: pending_review or published per publishing mode)
Dashboard: "Manage Capacity & Services" — current / used / remaining / add-more, one combined order.
```

Constraints from the code: draft creation is tied to the Visibility index; Form needs passes; Details
needs type/subtype; Fundraising needs Details' end date; `currentStep` and `completedValues` are
**positional and persisted** — reordering needs a step-id migration for existing drafts; step indices
are hard-coded in `publishRequirements.ts`, `buildReadinessReport`, `Step3View`, tests.

---

## 8. Decisions required (no code path may guess these)

| # | Decision | Why it cannot be derived | Blocks |
|---|---|---|---|
| **D1** | **Prepaid unit rates** for WhatsApp / certificates: reuse the existing per-use rates (50 p / 200 p) or set separate prepaid rates? | Existing rates are pay-as-you-use wallet rates, never sold as allowances | §9.3 |
| **D2** | **GST on service allowances**: activation adds 18% GST; comm-wallet charges carry **no GST** today. Are prepaid allowances GST-exclusive (+18%) like activation? | No GST exists on comm charges | §9.3, §9.5 |
| **D3** | **Consumption point**: debit on provider *accept* (today) or *delivery*? Failed/undelivered broadcast recipients — returned to allowance? | **DECIDED 2026-10-05 (product owner): charge on Meta accept** for every WhatsApp path. A broadcast is paid upfront and settled when it ends: money / prepaid units for every recipient Meta never accepted (invalid phone, rejected, timed out, cancelled, unsent) are returned. An accepted message stays charged even if a later webhook reports it failed. Implemented in RD-INTEG (`lib/communications/billing.ts` settleBroadcastBilling + `lib/broadcasts/settlementSweep.ts`). | §9.3 |
| **D4** | **Exhaustion policy**: block with message, or allow an explicit top-up/overage purchase? Fallback to comm wallet for new events? | Must not permit uncontrolled unpaid usage | §9.3 |
| **D5** | **Media allowance**: unit (photos vs GB), rate, and relation to the existing (disabled) media-credit system | Only a 100 p "PLACEHOLDER" per photo credit exists | §9.3 |
| **D6** | **Unused-allowance credit policy**: eligible services, % credited, GST treatment (credit note?), coupon/discount allocation, expiry, eligibility trigger (manual Complete only exists; no auto-completion) | No credit-note, GST-reversal or closure concept exists | §9.5 |
| **D7** | **Edits after publish**: should save-changes be allowed to change pass prices / free↔paid on a live event? (Today it silently can; `/edit` forbids it.) | Product rule, affects live events | E1 |
| **D8** | **Legacy events**: keep existing wallet pay-as-you-use billing for events published before the prepaid model (recommended), versioned by `commercialModelVersion` | Silent migration is forbidden | §9.3 |
| **D9** | **Wizard restructure**: approve re-ordering into the 6 logical stages with a step-id migration for in-flight drafts | Changes persisted draft semantics | §9.2 |

---

## 9. Implementation plan (Phase B)

### 9.1 Done now — defect fixes needing no business decision
D1+D2 (together), X1, D3, D4, D5, M1. File-by-file in the final report of this task. Each has a
regression test that fails on the old code.

### 9.2 Wizard (after D9)
Introduce step **ids** as the persisted position (keep index for old drafts via a read-time map);
extract fee-collection + communication toggles from `Step7View` into an **Activation & Services** step
next to License; split Review (read-only) from a new **Payment** step that owns `handlePayAndSubmit`;
lock License/Services on published drafts (route to Manage Capacity & Services); fix F1/F8/F10/F13/F14/E2/E3.

### 9.3 Prepaid service entitlements (after D1–D5, D8)
`eventEntitlements/{slug}__{service}` with purchased/used/remaining, unit snapshot, order ref, status;
`entitlementUsage/{service}_{logicalId}` deterministic consumption records inside the existing send
transactions (`sendWhatsAppConfirmation`, `whatsappRetry`, `certificates/billing`, `certificates/whatsapp`,
broadcasts); `commercialModelVersion` on events so legacy events keep wallet billing; combined order =
extend `licenseOrders` with `lineItems[]` (activation + add-ons) reusing purchase/confirm/webhook.

### 9.4 Manage Capacity & Services + hardening
Unified dashboard panel (reusing CapacitySelector + new service rows), freeze commercial terms per event
at activation (C1), server lifecycle check + `transactions` permission on capacity spend (C3), C4, W1, W3,
C2 display fixes, admin tier actions hidden/blocked for capacity licences, E1 per D7.

### 9.5 Closure & credits (foundation only until D6)
Separate `serviceCreditWallets` + `serviceCreditLedger` (report-only reconciler), a post-commit
closure hook on `complete`, and a **dry-run** credit calculator that records what *would* be credited
from immutable purchase snapshots — **no automatic credit until D6 is approved**.

> **D6 decided (2026-10-01)** — implemented as organizer *requests* decided by a Super Admin
> (`lib/wallet/serviceRequestRules.ts`, `lib/wallet/serviceRequests.ts`); still **no automatic credit or refund**.
> - Eligible: completed, archived or cancelled events; unused WhatsApp messages and certificates only.
>   Registration capacity and extra-photo allowance are not refundable.
> - Amount: verified unused units × the original paid service line incl. GST, capped at the verified
>   refundable amount; the Super Admin approves the amount within the cap.
> - **Coupons — Option A:** a licence coupon applies to the activation fee only; service lines are
>   charged at full price, so refunds use the line's verified paid total. An activation discount is
>   never allocated across service lines.
> - Window: a refund request must be submitted within 24 HOURS of the event's closure (changed from 30 days on 2026-10-06; at or after closure + 24 h it is refused)
>   (checked at submission, not at approval).
> - Approval moves no money; a refund is marked refunded only with the external refund reference.
> - Carry-forward: Super Admin approval, to an eligible event of the same organizer; units, never money.
>
> **Event-wise Wallet (2026-10-02)** — extends the above to every event service (`lib/wallet/serviceRequestRules.ts`):
> - **Registration capacity** — refund only: paid capacity units above the free allowance and above
>   registrations taken, valued from the capacity orders' snapshots (an activation coupon reduced exactly
>   that part — the lot is what was collected). Approval lowers `events/{slug}.totalCapacity` (and the
>   licence mirror) by the refunded units. Never carried forward.
> - **Event photos** — every new media purchase line records the base photo limit it sits on
>   (`baseCapAtPurchase`); used = photos stored above that base. Lines bought before 2026-10-02 have no
>   such record → "requires Super Admin review", no calculated amount. Refund + carry-forward (the upload
>   gate honours carried / refunded units). Organizer-wide media credits are a separate entitlement.
> - **Valuation** — usage consumes the OLDEST purchase lines first; units that left (refunds,
>   carry-forwards, capacity reductions) leave from the NEWEST end; each unused unit is valued at its own
>   line's paid total (incl. GST), floor-rounded per line, so partial refunds never exceed a line.
> - "Refund all" submits one request per eligible service in one transaction (a shared group id).
> - Every verified purchase notifies the organizer (email), the support inbox (email) and the Super Admin
>   in-dashboard feed — exactly once per order (`purchaseNotifications/{orderId}` claim).

### Rollback
Every §9.1 change is local and reversible; no data migration; no rules change; historical records untouched.

---

## 10. Removal ledger (proposed — nothing removed yet)
Candidates proven dead in §6 are **not removed in this batch**: removal is Phase D and happens only after
the replacement flows land and their tests pass. Each will be listed with importer evidence and the test
that proves its replacement.

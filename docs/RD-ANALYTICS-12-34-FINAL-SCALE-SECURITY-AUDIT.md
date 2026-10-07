# RD-ANALYTICS-12-34 — FINAL ANALYTICS SCALE + SECURITY AUDIT

**Type:** AUDIT ONLY — final system-level audit of RegisterDesk Analytics. No source, test, rules, index, schema, API, permission, calculation, cache, UI, navigation or Reports change. Nothing committed, pushed or deployed.
**Date:** 2026-09-12
**Baseline audited:** HEAD `b7e5fdf`, 0 staged, 833 worktree entries (`$TEMP/rd1234-baseline.txt`): 345 `M`, 383 `??`, 105 other (deletions/renames from concurrent workstreams). The Analytics tree is unchanged since RD-12-33 closed (newest analytics file 2026-09-11 23:14; the 12-33 report was written at 23:51). Concurrently modified files audited read-only: `app/(dashboard)/dashboard/analytics/page.tsx` (8 Sep 15:54), `config/workspaceNav.ts` (8 Sep 18:22), `lib/reports/builders.ts` (7 Sep 11:39), `app/(dashboard)/dashboard/reports/page.tsx` (11 Sep 11:40). `firestore.rules` (3 Sep) / `firestore.indexes.json` (8 Sep) untouched.

---

## 1. Executive summary

The Analytics workspace is one architecture end to end: two organizer routes (`/api/organizer/analytics/overview/[eventId]` for the seven module pages; the older `/api/organizer/analytics/[eventId]` for the legacy landing and its exports) share one authorization order (authenticate → workspace + gate-role exclusion → one `events/{slug}` read → `organizerUid === workspaceUid` → `transactions` decides money), one producer (`getEventAnalytics`), one set of canonical readers (status/payment/source `count()` aggregates, the registration counter, IST daily rollups, `sumConfirmedRevenueFromLedgerChecked`, `readRefundSource`, `count()`/`sum()` communication aggregates), one pure normaliser, one pure comparison, one pure Insights engine, and one shell. No module bypasses it; no registration document is ever read; no cache exists; no PII leaves the server.

Cross-workspace isolation, the financial boundary and the 20,000-registration path were **re-verified today** on the live emulator (60/60 emulator tests: workspace A/B isolation, gate-role refusal, manager receives no money key, 20k exactness, ledger bound, comms and participants at 20.5k rows) and by 792 analytics unit tests. `tsc` is clean.

**No P0 and no P1 finding.** Six P2 conditions remain, all already documented by earlier phases or by this audit as integration/terminology/legacy items: the legacy landing (U-1) is still the sidebar target and still carries its own event picker and exports; that legacy export's per-pass "Revenue" column can print ₹0 where the figure is withheld (the only false-zero left, on a legacy export path); a module the strip does not offer still renders on a direct URL; the SES/Resend webhook's recipient-email fallback is unfiltered (F-2); Reports still labels an accepted count "Delivered" (F-5); and Analytics spend and the wallet ledger measure different things (F-3, labelled). None is a security or data-integrity blocker for the canonical module pages.

## 2. Final verdict

**FINAL ANALYTICS VERDICT: PRODUCTION READY WITH NON-BLOCKING CONDITIONS** — see §31–32.

## 3. P0 findings

None.

## 4. P1 findings

None.

## 5. P2 findings

| ID | Where | Behaviour | Roles | Why not P1 |
|---|---|---|---|---|
| **P2-1 · U-1 legacy landing** | `config/workspaceNav.ts:195` → `/dashboard/analytics`; `app/(dashboard)/dashboard/analytics/page.tsx` (concurrent `M`) | The sidebar row still lands on the legacy page: it loads its own event list from `/api/organizer/licenses` (first licence auto-selected — not the shared selector), owns CSV/XLSX/PDF exports, reads the legacy `EventAnalytics` shape, and mounts `AnalyticsModuleNav` outside `AnalyticsScopeProvider` so the strip is un-gated there (a manager sees a Revenue link that the module page then refuses correctly). | all non-gate | Authorization is identical on both routes; nothing leaks. It is an IA/integration condition blocked on concurrent work (12-33 C-3). |
| **P2-2 · legacy export per-pass false zero** | `app/api/organizer/analytics/[eventId]/route.ts:141,145` | `passRevenue` is `[]` (truthy) when `limits.passValue` is false (pass-value budget of 60 aggregates exceeded — > 30 passes — or the aggregate failed), so the Pass-sales table exports a "Revenue" column of `0` for every pass. Also, `passSales` and `passRevenue` are each sliced to their own top 8, so a pass in the top 8 by count but not by value exports `0`. | owner, finance (only they receive `passRevenue`) | Legacy export reachable only from the legacy landing; the Financial summary rows in the same file are correct (`moneyRow` omits unavailable); the canonical Revenue module renders no row and notes "per-pass revenue is incomplete". Fix belongs with U-1 (exports move to Reports). |
| **P2-3 · direct URL to an un-offered module** | module components (`OperationsAnalytics`, `CommunicationsAnalytics`, `RegistrationsAnalytics`, `ParticipantsAnalytics`) | The strip filters on `capabilities.modules` (12-33 U-6), but the module page itself renders from payload presence, so e.g. finance at `/dashboard/analytics/communications` sees the Communications panel. | finance/admin/manager | Not a leak: every non-financial section is authorized by workspace membership (the same payload the Overview shows); only `revenue` is stripped by `transactions`, and the Revenue module has its own denied state. IA consistency only. |
| **P2-4 · F-2 webhook fallback** | `app/api/webhooks/ses/route.ts:113-119` (Resend equivalent) | When `providerMessageId` does not match, up to 5 recipient addresses are matched by `recipientEmail` alone — no organizer/event/date filter, `LOG_QUERY_LIMIT` rows each — so a verdict can be written onto another event's (or workspace's) log rows for the same address. Analytics `delivered`/`bounces`/`complaints` inherit whatever was written. | affects data provenance, not access | Signature-verified webhook; bounded; only on the fallback path; the screen says "as recorded by the provider". Hardening item. |
| **P2-5 · F-5 Reports "Delivered"** | `lib/reports/builders.ts:484,498,506` (concurrent rework) | Broadcast Usage exports `successCount` under the label "Delivered" / "Total Delivered"; the source establishes *accepted*, not provider-confirmed delivery. Analytics uses "Delivered" only for provider confirmation. | owner/finance (Reports) | Terminology in a Reports document; Analytics is not contradicted on screen, but the two surfaces disagree on a word. Blocked on the concurrent Reports rework. |
| **P2-6 · unoffered-module notice text** | `CommunicationsAnalytics.tsx:541-543`, `AnalyticsOverview.tsx:401` | For a caller *without* `transactions`, the emailLogs spend-fallback page is still read (see P3-1); when that page overflows (> 5,000 messages) `limits.communications` goes false and the UI tells an admin/manager "the spend fallback page exceeded its read limit" and "communication activity is incomplete" — although every count they see is an exact aggregate. | admin, manager on large events | Misleading caption, not a wrong number. |

## 6. P3 findings

| ID | Where | Note |
|---|---|---|
| P3-1 | `eventAnalytics.ts:1010-1014` | The `emailLogs` `limit(5001)` page is read for every caller whose `sum('costPaise')` was **not attempted** (no `transactions`): up to 5,001 documents per admin/manager request whose only effect is `limits.communications`. 12-32 F-4 skipped it only when the aggregate answered. Cost, not correctness. |
| P3-2 | `revenueIntelligence.ts:88-90` | AOV with zero paid registrations is `gone('query_failed')` on the wire; `denominator: 0` lets the UI say "No paid registrations yet" (12-33 U-2), but an export/consumer reading `reason` alone would call it a read failure. Contract wording. |
| P3-3 | `normalize.ts:422` `normalizeDashboardAnalytics` | Second adapter with no consumer outside `tests/unit/analyticsNormalize.test.ts`; its `DashboardAnalyticsSource.events[].revenuePaise` is the only remaining `revenuePaise` in the Analytics contract surface. Dead, not dangerous. |
| P3-4 | `app/(dashboard)/dashboard/reports/page.tsx`, `lib/navigation/breadcrumbs.ts:196` | The old Event Insights page (`ANALYTICS_ROUTE_CURRENT = '/dashboard/reports'`) still resolves, is unlinked from the sidebar, breadcrumbs as "Analytics", and reads the canonical dashboard endpoint (`confirmedRevenuePaise` + `revenueUnavailable`). Migration step 2 (`routes.ts`) not executed. |
| P3-5 | Reports vs Analytics day bounds | Reports uses inclusive **UTC** day bounds (`lib/reports/format.ts:23`); Analytics uses **IST** (`REPORTING_TZ_OFFSET_MINUTES = 330`). Documented divergence; no contract says they share semantics. |
| P3-6 | F-6 / F-7 / F-9 | Organizer-directed WhatsApp alerts share the event bucket (screen says "including alerts sent to you"); windowed `unknown` is not available (no `deliveryUnknown`+`createdAt` composite, not estimated); reminder recipient sum withheld above 500 reminders and certificate downloads withheld above 5,000 certificates — all disclosed through `limits`. |
| P3-7 | `insightsRules.ts:229` | `capacity_exceeded` summary prints `remaining ?? 0` — reachable only if `capacity.over` is true while `remaining` is null, which the normaliser cannot produce (both derive from the same two counts). |
| P3-8 | `eventAnalytics.ts:946`, `:1084` | Ledger figures (gross collected, fees, net settlement) become `out_of_budget` above 5,000 `platformTransactions`; certificate downloads above 5,000 certificates. Honest and disclosed (`limits.ledger`, `limits.certificates`), but a 50k–100k paid event will show "—" for gateway figures in Analytics (Reports carry them through their own path). |
| P3-9 | `lib/finance/financeAnalytics.ts:689-691` (outside Analytics) | The Finance control-centre ledger trend fills a failed bucket sum with `?? 0`. Not an Analytics path; recorded because the brief asked for adjacent false-zero patterns. Do not weaken dashboard behaviour to fix. |

## 7. Architecture audit

Request path, verified layer by layer:

| Layer | Implementation | Consistent |
|---|---|---|
| UI | 7 module pages under `AnalyticsScopeProvider` → `useStandaloneAnalyticsScope` → **one** fetch of `/api/organizer/analytics/overview/{slug}?preset=` per page; strip reads the same response via context | ✓ |
| Route | `overview/[eventId]/route.ts`: `authorizeAnyWorkspace` → `resolveAnalyticsEventIdentity` (1 doc) → `organizerUid === workspaceUid` && `requireEventScope` → `financeAllowed = permissions.includes('transactions')` → `normalizeRange` → `getEventAnalytics(…, eventDocument)` → `getFeatureFlags` → `normalizeEventAnalytics` → `Cache-Control: no-store` | ✓ |
| Authorization | `authorizeAnyWorkspace` (verify token, single active membership → workspace; owner wins; `isCheckinOnlyRole` derived from `ROLE_PERMISSIONS`) | ✓ |
| Event/workspace identity | `events/{slug}.uid` (or `organizerUid`) compared to the caller's `workspaceUid`; one 403 text for foreign/unknown/unassigned | ✓ |
| Capability resolution | `availableAnalyticsModules(ctx)` over `ITEM_GATES` (workspace flags + caller permission), `financeAllowed`, `hasParticipantData`, `identifiersEnabled`/`timingEnabled` from `identifierConfigs/{slug}` | ✓ |
| Financial boundary | `includeFinancial` decided before the producer runs; every money read is `includeFinancial ? … : null`; `revenue` key never written without it | ✓ |
| Producer | `getEventAnalytics` — aggregates, counter, rollups, canonical finance readers, bounded pages (§24) | ✓ |
| Normalisation | `normalizeEventAnalytics` pure; no `?? 0` on any measured figure (§26) | ✓ |
| Comparison | `previousPeriod` / `compareMetric` / `computeDelta` (zero baseline → `pct: null`) | ✓ |
| Intelligence | `revenueIntelligence`, `communicationIntelligence`, `participantsModel` — pure derivations over the producer's figures | ✓ |
| Insights | `buildInsights(response)` pure (§18) | ✓ |
| Presentation | models (`revenueModel`, `operationsModel`, …) + components; every ratio null-guarded | ✓ |

No duplicate reader, no raw registration scan, no per-registration computation, no independent revenue or refund calculation: confirmed revenue is `sumConfirmedRevenueFromLedgerChecked` (the Dashboard/Events/Finance helper); refunds are `readRefundSource` → `listOrganizerRefunds` (the Reports reader); registration counts are `aggregateRegistrationStatusCounts` (the registrations list/attendance helper); payment split is `getRegistrationSplit` (the Finance helper). Timezone is one helper family (`dayKey`/`dayKeyRange`/`istRangeBounds`, §13). Stale implementations that still exist are catalogued in §29 and are all legacy surfaces, not alternative engines.

## 8. Scale audit

| Case | Behaviour | Basis |
|---|---|---|
| 0 registrations | every count a measured `0` from aggregates; series zero-filled inside coverage; ratios `null` (denominator 0); AOV `denominator: 0`; attendance "Not started" | tests `analyticsUnavailable`, `analyticsPremiumUx` |
| 1 registration | exact; comparisons refused below floors in Insights | unit |
| 20,000 registrations | exact status/payment/check-in/per-pass counts; rows at 5,001/9,999/19,999 inside totals; no foreign leakage; `limits.registrations: true` | **re-run today**: `analyticsScale.emu.test.ts` 11/11 |
| historical event (rollups start after registrations) | `coverageSince` clips series; `coveragePartial`; baseline refused `outside_coverage` | producer + unit |
| 90-day range | ≤ 90 + 90 rollup documents by `getAll`; `MAX_RANGE_DAYS = 90` clamps custom ranges | `dateRange.ts` |
| 7-day range / no-data window | period totals 0 from present-but-empty rollups; absent rows are genuinely quiet days | producer comment + rollup writer contract |
| high refund volume | one acquisition, cap 1,000 (+ ≤ 50 unattributed); above cap: exact count, amount `out_of_budget` | `registrationRefunds.ts:149-152`, `revenueLedgerBound.emu` |
| high communication volume | 47 `count()` aggregates, volume-independent; proven at 20,500 rows | `communicationsScale.emu`, `communicationIntelligence.emu` (today) |
| high certificate/reminder volume | status/issued via aggregates; recipient sum (501) and downloads (5,001) withheld above bound with `limits` | producer |

Confirmed absent: any `.limit(5000)`/`.limit(5001)` on `registrations` (the only 5,001 pages are `platformTransactions`, `emailLogs` fallback, `certificates`; `.limit(5000)` hits are sitemap, exhibition and nominations exports — not Analytics); any `.get()` of a registrations collection; any registration-sized client payload (payload is counts, ≤ 8-row lists, ≤ 90-point series, ≤ 6 insights); any per-registration computation; any O(N registrations) path; any repeated canonical read after 12-32.

**Beyond 20k:** registration-scaled cost is zero documents at any N (aggregates + counter + rollups). What grows is the number of *paid transactions* (ledger page → `out_of_budget` above 5,000, disclosed), *messages* (fallback page → withheld above 5,000, counts unaffected) and *certificates* (downloads withheld above 5,000). Architecture supports 50k and 100k registrations; **50k/100k were not benchmarked and no figure is claimed.**

## 9. Request amplification audit (post 12-32)

- **A. Refunds:** `readRefundSource` acquired **once** per request (`eventAnalytics.ts:857`); lifetime, window and baseline are `refundTotalsFromRead` derivations over that read; unit `analyticsRequestDedup` (17) and emulator `revenueLedgerBound` confirm. No re-introduction.
- **B. Event identity:** both organizer routes pass `eventDocument: identity.document`; the producer reads `events/{slug}` only when no document is handed over (admin route/export callers). One read per request.
- **C. Spend:** `sum('costPaise')` first; the page is read only when the sum did not answer. **Residual (P3-1):** "did not answer" includes "was not attempted", so callers without `transactions` still pay the ≤ 5,001-document page for a flag.
- **D. Insights:** `insightsRules.ts` imports only `lib/dashboard/insights` (a constant), `routes`, `dateRange`, `communicationsModel` and types — no `firebase`, `adminDb`, `fetch(`, `Date.now`, `new Date`, `Math.random`, `process.env` (grep today: 0 hits; `insightsEngine.test.ts` pins it).

Remaining bounded pages per request (worst case, owner): `platformTransactions` ≤ 5,001, `certificates` ≤ 5,001, `scheduledReminders` ≤ 501, refunds ≤ 1,050 (+ ≤ 50 point gets), coupons subcollection (organizer-authored, small), `emailLogs` ≤ 5,001 only if the spend sum failed. Aggregates ≈ 7 + 8 + 12 + 47 + ≤ 6 + 1 + 1 + 2 + 1 + ≤ 60 (pass value) ≈ 145, all parallelised in five `Promise.all` waves.

## 10. Security / workspace isolation

Verified today on the emulator (`organizerAnalyticsAuthz.emu.test.ts`, 13/13): owner A, finance A, manager A reach event A; **no workspace-A role reads workspace B's event; B's owner reads B not A; a non-existent event answers exactly as a foreign one** (same 403 body); gate roles (`checkin_staff`, `checkin_lead`) refused before any read; unauthenticated refused; finance can list only A's events. Code: the boundary is `identity.organizerUid !== authz.workspaceUid` on both routes; slugs/ids cannot bypass it because the owning uid is read from the event document itself, never from the request. Direct URLs cannot cross workspaces on the client either: `useStandaloneAnalyticsScope` fetches only for `selectedEvent.slug` from the authorized event list, so an unknown/foreign `?eventId=` issues **no** API call and renders the non-leaky `urlEventMissing` state. Unauthorized financial reads are never issued (every money reader is behind `includeFinancial`; `analyticsFinancialTruth`/`organizerRevenueBoundary` pin zero financial reads for a denied caller). `requireEventScope` is retained though it refuses no current non-gate role (documented).

## 11. Financial security

Canonical confirmed ticket revenue remains Σ `amount` (post-coupon ticket base, pre-deduction) over `status == 'confirmed'`, refund-stable (RD-12-26), via `sumConfirmedRevenueFromLedgerChecked`. Audit of every money field on the wire (`RevenueAnalytics`): `confirmedRevenue` (canonical), `netRevenue` (confirmed − completed refunds, both `ok` or `gone`), `grossCollected`/`platformFee`/`gst`/`gatewayFee`/`netSettlement` (ledger, `ledgerMoney`: `out_of_budget` over cap, `query_failed` on throw, measured 0 on an empty successful read), `refunds` (+ `refundCount`), `communicationCost` (sum → complete page → `gone`), `profitEstimate` (all three inputs `ok` or `gone`), `intelligence.velocity` (period revenue ÷ window days), `averageOrderValue` (confirmed ÷ paid; `denominator` carried), `refundRate` (null on zero revenue), `refundsInPeriod` (windowed by refund `createdAt` in IST; baseline refused `outside_coverage`), `beforeDiscount` (discount unavailability flows through — 12-26 F-1). Coupon performance is a `sum('discountAmount')` aggregate + the coupons subcollection.

Searches: `estimatedRevenue` — **0 hits** in app/lib/components/features. DashboardEvent `revenuePaise` alias — **removed** (`app/api/organizer/dashboard/route.ts:1468` records the removal; the wire field is `confirmedRevenuePaise` + `revenueUnavailable`). Other `revenuePaise` spellings (rollup day revenue in `dailyStats`, Analytics period revenue, Admin licence income in `organizer360`/`platformMonitor`, `registrationCounters.revenuePaise` behind `RevenueState`) are distinct quantities and are never fed into the ticket-revenue figure. `MaybeMoney` (`{ok:true,paise}|{ok:false,reason}`) is the only money type on the Analytics wire; `RevenueState` (`lib/finance/revenueState.ts`) governs the Dashboard/Events wire. `?? 0` on money in the Analytics path: none that converts unavailable into measured (§26); the one financial false zero left is the legacy export column (P2-2).

Locked Dashboard wire behaviour re-confirmed unchanged: authorized+measured → number; authorized+unavailable → `0` + `revenueUnavailable: true`; unauthorized → `confirmedRevenuePaise: null`. Analytics wire: unauthorized → `revenue` key **absent**, `financialAllowed: false`.

## 12. Absence / zero / unknown semantics

| State | Representation | Verified example |
|---|---|---|
| measured zero | `0` / `money(0)` | empty successful ledger read → `grossCollected` ₹0 |
| unavailable | `null` / `gone('query_failed')` | failed status aggregate → `registrations: null`; funnel step omitted |
| unauthorized | key absent (`revenue`), `financialAllowed:false`; Revenue module denied state | manager payload has no money field (emu test 9) |
| unsupported capability | module absent from `capabilities.modules`; panel absent (`identifiers?`, `timing?`); channel `not_implemented` (SMS/Push) | finance strip = Insights/Overview/Revenue/Participants |
| insufficient denominator | AOV `denominator: 0` → "No paid registrations yet"; every `rate/share` returns `null` on `total <= 0` | `a28-intel` (12-33 QA) |
| not started | `checkedIn === 0` with `pct` measured → "Not started" | Operations (12-33 QA) |
| outside coverage | `coverageSince` clip, `coveragePartial`, baseline `unavailable: 'outside_coverage'` | producer + unit |

Communications: `unknown` (transport timeout, `deliveryUnknown`) is never folded into `failed`; windowed "Not delivered" is labelled as raw and explained. Comparisons: `baseline === null` → `delta: null` with a reason; `computeDelta` with `previous <= 0` → `pct: null` (never Infinity). No `Infinity`/`NaN` can reach the UI: every division in the models is guarded (`operationsModel.rate`, `registrationsModel.share`, `participantsModel.share`, `communicationsModel.deliveryRate/unconfirmedShare`, `revenueIntelligence.refundRate/velocity`); date parsing guards `Number.isFinite`.

## 13. Timezone audit

One fixed-offset model (`REPORTING_TZ_OFFSET_MINUTES = 330`, no ICU dependence): `dayKey` shifts the instant by +05:30 and reads UTC fields; `dayKeyRange` walks back in 86,400 s steps from an instant; `rangeDayKeys` converts a day key back to an IST-midnight instant before walking; `istRangeBounds` produces `[from 00:00:00.000 IST, to 23:59:59.999 IST]` and every windowed query uses `>= from` / `<= to`. Daily statistics and revenue windows are the rollup rows keyed by IST day; refunds, campaigns and communications windows use `istRangeBounds`; check-in arrivals per day come from the same rollups; comparison periods are day-key arithmetic in UTC-midnight space (safe because keys are calendar days). 23:45 UTC → next IST day is pinned (`communicationIntelligence.test.ts` 27). Reports keep inclusive UTC day bounds (`rangeBounds`) — a separate historical contract, not a defect (P3-5). No server-local-timezone `Date` operation was found in `lib/analytics`.

## 14. Comparison audit

7d/30d/90d presets and custom ranges (≤ 90 days) all derive `previousPeriod` of equal length ending the day before `from`. Compared metrics are **period** totals (registrations, check-ins, period revenue) against the preceding period — never lifetime against a window (`normalize.ts:335-343` states and enforces it; Overview captions say "All time" on lifetime figures since 12-33). Coverage floor: a baseline window starting before `coverageSince` is refused (`baselineOutsideCoverage`), and the communications baseline is refused when it ends before `publishedAt`. Zero baseline → `pct: null`, `direction` only. Unavailable baseline → `delta: null`, reason `no_baseline`. Insights apply further floors (`TREND_MIN_BASELINE 20`, `TREND_MIN_ABS_DELTA 10`, `TREND_MIN_PCT 15`, `MONEY_MIN_BASELINE`). **Event-to-event comparison remains absent**: `resolveComparison` accepts `mode: 'event'` structurally but no route requests it and the contract documents it as deferred; nothing pretends it works.

## 15. Operations / attendance

`checkedIn` = `count()` on `registrations` ordered by `checkedInAt` (the same helper the attendance dashboard uses); denominator = confirmed `count()`; `attendancePct` null when either is unmeasured; `awaited = confirmed − checkedIn` (may be negative with `over: true`); by-day arrivals from rollups; capacity/fill from `events.totalCapacity` with the true (unclamped) percentage and negative `remaining`. `checkinHistory` is **not** read anywhere in `lib/analytics` (grep: 0). No no-show figure exists (no event-end instant is consumed). No operator ranking. Identifiers/timing: three aggregates each, only when `identifierConfigs/{slug}.enabled` / `.tagMapping.enabled`; the BIB-before-chip invariant is untouched (Analytics only counts). No R2 scanning.

## 16. Communications

Lifetime counts (sent/delivered/failed/unknown/queued/skipped per channel) are aggregates; campaigns via `broadcastCampaigns` counts; broadcast/automatic via `BROADCAST_TEMPLATE_KEY`; signals (bounce, complaint, WhatsApp read, wallet-held/skipped) via aggregates; windowed attempted/delivered/not-delivered/queued/skipped via `createdAt` range aggregates; reminders via 5 status aggregates + 501-row recipient page; certificates via `count()` + 5,001-row download page; spend via `sum('costPaise')` (money-gated). Terminology on screen: "Delivered = confirmed by the provider", "Failed = provider rejected, excludes timeouts", "Unknown = send timed out", "Not delivered (window) = raw, includes timeouts".

Deferred 12-28 findings, final classification: **F-2** still present — P2 condition (P2-4); **F-3** still present, labelled on screen — P3 (documented divergence); **F-5** still present — P2 terminology (P2-5); **F-6** still present — P3, disclosed in copy; **F-7** still present — P3, not estimated; **F-9** still present — P3, caps disclosed via `limits`. None is a production blocker.

## 17. Participants

`participants` is written only when the producer measured the source composition (12 equality aggregates on `registrationSource` × `status`); supported facts are exactly registration source, online/walk-in/unrecorded composition, status × source, pass mix over confirmed (+ "Other passes"), status mix, and the two identity-rule flags. The contract's demographic keys stay absent; no unique/returning participants, no edition linkage, no CRM retention, no inferred identity (`participantIntelligence.test.ts` 36 pins the absences; grep for `returning|demograph|unique` in the model returns only the documented "not supported" notes). Copy says "registrations", never "participants", for counts.

## 18. Insights

`buildInsights(response, labels)` is pure: 19 rules over `AnalyticsResponse` fields only; no Firestore, fetch, clock, randomness or env (grep and test 39); financial rules read `response.revenue` and are absent when it is; floors and zero-baseline/coverage protections applied through `ComparedMetric.unavailable` and the rule floors; dedup by rule id; deterministic ranking (severity → magnitude → id); `MAX_SURFACED = 6`; every card carries `evidence` (field, basis, unit, value, baseline, thresholds) and a module `action.href`. No AI or independent reader introduced (42 unit tests; QA bundle had 0 Firebase references in 12-31).

## 19. UX

Final state after 12-33 (browser-verified then, tree unchanged since): one event selector (top bar); capability-filtered strip via context (no second fetch); 1440/834/390 with no page overflow on all seven modules; focus ring on strip links and presets; targets ≥ 36 px measured; rail-shaped skeleton; honest empty (AOV) / unavailable (mark + reason) / not-started (attendance) states; "All time" vs "in the last N days" provenance; Communications window as a list below `sm` and a fitted table above; H1 = module. Premium direction is restrained (tokens only, no new palette/gradient/animation).

## 20. Legacy landing condition (U-1)

Inspected read-only. Sidebar "Analytics" (`config/workspaceNav.ts:195`, concurrent `M`) → `/dashboard/analytics` → `app/(dashboard)/dashboard/analytics/page.tsx` (concurrent `M`, +174/−41 vs HEAD). The page: (a) builds its own event list from `/api/organizer/licenses` and auto-selects the first licence — a **second selector** that ignores the shared one; (b) keeps CSV/XLSX/PDF **export controls**; (c) reads the legacy `/api/organizer/analytics/[eventId]` shape, not the contract; (d) mounts `AnalyticsModuleNav` without a provider (full, un-gated strip). It conflicts with the seven-module IA and **U-1 is not resolved**. Because the file is concurrently modified, the intended final state cannot be proven here: **documented integration condition** (P2-1). Canonical landing is not yet `/dashboard/analytics`; the module shell lives under `/dashboard/analytics/{module}`.

## 21. Direct URL condition (U-3)

`?eventId=<valid>` → selector resolves it, one fetch, module renders. `?eventId=<unauthorized>` or `<unknown>` → not in the authorized list → `urlEventMissing` → "This event is not available in your workspace…" with **no API call** and no distinction between not-found/unpublished/not-yours (12-33 unit tests 5–7; QA capture). The UI no longer claims "Select a single event" when an id was supplied. A server refusal (if a stale slug is somehow selected) renders the server's single generic 403 text. **Acceptable** — no existence information leaks in either layer. The related un-offered-module rendering is P2-3 (UX), not a security item.

## 22. Reports F-5 condition

`lib/reports/builders.ts:484` maps `successCount` → `delivered`; `:498` labels it "Delivered"; `:506` "Total Delivered". Not fixed by the concurrent rework as of 7 Sep 11:39. Severity **P2 (terminology)** — the underlying source establishes acceptance; Analytics reserves "Delivered" for provider confirmation.

## 23. PII audit

`lib/analytics/contract.ts`, `normalize.ts`, `eventAnalytics.ts`, `participantsModel.ts`, `insightsRules.ts` and `components/analytics/**`: no `attendeeName`, attendee email, mobile, address, registration id, ticket code or payment id anywhere (the tokens "email"/"mobile" occur only as the channel name and the `limitPerEmail`/`limitPerMobile` boolean flags; "razorpay" 0 hits). The payload is aggregate-first by construction: counts, sums, ≤ 8-row labelled lists (pass names, coupon codes), day series, insights. The legacy export writes the same aggregates. Organizer dashboard paths outside Analytics (registrations list, attendance search) carry PII by design behind their own permissions and were not weakened or assessed for change here.

## 24. Data-source inventory

| Source | Reader | Class | Bound | Overflow surfaced |
|---|---|---|---|---|
| `events/{slug}` | `resolveAnalyticsEventIdentity` (reused by producer) | canonical, 1 doc | — | — |
| `registrations` status ×7 | `aggregateRegistrationStatusCounts` | aggregate | 0 docs | null on failure |
| `registrations` payment ×8 | `getRegistrationSplit` | aggregate | 0 docs | null |
| `registrations` source ×12 | `readRegistrationSourceComposition` | aggregate | 0 docs | block absent |
| `registrationCounters/{slug}` + shards | `getRegistrationCounter` | canonical counter | 1 + shards | null |
| `organizerDailyStats` | `readDailyStats` `getAll` | keyset (deterministic ids) | ≤ 90 × 2 | null |
| `organizerDailyStats` `{uid}__meta` | `readCoverage` | 1 doc | — | epoch fallback |
| `identifierConfigs/{slug}` | `resolveOperationalCapabilities` | 1 doc | — | no capabilities |
| identifier locks / timing locks | 3 + 3 aggregates | aggregate | 0 docs | null |
| `registrations` confirmed revenue | `sumConfirmedRevenueFromLedgerChecked` | canonical aggregate | 0 docs | `ok:false` |
| `registrations` per-pass value | `aggregateValueByPass` | aggregate, budget 60 | 0 docs | `limits.passValue` |
| `registrations` discount | `sum('discountAmount')` | aggregate | 0 docs | `discountUnavailable` |
| `events/{slug}/coupons` | `getCouponPerformance` | bounded by authored coupons | all coupons | — |
| refunds | `readRefundSource` → `listOrganizerRefunds` | canonical, capped | 1,000 + 50 (+ ≤ 50 gets) | `out_of_budget`, `complete` |
| `platformTransactions` | producer page | bounded page | 5,001 | `limits.ledger`, `out_of_budget` |
| `emailLogs` counts (47) | `communicationsSources` | aggregate | 0 docs | null per figure |
| `emailLogs` spend | `sum('costPaise')` | aggregate (money-gated) | 0 docs | `gone` |
| `emailLogs` spend fallback | producer page | **fallback**, bounded | 5,001 | `limits.communications` |
| `broadcastCampaigns` | 6 aggregates | aggregate | 0 docs | null |
| `scheduledReminders` status ×5 | aggregates | aggregate | 0 docs | block null |
| `scheduledReminders` recipients | producer page | bounded page | 501 | `limits.reminders` |
| `certificates` issued | `count()` | aggregate | 0 docs | block null |
| `certificates` downloads | producer page | bounded page | 5,001 | `limits.certificates` |
| feature flags | `getFeatureFlags` | config doc | 1 | — |

No unbounded, no cached, no legacy reader remains in the canonical path. Deviations from the preference order: the three bounded pages (ledger, certificates, reminders) and the spend fallback — all fixed caps with disclosure.

## 25. Cache / staleness audit

No Redis, Firestore cache, global `Map`, TTL, `unstable_cache`, `revalidate`, analytics collection or cross-request `AnalyticsResponse` cache exists (grep of `lib/analytics/**` and both routes: 0; the only `new Map` instances are request-local tallies). Both routes send `Cache-Control: no-store`. Request-level deduplication is present where required (refund source, event document, strip via React context). Nothing to key.

## 26. Error-handling audit

| Occurrence | Verdict |
|---|---|
| `eventAnalytics.ts:768` `byPayment.get(ps) ?? 0` gated by `split === null ? null` | SAFE (a status absent from a successful aggregate is 0) |
| `:831` coupon `catch → discountUnavailable: true` | SAFE |
| `:837` revenue `catch → {ok:false}` | SAFE |
| `:878` pass value `catch → complete:false` | SAFE |
| `:1048-1050` reminder `?? 0` gated by `remOk` (block null if any aggregate failed) | SAFE |
| `:1062` `counts.recipients ?? 0` per reminder doc | SAFE (absent field = none recorded) |
| `:1098` `certIssuedAgg ?? 0` gated by `certOk` | SAFE |
| `:1201` `totalDiscountPaise ?? 0` with `discountUnavailable ?? true` | SAFE |
| `:946-975` ledger `catch` → `ledgerAvailable=false` → `gone` | SAFE |
| `:1010-1025` emailLogs `catch → commOk=false` → `gone` | SAFE |
| `communicationsSources.ts:161-162` `catch(() => EMPTY)` (all-null channel) | SAFE |
| `couponPerformance.ts:204` non-number sum → 0 | SAFE (sum() returns a number) |
| `participantsModel.ts:92-93`, `registrationsModel.ts:145,150` (null filtered first) | SAFE |
| `insightsRules.ts:523` ranking magnitude `?? 0` | SAFE (ordering only) |
| `insightsRules.ts:229` `remaining ?? 0` in summary | SAFE in practice (P3-7) |
| `[eventId]/route.ts:145` export `passRevenue.find(...)?.value ?? 0` | **UNSAFE** — P2-2 (legacy export only) |
| `[eventId]/route.ts:132` export `revenueByDay[i]?.value ?? 0` | SAFE (same rows, index-aligned) |
| `financeAnalytics.ts:689-691` trend bucket `?? 0` | outside Analytics — P3-9 |
| `adminAnalytics.ts`, `adminCommunications.ts` `catch { return 0 }` | admin platform surfaces, not organizer Analytics — noted, out of scope |

`Number(`/`parseInt`/`parseFloat` in `lib/analytics`: none on measured figures.

## 27. Role matrix

From `ROLE_PERMISSIONS`, `ITEM_GATES`, the 12-33 browser QA (strips measured on `a29-mix`) and today's emulator authz run:

| Role | Overview | Registrations | Revenue | Operations | Communications | Participants | Insights | Reports/Finance |
|---|---|---|---|---|---|---|---|---|
| Owner | ✓ | ✓ | ✓ money | ✓ (+BIB/timing when configured) | ✓ + spend | ✓ when measured | ✓ incl. financial | ✓ |
| Finance | ✓ counts | not offered (no `registrations`) | ✓ money | not offered (no `checkin`) | not offered (no `communications`) | ✓ | ✓ incl. financial | ✓ (`transactions`) |
| Admin | ✓ | ✓ | **denied** (no `transactions`; key absent) | ✓ | ✓ (no spend) | ✓ | ✓ non-financial only | ✗ |
| Manager | ✓ | ✓ | **denied** | ✓ | not offered (no `broadcasts`) | ✓ | ✓ non-financial only | ✗ |
| Gate (`checkin_staff`, `checkin_lead`) | ✗ 403 before any read; sidebar row hidden | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ |

Financial values only with `transactions` (owner, finance); Admin/Manager payloads carry no money key (emu test 9); Participants gated on measured composition; Operations gated on `checkin`; BIB/timing panels gated on the event's `identifierConfigs`, not on event type. Condition P2-3 applies to the "not offered" cells reached by direct URL.

## 28. Scale / cost classification

| Module / area | Class | Basis |
|---|---|---|
| Overview | GREEN | aggregates + rollups |
| Registrations | GREEN | aggregates + counter + rollups; pass value budgeted |
| Revenue — confirmed/net/AOV/velocity/discount | GREEN | aggregates |
| Revenue — refunds | YELLOW | cap 1,000 (+50), exact count kept, amount withheld over cap |
| Revenue — ledger (gross/fees/settlement) | YELLOW | 5,001 page, `out_of_budget` over cap (P3-8) |
| Operations | GREEN | aggregates + rollups + ≤ 6 aggregates |
| Communications — counts/campaigns/signals/windows | GREEN | 47 aggregates |
| Communications — spend fallback | YELLOW | 5,001 page, only when sum unanswered (P3-1 for non-money callers) |
| Reminders | YELLOW | 5 aggregates + 501 page for recipients |
| Certificates | YELLOW | aggregate + 5,001 page for downloads |
| Participants | GREEN | 12 aggregates |
| Insights | GREEN | pure |
| paymentIntent reconciliation (unattributed refunds) | YELLOW | N+1 capped at 50, gives up above |
| Coupons | GREEN/YELLOW | subcollection sized by authored coupons |
| Reports (separate product) | YELLOW | row-level `limit(CAP + 1)` with `truncated` disclosure |
| Legacy export | YELLOW | same producer; P2-2 false zero |

**No RED path.** Every cap is surfaced through `limits.*`, `out_of_budget`, `complete:false` or `truncated`.

## 29. Regression search

| Pattern | Result | Class |
|---|---|---|
| old `/dashboard/reports` | still resolves (Event Insights, reads canonical dashboard endpoint), unlinked, breadcrumb "Analytics" | stale-safe legacy (P3-4) |
| legacy Analytics landing | present, sidebar target, concurrent | P2-1 |
| duplicate event selectors | none in module shell; one on the legacy landing | P2-1 |
| `estimatedRevenue` | 0 hits | clean |
| DashboardEvent `revenuePaise` | removed; `confirmedRevenuePaise` + `revenueUnavailable` | clean |
| `.limit(5000)` / `.limit(5001)` on registrations | 0; `CAP + 1` pages are ledger/emailLogs/certificates | clean |
| unauthorized financial reads | none (every money reader gated; tests pin) | clean |
| independent revenue calculations | none in Analytics; Reports gross = ledger gross (same meaning as `grossCollected`) | clean |
| old Analytics imports (`normalizeDashboardAnalytics`) | tests only | P3-3 |
| stale navigation | `ANALYTICS_ROUTE_MIGRATION` steps 2–3 pending | P2-1 / P3-4 |
| stale "Delivered" terminology | Reports Broadcast Usage | P2-5 |

## 30. Validation evidence

| Evidence | Status | Detail |
|---|---|---|
| Analytics unit suites (23 files) | **VERIFIED today** | 792 tests; 790 passed in the batch, 2 first-test 5 s import timeouts under parallel load (`analyticsFinancialTruth` #1, `analyticsUnavailable` #1) re-run alone → 48/48 |
| Emulator: cross-workspace authz, 20k scale, ledger bound, comms intelligence + scale (20.5k rows), participant composition (20.5k) | **VERIFIED today** | 6 files, 60/60, 78.7 s, against the live emulator |
| `tsc --noEmit` | **VERIFIED today** | 0 errors; `tsconfig.json` unchanged |
| ESLint | VERIFIED 2026-09-11 (12-33) | 0 errors on the last touched set; tree unchanged since |
| Production build | VERIFIED 2026-09-11 (12-33) | isolated dist, clean, all 8 analytics routes; tree unchanged since |
| Browser QA at 1440/834/390 × 7 modules × owner/finance/admin/manager/staff | VERIFIED 2026-09-11 (12-33) | 370 checks, 0 issues, payload cross-checks |
| Role matrix | VERIFIED (12-33 browser + today's emulator) | §27 |
| Cross-workspace validation | VERIFIED today | §10 |
| Request dedup (refunds ×1, event doc ×1) | VERIFIED (12-32 tests, re-run today) | `analyticsRequestDedup` 17 |
| Full repository unit suite | VERIFIED 2026-09-11 | 380 files, 10,452 passed; one unrelated public-chrome walk timeout passes alone |
| 50k / 100k registrations | ARCHITECTURALLY SUPPORTED | not benchmarked; no figure claimed |
| Ledger > 5,000 transactions in production | ARCHITECTURALLY SUPPORTED (disclosed `out_of_budget`) | emulator `revenueLedgerBound` covers the bound; no production-volume run |
| F-2 mis-attribution frequency | NOT TESTED | no fixture exercises the recipient-email fallback |

## 31. Production-readiness decision

Criteria check: zero P0 ✓; zero P1 ✓; no cross-workspace leak ✓ (verified); no unauthorized financial exposure ✓ (verified); no false-zero financial behaviour **in the canonical Analytics contract and modules** ✓ — the single remaining false zero is a per-pass column in the legacy export (P2-2), on a legacy surface with a correct financial summary beside it; no unbounded registration-scale path ✓; no critical timezone/comparison error ✓; no critical UX/security contradiction ✓ (P2-3 is an IA inconsistency with no data consequence).

The P2 items are explicitly documented, are not security or data-integrity blockers for the module pages organizers are directed to, and can be addressed later — two of them (P2-1, P2-5) are blocked on concurrent work by design.

**FINAL ANALYTICS VERDICT:**
**PRODUCTION READY WITH NON-BLOCKING CONDITIONS**

## 32. Remaining non-blocking conditions

1. **P2-1 U-1** — when the concurrent landing/nav work lands: point the sidebar row at the module shell (Insights or Overview) honouring the shared selector, retire the landing's own picker, and move CSV/XLSX/PDF exports to Reports (`ANALYTICS_ROUTE_MIGRATION` steps 2–3).
2. **P2-2** — retire or fix the legacy export's per-pass "Revenue" column (omit the column when `limits.passValue` is false; omit the cell when no value row exists) as part of (1).
3. **P2-3** — give each module page a "not offered for this role/event" state keyed on `capabilities.modules`, or accept direct-URL rendering as the documented behaviour.
4. **P2-4 F-2** — constrain the webhook recipient-email fallback by organizer/event/status/recency.
5. **P2-5 F-5** — rename Reports "Delivered" → "Accepted" once `lib/reports/builders.ts` is stable.
6. **P2-6 / P3-1** — skip the spend-fallback page when the caller holds no `transactions` (it cannot see spend), and drop the resulting notice for those roles.
7. **P3-2…P3-9** — contract wording for AOV reason; delete `normalizeDashboardAnalytics`; migrate/redirect `/dashboard/reports`; keep the Reports-UTC vs Analytics-IST difference documented; F-6/F-7/F-9 as recorded; the Finance trend `?? 0` outside Analytics; the 5,000-transaction ledger cap communicated in product copy for very large paid events.

## 33. Statement of non-implementation

No implementation was performed in this phase. No source, test, rules, index, schema, API, permission, calculation, cache, UI, navigation or Reports file was modified; the only file created is this report. Read-only verification consisted of running existing unit and emulator tests and `tsc --noEmit` (tsconfig restored byte-identical). Nothing was reset, cleaned, stashed, checked out, restored, reverted, amended, committed, pushed or deployed. `firestore.rules` and `firestore.indexes.json` remain untouched. This is the final RegisterDesk Analytics phase; no RD-12-35 exists.

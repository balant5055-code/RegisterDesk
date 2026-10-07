# RD-ANALYTICS-12-32 — PERFORMANCE + CACHING IMPLEMENTATION

**Scope:** request-scoped deduplication only, per the RD-12-32 audit (APPROVED WITH CONDITIONS, C-1…C-6).
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged before and after. `firestore.rules` (3 Sep) / `firestore.indexes.json` (8 Sep) untouched. No cache of any kind introduced.

---

## 1. Executive summary

Three request-local changes, no new infrastructure:

1. **Refunds: 3 → 1 source acquisitions per financial request.** `getRefundTotals` was split into `readRefundSource(scope)` (the one `listOrganizerRefunds` call — same query, same caps, same unattributed-refund recovery) and `refundTotalsFromRead(read, scope)` (the unchanged in-memory arithmetic). `getRefundTotals` itself is now `refundTotalsFromRead(await readRefundSource(scope), scope)` — byte-identical for every existing caller including Reports. The producer acquires the source once and derives lifetime, selected-window and baseline totals from it.
2. **Event document: 2 → 1 reads per request.** `resolveAnalyticsEventIdentity` now carries the `events/{slug}` document it resolved; both organizer analytics routes hand it to `getEventAnalytics({ eventDocument })` after authorization. The producer reads the document itself only when no document is passed (admin route, tests) — behaviour unchanged there.
3. **emailLogs spend fallback: skipped when the `sum()` aggregate answered.** The ≤ 5,001-document page is read only when `commSpend?.ok !== true` — i.e. the aggregate failed, was unavailable, or was never attempted (no `transactions`). Money and `limits.communications` semantics unchanged.

Verified: 17 new regression tests (+ 3 suites re-anchored to the new shape with no weakened assertion), full unit suite **357 files / 9,926 passed**, 7 emulator suites **80 passed** including the 20,000-registration analytics run, `tsc` clean, ESLint clean, production build clean, browser QA re-run on Communications (250 checks), Participants (130), Insights (14 card-set matches) and a 30-page seven-module × three-width × two-role capture with 0 overflow and 0 errors.

**Verdict (§19): IMPLEMENTED — SAFE FOR NEXT ANALYTICS PHASE.**

---

## 2. Before / after refund read graph

**Before** (finance request, comparison on):

```
getRefundTotals(lifetime)  → listOrganizerRefunds → count() + limit(1000).get()  + recoverUnattributed: count() + limit(50).get() + ≤50 paymentIntents.get()
getRefundTotals(window)    → listOrganizerRefunds → (identical read)            + (identical recovery)
getRefundTotals(baseline)  → listOrganizerRefunds → (identical read)            + (identical recovery)
```

**After:**

```
readRefundSource({uid, slug})   → listOrganizerRefunds → count() + limit(1000).get() + recoverUnattributed: count() + limit(50).get() + ≤50 paymentIntents.get()
refundTotalsFromRead(read, lifetime)   — in memory
refundTotalsFromRead(read, window)     — in memory
refundTotalsFromRead(read, baseline)   — in memory (skipped when the baseline would be refused)
```

## 3. Exact read reduction

| Read | Before (worst case) | After (worst case) | Saved |
|---|---|---|---|
| `registrationRefunds` `count()` | 3 | 1 | 2 aggregates |
| `registrationRefunds` page (≤ 1,000 docs) | 3 | 1 | ≤ 2,000 documents |
| unattributed pool `count()` | 3 | 1 | 2 aggregates |
| unattributed page (≤ 50 docs) | 3 | 1 | ≤ 100 documents |
| `paymentIntents` point gets | ≤ 150 | ≤ 50 | ≤ 100 point reads |
| `events/{slug}` doc get (organizer routes) | 2 | 1 | 1 document |
| `emailLogs` spend page (≤ 5,001 docs) | 1 always | 0 when `sum()` answered | ≤ 5,001 documents on healthy finance requests |

Typical event (≤ 20 refunds, no unattributed pool): 6 → 2 refund aggregates, 3 → 1 refund pages, 2 → 1 event reads, spend page skipped. Non-finance request: unchanged except the event read (no financial read ran before, none runs now).

---

## 4. Refund implementation

`lib/finance/financeAnalytics.ts`:

```ts
export async function getRefundTotals(scope) { return refundTotalsFromRead(await readRefundSource(scope), scope) }
export function readRefundSource(scope: Pick<FinanceScope,'organizerUid'|'eventSlug'>): Promise<OrganizerRefundRead>
export function refundTotalsFromRead(read: OrganizerRefundRead, scope: FinanceScope): RefundTotals
```

`refundTotalsFromRead` is the former body of `getRefundTotals`, moved verbatim: the `ownedCount === null → gone('query_failed')` path, the `!complete && records.length === 0 && ownedCount > REFUND_READ_CAP → gone('out_of_budget')` path, `withinRange(r.createdAt, from, to)`, the `recovered` slice, `unlinked`, `complete`. Completed/pending refund definitions, refund date semantics, IST bounds (`istRangeBounds` at the call sites), window definitions and amount arithmetic are untouched. Reports continue to call `listOrganizerRefunds` directly — one canonical reader, one filter.

`lib/analytics/eventAnalytics.ts`: `refundSource = includeFinancial ? await readRefundSource(...).catch(() => null) : null`; the three totals are `refundSource ? refundTotalsFromRead(refundSource, …) : null` — a failed acquisition yields three nulls exactly as three failed reads did.

## 5. Bounds verification

Unchanged and pinned (test 9): `ORGANIZER_REFUND_READ_CAP = 1000` (owned rows withheld above it, count kept exact), `UNATTRIBUTED_REFUND_SCAN_CAP = 50` (pool abandoned above it), `paymentIntents` gets bounded by the candidate page (≤ 50), no unbounded scan, no new fan-out. The bounded N+1 inside `recoverUnattributed` still exists but now runs once per request instead of three times.

## 6. Event identity optimization

`AnalyticsEventIdentity.document` added (the raw `events/{slug}` data). `getEventAnalytics` gains `eventDocument?`; when present the producer uses it, otherwise it reads the document as before. Both organizer routes pass `identity!.document` **after** `resolveAnalyticsEventIdentity → ownership check → requireEventScope → financeAllowed`. The admin analytics route is untouched (it passes nothing and reads once, as before). Slug resolution, capabilities, role behaviour: unchanged. Test 10b pins that exactly two `events/{id}` reads remain in the producer module (the resolver's and the producer's own fallback) and 11–12 pin the authorization order in both routes.

## 7. Email spend optimization

`const spendAnswered = commSpend?.ok === true`; the page is read only when it is false. `ok:false` (gone) and `null` (aggregate not attempted for a caller without `transactions`) both keep the page, its `CAP + 1` overflow detection and `limits.communications`. The money rule (`commSpend?.ok ? commSpend : commOk && !commTruncated ? money(commCostPaise) : gone(...)`) is unchanged; unavailable never becomes zero (tests 14–15).

## 8. Authorization verification

Unchanged: `authorizeAnyWorkspace` → `identity.organizerUid !== authz.workspaceUid` → `requireEventScope` → `financeAllowed = permissions.includes('transactions')` → producer. Every financial read remains behind `includeFinancial`; the refund acquisition is gated on it (test 13). Browser QA re-run: admin/manager payloads carry no `revenue` key (12-29 "revenue presence follows transactions" ×10 ✓, 12-31 non-money role checks ✓); gate staff never reach the API.

## 9. Cache prohibition verification

No Redis, Firestore cache, global/module-level Map, TTL, cache collection, invalidation, `unstable_cache`, or client storage. `Cache-Control: no-store` retained on both routes. The only reuse is `const refundSource` and the `eventDocument` argument — request-local values created after authorization and discarded with the request. Pinned by the "no cache was introduced" test over the producer, the finance reader and both routes.

## 10. Semantic regression verification

- `refundTotalsFromRead(read, scope)` ≡ `getRefundTotals(scope)` for lifetime, window and baseline on a mixed fixture (window, IST-boundary, baseline, unlinked, pre-both, recovered rows) — test 2–4 asserts deep equality **and** the literal values.
- Empty ledger → measured zeros (test 6); failed acquisition → `query_failed` unavailable (7); over-cap → exact count + `out_of_budget` (7b); recovered count carried, not re-reconciled (8); IST boundary rows land in the correct window (dedicated test).
- Existing pins re-anchored, none weakened: `analyticsFinancialTruth` mocks `readRefundSource` + `refundTotalsFromRead` instead of `getRefundTotals` (same fixture, same assertions); `gatewayFeeResolution` slices the region `getRefundTotals … refundTotalsFromRead` (same six assertions); `revenueIntelligence` asserts one `readRefundSource` + three `refundTotalsFromRead` and the new gate variables (same intent, exact new shape).

## 11. Tests

- New: `tests/unit/analyticsRequestDedup.test.ts` — **17** covering the brief's 16 proofs plus the IST-boundary and cache-prohibition cases.
- Re-anchored: `analyticsFinancialTruth.test.ts` (mock), `gatewayFeeResolution.test.ts` (slice bounds, 3 sites), `revenueIntelligence.test.ts` (2 pins).
- Full unit suite: **357 files / 9,926 passed / 1 skipped.**

## 12. Emulator

`analyticsScale`, `organizerAnalyticsAuthz`, `communicationsScale`, `communicationIntelligence`, `participantComposition`, `adminFinanceHistoricalScope`, `refundClaim` — **7 files / 80 passed**, run against the deduplicated producer.

## 13. 20k scale

**Benchmark executed:** `tests/emulator/analyticsScale.emu.test.ts` — `getEventAnalytics` over a 20,000-registration event (seven statuses, rows at positions 5,001 / 9,999 / 19,999 verified inside totals, foreign-organizer/foreign-event rows excluded) — passed after the change. **Architecture supports** 50k/100k (aggregate cost is independent of registration count; only the ledger/emailLogs pages grow and they are overflow-detected) — **not benchmarked** at those sizes.

## 14. Browser QA

Against the rebuilt emulator bundle: RD-12-28 Communications (**250 ✓**, owner 1440/834/390 + finance/admin/manager/gate), RD-12-29 Participants (**130 ✓**), RD-12-31 Insights (**14 card-set matches**, engine-vs-screen), and a 30-page capture of all seven modules (Overview, Registrations, Revenue, Operations, Communications, Participants, Insights) at 1440/834/390 for owner and 1440 for manager — **0 overflow, 0 console/page errors**. The RD-12-26 Revenue script reported one issue, "intelligence block sent to a caller without transactions": that script's regex (`/"intelligence"/`, written before 12-28) now matches the non-financial `communications.intelligence` key; the money boundary itself is proven by the 12-29/12-31 `'revenue' in payload` assertions (all ✓). The stale regex is a QA-script artefact, not a leak, and the script was left unmodified (out of scope).

## 15. TypeScript / ESLint / build

`tsc --noEmit` clean · ESLint 0 errors on all touched source and test files · `NEXT_DIST_DIR=.next-a1232 next build` clean (removed after) · `emu:build` clean · `tsconfig.json` restored after each build.

## 16. Worktree verification

HEAD `b7e5fdf`; 0 staged; no commit/push/deploy; no reset/clean/stash/checkout/restore/revert; CRLF preserved (`financeAnalytics.ts` 771→794 CR = +23 lines, `eventAnalytics.ts` 1300→1338 = +38, routes LF); concurrent files not opened.

## 17. Diff review

Changed vs pre-edit snapshots: `lib/finance/financeAnalytics.ts` +25/−2; `lib/analytics/eventAnalytics.ts` +73/−35; `app/api/organizer/analytics/overview/[eventId]/route.ts` +3/−1; `app/api/organizer/analytics/[eventId]/route.ts` +2/−1; `lib/refunds/registrationRefunds.ts` +0/−0 (untouched); three test files re-anchored; one test file and this report added. No rules, index, lockfile, contract, UI, navigation, Reports, CRM or Insights change; no build artefact retained (`.next-a1232` removed; `.next-emulator` is the pre-existing QA build).

## 18. Remaining conditions

None from the RD-12-32 audit. Recorded for later phases (unchanged by this one): F-6 client-side payload sharing across module pages; the bounded N+1 in `recoverUnattributed`; the stale `/"intelligence"/` regex in `scripts/qa/rd-analytics-12-26-shots.mjs`.

## 19. Final verdict

**IMPLEMENTED — SAFE FOR NEXT ANALYTICS PHASE.**

STOP. Awaiting review.

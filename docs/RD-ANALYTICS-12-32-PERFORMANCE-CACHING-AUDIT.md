# RD-ANALYTICS-12-32 — PERFORMANCE + CACHING AUDIT

**Type:** AUDIT ONLY — no source, test, rules, index, schema, data, cache, infrastructure or deployment changes.
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged, 826 worktree entries (`$TEMP/rd1232-baseline.txt`). `firestore.rules` (mtime 3 Sep) / `firestore.indexes.json` (8 Sep) untouched; both were already modified in the pre-existing baseline. No CRLF/LF normalisation, no reformatting, no file touched by this phase.
**Concurrent work:** the analytics workstream's own uncommitted modules (06 … 12-31) plus the public-chrome workstream. `app/(dashboard)/dashboard/analytics/page.tsx` (legacy landing) is concurrently modified — read only.

---

## 1. Executive summary

RegisterDesk Analytics is already an aggregate architecture: one request produces one `AnalyticsResponse` from `count()` / `sum()` aggregates, counter documents and IST daily rollups. **Nothing in the organizer analytics path scans registrations**, and the cost of almost every figure is independent of registration count — a 100,000-registration event costs what a 100-registration one costs. The measured exceptions are five bounded page reads whose caps are already overflow-detected and disclosed (`limits.*`).

The audit finds **no P0 and one P1**, and it is not a caching problem:

> **F-1 (P1): the refund ledger is read three times per financial request, and all three reads return the same rows.** `getRefundTotals` reads *every* refund for the event and then filters by `scope.from/to` **in memory**; the producer calls it three times (lifetime, selected window, previous window) with identical `organizerUid`/`eventSlug`. Each call costs 2 `count()` + up to 2 page reads (≤1,000 refunds, ≤50 unattributed) **+ up to 50 `paymentIntents` point gets** — so a finance request pays up to 6 counts, 3 × 1,050 documents and **150 point reads** to compute three numbers from one data set. This is the single largest hotspot and it is removable without any cache: pass the read, not the scope.

The second and third hotspots are much smaller and equally undramatic: `events/{slug}` is read twice per request (route identity + producer), and four capped pages (platformTransactions 5,001, emailLogs 5,001, certificates 5,001, scheduledReminders 501) survive only to compute figures that have no aggregate form.

On caching: the platform has **no cache infrastructure at all** for analytics (`Cache-Control: no-store` on both routes, `cache: 'no-store'` on the client; no `unstable_cache`, LRU, Redis or cache collection anywhere), and this audit does **not** recommend adding one. A cross-request cache of `AnalyticsResponse` would place a *derived, permission-shaped* object behind a key that must encode workspace + event + range + comparison + `includeFinancial`, and the payload's shape is itself the permission boundary (`revenue?`/`spend?` absent without `transactions`) — a mis-keyed entry is a financial disclosure, not a stale number. The evidenced problem is duplicated work *inside one request*, and request-local reuse solves it with no key, no TTL, no invalidation and no authorization surface.

**Verdict (§23): APPROVED WITH CONDITIONS** — for request-scoped deduplication only (F-1, F-2), explicitly **not** for a server cache.

---

## 2. Current read architecture

```
GET /api/organizer/analytics/overview/[eventId]?preset=30d        (Cache-Control: no-store)
  1  authorizeAnyWorkspace(req)                    — session + teamMembers (auth layer)
  2  resolveAnalyticsEventIdentity(eventId)        — 1 doc  events/{slug}
  3  ownership + requireEventScope                 — in memory
  4  financeAllowed = permissions.includes('transactions')
  5  normalizeRange(query)                         — pure
  6  getEventAnalytics(eventId, { includeFinancial, range })   ← the whole read graph (§3)
  7  getFeatureFlags()                             — config layer (has its own 60 s TTL cache,
                                                     lib/config/businessConfigService.ts)
  8  normalizeEventAnalytics(...)                  — pure
  9  buildInsights(response)                       — pure, client-side (12-31)
```

A second route, `/api/organizer/analytics/[eventId]`, serves the same producer for `?format=csv|xlsx|pdf` exports and the legacy JSON shape; an admin route (`/api/admin/events/[slug]/analytics`) calls the producer with `includeFinancial: true`. All three share one producer — there is no second analytics engine.

**Client cadence:** `useAnalyticsScope` fetches once per `(slug, preset)` and is re-created per module page. Navigating Overview → Registrations → Revenue → Operations → Communications → Participants → Insights therefore issues **seven identical requests**, each re-running the whole graph. That is the strongest argument for a short-TTL cache — and the strongest argument against solving it with one (§17).

---

## 3. Read graph (one finance-authorized request, comparison on)

| # | Source | Query | Scope | Fan-out | Financial | Failure |
|---|---|---|---|---|---|---|
| 1 | `events/{slug}` | doc get | event | 1 | no | null identity → 403 |
| 2 | `events/{slug}` | doc get (**again**, inside producer) | event | 1 | no | null → no analytics |
| 3 | `registrations` | `count()` × 7 (total + 5 statuses + `checkedInAt` order) | uid+slug | 7 | no | `null` counts |
| 4 | `registrations` | `count()` × 7 (`getRegistrationSplit`: total, free, 5 payment statuses) | uid+slug | 7 | no | `null` |
| 5 | `registrationCounters/{slug}` + `attendanceShards` | 1 doc + 1 subcollection get | event | 2 | no | null |
| 6 | `organizerDailyStats` | `getAll` of ≤ 90 day docs (window) | uid+slug | 1 batch | revenue field gated | null → trend unavailable |
| 7 | `organizerDailyStats` | `getAll` of ≤ 90 day docs (**baseline**) | uid+slug | 1 batch | idem | null → no baseline |
| 8 | `organizerDailyStats/{uid}__meta` | doc get | workspace | 1 | no | null coverage |
| 9 | `identifierConfigs/{slug}` | doc get (capabilities) | event | 1 | no | `NO_OPERATIONAL_CAPABILITIES` |
| 10 | `registrations`/`timingTags` | identifier + timing `count()`s — **only when enabled** | event | ~4 | no | null |
| 11 | `emailLogs` | `count()` × 16 (lifetime, 2 channels × 6 states + totals) | eventId | 16 | no | `null` per figure |
| 12 | `emailLogs` | `sum('costPaise')` | eventId | 1 | **yes** | `gone` |
| 13 | `emailLogs` | `count()` × 5 (signals) | uid+eventId | 5 | no | null |
| 14 | `emailLogs` | `count()` × 10 (windowed) | uid+slug+status+createdAt | 10 | no | null |
| 15 | `emailLogs` | `count()` × 10 (**baseline window**) | idem | 10 | no | null |
| 16 | `broadcastCampaigns` | `count()` × 6 | uid+slug | 6 | no | null |
| 17 | `registrations` | `count()` × 12 (source composition) | uid+slug+source+status | 12 | no | null |
| 18 | `registrations` | `sum('amount')` × 2 per pass, budget 60 | uid+slug+pass | ≤ 60 | **yes** | `passValue` false |
| 19 | `registrations` | `sum('amount')` confirmed (ledger-checked) | slug | 1 | **yes** | `ok:false` |
| 20 | `coupons` + `registrations` | 1 collection get (coupons) + 1 `sum('discountAmount')` | event | 2 | **yes** | flagged unavailable |
| 21 | `platformTransactions` | page `limit(5001)` | entityId | 1 | **yes** | `out_of_budget` |
| 22 | **`registrationRefunds` + `paymentIntents`** | **`getRefundTotals` × 3** — see §5 | uid+slug | **≤ 6 counts + 3×1,050 docs + ≤150 point gets** | **yes** | `gone` |
| 23 | `emailLogs` | page `limit(5001)` (spend fallback only) | eventId | 1 | no (read always) | `limits.communications` |
| 24 | `scheduledReminders` | `count()` × 5 + page `limit(501)` | eventId | 6 | no | null / `limits.reminders` |
| 25 | `certificates` | `count()` × 1 + page `limit(5001)` | eventId | 2 | no | null / `limits.certificates` |

**Totals for a finance request with comparison:** ~120 aggregate queries (zero documents transferred), ~5 document batches, 4 capped pages (≤ 5,001 docs each, ≤ 501 for reminders), and the refund block of §5. For a non-finance request, rows 12, 18–22 do not run at all — **unauthorized requests perform no financial reads** (verified: every financial read sits behind `includeFinancial`, which the route computes from `transactions` before calling the producer).

Independent re-reads of the same source by different modules: `registrations` is read by rows 3, 4, 10, 17, 18, 19 — but each is a *different aggregate* (different filter/field), not the same data twice. `emailLogs` rows 11, 13, 14, 15 likewise. The genuine duplicates are rows 1↔2 and the three refund calls.

---

## 4. Repeated-read findings

| ID | What | Evidence | Severity |
|---|---|---|---|
| **F-1** | `getRefundTotals` called 3× with the same `(organizerUid, eventSlug)`; range filtering happens in memory after a full read | `eventAnalytics.ts:824, 842, 846`; `financeAnalytics.ts:248` → `listOrganizerRefunds(uid, {eventSlug})` ignores `from/to`; `:260` filters `read.records` by `withinRange` | **P1** |
| **F-2** | `events/{slug}` read twice per request | route `:94` → `resolveAnalyticsEventIdentity` (`eventAnalytics.ts:271`) and `getEventAnalytics` (`:557`) | **P2** |
| F-3 | `organizerDailyStats` read twice (window + baseline) as two `getAll` batches over disjoint keys | `:600, :602` | **P3 — not a duplicate**: disjoint day keys, one batch each. No action. |
| F-4 | `emailLogs` read by four different aggregate groups + one capped page | rows 11–15, 23 | **P3** — different filters; the capped page (row 23) exists only as the spend fallback and could be skipped when the `sum()` aggregate succeeded |
| F-5 | `registrations` aggregated by six independent groups | rows 3, 4, 10, 17, 18, 19 | **P3 — by design**; each is a distinct `count()`/`sum()`, all zero-document |
| F-6 | Seven module pages each re-run the entire graph for the same `(slug, preset)` | `useAnalyticsScope.ts:71-98`, no shared client store | **P2** (product/UX cost, not correctness) |
| F-7 | Financial authorization is resolved once and passed down; no repeat | route `:102`, producer `includeFinancial` | **none** — correct |
| F-8 | `resolveOperationalCapabilities` reads `identifierConfigs/{slug}`; `readIdentifierProgress`/`readTimingProgress` re-resolve config internally | `operationsSources.ts:64`, `:155` | **P3** — only when the capability is enabled; 1 extra doc |

Nothing is labelled expensive merely because it is repeatable: F-3/F-5 are explicitly *not* findings.

---

## 5. Refund amplification (the §3 question, traced)

One `getRefundTotals(scope)` call:

```
listOrganizerRefunds(uid, { eventSlug })            registrationRefunds.ts:230
  ├─ owned:      count()  on (organizerUid, eventSlug)                     1 aggregate
  │              if count === 0 → stop
  │              if count  > 1000 (ORGANIZER_REFUND_READ_CAP) → rows withheld, count kept
  │              else      .limit(1000).get()                              ≤ 1,000 docs
  └─ recoverUnattributed(uid, eventSlug)            :180
        ├─ count()  on (organizerUid == null)                              1 aggregate
        ├─ if 0 → stop; if > 50 → give up (complete:false)
        ├─ .limit(50).get()                                                ≤ 50 docs
        └─ for each candidate with gatewayOrderId:
             paymentIntents/{orderId}.get()                                ≤ 50 point gets
then getRefundTotals filters read.records by scope.from/to  IN MEMORY      financeAnalytics.ts:260
```

The producer calls it **three times**:

| Call | Site | Scope passed | Data read |
|---|---|---|---|
| lifetime | `:824` | `from: null, to: null` | every refund of the event |
| selected window | `:842` | `istRangeBounds(activeRange)` | **the same every refund** |
| previous window | `:846` | `istRangeBounds(priorRange)` | **the same every refund** |

Upper bound per finance request with comparison: **6 count aggregates, up to 3,150 documents, up to 150 `paymentIntents` point gets** — to produce three totals that are three in-memory filters of one identical record set. Typical event (≤ 20 refunds, 0 unattributed): 6 counts + 60 docs — small, but still three times what is needed and three round trips on the critical path.

Revenue Intelligence does **not** add refund reads (`refundsInPeriod` consumes calls 2 and 3 — they exist *for* it). Insights adds none (12-31 is pure; test 39 pins no data access). Reports reads refunds through the same `listOrganizerRefunds`, in a separate request.

**Answer to the audit's A/B/C/D question: B — request-level deduplication.** The three results are pure functions of one read plus a range filter that already runs in memory; no cache, no TTL and no architectural change is needed. The minimal fix is to read once per `(organizerUid, eventSlug)` per request and apply the three range filters to that one result — i.e. expose the filter (`totalsFromRead(read, scope)`) beside the existing reader, or memoize `listOrganizerRefunds` per request. **C and D are rejected**: a TTL cache would make a *financial* figure stale and cross-request, for a problem that is entirely within one request; an architectural change (refund rollups) is unjustified at the observed refund volumes.

Secondary observation (**F-1b, P3**): `recoverUnattributed` is a genuine N+1 — one `paymentIntents` get per unattributed candidate — but it is hard-capped at `UNATTRIBUTED_REFUND_SCAN_CAP = 50` and gives up entirely above it. Bounded; deduplicating F-1 removes two thirds of it for free.

---

## 6. Communications performance

All counts are `count()` aggregates over equality filters (and one `createdAt` range on declared composites), zero documents: 16 lifetime + 5 signals + 10 window + 10 baseline + 6 campaigns = **47 aggregates**, independent of message volume. Proven on the emulator at 20,500 rows (12-28 test 1). Caps: the `emailLogs` `limit(5001)` page survives **only** as the spend fallback when the `sum('costPaise')` aggregate fails, and it is overflow-detected (`CAP + 1`) with `limits.communications`; `scheduledReminders` uses a 501 page for the recipient sum only (status counts are aggregates); `certificates` uses a 5,001 page for the download count only (issued is an aggregate). No document scan feeds any count. Velocity, channel mix and the windowed comparison are pure derivations over those aggregates (12-28). Semantics unchanged by this audit.

**F-4 (P3):** the spend-fallback page is read even when the `sum()` succeeded — a wasted ≤ 5,001-document read on every finance request for a large event. Skipping it when `commSpend.ok` is a one-line, semantics-preserving improvement (and the audit explicitly does **not** require it now).

---

## 7. Registration performance

No regression: the organizer analytics path contains **no raw registration scan, no 5k/10k cap on a canonical count, no newest-first truncation and no per-registration loop**. Canonical registration figures come from `count()` aggregates (7 status + 7 payment split + 12 source composition), the counter document + attendance shards, and IST daily rollups. Per-pass value is `sum('amount')` × 2 per pass under a hard 60-aggregate budget with `limits.passValue` disclosure. Attendance is a `count()` on `checkedInAt`.

| Registrations | Aggregates | Documents transferred by registration reads |
|---|---|---|
| 5,000 | ~26 + ≤60 pass | 0 |
| 20,000 | identical | 0 |
| 50,000 | identical | 0 |
| 100,000 | identical | 0 |

Cost moves only with **passes** (budgeted) and **window length** (≤ 90 rollup docs × 2). Architecture supports; measured at 20k on the emulator (12-28/12-29 suites), **not** benchmarked at 50k/100k.

---

## 8. Financial performance

- `includeFinancial` is computed in the route from `transactions` **before** the producer runs; every financial read (`readCommunicationSpend`, `aggregateValueByPass`, `sumConfirmedRevenueFromLedgerChecked`, `getCouponPerformance`, `platformTransactions`, all three `getRefundTotals`) is behind that flag. An unauthorized request issues **zero** financial queries — the cheapest possible guarantee that money cannot leak.
- Ledger and refund reads are capped and disclose truncation (`out_of_budget`, `limits.ledger`, `complete:false`).
- Comparisons do not duplicate financial reads *except* F-1 (refunds), which is the finding.
- Could a financial value ever be cached incorrectly today? **No cache exists**, so no. For any future cache the risk is real and is the reason for the §9 conditions: the payload's *shape* encodes permission, so one entry keyed without `includeFinancial` would serve `revenue` to a manager.

---

## 9. Cache safety

Current state: `Cache-Control: no-store` on both analytics routes; `cache: 'no-store'` on the client fetch; no `unstable_cache`, no LRU, no Redis, no cache collection. The only precedent in the repo is `lib/config/businessConfigService.ts` — an in-process 60 s TTL over **one global, non-personal document**, which is precisely the case where a TTL cache is safe.

If a cache were ever added, the **minimum safe key** is:

```
workspaceUid · eventSlug · range.from · range.to · comparison.enabled · includeFinancial · schemaVersion
```

- `workspaceUid` and `eventSlug` are mandatory isolation dimensions.
- `range` must be the **resolved** window (from/to), never the preset — `30d` means different days tomorrow.
- `includeFinancial` is the **minimum authorization dimension**: it is exactly the boolean that changes the payload's shape. Role is *not* required and must not be used — two managers with identical permission scope share a correct entry, and adding role would fragment the cache without adding safety.
- Capability/panel state derives from the event document and feature flags; flags are workspace-global and already TTL-cached, so a flag flip could serve a stale module list for the TTL — acceptable only if the TTL is short and stated.
- No user id in the key, and therefore **no user-specific data may ever enter the payload** (today it does not — verified across 12-26/12-28/12-29/12-31: no names, emails, phones or ids of people).

A cache must never allow workspace A → B, event A → B, finance → non-finance, or an unauthorized caller to retrieve a previously cached financial response. The structural guarantee is that **authorization must precede cache lookup** (§19): the key is derived from the authorization result, not from the request.

---

## 10. Cacheable / non-cacheable classification

| Section | Class | Why |
|---|---|---|
| `scope`, `capabilities`, `limits`, `coverage` | **B** — safe only with strict keying | derived from event doc + flags + the reads themselves; changes when a capability is toggled |
| registration counts, status/payment split | **A** — safe for short TTL | monotone-ish aggregates; a minute of staleness is visible but not misleading |
| registration trends (`byDay`, `period`) | **A** | rollups; written in the registration transaction |
| attendance / operations | **C — request-local only** | check-in is the one live, second-by-second surface; a stale attendance figure on event day is actively harmful |
| communications counts, window, signals | **A** | messaging is not second-critical |
| refunds, revenue, spend, coupon discount | **B, with `includeFinancial` in the key** — and this audit recommends **D (uncached)** for a first implementation | a stale money figure is the most expensive wrong number the product can show, and the refund win is available without caching |
| comparisons (`ComparedMetric`) | inherits the strictest class of its two windows | never cache a delta separately from its inputs |
| `participants.composition` | **A** | lifetime aggregates |
| `insights` | **not applicable** | computed client-side from the payload; caching the payload caches the insights |
| event identity (`events/{slug}` read) | **C — request-local** | the clean, evidenced win (F-2); a cross-request cache adds ownership-staleness risk for one document read |

Nothing is classed **E**: the evidence is sufficient throughout.

---

## 11. Failure / unavailable semantics under a cache

A cache must preserve, byte-for-byte, the discipline the modules spent seven phases establishing: `Count = number | null`, `MaybeMoney { ok:false, reason }`, `RevenueState` / `revenueUnavailable` (dashboard contract), `coverage.partial`, `coverage.unavailable`, `baselineOutsideCoverage` (as `ComparedMetric.unavailable`), `limits.*`, absent keys for unauthorized or unsupported.

Rules any future cache must obey:

1. **Never cache a failed or partial response.** A `null` count, a `gone(...)`, `limits.* === false` or `coverage.unavailable` means the read did not answer — storing it turns a transient failure into a minutes-long lie, and storing the *successful* older copy in its place turns a failure into undisclosed stale data. A response containing any failure marker should bypass the cache on write.
2. Never re-key or re-shape on read; serve the stored object exactly, so an absent `revenue` key stays absent.
3. Never merge a cached section with a fresh one — partial coverage would silently become complete.
4. Cache misses and cache errors must fall through to the live read, never to an empty payload.

---

## 12. Freshness requirements

**The repository contains no explicit freshness SLA for analytics.** No config value, no comment and no product document states one; the only staleness policy in the codebase is the config layer's 60 s TTL. This audit therefore states requirements as *derived from what writes the data*, not as invented SLAs:

| Module | Write cadence | Derived requirement |
|---|---|---|
| Operations / attendance | per scan, transactional | near-real-time — request-local only |
| Registrations (counts, trend) | per registration transaction + rollup | seconds acceptable |
| Revenue / refunds | per payment/refund + reconciliation cron (02:00 IST) | seconds; staleness must never be undisclosed |
| Communications | per send + provider webhook | minutes acceptable |
| Participants (composition) | per registration | minutes acceptable |
| Capabilities / limits / coverage | per configuration change | minutes acceptable |
| Insights | derived | exactly as fresh as the payload |

---

## 13. Reports vs Analytics duplication

Reports (`lib/reports/builders.ts`) uses its own `fetchScoped`/`reduceScoped` readers over `platformTransactions`, `settlementRequests`, `walletTransactions`, `broadcastCampaigns` — and **shares one canonical reader with Analytics for refunds** (`listOrganizerRefunds`). The two systems run in different requests, produce different artefacts (operational intelligence vs export documents) and have different date semantics (Reports is UTC `rangeBounds`; Analytics is IST). There is no per-request duplication between them.

Recommendation: **do not merge, do not share a cache.** Sharing a cache would couple Reports' UTC windows to Analytics' IST windows and make an export's correctness depend on an analytics cache entry. Continuing to share *canonical readers* (as refunds already do) is the right coupling.

---

## 14. Insights performance

Confirmed unchanged from RD-12-31: `AnalyticsResponse → buildInsights(response) → Insight[]`.

- Zero DB reads, zero fetch, zero independent computation — pinned by source assertion (no `firebase`, `adminDb`, `fetch(`, `Date.now`, `new Date`, `Math.random`, `process.env`) and by the QA script, which esbuild-bundles the engine and finds **0** Firebase references.
- Complexity: 19 rules × O(1) field reads + a sort of ≤ 26 candidates; 1,000 full runs over the busiest fixture complete in < 500 ms (test 39).
- Deterministic: identical payload → identical ids and order (test 34).

Insights has not become a data source and must not.

---

## 15. Scale assessment

| Registrations | Aggregates | Doc batches | Capped pages | Refund block (F-1) | Hotspots |
|---|---|---|---|---|---|
| 5,000 | ~120 | ~5 | 4 (all under cap) | 6 counts + ≤ 3×(refunds) | refunds ×3 |
| 20,000 | ~120 | ~5 | ledger may approach 5,001 | same | refunds ×3, ledger page |
| 50,000 | ~120 | ~5 | ledger likely **over** cap → `out_of_budget` + `limits.ledger=false` (correct, disclosed) | same | ledger page, refunds ×3 |
| 100,000 | ~120 | ~5 | ledger over cap; emailLogs page likely over cap (spend fallback withheld, `limits.communications=false`) | same | same |

Registration count itself never changes the aggregate cost. What grows are (a) the **platformTransactions ledger page** (one row per paid transaction) and (b) the **emailLogs spend-fallback page** (one row per message) — both already overflow-detected and disclosed rather than truncated silently. Refund volume is the only input that can grow the refund block, and it is capped at 1,000 with an exact count preserved.

**Architecture supports** these volumes; **benchmark proved** only 20k (emulator suites in 12-28/12-29, plus the 20,500-row participant composition test). No 50k/100k measurement exists and none is claimed.

---

## 16. Worst-case legitimate request

Largest supported event, 90-day range, comparison on, `transactions` held, refunds present, communications active, identifiers + timing enabled:

- ~120 aggregate queries (zero documents)
- 2 × `getAll` of 90 rollup docs = 180 documents
- 4 capped pages: platformTransactions ≤ 5,001, emailLogs ≤ 5,001, certificates ≤ 5,001, scheduledReminders ≤ 501
- refund block: 6 counts + ≤ 3,150 documents + ≤ 150 `paymentIntents` point gets
- 2 × `events/{slug}`, 1 × `identifierConfigs`, 1 × counter + shards, 1 × coverage
- Insights: 0 reads

**Top three hotspots:** (1) the triple refund read with its bounded N+1 (F-1) — up to 150 point gets on the critical path; (2) the four capped pages, of which the emailLogs spend-fallback is avoidable when the `sum()` succeeded (F-4); (3) the seven-page navigation pattern re-running the whole graph per module (F-6).

---

## 17. Caching strategy options

| Option | Correctness | Complexity | Invalidation | Authorization | Cost | Operational risk | Stale risk |
|---|---|---|---|---|---|---|---|
| **A — no caching** (today) | perfect | none | n/a | none to get wrong | highest reads | none | none |
| **B — request-local memoization** (refunds, event doc) | perfect (same request, same data) | very low, no new module needed | n/a — lives and dies with the request | none: authorization already happened upstream | removes ~2/3 of refund work + 1 doc | none | none |
| **C — short-TTL in-process cache of `AnalyticsResponse`** | correct only with the full §9 key and the §11 rules | moderate | TTL only; no write-path invalidation exists | key must be derived from the authorization result | would fix F-6 (7 pages → 1 graph) | per-instance cache on serverless = low hit rate; memory growth | financial staleness, undisclosed |
| **D — persistent Firestore cache collection** | adds a new source of truth to keep honest | high | needs writers on every registration/payment/check-in | new rules surface | replaces reads with reads | a second thing to reconcile | high |
| **E — external cache (Redis/Upstash)** | as C plus network | high | as C | as C plus a new trust boundary | new infrastructure and bill | new dependency in the request path | as C |

**Recommendation: B now; C only if F-6 becomes a measured product problem; D and E rejected.** Option C's real benefit is the seven-fetch navigation pattern, and that is better solved on the client (share one payload across module pages for a `(slug, preset)`) than by caching a permission-shaped object on the server — a client-side share cannot cross a workspace, an event or a permission boundary, because the payload never leaves the session that was authorized for it. That client change is *not* in this phase's boundary and is recorded as a candidate for a future UX/performance phase.

---

## 18. Index / rules implications

None of the recommended work needs an index or a rule. Every query in §3 is served today by declared composites or by equality merges. Deferred items that *would* need indexes (recorded, not implemented): windowed `deliveryUnknown` (12-28 F-7), windowed `registrationSource` (12-29), `checkedInSource` aggregation (12-27), `crmContacts.totalRegistrations` (12-29). **No index deployment in this phase.**

---

## 19. Security / performance interaction

The hard boundary: `authorizeAnyWorkspace` → event ownership (`identity.organizerUid !== authz.workspaceUid`) → `requireEventScope` → `includeFinancial` → **only then** any read. Gate-only roles are refused before the producer is reached (`isCheckinOnlyRole`).

Request-local memoization (Option B) cannot move authorization: the memo is created inside a request that has already passed all four checks, and it is discarded with it. A cross-request cache (C/D/E) *could* invert the order if the key were built from request parameters rather than from the authorization result — the lookup would then happen before the caller was proven to own the event. Any future cache must therefore compute its key **after** authorization, from `authz.workspaceUid` and the resolved `identity`, never from `req.nextUrl`. This is the condition that matters most in §23.

---

## 20. Findings

| ID | Sev | File(s) | Evidence | Impact | Scale relevance | Recommended action | Now? |
|---|---|---|---|---|---|---|---|
| F-1 | **P1** | `lib/analytics/eventAnalytics.ts:824,842,846`; `lib/finance/financeAnalytics.ts:248,260`; `lib/refunds/registrationRefunds.ts:230,241` | three identical `listOrganizerRefunds(uid, {eventSlug})` reads; range applied in memory | up to 6 counts, 3,150 docs, 150 point gets per finance request | grows with refund count (capped 1,000) | read once per request, apply the three range filters to that read | **yes** |
| F-1b | P3 | `registrationRefunds.ts:210` | one `paymentIntents` get per unattributed candidate | bounded N+1 | capped at 50 | none; F-1 removes 2/3 of it | no |
| F-2 | **P2** | route `:94`; `eventAnalytics.ts:271,557` | `events/{slug}` read twice | 1 extra doc + 1 round trip per request | constant | pass the resolved identity into the producer, or memoize per request | **yes** |
| F-4 | P3 | `eventAnalytics.ts:980` | spend-fallback page read even when `sum()` succeeded | ≤ 5,001 docs on finance requests | grows with message volume | skip the page when `commSpend.ok` | optional |
| F-6 | P2 | `components/analytics/useAnalyticsScope.ts:71-98` | one fetch per module page; 7 pages | whole graph × 7 per navigation | constant per request, linear in navigation | client-side payload sharing (future phase) | no |
| F-3, F-5, F-7, F-8 | P3/none | — | disjoint or distinct aggregates; authorization already single-pass | none | — | no action | no |

**Counts: P0 = 0, P1 = 1, P2 = 2, P3 = 4.**

---

## 21. Recommended implementation boundary (if approved)

**In scope for RD-12-32 implementation — nothing else:**

1. **Refund read deduplication (F-1).** One `listOrganizerRefunds` per `(organizerUid, eventSlug)` per request; the lifetime, window and baseline totals become three in-memory range filters over that one read. Preferred shape: expose the existing in-memory filter (e.g. `refundTotalsFromRead(read, scope)`) beside `getRefundTotals` so both Analytics and Reports keep one canonical reader and identical semantics — `count`, `amount`, `unlinked`, `recovered`, `complete` and every `gone(...)` path must be byte-identical to today.
2. **Single event-identity read (F-2).** The route already resolved `events/{slug}`; pass that identity into `getEventAnalytics` (optional parameter, defaulting to the current read so the admin and export routes are unaffected), or memoize the document for the request.
3. *(Optional, same risk class)* **Skip the emailLogs spend-fallback page when the `sum()` aggregate succeeded (F-4).**

**Explicitly out of scope:** any server-side cache (in-process, Firestore or external), any TTL, any cache collection, any index, any rule, any change to calculations, contracts, permissions, navigation, UI, Reports, CRM, participants, communications or revenue semantics, and the client-side payload sharing of F-6.

---

## 22. Future test requirements

For the approved boundary: same-request refund read is issued **once** (spy/source assertion on `listOrganizerRefunds`); the three totals equal today's values for the same fixture (lifetime, window, baseline), including the `out_of_budget`, `query_failed` and `complete:false` paths; a refund outside the window is excluded from the window total and included in lifetime; `events/{slug}` is read once per request and the admin/export routes still work when no identity is passed; unauthorized requests still issue zero financial reads; emulator: refund dedup at 1,000+ refunds and the over-cap path; 20k-registration payload unchanged field-for-field before and after; Insights output identical for the same payload.

For any *future* cache phase (not approved here): cache key isolation (workspace, event, range, comparison, `includeFinancial`); authorized vs unauthorized never share an entry; failed/partial responses are never stored; coverage, limits and comparison reasons survive a round trip; cache miss and cache error fall through to the live read; stale-entry behaviour is disclosed.

---

## 23. Final verdict

**APPROVED WITH CONDITIONS.**

Conditions RD-12-32 implementation must satisfy:

- **C-1** Implement only §21 items 1–2 (and optionally 3). No cache of any kind — in-process, Firestore or external — and no TTL.
- **C-2** Refund semantics must be byte-identical after deduplication: the same `count`/`amount`/`unlinked`/`recovered`/`complete`, the same `gone('out_of_budget')` / `gone('query_failed')` paths, and no change to `REFUND_READ_CAP` or `UNATTRIBUTED_REFUND_SCAN_CAP`.
- **C-3** One canonical refund reader remains shared with Reports; no second reader, no divergent filter.
- **C-4** Authorization order is unchanged: no read may move ahead of `authorizeAnyWorkspace` → ownership → `requireEventScope` → `includeFinancial`, and any reuse must live and die inside one request.
- **C-5** No failure/absence contract may change: `Count` nulls, `MaybeMoney`, `coverage`, `limits`, `ComparedMetric.unavailable` all preserved exactly.
- **C-6** No index, rule, collection, contract, permission, navigation, UI, Reports, CRM or semantic change; the 20k payload must be field-for-field identical before and after.

---

## 24. Worktree verification

HEAD `b7e5fdf`; 0 staged; only file created: `docs/RD-ANALYTICS-12-32-PERFORMANCE-CACHING-AUDIT.md`. No source, test, index, rule, schema, data, cache, infrastructure or deployment change; no commit, push or deploy; no reset/clean/stash/checkout/restore/revert; no CRLF/LF normalisation; concurrent workstream files (including the legacy Analytics landing page) read only.

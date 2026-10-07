# RD-ANALYTICS-12-25 — Dashboard Revenue Alias Removal Audit

**AUDIT ONLY.** No source, test, type, serializer, schema, index or rule was modified. The alias
was **not** removed. This document is the only artifact.

---

## 1. Executive Summary

**APPROVED FOR DASHBOARD ALIAS REMOVAL.** `DashboardEvent.revenuePaise` can be removed in the next
implementation phase.

Every precondition the brief set is met, and each is backed by a search rather than an assumption:

| Precondition | Finding |
|---|---|
| No runtime consumer requires the alias | **Zero.** No file reads `.revenuePaise` off a `DashboardEvent` |
| No API/client contract requires it | **Zero.** No public route, webhook, SDK, OpenAPI schema or runtime validator exists |
| No test requires it except migration assertions | **Confirmed.** 6 assertions in one file pin it, all by design |
| No serializer emits it independently | **Confirmed.** One spread, one importer |
| No dynamic property access depends on it | **Zero** bracket-notation hits repository-wide |
| No persisted field is being confused with it | **Confirmed.** `registrationCounters.revenuePaise` is a different artifact |
| No unrelated `revenuePaise` would be removed | **Confirmed.** The removal touches one declaration and one spread |
| Removal alters no semantics or authorization | **Confirmed.** The canonical field already carries them |

**Removal is internal-only and non-breaking.** The surface is four lines of production code across
two locations, plus six test assertions.

**Two findings worth recording:**

- **A seventh unrelated `revenuePaise` quantity exists that RD-12-23 did not list** —
  `features/media-credits/**` platform totals (Σ `amountPaise` over media-credit purchases). It
  strengthens rather than weakens the earlier conclusion, and must be left alone.
- **`toLegacyRevenueFields` must NOT be deleted** after the alias goes. It loses its last
  production *importer* but keeps its job: `toConfirmedRevenueFields` delegates to it. The export
  becomes unnecessary; the function does not.

## 2. Exact Alias Definition

The removal target is **one field on one interface**:

```ts
// app/api/organizer/dashboard/route.ts:194
/**
 * @deprecated RD-ANALYTICS-12-24 · renamed to `confirmedRevenuePaise`.
 * Retained as a compatibility alias for one deploy. …
 */
revenuePaise:    number | null
```

emitted at exactly one site:

```ts
// app/api/organizer/dashboard/route.ts:1481
...toLegacyRevenueFields(revenue),
```

Nothing else is in scope.

## 3–4. Full Occurrence Inventory and Classification

Repository-wide, excluding `docs/`. Every occurrence classified per the brief's scheme.

### A · DashboardEvent compatibility alias — **THE ONLY REMOVABLE CATEGORY**

| File:line | Kind | Reachable at runtime? | Safe to remove? |
|---|---|---|---|
| `app/api/organizer/dashboard/route.ts:194` | type declaration | n/a (type) | **Yes** |
| `app/api/organizer/dashboard/route.ts:1481` | serialize (spread) | **Yes** — emitted on every dashboard response | **Yes** |
| `app/api/organizer/dashboard/route.ts:16` | import of `toLegacyRevenueFields` | n/a | **Yes**, once the spread goes |

**Three occurrences. No reads anywhere.**

### B · Persisted Firestore field — MUST REMAIN

`registrationCounters.revenuePaise` — a stored document key, written by `FieldValue.increment` in
`registrationCounters.ts:257` and `registrations.ts:563`, read at `dashboard/route.ts:1184`,
`events/route.ts:318`, `events/[eventId]/route.ts:343`, declared in `registrations/types.ts:187`,
reconciled in `reconciliation/events.ts`. Renaming it would be a **data migration**, explicitly
out of scope since RD-12-23.

### C · Daily stats / rollup — MUST REMAIN

`lib/dashboard/dailyStats.ts` (12 occurrences), `dailyStatsAdmin.ts` (3),
`DashboardData.trendDays[]` (`route.ts:653`), the trend aggregations (`route.ts:1232, 1242, 1496,
2125, 2139, 2140`), `components/dashboard/TrendPanel.tsx:29,89`, and
`reports/page.tsx:46, 80, 89`. **Day-attributed** revenue — RD-12-23 proved it decrements under
different rules from the counter and answers a different question.

### D · Analytics period / window — MUST REMAIN

`lib/analytics/normalize.ts:332–337, 366–367, 518`, `contract.ts:337`, `revenueModel.ts:136,142`,
`eventAnalytics.ts:121,139,618,636,1003`, `components/analytics/overview/AnalyticsOverview.tsx:252–254`.
**Windowed** revenue, documented in source as deliberately *not* the lifetime figure.

### E · Platform licence revenue — MUST REMAIN

`lib/admin/organizer360Types.ts:70,88`, `organizer360Service.ts:107,217,224–238,359`,
`lib/analytics/adminAnalytics.ts:20,98,152`, `platformMonitorService.ts:156,158`, and the four
Admin page clients. Money paid **by** organizers **to** RegisterDesk — the opposite direction.

### F · Admin Event360 counter-only — MUST REMAIN

`lib/admin/event360Types.ts:90`, `app/api/admin/events/[slug]/360/route.ts:108`,
`admin/events/[slug]/PageClient.tsx:296`. Counter-only, **no ledger fallback** — legitimately
differs from the ledger-backed figure on an un-backfilled event.

### G · Internal accumulators and serializer internals — MUST REMAIN

`events/[eventId]/route.ts:315,322,343,359,398` (`StatsResult`, the input to `RevenueState`) and
`lib/finance/revenueState.ts:111,116,118,119,165` (`LegacyRevenueFields`, the encoder's own
output shape). Neither is the DashboardEvent wire field.

### H · Documentation / comments — MUST REMAIN

Prose in `presentation.ts:86`, `dashboard/page.tsx:634`, `reports/page.tsx:214`,
`events/route.ts:64,281,406`, `registrationCounters.ts:115,133`, plus the `docs/` history.

### I · Unknown — **NEW, and not in the RD-12-23 inventory**

`features/media-credits/utils/platformTotals.ts:62,81,86,98,99` and
`components/AdminCreditsConsole.tsx:51,314` — `revenuePaise` accumulated from
`p.amountPaise` over media-credit purchases: **platform media-credit sales income**. RD-12-23
listed six unrelated quantities; this is a **seventh**. It is unambiguously not confirmed ticket
revenue, is untouched by anything in this migration line, and **must remain**. Reclassified from
*Unknown* to *must remain* on the evidence of its own source.

## 5. Serializer Audit

```ts
toLegacyRevenueFields(s)      // lines 115-120 — THE encoder
toConfirmedRevenueFields(s)   // lines 164-167 — delegates to it, renames the key
```

| Question | Answer |
|---|---|
| Is `toLegacyRevenueFields` now used only for DashboardEvent compatibility? | **As an import, yes** — `dashboard/route.ts` is its only production importer |
| Does any other API depend on it? | **No.** `/api/organizer/events` and `/events/[eventId]` use `toConfirmedRevenueFields` |
| Does removal require changing the serializer? | **No.** Delete the spread and the import; the module is untouched |
| Can `toConfirmedRevenueFields` become the sole DashboardEvent encoder? | **Yes** — it is already spread there, immediately above the alias |
| Does any consumer import `toLegacyRevenueFields` directly? | **No consumer.** Only the dashboard route and `revenueState.test.ts` |

**The trap to avoid:** `toLegacyRevenueFields` will have **zero production importers** after
removal but is still called *internally* by `toConfirmedRevenueFields` (line 165). Deleting it as
"dead" would break every organizer revenue contract. The correct cleanup is to drop the `export`
keyword, not the function — and even that is optional.

## 6. DashboardEvent Type Audit

| Property | Finding |
|---|---|
| `confirmedRevenuePaise` declared | line 186, **required**, `number \| null` |
| `revenuePaise` declared | line 194, **required** (not optional), `number \| null` |
| Marked `@deprecated` | **Yes** |
| Generic types derived from it | **None** — no `Pick`, `Omit`, `Partial` or mapped type references `DashboardEvent` anywhere |
| Runtime validation / schema | **None** — no zod or equivalent validates this payload |
| Other references | `DashboardData.events: DashboardEvent[]` (line 652), the mapping (line 1438), and `reports/page.tsx` importing the type for `EventRow` |

**Smallest safe removal surface: one property declaration + its JSDoc.** Because the field is
required rather than optional, removal is a compile-time-visible change — which is a *benefit*:
anything still depending on it fails loudly at `tsc` rather than silently at runtime.

## 7. API Contract Audit

| Route | Emits the alias? | Independent construction? | Hidden fallback? |
|---|---|---|---|
| `/api/organizer/dashboard` | **Yes** — the only emitter | **No** — one `revenue` state, two spreads | **No** |
| `/api/organizer/events` | No | No — `toConfirmedRevenueFields` only | No |
| `/api/organizer/events/[eventId]` | No | No — `toConfirmedRevenueFields` only | No |
| Any other route returning DashboardEvent | **None exist** | — | — |

Canonical field confirmed as `confirmedRevenuePaise`; the unavailable contract remains
`0 + revenueUnavailable: true`, locked by RD-12-24.5 and unchanged by anything here.

## 8. Client Consumer Audit

`reports/page.tsx` is the only `DashboardEvent` importer, and both RD-12-24 migration sites read
the canonical field:

```ts
// EventRow
event.confirmedRevenuePaise && !event.revenueUnavailable …
event.confirmedRevenuePaise === null || event.revenueUnavailable ? '—' …

// summary
e.confirmedRevenuePaise !== null && !e.revenueUnavailable
scopedEvents.reduce((s, e) => s + (e.confirmedRevenuePaise ?? 0), 0)
```

Checked and clear on every surface the brief named:

| Surface | Reads DashboardEvent? | Uses the alias? |
|---|---|---|
| Dashboard reports page | **Yes** | **No** — canonical only |
| Event cards (`presentation.ts`) | No — reads `EventListItem` | No |
| Event overview (`eventOverview.ts`) | No — reads `EventDetailResponse` | No |
| Reports tab | No — reads `EventDetailResponse` | No |
| Command centre | No — reads `EventDetailResponse` | No |
| Hooks / context / selectors / adapters | **None reference `DashboardEvent`** | — |
| Sorting / filtering | **No consumer sorts or filters on any revenue field** | — |
| Analytics presentation | Separate contract (`MaybeMoney`) | No |

`lib/analytics/normalize.ts:366` declares a **structural** type containing `revenuePaise` for a
dashboard-shaped input. RD-12-23 established it is never read for money (only `capacity` and
`registered` feed the fill rate). It does not import `DashboardEvent`, so removal will not break
its compile — but it is listed in the plan (§16) as a verification point, because a structural
type that no longer matches its source is a latent trap.

## 9. Test Audit

| Class | Where | Action needed on removal |
|---|---|---|
| **1 · Proves the temporary alias** | `revenueState.test.ts` — RD-12-24 cases A, B, D, E, E2 (`w.revenuePaise`, the `wire()` helper at 224), case J (`'…the deprecated alias is still emitted'`), and three source assertions pinning `'...toLegacyRevenueFields(revenue)'` (lines 196, 270, 339) | **Repoint or delete** |
| **2 · Proves the canonical field** | RD-12-24 cases A–K asserting `confirmedRevenuePaise` | **Keep unchanged** |
| **3 · Unrelated `revenuePaise`** | cases F, G, H, H2, I2 (counter, Analytics, Event360, licence, trendDays) | **Keep unchanged — they are the guard** |
| **4 · Serializer-function tests** | `revenueState` cases 1–9 calling `toLegacyRevenueFields` directly | **Keep unchanged** — the function survives (§5) |
| **5 · Must remain** | `eventOverview`, `eventsLanding`, `organizerRevenueBoundary`, `registrationReportSources` — all on `EventListItem`/`EventDetailResponse`, not DashboardEvent | **Untouched** |

**Exactly six assertions and one helper require change**, all in `tests/unit/revenueState.test.ts`:
lines 196, 270, 284, 339 (and case J's two), plus the `wire()` helper at line 224.

Case J is the interesting one: it exists specifically to assert *"the deprecated alias is still
emitted during this phase"*. Its removal is the intended signal that the phase is over — it
should be **deleted, not weakened**.

## 10. Dynamic / Reflection Audit

Searched for every pattern the brief listed:

| Pattern | Hits |
|---|---|
| `['revenuePaise']` / `["revenuePaise"]` / bracket access | **0** |
| `Object.keys` / `Object.entries` over an event object | **0** |
| Spread of a DashboardEvent into another shape | **0** |
| Destructuring `{ revenuePaise }` from an event | **0** |
| Column / export / table configuration naming the field | **0** |
| Telemetry / logging of the field | **0** |
| Feature flags, query-param or URL-state mappings | **0** |
| `localStorage` / `sessionStorage` in the dashboard or reports pages | **0** |
| Runtime schema (zod or equivalent) over the payload | **0** |

The dashboard response is fetched, rendered and discarded. Nothing persists it, re-serializes it,
or reaches it by a computed key.

## 11. External Contract Audit

Re-verified after RD-12-24, repository and configuration only:

- **No `app/api/v1`**, no OpenAPI or Swagger document, no `sdk/` directory.
- `app/api/public/**` and `app/api/webhooks/**` contain **no** reference to `revenuePaise`,
  `DashboardEvent` or `organizer/dashboard`.
- No export, share card or certificate emits the field.
- No browser persistence (§10).

> **No external consumers exist.** The dashboard response is an authenticated, session-scoped
> organizer endpoint consumed only by this application's own client.

## 12. Backward Compatibility

**Classification: A — internal-only and safe.**

| Axis | Assessment |
|---|---|
| Next.js server/client boundary | Same build ships both; no version skew within a deploy |
| Internal fetch calls | One consumer, already migrated |
| Generated types | None — the type is hand-written and imported directly |
| Cached responses | None — no service worker is registered, no HTTP cache directives on the route |
| Browser persistence | None (§10) |
| Webhook payloads | None (§11) |
| Exports | None (§11) |

**The one real risk is deployment skew** — a browser tab holding the pre-removal bundle while the
server returns the post-removal payload. That is precisely what the one-deploy alias window
existed to cover, and it closes when RD-12-24 ships. The consumer's guards are
`=== null` / `!revenueUnavailable` on `confirmedRevenuePaise`, a field the old bundle never read,
so a stale bundle reading a post-removal payload would find `revenuePaise: undefined` — falsy,
rendering the muted class and a dash rather than `₹NaN`. **Removal should still follow the
deploy**, per the RD-12-19 → 12-20 precedent.

## 13. Authorization / Security

Removal changes none of this, because the canonical field already carries every property:

| Property | Preserved by |
|---|---|
| `transactions` gating | `revenueStateFromCounterMap(revBySlug, slug, financeAllowed)` — unchanged |
| Owner / finance / admin / manager visibility | unchanged — the gate is upstream of both fields |
| Unauthorized `null` | `toConfirmedRevenueFields` → `confirmedRevenuePaise: null`, flag `false` |
| Unavailable `0 + flag` | same encoder, RD-12-24.5-locked |
| Financial read ordering | the gate precedes the aggregate; untouched |
| Financial query suppression | unchanged |

Removing a *duplicate* of an already-gated value cannot widen exposure. If anything it narrows the
surface by one field.

## 14. Semantic Equivalence Proof

Both fields are produced from **one** `RevenueState`, resolved once per event:

```ts
const revenue = revenueStateFromCounterMap(revBySlug, slug, financeAllowed)
...toConfirmedRevenueFields(revenue),   // { confirmedRevenuePaise, revenueUnavailable }
...toLegacyRevenueFields(revenue),      // { revenuePaise,          revenueUnavailable }
```

and `toConfirmedRevenueFields` **delegates** to `toLegacyRevenueFields`, so the two values are
literally the same expression under two keys:

```ts
const { revenuePaise, revenueUnavailable } = toLegacyRevenueFields(s)
return { confirmedRevenuePaise: revenuePaise, revenueUnavailable }
```

| Case | `confirmedRevenuePaise` | `revenuePaise` | Equal? |
|---|---|---|---|
| authorized, positive | `s.paise` | `s.paise` | ✅ |
| authorized, zero | `0` | `0` | ✅ |
| authorized, unavailable | `0` (flag true) | `0` (flag true) | ✅ |
| unauthorized | `null` | `null` | ✅ |
| no slug / unpublished | `0` | `0` | ✅ |
| slug absent from map | `0` | `0` | ✅ |

**Divergence is unconstructible** — it would require the delegation to stop delegating. Test case
E2 already asserts equality exhaustively across every state, and case E asserts the structural
single-source property. **No reachable case differs.**

## 15. Dead-Code Assessment

What removal would leave behind, none of which may be deleted blindly:

| Item | Becomes | Correct action |
|---|---|---|
| `toLegacyRevenueFields` | zero production importers, **still called internally** | **KEEP the function.** Optionally drop `export` |
| `LegacyRevenueFields` interface | used only as that function's return type | Keep; optionally un-export |
| `toLegacyRevenueFields` import in `dashboard/route.ts` | unused | **Remove** — lint would flag it |
| RD-12-24 case J | asserts a field that no longer exists | **Delete** — its purpose is served |
| Source assertions at lines 196, 270, 339 | pin a spread that no longer exists | **Repoint** to the canonical spread |
| `wire()` helper (line 224) | spreads a removed serializer | **Simplify** to the canonical fields |
| RD-12-24 documentation | describes a temporary state | **Keep as history** — do not rewrite |

## 16. Exact Future Removal Plan

**Do not execute. For the next phase.**

1. **Type removal** — delete the `revenuePaise` property and its `@deprecated` JSDoc from
   `DashboardEvent` (`dashboard/route.ts:188–194`). Leave `confirmedRevenuePaise` and
   `revenueUnavailable` exactly as they are.
2. **API response** — delete the single line `...toLegacyRevenueFields(revenue),` (line 1481).
   Keep `...toConfirmedRevenueFields(revenue),` and the `const revenue` local above it.
3. **Serializer** — **no change to `revenueState.ts`.** Remove only the now-unused
   `toLegacyRevenueFields` name from the dashboard route's import (line 16). Do **not** delete the
   function (§5).
4. **Consumer verification** — `tsc` proves it: the field is required, so any surviving read is a
   compile error. Additionally confirm `normalize.ts:366`'s structural type still matches its
   input (§8).
5. **Tests** — delete RD-12-24 case J; repoint the three source assertions (196, 270, 339) to the
   canonical spread; simplify the `wire()` helper (224); drop `w.revenuePaise` comparisons in
   cases A/B/D/E2. **Keep cases F, G, H, H2, I2 untouched — they are what prevents an over-broad
   removal.** Add one assertion that `DashboardEvent` no longer declares the alias.
6. **Dead-code cleanup** — per §15. Nothing beyond the unused import is required.
7. **Validation** — focused revenue/dashboard tests → full vitest → `tsc --noEmit` → ESLint on
   touched files → `next build` (isolated `NEXT_DIST_DIR`, restore `tsconfig.json` from a
   pre-build backup) → organizer emulator suites.
8. **Browser** — optional. One pass on the reports page confirming the revenue column still
   renders value / `₹0` / `—` correctly is cheap insurance, since that page is the only consumer.

**Explicitly preserved throughout:** every occurrence in categories **B, C, D, E, F, G, H and I**
(§3–4). The removal must touch **one declaration and one spread**, nothing else. No global
replacement, no regex sweep.

## 17. Final Classification Table

| Area | Status | Evidence | Risk | Required action |
|---|---|---|---|---|
| Field identity | **PASS** | 3 occurrences, all in `dashboard/route.ts` | None | — |
| Runtime consumers | **PASS** | 0 reads of `DashboardEvent.revenuePaise` | None | — |
| Dynamic access | **PASS** | 0 bracket/reflection/persistence hits | None | — |
| Serializer | **PASS** | 1 importer; `toConfirmedRevenueFields` already spread beside it | None | Keep the function (§5) |
| Type derivations | **PASS** | No Pick/Omit/mapped/schema depends on it | None | — |
| API contract | **PASS** | 1 emitter, no fallback, no independent construction | None | — |
| Client consumers | **PASS** | `reports/page.tsx` fully migrated | None | — |
| External contracts | **PASS** | No public/webhook/SDK/OpenAPI surface | None | — |
| Semantic equivalence | **PASS** | Delegation makes divergence unconstructible; case E2 exhaustive | None | — |
| Authorization | **PASS** | Gate is upstream of both fields | None | — |
| Backward compatibility | **PASS** | Internal-only; skew degrades to a dash, not `₹NaN` | None | Remove after one deploy |
| Tests requiring change | **GAP** | 6 assertions + 1 helper in one file | Low | Repoint in the implementation phase |
| Dead code after removal | **P3** | `toLegacyRevenueFields` loses importers but is still called | Low — deleting it would break 3 routes | Keep the function; drop only the unused import |
| Seventh unrelated quantity | **P3** | `features/media-credits` platform totals, absent from the RD-12-23 inventory | Low | Leave alone; inventory now corrected |

## 18. Final Verdict

## APPROVED FOR DASHBOARD ALIAS REMOVAL

> **`DashboardEvent.revenuePaise` can be removed in the next implementation phase.**

Two operational notes, neither a condition:

- Remove **after** RD-12-24 has been deployed once, per the RD-12-19 → 12-20 precedent. The
  failure mode if that is skipped is mild here (a dash, not `₹NaN`), but the discipline is cheap.
- Do **not** delete `toLegacyRevenueFields` as dead code. It loses its last importer and keeps its
  job.

---

### Worktree Safety

No file was modified; this audit was read-only apart from creating this document. No `reset`,
`clean`, `stash`, `checkout` or `restore` was run, and no broad replacement was performed. Per
RD-12-23.5, entry counts are context and not proof: the tree still carries its pre-existing
uncommitted work (A), the four RD-12-24 files (B), and the active auth/login UI workstream (C),
none of which this audit touched. Nothing was committed, pushed or deployed; no Firestore schema,
index or rule was modified.

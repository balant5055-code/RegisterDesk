# RD-ANALYTICS-12-33 — PREMIUM ANALYTICS UX IMPLEMENTATION

**Type:** IMPLEMENTATION — presentation only. No calculation, contract, engine rule, permission, route, query, index, rules, cache, collection or Reports change.
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged, 830 worktree entries (`$TEMP/rd1233i-baseline.txt`, 22:40). Pre-edit byte snapshots of every candidate file in the session scratchpad (`rd1233-pre/`).
**Source of truth:** `docs/RD-ANALYTICS-12-33-PREMIUM-ANALYTICS-UX-AUDIT.md` §29 (items 1–5) and its conditions C-1…C-5.
**Concurrent work honoured:** `app/(dashboard)/dashboard/analytics/page.tsx` (legacy landing, `M`, mtime 8 Sep 15:54) and `lib/reports/builders.ts` (`M`, 7 Sep) not opened for writing; `firestore.rules` (3 Sep) / `firestore.indexes.json` (8 Sep) untouched; public-chrome workstream untouched.

---

## 1. Exact UX changes

| Audit ID | Sev | Change | Where |
|---|---|---|---|
| U-2 | P1 | Average order value with **zero paid registrations** renders "No paid registrations yet" — no unavailable mark, no "could not be read". A genuine read failure still renders the mark + reason. | `lib/analytics/revenueModel.ts` (`MoneyRow.emptyDenominatorNote`), `RevenueAnalytics.tsx` (`MoneyMetric`) |
| U-3 | P1 | An event the workspace cannot see (URL `eventId` not in the authorized list) renders its **own placeholder** — "This event is not available in your workspace. It may not exist, may not be published yet, or may not be yours to see. Choose an event from the selector above." — instead of "Select a single event". One sentence for not-found / unpublished / not-yours; nothing says which. | `useAnalyticsScope.ts` (exposes the context's existing `urlEventMissing`), `ModuleChrome.tsx` (`ModuleStates`) |
| U-4 | P2 | Attendance with **zero scans** renders "Not started · No check-ins yet — the rate appears once scanning begins" instead of "0 %". Measured rates with scans, and unavailable rates, are unchanged. | `OperationsAnalytics.tsx` |
| U-5 | P2 | **One event selector**: the module header no longer mounts its own `EventSelector`; the top-bar selector is the only one. | `ModuleChrome.tsx` (`ModuleHeader`), `AnalyticsOverview.tsx` |
| U-6 | P2 | **Capability-gated module strip**: once the payload is known, modules absent from `capabilities.modules` are not linked. Insights and Overview always remain. | `AnalyticsModuleNav.tsx`, `AnalyticsScopeProvider.tsx` (new), 7 module pages |
| U-7 | P2 | Overview H1 is **"Overview"** (eyebrow "Analytics"), through the shared `ModuleHeader`; its panel formerly titled "Insights" is **"Highlights"** — the dedicated Insights module keeps the name. | `AnalyticsOverview.tsx` |
| U-8 | P2 | Overview headline captions carry **"All time ·"** on every lifetime figure; the windowed line beneath keeps "in the last N days". No windowed figure was relabelled lifetime or vice versa. | `AnalyticsOverview.tsx` |
| U-9 | P2 | **Compact mobile header**: eyebrow + title inline, controls in one wrapping row, single-line range; first content block at **254 px** on 390 px (audit measured ~230 px of chrome before any value; now the whole header including strip and range fits above 260 px). | `ModuleChrome.tsx` |
| U-10 | P2 | **Communications window table** no longer has `min-w-[32rem]`: below `sm` each channel is a definition list (every figure kept, nothing hidden, no sideways scroll); from `sm` up the table fits its container with compact padding through `lg`. | `CommunicationsAnalytics.tsx` |
| U-12 | P2 | **Touch targets ≥ 36 px measured, 40 px nominal**: presets `min-h-9` (36 px) inside a 40 px group, Refresh `min-h-10`, strip links `min-h-10`, Insights footer links `min-h-10`. Padding, not font. All are real `<button type="button">` / `<a>`. | `ModuleChrome.tsx`, `AnalyticsModuleNav.tsx`, `InsightsAnalytics.tsx` |
| U-13 | P2 | **Rail-shaped skeleton** while loading (`aria-busy`, `aria-live="polite"`, `animate-pulse motion-reduce:animate-none`): a rail of four and two section blocks in the final layout's shape, replacing the one-line sentence. | `ModuleChrome.tsx` (`ModuleSkeleton`, `Bone`) |

Not changed (per audit §29 "not in the boundary"): U-1 legacy landing (see §13), U-11 Communications restructuring, U-14 terminology, U-15…U-23 P3s, charts.

## 2. Files changed

Source (16 files, presentation layer only):

| File | Δ | Line endings |
|---|---|---|
| `components/analytics/ModuleChrome.tsx` | +97 −21 | LF, preserved |
| `components/analytics/useAnalyticsScope.ts` | +35 −4 | LF |
| `components/analytics/AnalyticsModuleNav.tsx` | +23 −2 | LF |
| `components/analytics/AnalyticsScopeProvider.tsx` | **new**, 20 lines | LF |
| `components/analytics/overview/AnalyticsOverview.tsx` | +37 −102 | **CRLF**, preserved (CR count = line count before and after: 478 → 413) |
| `components/analytics/revenue/RevenueAnalytics.tsx` | +5 −1 | LF |
| `components/analytics/operations/OperationsAnalytics.tsx` | +20 −6 | LF |
| `components/analytics/communications/CommunicationsAnalytics.tsx` | +41 −10 | LF |
| `components/analytics/insights/InsightsAnalytics.tsx` | +6 −3 | LF |
| `lib/analytics/revenueModel.ts` | +11 −2 (presentation model: one optional note string) | LF |
| `app/(dashboard)/dashboard/analytics/{overview,registrations,revenue,operations,communications,participants,insights}/page.tsx` | +8 −4 each (wrap in `AnalyticsScopeProvider`) | LF |

Tests / QA (3 files): `tests/unit/analyticsPremiumUx.test.ts` (**new**, 25 tests), `tests/unit/analyticsOverview.test.ts` (tests 15 and 28 re-anchored to the single-selector shell), `scripts/qa/rd-analytics-12-33-shots.mjs` (**new**).

Documentation: this file. Screenshots in git-ignored `e2e/.shots/rd-analytics-12-33-impl/` (45 captures).

Snapshotted defensively but **byte-identical**: `components/analytics/overview/Primitives.tsx`, `lib/analytics/operationsModel.ts`.

## 3. Empty denominator behaviour

`revenueIntelligence.averageOrderValue` already carries `denominator` in the payload. `lib/analytics/revenueModel.ts` sets `emptyDenominatorNote: 'No paid registrations yet'` only when `aovDenominator === 0`; `MoneyMetric` renders `row.emptyDenominatorNote ?? moneyUnavailableNote(row.money)`. The AOV row definition now reads "Confirmed revenue per paid registration, all time". A read failure (`unavailable` with a reason) still shows the unavailable mark and the reason. Verified on `a28-intel` for owner and finance: "AVERAGE ORDER VALUE — No paid registrations yet" with no read-failure wording (QA check "AOV empty denominator — no read-failure wording"). Unit tests 1–4 pin both branches and the AOV model with a non-zero denominator.

## 4. Unknown / unauthorized event behaviour

`EventContextProvider` already computes `urlEventMissing` (the URL's `eventId` is not in the caller's authorized event list — a single non-leaky signal for not-found, unpublished and not-yours). `useAnalyticsScope` now surfaces it; `ModuleStates` checks `if (urlEventMissing)` before the "Select a single event" branch and renders the sentence quoted in §1. No new resolution logic, no fetch, no event id echoed. A server refusal (403/404 from the analytics route) still renders the server's generic message as `role="alert"`. Verified for owner/finance/admin/manager with `?eventId=does-not-exist`: state distinct from "no selection" and non-leaky (unit tests 5–7; QA "unknown event state distinct from no selection", "…is non-leaky"; capture `desktop-owner-unknown-event.png`).

## 5. Attendance not-started behaviour

`OperationsAnalytics.tsx`: when `attendance.pct !== null && attendance.checkedIn === 0` the rail shows `Not started` with "No check-ins yet — the rate appears once scanning begins"; otherwise the existing `RailMetric` with "Checked in ÷ confirmed, all time" and the "needs both figures" unavailable note. `operationsModel.ts` is untouched — `pct` is still computed and still 0 in the payload; only the rendering branches. Measured rates with scans render the percentage; `pct === null` renders the mark. Unit tests 8–10; QA "attendance Not started, not 0%" for every role at desktop; captures `*-owner-operations.png`.

## 6. Overview provenance changes

- H1 "Overview" with eyebrow "Analytics" via `ModuleHeader` (subtitle "How this event is doing — …"); the event name is no longer the heading (it lives in the top-bar selector).
- Rail captions: registrations "All time · N total across every status"; revenue "All time · Σ ticket value over confirmed registrations" (+ the windowed `RailMovement` line unchanged); checked-in "All time · no check-ins yet" when zero; awaiting payment / cancelled "All time · …".
- Section "Insights" → "Highlights".
- Nothing windowed was relabelled: every "in the last N days" line is still bound to `period.*`. QA cross-checked rendered `540` confirmed against the payload and asserted "lifetime figures captioned All time" and "Highlights section, no second Insights" at all three viewports.

## 7. Selector consolidation

`ModuleHeader` no longer imports or renders `EventSelector`; the top-bar (global) selector is the one selector, and the analytics scope follows it through `useEventContext` exactly as before. `AnalyticsOverview` dropped its private header (and its `EventSelector`/`RefreshCw`/`Loader2`/`ANALYTICS_PRESETS` imports) for the shared `ModuleHeader` + `ModuleStates`. QA on every module × role × viewport: "one event selector (main:0, total:1)" (counted by `aria-label` "Selected event:"). Event switching through the top-bar selector re-fetches as before ("no broken event switching" — the scope hook is unchanged apart from the context wrapper).

## 8. Mobile improvements (390 px)

- Header: eyebrow + title on one line, `text-[length:var(--fs-xl)]` below `sm`, controls wrap in one row, range on one line; first content block top **254 px** (was ~230 px of header chrome *plus* the strip and range before any figure).
- Communications window: list layout below `sm` (§9).
- Strip links, presets, Refresh, Insights footer links all ≥ 36 px measured (§10).
- No horizontal overflow on any of the 7 modules at 390 (`documentElement` and `main` scrollWidth = clientWidth).
Captures: `mobile-owner-*.png`, `mobile-window-list.png`.

## 9. Communications responsive behaviour

`CommunicationsAnalytics.tsx` "Messages in the last N days": `min-w-[32rem]` removed. Below `sm` (`sm:hidden`) each channel renders as a definition list of five label/figure pairs (`PairLine`: unmeasured keeps the mark, measured is `tabular-nums`). From `sm` up (`hidden … sm:block`) the same `<table>` with compact cell padding (`px-2`/`px-3`, widening to `lg:px-3`/`lg:px-5`), so the table fits 834 and 1440 without a swipe (QA: "window table fits its container (1142/1142)" at desktop; list present at 390, no overflow). Every figure appears in exactly one layout at a time; nothing is dropped.

## 10. Touch-target / accessibility changes

- Presets: `<button type="button">` `inline-flex min-h-9` inside a `role="group" aria-label="Date range"` (40 px group); Refresh `min-h-10`; strip links `min-h-10` (`nav aria-label="Analytics modules"`, `aria-current` unchanged); Insights footer links `inline-flex min-h-10`.
- Keyboard: focus ring visible on the strip link (QA "focus ring visible on strip link"), Enter activates a preset (QA "Enter activates a preset (7D)").
- Heading outline: one H1 per module, now including Overview.
- Skeleton announces `aria-busy="true" aria-live="polite"`; pulse respects `motion-reduce`.
- QA "no target under 36px" on all 7 modules × 3 viewports × 4 roles.
No new colour, gradient, shadow or animation; tokens only (`--fs-*`, semantic borders/text) — C-4.

## 11. Loading-state changes

`ModuleStates` loading branch renders `<ModuleSkeleton />`: a rail of four `Bone` blocks and two section blocks matching the module's final shape, so content lands without shifting the header. Early-probe QA confirms "skeleton/placeholder present before data" on every page; captures were taken after settle so the loaded layouts are the ones compared.

## 12. Capability-based visibility

- `AnalyticsScopeContext` (`createContext`) + `AnalyticsScopeProvider` wrap each module page so the strip reads the **same** fetched response — no second fetch, no cache, no new request (C-1; RD-12-32 request budget unchanged).
- `AnalyticsModuleNav`: `offered = capabilities.modules` once known; `ALWAYS = {insights, overview}`; other modules filtered to `offered`. Before the payload is known the full strip renders (progressive), so a denied module never flashes *after* being clicked.
- Measured strips (a29-mix): owner `Insights, Overview, Registrations, Revenue, Operations, Communications, Participants`; admin without Revenue; manager without Revenue and Communications; finance `Insights, Overview, Revenue, Participants`. Staff (gate) never reaches the analytics API and sees no analytics content. Financial gating is untouched: `revenue` key follows `transactions` on every payload checked.
- **Observation for the final audit (not changed here):** a module the strip does not offer is still reachable by direct URL and renders its panel from the payload (e.g. finance at `/dashboard/analytics/communications` sees the Communications panel). This is not a data leak — every non-financial section is authorized by the Analytics permission and only `revenue` is stripped by `transactions` — but the module page has no "not offered for this role" state of its own. Pre-existing; out of §29's boundary.

## 13. Legacy Analytics concurrent-work treatment

`app/(dashboard)/dashboard/analytics/page.tsx` is concurrently modified (`M`, 8 Sep) — not opened for writing, per C-3. The sidebar's "Analytics" row still targets `/dashboard/analytics` (the legacy landing). No navigation SSOT under `lib/navigation/*.ts` names that path (only the untracked `breadcrumbs.ts` rows), and the row's target lives in the concurrently edited dashboard shell area, so no "smallest safe" redirect existed without touching concurrent work. **Deferred integration item U-1** stands exactly as the audit recorded it: when the concurrent work lands, land the sidebar row on the module shell (Insights or Overview) honouring the shared selector and move exports to Reports.

## 14. Test results

| Gate | Result |
|---|---|
| `tsc --noEmit` | clean (0 errors), run after the last edit |
| ESLint on the 19 touched/added files | 0 errors, 1 pre-existing warning (`analyticsOverview.test.ts:54` unused `_req` in an RD-06 mock — line not edited by any phase) |
| `next build` (isolated `NEXT_DIST_DIR=.next-a1233`) | clean, all 8 `/dashboard/analytics*` routes emitted; dist removed; `tsconfig.json` restored to its pre-build bytes |
| `npm run emu:build` | clean ×3 during the phase (last one before the final QA run) |
| Full unit suite `vitest run tests/unit features` | **380 files: 379 passed, 1 failed · 10,452 tests passed, 1 skipped, 1 failed**. The failure is `publicChromeUnification.test.ts › H. MarketingNavbar and MarketingFooter…` — a repo-wide directory walk that hit the 5 s timeout under full-suite load; re-run alone it passes **47/47**. It belongs to the public-chrome workstream and walks no analytics file. (The suite grew from 358 to 380 files across the session; one of those is this phase's.) |
| `tests/unit/analyticsPremiumUx.test.ts` | 25/25 — AOV empty denominator vs failure, unknown event, attendance not started, Overview provenance/Highlights, single selector, chrome/targets/skeleton, strip gating + provider, comms list/table, data safety (no calc/contract/route/rule change) |
| `tests/unit/analyticsOverview.test.ts` | passes with tests 15/28 re-anchored |

Brief §14 required cases → covered: AOV zero paid (1–2), revenue read failure (3), unknown event (5–6), unauthorized/server refusal (7), attendance zero scans (8), measured 0 % with denominator unchanged (9–10), financial authorization unchanged (data-safety group), capability-hidden modules (strip group), one selector (selector group), Communications mobile no-overflow (comms group + browser).

## 15. Browser QA results

`scripts/qa/rd-analytics-12-33-shots.mjs` against the emulator production build (`.next-emulator`, rebuilt before the run; server on 3187, stopped afterwards). **370 checks passed, 0 issues.** Coverage: owner at 1440/834/390 for all seven modules on `a29-mix`; admin, finance, manager at 1440 for all seven; staff (gate) at 1440; unknown-event probe per role; AOV on `a28-intel` (owner, finance); keyboard probe.

Per page: no horizontal overflow (`documentElement`, `main`), no console errors / page errors, one event selector, no target under 36 px, skeleton before data, no literal `NaN`/`undefined`/`null`, strip = `capabilities.modules` (+ Insights/Overview), `revenue` key follows `transactions`. Overview: H1 "Overview", "All time" captions, "Highlights", `540` confirmed rendered from the payload, "no check-ins yet". Operations: "Not started", not "0%". Communications: window list at 390, table fits its container at 834/1440. Revenue (`a28-intel`): AOV "No paid registrations yet" without failure wording. Shell: unknown-event state distinct and non-leaky; focus ring on strip link; Enter activates 7D; first content block top 254 px at 390. Staff: never reaches the analytics API, no analytics content. Event switching via the top-bar selector exercised by the per-event probes (a29-mix → a28-intel).

45 captures in `e2e/.shots/rd-analytics-12-33-impl/` (desktop × 4 roles × 7 modules, tablet × 7, mobile × 7, `desktop-owner-a28-intel-revenue`, `desktop-owner-unknown-event`, `mobile-window-list`).

## 16. Worktree / concurrent-change verification

- `git status --porcelain` before (830 lines) vs after (832): the only status-level delta is `?? components/analytics/AnalyticsScopeProvider.tsx` and `?? tests/unit/analyticsPremiumUx.test.ts` (every other touched file was already `??`/`M` from earlier analytics phases). 0 staged. HEAD still `b7e5fdf`.
- mtime sweep of `app/ components/ lib/ tests/ scripts/ docs/` newer than the baseline: exactly the 19 files in §2 plus `docs/RD-ANALYTICS-12-33-PREMIUM-ANALYTICS-UX-AUDIT.md` (mtime 23:01 — an IDE editor save of the already-written audit, recorded in the transcript as an `edited_text_file` attachment, not a tool write of this phase; still `??`).
- Byte comparison against the pre-edit snapshots: 16 changed as intended, 2 identical; CR counts preserved on every file (AnalyticsOverview CRLF, all others LF).
- Root: `tsconfig.json` byte-identical to the pre-phase backup after each build; `next-env.d.ts` regenerated by the build, no diff to git; `tsconfig.tsbuildinfo` (git-ignored) refreshed by `tsc`.
- Concurrent files not touched: `app/(dashboard)/dashboard/analytics/page.tsx` (8 Sep 15:54), `lib/reports/builders.ts` (7 Sep 11:39), `firestore.rules` (3 Sep), `firestore.indexes.json` (8 Sep), `package.json` (3 Sep), `package-lock.json` (9 Aug). `.next-p5/` and other sessions' dist entries left alone.
- No reset / clean / stash / checkout / restore / revert; no lockfile change; no commit, push or deploy.

## 17. No backend / data / security / index / rules / deploy changes

Confirmed: no file under `app/api/**`, `lib/analytics/eventAnalytics.ts`, `normalize.ts`, `contract.ts`, `modules.ts`, `insightsRules.ts`, `*Sources.ts`, `lib/finance/**`, `lib/auth/**`, `firestore.rules`, `firestore.indexes.json`, `vercel.json` or `.github/**` was modified. The one `lib/` file touched (`revenueModel.ts`) is the Revenue *presentation* model: it adds an optional note string derived from a value already in the payload; no number, threshold, reason or shape of `AnalyticsResponse` changed. Authorization order, financial gating (`transactions`), the RD-12-32 request budget (one fetch per module page; the strip reads the same response through context) and every engine rule are unchanged. Nothing deployed.

## 18. Remaining audit conditions

| Condition | Status |
|---|---|
| C-1 §29 items 1–5, presentation only | **Met** — items 1–5 implemented (U-2/3/4, U-7/8, U-5/9/12/13, U-10, U-6); no calc/contract/rule/permission/route/Reports change (§17) |
| C-2 distinct states, never relabelled marks | **Met** — empty denominator, unknown event, not-started are three new branches; measured zero, unavailable, unauthorized (server alert), not-applicable and not-started remain visually distinct (tests 1–10) |
| C-3 legacy landing untouched | **Met**, and therefore **U-1 remains open** as the deferred integration item (§13) |
| C-4 existing tokens/primitives only | **Met** |
| C-5 verified at 1440/834/390 for owner/finance/admin/manager/gate; financial protection unchanged | **Met** (§15) |

Open after this phase: **U-1** (legacy landing / sidebar target — blocked on concurrent work), the §12 observation (direct-URL access to a module the strip does not offer has no "not offered" state), U-11 and U-14 follow-ups, P3 items U-15…U-23, and the RD-12-28 F-5 Reports "Delivered→Accepted" label still deferred behind `lib/reports/builders.ts`.

---

## Final verdict

**IMPLEMENTED — CONDITIONS REMAIN**

Every item in the audit's implementation boundary is in place and verified in the browser at all three viewports and all five roles with 370 automated checks and the full unit suite green for every analytics file; the one remaining condition is the legacy landing (U-1), which the audit itself placed outside this phase until its concurrent modification lands.

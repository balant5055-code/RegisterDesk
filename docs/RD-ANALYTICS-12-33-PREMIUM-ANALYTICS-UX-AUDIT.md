# RD-ANALYTICS-12-33 — PREMIUM ANALYTICS UX AUDIT

**Type:** AUDIT ONLY — no source, component, style, token, test, rules, index, API, contract or navigation change.
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged, 827 worktree entries (`$TEMP/rd1233-baseline.txt`). No line-ending normalisation, no reformatting, no file touched. `firestore.rules` / `firestore.indexes.json` untouched.
**Concurrent work:** the analytics workstream's uncommitted modules (06 … 12-31) and the public-chrome workstream. `app/(dashboard)/dashboard/analytics/page.tsx` (the legacy landing, the sidebar's "Analytics" target) is **concurrently modified** — read and photographed only.
**Evidence:** 30 page captures + DOM metrics from the emulator production build (`.next-emulator`, built 18:13 today, no analytics source newer than it): owner at 1440/834/390 for all seven modules on `a29-mix` (capacity 90 %, revenue rollups, participants) and Communications/Operations/Overview on `a28-intel`; manager at 1440 for Overview/Revenue/Registrations/Insights; the legacy landing; a loading capture; an unknown-event capture; a keyboard-focus capture. Metrics per page: overflow (`documentElement` and `main`), elements wider than `main`, heading outline, font-size/weight histogram, icon-only controls, sub-32 px targets, box-shadow/gradient/blur counts, table widths, unavailable-mark counts. Shots in `e2e/.shots/rd-analytics-12-33/` (git-ignored). Where a claim is not backed by a capture it is marked *not audited*.

---

## 1. Executive summary

The seven Analytics modules are **coherent, restrained and honest**: one shell (`ModuleHeader` / `ModuleStates` / `Section` / `RailMetric`), every size from the `--fs-*` token scale (no arbitrary pixel sizes in `components/analytics`), one box-shadow on the whole surface (the active preset pill), zero gradients, zero blur, zero icon-only controls, a visible 2 px focus ring, `main` overflow 0 at every width on every module, no runtime or console error on any capture. Provenance discipline is unusually good for a SaaS analytics product — most figures carry a basis line, rates print their denominators, and unavailable is a mark plus a reason rather than a zero.

What keeps it short of premium is not decoration but **a handful of trust and IA seams**, three of them P1:

| # | Finding | Sev |
|---|---|---|
| U-1 | **The sidebar's "Analytics" row lands on the legacy page**, which has its *own* event dropdown reading "No published events" / "Publish an event to see analytics" while the shared selector beside it holds a published event, carries CSV/XLSX/PDF export buttons (a report builder inside Analytics), and a subtitle "Insights for each of your events" that now collides with the Insights module. A first-time user's first screen contradicts the product. (Concurrently modified — documented, not touched.) | P1 |
| U-2 | **Average order value with zero paid registrations prints "— could not be read"** while its own caption says "no paid registrations yet". A measured empty denominator is rendered with the read-failure mark. | P1 |
| U-3 | **An unknown or unauthorized `?eventId=` renders the "Select a single event" placeholder**, indistinguishable from having selected nothing. Not-found/403 collapse into "no selection". | P1 |
| U-4 | Operations shows **"Attendance 0 %"** for an event with no scans yet — a measured zero presented as a rate on an event that has not started; the Insights engine already treats `checkedIn = 0` as "not started" and stays silent, the page does not. | P2 |
| U-5 | **Two event selectors on every module** (top bar + module header), stacked on mobile. | P2 |
| U-6 | The module strip lists **Revenue for roles that can never see it** (manager/admin get "Financial analytics are not available to you") and does not consult `capabilities.modules`. | P2 |
| U-7 | **Overview's H1 is the event name**; every other module's H1 is the module name. Overview also has a section titled "Insights" (the pre-12-31 signal list) next to a module called Insights. | P2 |
| U-8 | Overview KPI headlines are **lifetime without saying so** while their sublines are windowed (`540` / "90 confirmed in the last 30 days"; `₹0` / "₹30,000 in the last 30 days"). Revenue's own cards say "all time"; Overview's do not. | P2 |
| U-9 | **~230 px of header chrome before the first figure on a phone** (eyebrow, H1, range, selector, presets, Refresh), repeated on every module. | P2 |
| U-10 | Communications' windowed table is `min-w-[32rem]` — **545 px inside a 356 px container at 390 px** (scrolls within its own box; page overflow 0). Participants' equivalent table was fitted; this one was not. | P2 |
| U-11 | Communications is **11 sections / 2,469 px desktop / 4,511 px mobile** — twice any other module. | P2 |
| U-12 | Tap targets: **preset buttons 30 px tall, card links 18 px tall**. | P2 |
| U-13 | Loading is the sentence "Loading analytics…" — no skeleton, layout shift on arrival. | P2 |

Counts: **P0 = 0 · P1 = 3 · P2 = 10 · P3 = 8.** The P1s are all *state* problems, not visual ones, and all are presentation-fixable without touching a contract.

**Verdict (§31): APPROVED WITH CONDITIONS.**

---

## 2. Current IA

Nav order (`lib/analytics/routes.ts`): **Insights · Overview · Registrations · Revenue · Operations · Communications · Participants**. Breadcrumb `Overview › Analytics › {Module}` from `lib/navigation/breadcrumbs.ts` — consistent on every capture. H1 = module name on six modules; **H1 = event name on Overview** (U-7). Section hierarchy is `H1 › H2 (Section) › H3 (channel/card)` throughout; Insights has a visually-hidden `H2 "Insights"` under `H1 "Insights"` (duplicate wording, harmless).

Module boundaries make sense and the copy states them ("Delivery states come from the provider's own callbacks"; "Every figure counts registrations — one person may hold several"). Two boundary blurs: Overview's "Insights" panel (U-7) and Revenue's "Paying population" (counts by payment status, which Registrations also shows as "Payment split").

The legacy route `/dashboard/analytics` (U-1) is still the sidebar target and still the breadcrumb root "Analytics"; the module strip is rendered on it, so users can escape, but it is the *first* screen.

---

## 3. Event context

Identity is visible three times on desktop: top-bar selector, top-bar event title ("A29-MIX · Workshop & Training"), and the module-header selector (U-5). Switching works and is URL-driven (`?eventId=`), so bookmarks and back buttons hold context. Empty selection: "Select a single event — This Overview reports one event at a time…" (correct, honest). **Failure/unauthorized**: `?eventId=does-not-exist` shows the same "Select a single event" placeholder (U-3) — the shell resolves the selector by draft id, finds nothing, and treats it as unselected; the user gets no "this event was not found or is not yours" signal. Loading of the event list itself was *not audited* separately.

---

## 4. Date range UX

Presets 7D/30D/90D as a segmented control; the resolved window is printed as "Last 30 days · 13 Aug 2026 – 11 Sept 2026" beneath the H1 on every module. **No custom-range control exists in the UI** (the API accepts `from/to`; the client offers presets only). Comparison is always previous-period and is not user-toggleable; "vs the 30 days before" wording appears wherever a delta is drawn. IST is never named on screen — the dates are IST days but a reader is not told the zone (P3, U-19). Lifetime vs windowed: Revenue, Communications, Participants and Insights label it explicitly ("all time", "selected period" badge, "the date range above does not apply"); **Overview and Operations do not** (U-8, U-4). No visual implies a lifetime figure is windowed *except* the Overview headline/subline pairing.

---

## 5. Metric hierarchy

`RailMetric` (uppercase 11 px/600 label, `--fs-xl`/`--fs-4xl` value, 12 px sub) is used consistently; primary KPIs are visually primary. Number formatting is uniform (`toLocaleString('en-IN')`; `₹` via `inrPaise`); percentages carry `%`. Observed duplications: **confirmed registrations** appears as a KPI on Overview, Registrations, Operations ("Confirmed · Expected to attend") and inside Participants' status mix — acceptable as anchors, but Operations' relabel "Expected to attend" is a semantic drift (a confirmed seat is not an expectation). Terminology drift for one concept (U-14): "Still expected" (Operations), "awaiting arrival" (Insights), "Registration pending" (Overview legend) vs "Pending approval" (Participants).

---

## 6. Provenance / trust

Strong: every rate prints its denominator ("of 1,023 messages with a confirmed outcome"); money cards say what they are ("Ticket value of confirmed registrations, all time"; "Wallet charges recorded on sent messages"); Communications separates Failed / Unknown / Not delivered; Participants opens with the seats-not-people sentence; Insights prints the evidence line and the floors note; `limits.*` are disclosed in trust notices.

Weak spots (all captured): U-2 (AOV), U-8 (Overview headlines), U-4 (attendance 0 % before start), and one observation the fixture exposed — Overview showed **Confirmed revenue ₹0 (counter) above "₹30,000 in the last 30 days" (rollups)** with nothing on screen reconciling the two. In production that pairing appears whenever counter and rollup disagree; the UI has no "these come from different sources" caption (P3, U-20).

---

## 7. State handling

| State | Rendering today | Distinct? |
|---|---|---|
| A measured zero | `0` / `₹0` with caption | ✔ |
| B unavailable | `—` + "not measured" / "could not be read" | ✔ |
| C unauthorized (money) | section absent; Revenue page: "Financial analytics are not available to you" | ✔ |
| D insufficient coverage | trust notice sentences; "no earlier period on record" | ✔ |
| E no data yet | "Nothing recorded for this event yet." / "No check-ins recorded in this period." | ✔ |
| F module not applicable | panel absent (identifiers/timing/capacity/waitlist) | ✔ |
| **empty denominator** | rendered as B (U-2) | ✘ |
| **unknown / unauthorized event** | rendered as "select an event" (U-3) | ✘ |
| **not started yet (attendance)** | rendered as A "0 %" (U-4) | ✘ |

---

## 8. Insights UX

Severity as text chip + colour (`Critical / Needs attention / Positive / Observation`), window badge, H3 title, sentence, evidence line with `DeltaChip`, "View analytics" + action, floors footnote, honest empty state ("not a statement that everything is fine"). Max six confirmed. Mobile: single column, no overflow. Issues: card links are 18 px tall (U-12); the sentence and evidence line repeat the same numbers ("₹15,000 … → ₹30,000" then "₹30,000 from ₹15,000 ↑100 %") — acceptable redundancy but could tighten (P3, U-21); the hidden `H2 "Insights"` under the `H1` is redundant for screen readers.

---

## 9. Revenue UX

Three-card rail (Confirmed / Completed refunds / Net) with correct captions; intelligence rail (velocity, AOV, before-discount) with refund rate + refunds-in-window line; trend with delta; **Payment gateway** panel labelled "a different population from ticket revenue" with gross → fees → net settlement; Revenue by pass; Paying population. The UI does not imply revenue = money kept — "Net settlement — what the gateway settles to the organizer, after its fees" is the only "kept" figure and says so. Colour: **Completed refunds ₹0 in red, Net revenue ₹0 in green** — semantic colour applied to a zero (P3, U-15). Permission states captured: owner/finance full; manager "Financial analytics are not available to you" with no cards, no zeros, no reserved space — correct — but the range presets and Refresh remain on that page (P3, U-16) and the tab remains in the strip (U-6). Gate roles never reach Analytics (verified in 12-28…31).

---

## 10. Registrations UX

Lifetime KPIs, movement block with deltas, payment split, by-pass ("Confirmed registrations, all time — not limited to the selected period"), cancellations only when recorded. Counts are counts; shares use stated denominators; "registrations" never becomes "people". Pending backlog is a number in the status composition, not called out (Insights does it). No finding beyond the Overview headline labelling (U-8, which is Overview's).

---

## 11. Operations UX

Rail: Confirmed / Checked in / Attendance / Still expected; check-in trend; capacity meter (90 %, 540/600, 60 remaining) — clean. Findings: U-4 (0 % before start); "Expected to attend" and "Still expected" wording (U-14); over-attendance note exists (12-27) but was *not captured* (no over-attended fixture). Timing/identifier panels are absent unless configured (correct; not captured on these events). No no-show wording anywhere (source-pinned in 12-31).

---

## 12. Communications UX

Lifetime rail (Sent / Delivered / Failed / Unknown) with three denominated rates; window section with attempted/delivered/**not delivered** and the raw-vs-unknown footnote; campaigns; composition + channel mix bar; provider signals; per-channel panels including "Not available on this platform" for SMS/Push; reminders; certificates; spend (finance only). "Not delivered" is never styled as "Failed". Findings: U-10 (table min-width at 390), U-11 (page length — the four lifetime channel panels each repeat six pairs and three rate lines; the window table repeats the same five columns), definitions truncate at `sm` and wrap below (good).

---

## 13. Participants UX

Opens with the seats-not-people sentence and "all time; the date range above does not apply"; source rail with shares; status × source table (fits 356 px after 12-29); pass mix and status mix bars; duplicate-rules panel with the "these rules never turn registrations into a count of people" caveat; closing notice explaining the absent demographics. Truthful; no finding.

---

## 14. Charts

Four SVG charts in use (Overview: registration trend + revenue trend bars; Registrations: trend; Revenue: trend; Operations: check-in trend; Communications/Participants: none — bars are CSS). Each has a title, a per-day basis line, an axis with 3 ticks and units (`₹1,000`), dated x-labels (13 Aug / 28 Aug / 11 Sept), and a "Total · Peak day" summary — useful, not decorative. Time zone is IST by construction; not named (U-19). Zero/empty: "No check-ins recorded in this period." replaces the chart (good). Partial coverage: disclosed in the trust notice rather than on the axis. **Hover tooltips not audited.** No chart should be removed; the Overview's two trend charts duplicate Registrations' and Revenue's — acceptable for a landing, but they push Capacity and the Overview "Insights" panel below the fold on desktop (1,118 px page).

---

## 15. Tables

Two tables: Communications window (6 columns, `min-w-[32rem]`, right-aligned tabular numerals, uppercase 11 px headers) and Participants status × source (4 columns, fitted). Sorting: none, and none needed (≤ 5 rows). Empty states handled upstream. Finding U-10 only.

---

## 16. Responsive audit

| Width | Result |
|---|---|
| 1440 | overflow 0 on all 10 owner captures + 4 manager captures; two-column grids balance; Communications and Revenue exceed 1,300 px height |
| 834 | overflow 0; rails wrap to 2 columns; window table 545 px in 536 px container (scrolls 9 px — U-10 already applies) |
| 390 | overflow 0 on all seven modules; header chrome ~230 px (U-9); module strip clips "Revenue" with no affordance (P3, U-17); status legend truncates "Registration pend…" (P3, U-18); Communications window table needs a swipe (U-10); presets 30 px, links 18 px (U-12) |

No clipped card, no chart overflow, no broken label was found at any width.

---

## 17. Typography

All sizes in `components/analytics` resolve to tokens (`text-fs-*` classes or `text-[length:var(--fs-xl)]`-style arbitrary lengths for the KPI values). Observed histogram (Communications, desktop): 11 px/600 ×18 (labels), 12 px/500|400 ×32 (captions), 13 px ×22, 15 px/600 ×8 (section titles), 24 px/600 ×8 (KPI values), 28 px/700 ×1 (H1). Hierarchy is sound; weights are consistent; no hard-coded family. Only note: eleven-pixel uppercase labels dominate the count (18 per screen) — the page reads "label-heavy" at density (P3, U-22).

---

## 18. Spacing / density

Page padding and `gap-5`/`gap-4` grids are consistent across modules; cards use `px-5 py-4/py-3.5`. Excess whitespace: Operations (two rows, 1,007 px = viewport) and Insights with ≤ 3 cards leave the lower half empty — acceptable. Excess density: none. Inconsistency: the module header stacks four controls on mobile (U-9).

---

## 19. Colour system

Tokens only: `--primary` for the module strip/active state and bars, `--success` / `--warning` / `--destructive` for semantic chips, muted text for captions, `bg-muted` for neutral chips, `border-border` surfaces. No new palette, no gradient. Colour is never the sole carrier of meaning (severity chips carry words; delta chips carry arrows and words; "Not available on this platform" is text). One misuse: colour applied to money values by kind rather than by sign (U-15).

---

## 20. Effects

Box-shadow: 1 element per page (`shadow-sm` on the active preset pill); gradients 0; blur 0; hover: underline on links, colour on nav. This is already the restraint the brief asks for.

---

## 21. Accessibility

- Keyboard: module strip links focusable; focus ring `0 0 0 2px rgb(229,39,126)` visible (captured). Preset buttons focusable.
- Headings: `H1 › H2 › H3` outline correct on all modules; Overview's H1 is the event name (U-7); Insights' hidden H2 duplicates the H1.
- Labels: 0 icon-only controls without an accessible name across 30 captures; `nav aria-label="Analytics modules"`; sections carry `aria-label`; charts have `role="img"`-style summaries (Communications mix) — SVG chart accessibility (title/desc) *not audited*.
- Contrast: muted captions are the token's muted-foreground on card white — *not measured* in this audit.
- Colour-independent meaning: yes (§19).
- Targets: presets 39–48 × 30 px, card links 81 × 18 px, nav links ~py-2 (≈ 36 px) — below 44 px (U-12).
- Responsive text: definitions wrap below `sm` (12-28/12-29 fix).

---

## 22. Loading / error UX

Loading: "Loading analytics…" sentence under the header (captured); no skeleton; content lands with layout shift (U-13). Error: `ModuleStates` renders the API's message with a retry — *not captured* (no failure induced). Per-module isolation: a null section renders its own unavailable note ("These figures could not be read for this event.") while siblings render — verified across 12-26…31 fixtures; nothing implies whole-system failure. Error messages: the route's DENIED string is generic; other messages come from `body.error` — *not audited for implementation leakage*. Unknown event → U-3.

---

## 23. Role UX

Owner/finance: full (finance sees money; verified in 12-28/29/31 QA). Admin/manager: no money keys, no empty financial cards, no zeros, no reserved space; Revenue page explains itself; Insights omit money cards silently (correct). Gate: routed to `/checkin`, never reaches Analytics. Findings: U-6 (dead Revenue tab), U-16 (controls on the denied page).

---

## 24. Performance / UX interaction

Each module page mounts its own `useAnalyticsScope` and fetches the full payload for `(slug, preset)`; switching modules re-fetches; switching presets re-fetches (correct); remounts on navigation are the cause, not the server (RD-12-32 F-6 — client duplication, distinct from the server hotspots there). No repeated event-selection requests observed beyond the one fetch per mount.

---

## 25. Analytics ↔ Reports boundary

Modules contain no export controls; Insights link to Reports only for refunds. **The legacy landing carries CSV/XLSX/PDF buttons** (U-1) — the one place Analytics behaves like a report builder. Reports remains the generator/registry.

---

## 26. Legacy routes

- `/dashboard/analytics` — legacy "Event Insights" landing; sidebar target; own event dropdown; export buttons; subtitle "Insights for each of your events"; **concurrently modified** — migration risk: whichever way it is resolved, the sidebar row and the breadcrumb root must land on a page that honours the shared selector and does not contradict the module strip.
- `/dashboard/reports` — recorded by `lib/analytics/routes.ts` as `ANALYTICS_ROUTE_CURRENT` (the older organizer-wide dashboard); still resolves; breadcrumb leaf "Analytics" — a second surface called Analytics (P3, U-23).
- `/api/organizer/analytics/[eventId]` — legacy JSON + export route beside the normalized overview route (server-side; not a UX surface).

---

## 27. Premium benchmark (1–10, with evidence)

| Quality | Score | Evidence |
|---|---|---|
| First-glance comprehension | 6 | strong per module; broken at the entry point (U-1) and by Overview's event-name H1 and unlabelled lifetime headlines (U-7, U-8) |
| Information hierarchy | 8 | rail → sections → rows is consistent; token scale; one shadow |
| Visual restraint | 9 | 0 gradients, 0 blur, 1 shadow, token colours only |
| Data trust | 7 | denominators, bases, unknown ≠ failed, seats ≠ people; minus U-2, U-3, U-4 |
| Consistency | 6 | two selectors (U-5), H1 drift (U-7), terminology drift (U-14), one table fitted and one not (U-10) |
| Density | 7 | desktop good; Communications long (U-11); mobile header heavy (U-9) |
| Responsiveness | 8 | overflow 0 everywhere; two table/target issues (U-10, U-12) |
| Accessibility | 7 | focus ring, headings, names, text-carried meaning; targets and unmeasured contrast |
| Enterprise credibility | 6 | honest and calm, but the sidebar entry page (U-1) and the "could not be read" on an empty denominator (U-2) read as defects |
| Operational usefulness | 8 | Insights + Operations + Communications answer real questions; capacity, awaiting, wallet-held, backlog are actionable |

---

## 28. Findings table

| ID | Sev | Module | File/component | Evidence | User impact | Responsive | A11y | Direction | Impl. |
|---|---|---|---|---|---|---|---|---|---|
| U-1 | P1 | Landing | `app/(dashboard)/dashboard/analytics/page.tsx` (concurrent) | `desktop-owner-landing.png`: own dropdown "No published events", "Publish an event to see analytics", CSV/XLSX/PDF, subtitle "Insights for each…" while the shared selector holds `a29-mix` | first screen contradicts product; export inside Analytics | all | — | resolve when the concurrent work lands: land the sidebar row on the module shell (Insights or Overview) honouring the shared selector; move exports to Reports | required, **later phase** |
| U-2 | P1 | Revenue | `components/analytics/revenue/RevenueAnalytics.tsx` (`MoneyMetric` + `moneyUnavailableNote`) / `revenueIntelligence.averageOrderValue` reason | `desktop-owner-a29-mix-revenue.png`: "— could not be read" + "no paid registrations yet" | empty denominator shown as read failure | all | — | present zero-denominator as its own state ("No paid registrations yet") without the failure mark; presentation-side, no contract change (`denominator === 0` is already in the payload) | required |
| U-3 | P1 | Shell | `components/analytics/ModuleChrome.tsx` / `useAnalyticsScope` | `desktop-owner-badevent.png`: unknown id → "Select a single event" | not-found/403 look like "nothing selected" | all | — | distinct state: "This event could not be found or is not in your workspace" | required |
| U-4 | P2 | Operations | `components/analytics/operations/OperationsAnalytics.tsx` | `desktop-owner-a29-mix-operations.png`: "Attendance 0 %" with 0 scans | upcoming event reads as a failure | all | — | when `checkedIn === 0`: "No check-ins yet" instead of a rate; align with Insights' rule | required |
| U-5 | P2 | Shell | `ModuleChrome.ModuleHeader` + top bar | every capture: two selectors | redundancy; 60 px on mobile | mobile | — | keep one (top-bar selector is global; header selector is the analytics-scoped one — choose per product) | required |
| U-6 | P2 | Nav | `AnalyticsModuleNav.tsx` / `lib/analytics/routes.ts` | manager captures: Revenue tab present, page denies | dead tab for non-finance | all | — | hide or mark modules absent from `capabilities.modules` once the payload is known (progressive) | recommended |
| U-7 | P2 | Overview | `components/analytics/overview/AnalyticsOverview.tsx` | H1 `a29-mix`; section "Insights" | orientation; two "Insights" | all | headings | H1 "Overview"; rename the panel ("Signals" or fold into Insights) | required |
| U-8 | P2 | Overview | `AnalyticsOverview.tsx` rail | `540` / "90 in the last 30 days"; `₹0` / "₹30,000 in the last 30 days" | lifetime read as windowed | all | — | "all time" on headline captions, as Revenue does | required |
| U-9 | P2 | Shell | `ModuleHeader` | `mobile-owner-*`: ~230 px before data | scroll before value | mobile | — | compact mobile header: eyebrow+title inline, controls in one row, range as a single line | recommended |
| U-10 | P2 | Communications | `CommunicationsAnalytics.tsx` window table `min-w-[32rem]` | metrics: table 545 px in 356 px | swipe to see 3 columns | mobile/tablet | — | fit as Participants' table was (drop min-w, nowrap headers, wrap the last) | required |
| U-11 | P2 | Communications | `CommunicationsAnalytics.tsx` | 11 sections; 2,469/4,511 px | long scroll | all | — | collapse the four per-channel panels into one table; demote reminders/certificates | recommended |
| U-12 | P2 | Shell/Insights | `ModuleChrome` presets; `InsightsAnalytics` links | 30 px, 18 px targets | hard to tap | mobile | targets | ≥ 40 px hit areas (padding, not font) | required |
| U-13 | P2 | Shell | `ModuleStates` | `desktop-owner-loading.png`: sentence | layout shift | all | — | rail-shaped skeleton | recommended |
| U-14 | P3 | Ops/Insights/Overview | copy | "Still expected" / "awaiting arrival" / "Registration pending" vs "Pending approval" | drift | — | — | one term per concept | recommended |
| U-15 | P3 | Revenue | `MoneyMetric` tone | ₹0 red / ₹0 green | colour on a zero | — | colour | tone only when non-zero | optional |
| U-16 | P3 | Revenue | manager page | presets + Refresh on a denied page | noise | — | — | hide controls when the module is denied | optional |
| U-17 | P3 | Nav | `AnalyticsModuleNav` | mobile: "Revenue" clipped, no fade | discoverability | mobile | — | edge fade or overflow indicator | optional |
| U-18 | P3 | Overview | status legend | "Registration pend…" at 390 | truncation | mobile | — | shorter label ("Pending") | optional |
| U-19 | P3 | Shell | range line | zone never named | ambiguity for non-IST viewers | — | — | "(IST)" once in the range line | optional |
| U-20 | P3 | Overview | rail | counter ₹0 vs rollup ₹30,000 unreconciled | contradiction possible | — | — | caption which source each figure is from | optional |
| U-21 | P3 | Insights | card | sentence and evidence repeat numbers | redundancy | — | — | shorten evidence line to delta only when the sentence carries both values | optional |
| U-22 | P3 | All | labels | 18 uppercase 11 px labels per screen | label-heavy | — | — | none required | — |
| U-23 | P3 | Legacy | `/dashboard/reports` | second surface called "Analytics" | naming | — | — | migration item recorded in `routes.ts` | later |

---

## 29. Recommended implementation boundary

Smallest evidence-backed set, presentation only, data semantics locked (§29 of the brief):

1. **State semantics (U-2, U-3, U-4)** — three rendering branches: empty-denominator, unknown/unauthorized event, not-started attendance. No contract change; the payload already carries `denominator: 0`, the 403/404 response, and `checkedIn === 0`.
2. **Overview provenance (U-7, U-8)** — H1 "Overview", "all time" on lifetime headline captions, rename the "Insights" panel.
3. **Shared shell (U-5, U-9, U-12, U-13)** — one selector, compact mobile header, ≥ 40 px targets, skeleton.
4. **Communications fit (U-10)** — the same table fix Participants received.
5. **Nav gating (U-6)** — hide modules absent from `capabilities.modules` once the payload is known.

Not in the boundary: the legacy landing (U-1) until the concurrent modification lands (then required); Communications restructuring (U-11) and terminology unification (U-14) as a follow-up; charts (no defect found); any change to calculations, contracts, engine rules, permissions or routes.

---

## 30. Future test plan

Viewport suites at 1440/834/390 for all seven modules asserting `main` overflow 0 and no element wider than `main`; role suites (owner, finance, admin, manager, gate) asserting money presence/absence and the denied-module rendering; state suites: AOV with `denominator: 0` renders the empty-denominator copy and not the failure mark, unknown event renders the not-found copy, `checkedIn === 0` renders "No check-ins yet", measured zeros render `0`, unavailable renders `—` + reason, partial coverage renders the notice; Insights rendering (≤ 6 cards, severity text present, evidence line, links carry `eventId`); chart rendering (title, basis, axis units, empty replacement); navigation (strip present on every module page, active state, denied modules hidden when gated); event switching (URL-driven, both selectors agree or only one exists); preset switching (range line updates, one fetch); accessibility: heading outline per module, no icon-only control without a name, targets ≥ 40 px, focus ring on strip and presets, contrast measured for muted captions.

---

## 31. Final verdict

**APPROVED WITH CONDITIONS.**

- C-1 Implement only §29 items 1–5; presentation only — no change to any calculation, contract, engine rule, permission, route or Reports.
- C-2 U-2/U-3/U-4 must be fixed as distinct states, never by relabelling the unavailable mark; measured zero, unavailable, unauthorized, not-applicable and not-started remain visually distinct.
- C-3 The legacy landing (U-1) is out of scope until its concurrent modification lands; the implementation must not touch `app/(dashboard)/dashboard/analytics/page.tsx`.
- C-4 Use existing tokens and primitives only (`--fs-*`, `--primary`, semantic tokens, `Section`/`RailMetric`/`ModuleChrome`); no new palette, gradient, shadow or animation.
- C-5 Every change verified at 1440/834/390 and for owner/finance/admin/manager/gate before completion; financial protection unchanged.

**Worktree:** HEAD `b7e5fdf`, 0 staged; only `docs/RD-ANALYTICS-12-33-PREMIUM-ANALYTICS-UX-AUDIT.md` created; screenshots live in the git-ignored `e2e/.shots/`; QA server stopped; no source, test, rules, index, commit, push or deploy.

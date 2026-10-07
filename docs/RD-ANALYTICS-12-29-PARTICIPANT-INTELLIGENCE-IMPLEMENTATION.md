# RD-ANALYTICS-12-29 — PARTICIPANT INTELLIGENCE IMPLEMENTATION

**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged before and after. `firestore.rules` (3 Sep) / `firestore.indexes.json` (8 Sep) untouched.
**Audit:** `docs/RD-ANALYTICS-12-29-PARTICIPANT-INTELLIGENCE-AUDIT.md` — APPROVED WITH CONDITIONS (C-1…C-5); the §36 boundary was implemented and nothing beyond it.

---

## 1. Executive summary

The Participants module — declared since RD-ANALYTICS-06 and hidden behind a hard-coded `hasParticipantData: false` — is now live with the only participant facts the audit proved reliable: **registration composition by source** (online / walk-in / source-not-recorded, lifetime, from equality `count()` aggregates on the persisted `registrationSource` field), the same split **inside each registration status**, **pass mix** and **status mix** as shares of counts other modules already publish, and the event's **duplicate rules** as facts about the gate. Every label says "registrations"; the module's first line states that a registration is a seat and the platform does not identify unique participants. No `attendee.*`, `formResponses`, CRM, BIB, timing or session field is read; the demographic and `returning` keys the contract declares remain absent; the module is offered only when the composition was measured.

Verified: 36 new unit pins, 6 emulator cases (20,500 rows, unrecorded remainder, two-workspace/two-event isolation), full suite 9,860 green, `tsc` clean, ESLint clean on touched files, production build clean, browser QA at 1440/834/390 for owner and 1440 for finance/admin/manager/gate-staff — 130 payload and screen assertions matched the seeded arithmetic; two phone-width fits found and fixed by QA.

**Verdict (§25): IMPLEMENTED — CONDITIONS REMAIN** — the module ships with exactly the Tier 1/2 scope; registration-month cohorts were deferred (window-edge months would misrepresent), and everything Tier 3 remains for the named future phases.

---

## 2. Audit constraints followed

| Condition | Status |
|---|---|
| C-1 §36 only; counts are registrations and say so; nothing labelled participants/unique/returning | Met — pinned by unit tests 26–29 and the browser text checks |
| C-2 No demographics, geography, age, gender, uniqueness, returning, edition, cross-event | Met — keys absent; source assertions 21, 28 |
| C-3 No `formResponses`, `attendee.*`, `crmContacts`, `crmActivities`; no index/collection/schema | Met — source assertions 30–32; no index or schema change |
| C-4 Session occupancy only with verification | Not attempted (brief §16 excludes it outright) |
| C-5 F-3 (paid path CRM emit) and fail-open duplicate check recorded, not fixed | Met — §21/§22 |

---

## 3. Exact metrics implemented

| Metric | Scope | Contract |
|---|---|---|
| Registrations by source: online / walk-in / source not recorded, with share of all registrations | lifetime | `participants.composition.source` |
| Source split inside each status (confirmed, pending, cancelled, rejected, waitlisted) | lifetime | `participants.composition.sourceByStatus` |
| Registration mix by pass — shares of the **confirmed total**, with an "Other passes" remainder when the top-8 list does not cover it | lifetime | `participants.composition.passMix` |
| Registration mix by status — shares of all registrations | lifetime | `participants.composition.statusMix` |
| Duplicate rules — `limitPerEmail` / `limitPerMobile` On/Off | fact | `participants.composition.identityRules` |

Nothing windowed; nothing compared. The screen says "all time; the date range above does not apply".

---

## 4. Exact data sources

- `registrations` — `count()` on `organizerUid == ∧ eventSlug == ∧ registrationSource == 'online'|'walkin'` (+ `status ==`). Nothing else read from the document.
- Status totals — the producer's existing `aggregateRegistrationStatusCounts` result, passed in so the "unrecorded" remainder is against the same population every module uses.
- Pass counts — the payload's own `registrations.byPass` (counter-backed, `byPassBasis: 'lifetime_confirmed'`) and `registrations.confirmed`.
- Rules — `events/{slug}.registrationForm.registrationRules.{limitPerEmail,limitPerMobile}` from the event document the producer already loaded.

---

## 5. Exact aggregation strategy

12 equality aggregates per call (2 sources × [lifetime + 5 statuses]), zero documents transferred, no composite index (merge join over single-field indexes), no page, no cap. `unrecorded = max(0, total − online − walkin)` per population; a null on either side makes the remainder null. Whole block null only when no aggregate answered. Emulator test 1: exact over 20,500 rows in < 30 s.

---

## 6. Module availability / gate behaviour

`hasParticipantData: Boolean(result.analytics.registrationComposition)` in the overview route — true exactly when the composition read succeeded; `normalizeEventAnalytics` writes `participants` under the same condition, so `capabilities.modules` and the payload block can never disagree. The `AnalyticsModuleContext.hasParticipantData` JSDoc now states that the flag says nothing about demographics or identity. No new capability model; the existing per-module data signal is reused. Pinned by unit tests 22–23 and the re-anchored RD-06 test 12 (both directions).

---

## 7. Terminology decisions

- Module name "Participants" retained (IA); every figure label uses "registrations".
- `SEATS_NOT_PEOPLE` constant is the header subtitle and repeated above the numbers.
- "Source not recorded" — never "online", never "unknown source" folded away; the definition says "not assumed online".
- "Pending approval" for `pending`; statuses never merged into "inactive".
- Duplicate rules are described as "a rule about the gate, not a count of people".
- Closing notice explains why age/gender/location/unique/returning are absent and that none is zero.

---

## 8. Absence / unavailable behaviour

Measured zero → `0` (browser QA: `a29-clean` walk-in 0, unrecorded 0, waitlisted 0). Aggregate failure → `null` for that figure (`countOf` catches to null); every aggregate failing → `registrationComposition: null` → `participants` absent and module not offered. Share over unmeasured or empty denominator → `null` (no NaN/Infinity — unit test 4). Pass mix refuses counter drift (list > confirmed) rather than drawing >100 %. Rules unreadable → `identityRules: null` → "could not be read". Unsupported demographics → keys absent, explained on screen.

---

## 9. Permission behaviour

Unchanged route gate (`authorizeAnyWorkspace` + event scope; gate roles 403). Verified in the browser: owner, finance, admin, manager receive the module; gate staff is routed to `/checkin` and the analytics API is never called. No money in the block (source assertion; QA regex). No participant-level data anywhere in the payload.

---

## 10. Event / workspace isolation

Every query names `organizerUid` (from the authorized workspace) and `eventSlug`. Emulator test 5: workspace B's rows under A's slug are excluded (A's walk-ins unchanged, B sees only its own three rows); test 4: two events of one workspace stay apart. Browser QA: `a29-mix` and `a29-clean` differ on every figure for every role.

---

## 11. Date/time semantics

None applied — the block is lifetime by design (audit F-7 windowed source needs an undeclared index). The UI states this explicitly so the range control is not misread. No `createdAt`/`registeredAt`/`istRangeBounds` in the participants path (unit test 35).

---

## 12. UI changes

- `components/analytics/participants/ParticipantsAnalytics.tsx` (new): header + seats-not-people line; three-cell source rail with shares; status × source table (columns adapt — "Not recorded" drawn only when non-zero or unmeasured); pass mix and status mix with share bars; duplicate-rules panel; trust notice. Reuses `ModuleChrome`, `Section`, `EmptyNote`, `UnavailableNote`, `nf`, `UNAVAILABLE_MARK`.
- `app/(dashboard)/dashboard/analytics/participants/page.tsx` (new), `lib/analytics/routes.ts` (+1 module row), `lib/navigation/breadcrumbs.ts` (+1 leaf), `AnalyticsModuleNav` unchanged (renders the route table).

---

## 13. Mobile QA

390 px: every section 358 px wide, `main` 390/390, no page overflow; status table fits without a swipe (headers `whitespace-nowrap` except "Not recorded", which wraps at a word); definitions readable. Two fits found by measurement and fixed: the table's `min-w-[26rem]` forced a 382 px table into a 356 px container, and "WALK-IN" wrapped mid-word. 834 px and 1440 px: clean.

---

## 14. Unit tests

`tests/unit/participantIntelligence.test.ts` — 36: source rows/shares/zeros/unmeasured (1–6), status×source never merged (7–9), pass mix denominator/remainder/drift, status mix, `share()` (10–16), rules (17–18), payload/gate/route/nav (19–25), terminology (26–29), reads/isolation/scale/lifetime/universality (30–36).
Re-anchored: `tests/unit/analyticsOverview.test.ts` test 12 — from "never offered" to "offered exactly when the composition was measured", asserting both the absent and present cases and that demographic/returning keys stay absent. No other existing assertion changed.

---

## 15. Emulator tests

`tests/emulator/participantComposition.emu.test.ts` — 6: 20,500-row exactness and timing, unrecorded remainder per status, empty status = measured zeros, event isolation, workspace isolation under a shared slug, partial-null remainder. Run with `organizerAnalyticsAuthz.emu` and `analyticsScale.emu`: 37/37.

---

## 16. 20k scale validation

20,500 seeded registrations (12,000 online + 5,000 walk-in + 3,000 pre-field confirmed; 400 + 100 cancelled): every figure exact, 12 aggregates, no document read, well inside the 30 s bound. The old `.limit(5000)`-style page never existed in this path; none was introduced.

---

## 17. Browser QA

`scripts/qa/rd-analytics-12-29-fixture.mjs` + `rd-analytics-12-29-shots.mjs` against the emulator production build. 130 assertions passed: payload composition, status splits, pass-mix labels and sum-to-confirmed, status-mix share, rules, absence of `returning/ageBuckets/genderBuckets/cityBuckets`, no PII/money in the block, `capabilities.modules` includes participants, nav shows the module, required copy present, forbidden participant-count wording absent, "Source not recorded" present on `a29-mix` and the column absent on `a29-clean`, no email on screen inside `main`, no `NaN/Infinity/undefined/null`, no console errors, no overflow. Shots in `e2e/.shots/rd-analytics-12-29/`.

---

## 18. Build / type / lint results

`tsc --noEmit` clean · ESLint 0 errors on all touched files (one pre-existing `_req` warning in `analyticsOverview.test.ts`, untouched line) · full unit suite **354 files / 9,860 passed / 1 skipped** · `NEXT_DIST_DIR=.next-a1229 next build` clean (302 pages), dist removed, `tsconfig.json` restored · `emu:build` clean ×3.

---

## 19. Files changed

**New:** `lib/analytics/participantsSources.ts`, `lib/analytics/participantsModel.ts`, `components/analytics/participants/ParticipantsAnalytics.tsx`, `app/(dashboard)/dashboard/analytics/participants/page.tsx`, `tests/unit/participantIntelligence.test.ts`, `tests/emulator/participantComposition.emu.test.ts`, `scripts/qa/rd-analytics-12-29-fixture.mjs`, `scripts/qa/rd-analytics-12-29-shots.mjs`, this report.
**Edited (surgical):** `lib/analytics/contract.ts` (+57/−1), `lib/analytics/eventAnalytics.ts` (+38/−0), `lib/analytics/normalize.ts` (+23/−2), `lib/analytics/modules.ts` (JSDoc +7/−2), `app/api/organizer/analytics/overview/[eventId]/route.ts` (+9/−3), `lib/analytics/routes.ts` (+2), `lib/navigation/breadcrumbs.ts` (+1, CRLF preserved), `tests/unit/analyticsOverview.test.ts` (test 12 re-anchored).

---

## 20. Unrelated files confirmed untouched

`lib/reports/*`, `lib/crm/*`, `components/wizard/registrationFormConfig.ts`, `lib/registrations/*`, `lib/firebase/firestore/registrations.ts`, `lib/payments/*`, every Registrations/Revenue/Operations/Communications module file, `firestore.rules`, `firestore.indexes.json`. The concurrent public-chrome/registrations workstream's files (`app/(dashboard)/dashboard/events/[eventId]/registrations/*`, `app/api/organizer/registrations/*`, marketing components) were not opened. A `.next-p5/` build directory and its `tsconfig.json` entries appeared mid-phase from another session; `tsconfig.json` was restored only to the state captured before my own production build, which preserves those entries.

---

## 21. Deferred Tier-2 / Tier-3 work

- Registration-month cohorts (audit Tier 2.3) — deferred: the rollups read cover only the selected window, so edge months would be partial and misrepresented; needs a whole-coverage rollup read or a monthly rollup.
- Conference session occupancy — excluded by the brief.
- Windowed source composition — needs `(organizerUid, eventSlug, registrationSource, registeredAt)` (index phase).
- Signed-in share, exhibition/conference profile presence — indexes/rollups.
- Demographics (age/gender/geography) — Form Semantics phase (A).
- Unique / returning / cross-event — CRM paid-path emit + backfill + per-event rollup (B); **F-3 remains open**: `settleCapturedRegistration` still emits no CRM event.
- Edition retention — edition linkage (C).
- Fail-open `duplicateCheck` — registration hardening item.

---

## 22. Known limitations

All figures lifetime. Pass mix lists the producer's top eight plus a remainder row. `identityRules` describe the gate, not the data. The composition depends on the status aggregates succeeding. The emulator does not enforce indexes, but none of these queries needs a composite in production either.

---

## 23. Firestore rules / index verification

Unmodified (mtimes 3 Sep / 8 Sep, both pre-existing baseline modifications). No index or rule needed, none added, nothing deployed.

---

## 24. Git / worktree verification

HEAD `b7e5fdf`; 0 staged; no commit/push/deploy; no reset/clean/stash/checkout/restore/revert; per-file diffs against pre-edit snapshots are the sizes listed in §19; CRLF preserved on every edited file (breadcrumbs re-normalised after a `sed` pass stripped it, verified +1/−0); QA server stopped; isolated build dir removed.

---

## 25. Final verdict

**IMPLEMENTED — CONDITIONS REMAIN.**

Everything in the approved boundary is implemented and verified; the remaining conditions are the audit's own Tier 2 deferral (month cohorts) and Tier 3 phases (form semantics, CRM identity, editions), each named above.

STOP. Awaiting review before RD-12-30.

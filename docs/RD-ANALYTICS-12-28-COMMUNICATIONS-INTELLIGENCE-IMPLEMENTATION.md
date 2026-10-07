# RD-ANALYTICS-12-28 — COMMUNICATIONS INTELLIGENCE IMPLEMENTATION

**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged before and after. `firestore.rules` (mtime 3 Sep) and `firestore.indexes.json` (mtime 8 Sep) untouched.
**Audit:** `docs/RD-ANALYTICS-12-28-COMMUNICATIONS-INTELLIGENCE-AUDIT.md` — APPROVED WITH CONDITIONS (C-1…C-6), treated as authoritative.

---

## 1. Executive summary

The RD-ANALYTICS-11 Communications module is extended — not redesigned — with an `intelligence` block assembled entirely from `count()` aggregates over persisted fields: campaign counts from `broadcastCampaigns` documents, a broadcast/automatic split by the log's own `templateKey` discriminator, bounce/complaint/WhatsApp-read/wallet-held signals, an IST-windowed message position with previous-period comparison and a per-day velocity, and a supported-channel mix. The two silent page caps the audit flagged (reminders 500, certificates 5,000) are replaced by aggregates for the counts they can serve and by overflow-detected withholding for the two figures that still need rows. The dead `byTemplate` computation is removed.

Every new figure is `number | null`, every comparison goes through `compareMetric`, every window through `istRangeBounds`, and windowed `unknown` is **not** published (no index). Spend, billing, webhooks and Reports are untouched.

Verified: 56 new unit pins + 9 emulator cases (20,500-row window, IST boundary, workspace/event isolation), full suite 9,810 green, `tsc` clean, ESLint clean on touched files, production build clean, browser QA at 1440/834/390 for owner and at 1440 for finance/admin/manager/gate-staff — 250 payload assertions matched the seeded arithmetic.

**Verdict (§35): IMPLEMENTED — CONDITIONS REMAIN.**

---

## 2. Audit conditions carried forward

| Condition | Status |
|---|---|
| C-1 Tier 1 + Tier 2 only; no index/collection/webhook change | Met — no index, no collection, no provider change |
| C-2 Windowed = sent/delivered/queued/skipped/raw-failed + campaigns; `unknown` lifetime only | Met — `WindowedChannelDelivery` has no `unknown`; raw failed is `notDelivered` |
| C-3 `spend` stays behind `transactions`; basis text corrected; no cost-per-delivered | Met |
| C-4 Broadcast/automatic labelled to include organizer-directed alerts; no direction split | Met |
| C-5 Reminders/certificates via aggregates or `null`; no silent caps in the path | Met (status counts + issued are aggregates; recipient sum and downloads withheld on overflow) |
| C-6 F-2, F-3, F-5 recorded as separate hardening items, not fixed here | Met — §28, §29, §22 |

Findings F-1 (best-effort log), F-6 (no direction), F-7 (no `deliveryUnknown`+`createdAt` index), F-10 (admin projection not reused) shaped the design and are honoured in code comments and tests.

---

## 3. Exact metrics implemented

| Metric | Scope | Source | Contract field |
|---|---|---|---|
| Campaigns created / completed / scheduled | lifetime | `broadcastCampaigns` count() by `organizerUid`+`eventSlug`(+`status`) | `intelligence.campaigns.{created,completed,scheduled}` |
| Campaigns created in window vs previous | IST window on `createdAt` | same, `(organizerUid, eventSlug, createdAt)` | `intelligence.campaigns.period` (ComparedMetric) |
| Broadcast messages | lifetime | `emailLogs` `templateKey == BROADCAST_TEMPLATE_KEY` | `intelligence.composition.broadcast` |
| Automatic messages | lifetime | total − broadcast | `intelligence.composition.automatic` |
| Email bounces / complaints | lifetime | `error == 'bounce'` / `'complaint'` | `intelligence.email.{bounces,complaints}` |
| WhatsApp read | lifetime | `channel=='whatsapp' ∧ waStatus=='read'` | `intelligence.whatsapp.read` |
| WhatsApp held for balance | lifetime | `channel=='whatsapp' ∧ status=='skipped' ∧ error==WHATSAPP_WALLET_SKIP_REASON` | `intelligence.whatsapp.walletSkipped` |
| Windowed attempted / delivered / notDelivered / queued / skipped per channel | IST window | `(organizerUid, [channel,] eventSlug, status, createdAt)` counts; email = all − whatsapp | `intelligence.window.period.{email,whatsapp}` |
| Windowed totals vs previous window | IST window | folded across channels, `compareMetric` | `intelligence.window.{attempted,delivered,notDelivered}` |
| Communication velocity | IST window | attempted ÷ `rangeLengthDays`, truncated | `intelligence.window.velocity` |
| Channel mix | lifetime | share of lifetime `sent` per supported channel | `intelligence.channelMix` |
| Reminder status counts | lifetime | `scheduledReminders` count() by `eventId`+`status` (×5) | `remindersScheduled`, `remindersSent` (unchanged fields, new source) |
| Certificates issued | lifetime | `certificates` count() by `eventId` | `certificatesIssued` (unchanged field, new source) |

---

## 4. Exact metrics intentionally excluded

Windowed `unknown` and windowed true-`failed` (F-7, Tier 3); cost per delivered message and any spend reconciliation (F-3); hard/soft bounce split; attendee vs organizer direction (F-6); unique/duplicate recipients; delivery latency; campaign duration; top/recent campaigns inside analytics; open/click/unsubscribe/reply rates; any SMS or Push figure (remain `not_implemented`); windowed broadcast split (needs `(organizerUid, eventSlug, templateKey, createdAt)`); reminder recipient sum and certificate downloads beyond the page bound (withheld, not estimated).

---

## 5. Data sources

- `emailLogs` — best-effort (F-1): `writeEmailLog` never throws. The screen's trust notice and the contract JSDoc keep saying "as recorded"; nothing calls the log canonical.
- `broadcastCampaigns` — durable, one document per campaign; the campaign figures never touch message rows.
- `scheduledReminders` — status via aggregates; `counts.recipients` via a 501-row page with overflow → `null` + `limits.reminders=false`.
- `certificates` — issued via aggregate; `downloadCount > 0` via a CAP+1 page with overflow → `null` + `limits.certificates=false`.
- Admin `lib/communications/analytics` projection — **not** imported or reused (F-10).

---

## 6. Event / workspace isolation

Every new read carries `where('organizerUid','==', organizerUid)` AND `where('eventSlug'|'eventId','==', …)`, with `organizerUid` taken from the route's authorized workspace (`authz.workspaceUid`), never from the request. Pinned by unit tests 49–51 and proven on the emulator (test 3: a workspace whose rows claim the same slug is excluded; test 4: two events of one workspace stay apart). Browser QA: `a28-intel` and `a28-other` in one workspace returned different figures on every field for every role.

---

## 7. Permission matrix

| Role | Operational counts + intelligence | `spend` | Verified |
|---|---|---|---|
| owner | ✔ | ✔ | payload + screen (3 widths) |
| finance | ✔ | ✔ | payload + screen |
| admin | ✔ | ✘ (absent) | payload + screen |
| manager | ✔ | ✘ (absent) | payload + screen |
| checkin_staff (gate) | ✘ — routed to `/checkin`; analytics API never called | ✘ | screen |

No permission was broadened; the intelligence block rides the existing `authorizeAnyWorkspace` + event-scope gate. No recipient PII enters the contract (unit tests 45–47).

---

## 8. Financial gating

`spend` unchanged: issued only with `transactions`, key absent otherwise. The intelligence block contains no money field by construction (`readCommunicationSignals`/`readCampaignCounts`/`readWindowedCommunicationCounts` issue no `sum()` and read no `costPaise`/`actualCostPaise` — unit test 46). Campaign cost (`actualCostPaise`) was deliberately not added.

---

## 9. IST / date-range behaviour

Window bounds = `istRangeBounds(activeRange)` (the same instants the refund window uses), applied to `emailLogs.createdAt` / `broadcastCampaigns.createdAt`. Reports' UTC `rangeBounds` is not referenced (unit test 26). Emulator test 2 proves a row at 2026-08-31 23:45 UTC counts in the September window and one at 18:15 UTC (23:45 IST) does not. Browser QA seeded the same boundary row and the payload counted it (delivered 501 = 300 + 1 boundary + 200 broadcast). Presets 7/30/90 and custom ride the existing scope hook unchanged.

---

## 10. Comparison behaviour

`compareMetric` only. Baseline reason decided by the producer: `outside_coverage` when the preceding window ends before the event's `publishedAt` IST day; `no_baseline` when a comparison was requested but not read; `disabled` when not requested. Zero baseline → `delta.pct = null` (no percentage, chip not drawn); either side `null` → no delta. Campaign and message comparisons share one reason.

---

## 11. Absence / failure semantics

Measured zero → `0` (browser QA: `a28-other` WhatsApp read 0, campaigns scheduled 0). Read failure → `null` per field (every `countOf` catches to `null`; a whole-window failure yields the `EMPTY_WINDOW` shape). Unauthorized → `spend` absent; operational block present. Unsupported → SMS/Push `not_implemented`, no delivery, no share of the mix. Partial → `limits.reminders=false` / `limits.certificates=false` with the withheld figure `null` and a trust-notice sentence naming it.

---

## 12. Unknown vs failed semantics

Lifetime: unchanged — `failed = raw − deliveryUnknown`, `unknown` its own cell. Window: `notDelivered` = raw failed, explicitly documented and labelled "rejected or timed out"; never "Failed"; no `unknown` key exists on the windowed type (unit tests 7–11; QA asserts `'unknown' in window.period.whatsapp === false`). The screen footnote states the difference.

---

## 13. Campaign count

`readCampaignCounts(organizerUid, eventSlug, window, baselineWindow)` — 6 aggregates, no rows, no `campaignId` distinct. Emulator test 7: a 5,000-recipient campaign counts as one; the other workspace's same-slug campaign is excluded. Labels: Created (any state) / Completed (sent + partial) / Scheduled; period = created in window.

---

## 14. Broadcast / automatic split

Discriminator: `BROADCAST_TEMPLATE_KEY` imported from `lib/email-logs/types` (the declared model constant, pinned to its writer by the existing RD-WA-LOGS-03 test) — not a string literal, not a naming heuristic. `automatic = max(0, total − broadcast)`, `null` if either is unmeasured; the two sum to `totalMessages` (QA assertion on both events). The on-screen definition says "including alerts sent to you" (F-6).

---

## 15. Bounce / complaint

Equality counts on the `error` value the SES/Resend webhooks write. Definition text: "any type; hard and soft are not separated". No `bounceType` anywhere in the intelligence path (unit test 13). Bounce is a *cause* on a failed row; the lifetime `failed` figure is neither derived from nor reduced by it.

---

## 16. WhatsApp read

`waStatus == 'read'` on WhatsApp rows — Meta's monotonic state, applied by the existing webhook. Labelled "Meta reported the message read — WhatsApp only, not an email open"; never combined with email into engagement (RD-11 test 14 still holds).

---

## 17. Wallet-skipped

`status == 'skipped' ∧ error == WHATSAPP_WALLET_SKIP_REASON` on WhatsApp rows. Exact match by design (an aggregate cannot be case-tolerant); emulator test 6 proves a differently-cased reason is not counted. Labelled "held for balance — never sent because the wallet could not cover it — not a failure". No spend semantics touched.

---

## 18. Windowed counts

`readWindowedCommunicationCounts` — 10 aggregates per window (5 statuses × {all, whatsapp}), email = all − whatsapp so pre-`channel` rows are kept. `attempted = sent + delivered + failed(raw)`, mirroring the lifetime population rule. Emulator test 1: exact over 20,500 rows.

---

## 19. Velocity

`communicationVelocity(attemptedInWindow, range)` = `trunc(attempted / rangeLengthDays)`; own basis literal `attempted_in_window_per_day`; `null` for an unmeasured numerator or invalid/inverted range; no NaN/Infinity (unit tests 36–39). Rendered as "28/day attempted, averaged over the window".

---

## 20. Channel mix

`channelMix(email, whatsapp)` over lifetime `sent`; `null` when either is unmeasured or nothing was attempted (two zeros are not a mix). SMS/Push are not inputs. Rendered as a two-segment bar with percentages and counts.

---

## 21. Reminder / certificate coverage

Reminders: 5 `count()` aggregates replace the in-memory tally; the 500-row page becomes 501 with overflow detection; `recipients` withheld (`null`) and `limits.reminders=false` on overflow. Certificates: `issued` via `count()`; the CAP page becomes CAP+1 with overflow detection; `downloaded` withheld and the funnel step omitted (not zeroed) on overflow. `AnalyticsLimits.reminders` added to the contract so the screen can disclose it. Browser QA: 600 seeded reminders → scheduled 60 / sent 520 exact, recipient total withheld, trust notice shown.

---

## 22. Terminology changes

- Spend subtitle: "Wallet charges recorded on sent messages — the log's own cost field, not the ledger debit" (+ contract JSDoc).
- Trust notice: "spend fallback page exceeded its read limit" (was "per-template breakdown", which no longer exists); certificate-download and reminder-recipient withholding sentences added.
- Windowed third column: "Not delivered", never "Failed".
- **Reports "Broadcast Usage" `Delivered` → `Accepted` (F-5): NOT changed.** `lib/reports/builders.ts` carries a 419-line concurrent rework whose diff hunk covers `buildBroadcastUsage` itself; a surgical edit inside an actively reworked function is not safe per §1.7. Deferred to the Reports hardening item.

---

## 23. Scale strategy

New reads: 6 (campaigns) + 5 (signals) + 10 (window) + 10 (baseline) = 31 aggregates, zero documents, independent of message volume. Reminders: 5 aggregates + one 501-row page. Certificates: 1 aggregate + one CAP+1 page (pre-existing bound, now overflow-aware). Emulator test 1 exercises 20,500 rows; the fixture event for browser QA has 1,157 rows + 600 reminders. No new document page anywhere in the intelligence path (unit tests 20, 52).

---

## 24. Tests

- `tests/unit/communicationIntelligence.test.ts` — **56 new**: core absence (1–6), unknown≠failed incl. contract/source pins (7–11), bounce/complaint (12–15), WhatsApp (16–18), campaigns (19–22), composition (23–25), IST window + boundary (26–29), comparison incl. zero/unavailable/partial baseline (30–35), velocity (36–39), reminders/certificates (40–44), permissions/PII/spend text (45–48), isolation/scale (49–53), housekeeping (54–56).
- `tests/emulator/communicationIntelligence.emu.test.ts` — **9 new**: 20k window, IST boundary, workspace isolation, event isolation, composition sum, exact wallet match, campaign documents, reminder overflow, measured-zero window.
- Re-anchored: `analyticsNormalize.test.ts` (fixture + limits + walker skip `intelligence`), `analyticsCommunications.test.ts` (fixture: `byTemplate` removed, intelligence added), `analyticsAuthorization.test.ts` (two source pins → aggregate-based reads).
- Results: unit **352 files / 9,810 passed / 1 skipped**; emulator comm+analytics suites **48 passed**.

---

## 25. Browser QA

`scripts/qa/rd-analytics-12-28-fixture.mjs` + `rd-analytics-12-28-shots.mjs` against the emulator production build (`emu:build` → `emu:serve`, port 3187). 250 payload assertions passed for owner (1440/834/390), finance, admin, manager; gate staff routed to `/checkin`, analytics never called, no communication figure rendered. Text checks: no `NaN/Infinity/undefined/null`, no `SMS 0`/`Push 0`, all defining phrases present, spend present only for money roles, overflow note present. Shots in `e2e/.shots/rd-analytics-12-28/`.

Two defects found and fixed by QA, not by code reading:
1. "Not delivered ↑410%" rendered **green** — `PeriodMovement` gained an `invert` passthrough (additive, default unchanged) and the card passes it.
2. At 390px the Campaigns / What was sent cards (and the pre-existing Reminders/Certificates grid) were **474px/384px wide**, clipping their values, while the page-level overflow probe read 0 because the overflow lived inside `main`. Fix: `[&>*]:min-w-0` on both card grids; definition text wraps below `sm` instead of truncating so the honesty caveats stay readable. Re-measured: every section 358px, `main` 390/390.

---

## 26. TypeScript / ESLint / build

- `npx tsc --noEmit` — clean.
- ESLint on every touched source/test/QA file — 0 errors (2 pre-existing warnings in untouched lines of `analyticsAuthorization.test.ts`; none in new files after cleanup).
- `NEXT_DIST_DIR=.next-a1228 next build` — clean (301 static pages); dist removed; `tsconfig.json` restored after the build appended its dist entries.
- `npm run emu:build` — clean, twice.

---

## 27. Emulator validation

`npm run emu:start` was already up (Auth 9099, Firestore 8080). Ran: `communicationIntelligence.emu`, `communicationsScale.emu`, `organizerAnalyticsAuthz.emu`, `analyticsScale.emu` — 48/48. Note: the emulator does not enforce composite indexes; production without the windowed composites answers `null` for windowed figures, which the contract and tests handle.

---

## 28. F-2 — deferred webhook issue

SES/Resend fallback matching by `recipientEmail` (≤50 rows, no event/workspace/date filter) is unchanged. The windowed `delivered` and lifetime `delivered` inherit whatever status that fallback wrote; the screen's "confirmed by the provider — as recorded" wording does not overstate certainty. Hardening item: constrain the fallback by status and recency.

---

## 29. F-3 — deferred spend issue

Analytics Σ`costPaise` (sent rows), the wallet ledger (upfront campaign debit) and `communicationUsage` still disagree by design. Nothing in billing, finalize, ledger or `communicationUsage` was touched; `spend` keeps its gate and now says what it measures. No cost-per-delivered metric exists.

---

## 30. Tier 3 / unsupported metrics

As §4. Windowed `unknown` specifically: not indexed, not scanned, not estimated, not derived — pinned by unit tests 7–8 and QA.

---

## 31. Dead-code decision

`byTemplate` / `commByTemplate` removed from `eventAnalytics.ts` (F-4): no contract field, normaliser, component, route or test consumed it (verified by grep before removal; the only reference was the RD-11 test fixture, updated). The CAP+1 page itself is retained as the documented spend fallback; RD-11 test 23 still pins it. No other cleanup.

---

## 32. Exact files changed

**Source**
- `lib/analytics/communicationsSources.ts` (+213/−5) — `readCampaignCounts`, `readCommunicationSignals`, `readWindowedCommunicationCounts`; header note on campaign counting.
- `lib/analytics/communicationIntelligence.ts` (new, pure) — `windowedTotals`, `communicationVelocity`, `channelMix`, `unmeasuredCommunicationIntelligence`, `buildCommunicationIntelligence`.
- `lib/analytics/contract.ts` (+104) — `AnalyticsLimits.reminders`, `WindowedChannelDelivery`, `CommunicationIntelligence`, `CommunicationsAnalytics.intelligence`, spend JSDoc.
- `lib/analytics/eventAnalytics.ts` (+143/−43) — imports; type changes (`byTemplate` removed, `reminders.recipients`/`certificates.downloaded` nullable, `communicationIntelligence`); IST window + baseline reason; four new reads; reminders/certificates via aggregates with overflow-aware pages; limits; funnel step guard; assembly.
- `lib/analytics/normalize.ts` (+6/−1) — `limits.reminders`, `intelligence` passthrough, workspace-scope unmeasured block.
- `lib/analytics/communicationsModel.ts` (+79) — `campaignRows`, `compositionRows`, `signalRows`, `windowChannelRows`, `displayCommunicationVelocity`.
- `components/analytics/communications/CommunicationsAnalytics.tsx` (+219/−8) — sections 1b/1c/1d, `WindowMetric`, `Cell`, `ChannelMix`, wording, mobile grid fix.
- `components/analytics/overview/Primitives.tsx` — `PeriodMovement.invert?` passthrough (2 lines).
- `app/(admin)/admin/events/[slug]/PageClient.tsx` — 2 expressions tolerate `certificates.downloaded === null`.

**Tests**
- `tests/unit/communicationIntelligence.test.ts` (new, 56)
- `tests/emulator/communicationIntelligence.emu.test.ts` (new, 9)
- `tests/unit/analyticsNormalize.test.ts`, `tests/unit/analyticsCommunications.test.ts`, `tests/unit/analyticsAuthorization.test.ts` — fixture/pin re-anchors only.

**QA**
- `scripts/qa/rd-analytics-12-28-fixture.mjs`, `scripts/qa/rd-analytics-12-28-shots.mjs` (new)

**Docs**
- this report.

Not changed: `lib/reports/builders.ts` (+0/−0), `lib/analytics/revenueIntelligence.ts`, any billing/webhook/provider/index/rules file.

---

## 33. Worktree safety verification

- Baseline captured (`$TEMP/rd1228i-baseline.txt`, 799 entries) and every target file snapshotted before editing; diffs above are against those snapshots.
- No reset/clean/stash/checkout/restore/revert; no reformatting; CRLF/LF preserved on every edited file (checked).
- The concurrent public-chrome/marketing workstream continued editing during this phase (footer/navigation deletions, race-operations components, `publicChrome*` tests, `CampaignDetailClient.tsx`, `styles/heroSwiper.css`) — none of those files were opened or modified here.
- `lib/reports/builders.ts` inspected in place, left untouched (§22).
- `tsconfig.json` restored to its pre-build content after each build; isolated dist dirs removed; the QA server on 3187 stopped.

---

## 34. Index / rules / deployment status

`firestore.indexes.json` and `firestore.rules` not modified (mtimes 8 Sep / 3 Sep, pre-dating this workstream). No new index — in particular no `deliveryUnknown + createdAt`. No commit, push, deploy, migration, index or rules deployment. Windowed figures depend on the already-declared composites being deployed; if they are not, they read `null`.

---

## 35. Final verdict

**IMPLEMENTED — CONDITIONS REMAIN.**

All approved Tier 1/Tier 2 scope is implemented and verified. Conditions remaining, all by audit design rather than omission: windowed `unknown`/true-failed (index approval), spend reconciliation (F-3), webhook fallback matching (F-2), Reports "Delivered→Accepted" wording (F-5, blocked by the concurrent Reports rework), and the recipient-direction split (F-6). Each belongs to a separate infrastructure or hardening phase.

STOP. Awaiting review before RD-12-29.

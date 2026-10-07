# RD-ANALYTICS-12-29 — PARTICIPANT INTELLIGENCE AUDIT

**Type:** AUDIT ONLY — no source, test, rules, index, schema, data or deployment changes.
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged, 812 worktree entries (`$TEMP/rd1229-baseline.txt`). `firestore.rules` / `firestore.indexes.json` untouched (pre-existing baseline modifications, mtimes 3 Sep / 8 Sep).
**Concurrent-change note:** the public-chrome / registrations workstream has uncommitted edits in `app/(dashboard)/dashboard/events/[eventId]/registrations/*`, `app/api/organizer/registrations/*`, `app/api/organizer/events/[eventId]/registrations/route.ts`, `components/checkin/AttendeeConfirmation.tsx`, and has deleted `app/platform/{crm,participants,registration}/page.tsx`. All were inspected in place; none modified.

---

## 1. Executive summary

RegisterDesk already has an honest **Registrations** analytics module (status, payment split, by-pass, IST daily trend with comparison, capacity) built on aggregates and rollups. A **Participants** module is declared in the contract (`ParticipantAnalytics { returning?, ageBuckets?, genderBuckets?, cityBuckets? }`), listed in the module nav, and **hidden by a hard-coded `hasParticipantData: false`** with the comment *"needs a form-field → semantic-type mapping that does not exist"*. This audit confirms that comment is still true and adds the reasons it must stay true for now.

| # | Finding | Sev |
|---|---|---|
| F-1 | **No semantic field registry for registration-form fields.** Custom fields are keyed by random ids (`f_xxxxxxxx`), typed by widget (`text/date/radio/dropdown/city/state/…`), labelled free-text, with per-event option lists. Template defaults exist ("Date of Birth" date, "Gender" radio, "City" city, "Age Group" dropdown) but nothing marks a field *as* DOB/gender/city; `lib/metadata/registry.ts` declares system fields only. Demographic analytics from form responses is therefore **Tier 3** — any attempt now would be label-guessing. | Blocking for demographics |
| F-2 | **Registrations ≠ participants, and the platform cannot prove equivalence.** `limitPerEmail`/`limitPerMobile` are opt-in rules, checked only against non-cancelled rows, and the check **fails open** (`return false` on query error). Family/team sign-ups, imports and walk-ins legitimately create several registrations per person. "Participants" must not be a relabelled registration count. | P1 semantic |
| F-3 | **The CRM identity is canonical but its live feed is incomplete: the paid registration path never emits a CRM event.** `crmRecordRegistration` is called only from `createRegistration()` (free/walk-in/import); `settleCapturedRegistration` (Razorpay) writes the registration directly with no CRM call. CRM `totalRegistrations`/`repeatAttendees`/retention are correct only after a backfill. Returning-participant metrics from CRM are **Tier 3** until the emit is added and a backfill guarantee exists. | P2 data |
| F-4 | **No distinct-count aggregate exists** in Firestore. Unique participants (distinct `attendee.email` per event) cannot be computed without reading rows or a maintained rollup. Unsupported now. | design constraint |
| F-5 | **No event edition / series linkage** anywhere in the event model (no `editionNumber`, `previousEventId`, `seriesId`, `parentEventId`). Edition retention is unsupported; inferring editions from names or dates is forbidden by the brief and by this audit. | unsupported |
| F-6 | **No lifecycle timestamps beyond `registeredAt`, `checkedInAt`, `refundedAt`, `updatedAt`.** No `confirmedAt`/`cancelledAt`/`paidAt` on the document (the per-registration `auditLog` subcollection has them, fire-and-forget, unindexed). Trend semantics must stay on `registeredAt` (creation) and on the IST rollups for lifecycle deltas. | constraint |
| F-7 | **`registrationSource` is an honest, countable, universal segment** (`walkin` vs online-default; absent ⇒ online). It is the only participant-composition fact not already shown by Registrations. | opportunity |
| F-8 | **Event-type fields are typed on the document** (`companyName/designation/industry/website/passType` for exhibitions, `bibCategory` for sports, `selectedSessions` for conferences) but are free-text or arrays without aggregate support; only presence is countable and only with undeclared indexes. Tier 3. | constraint |
| F-9 | **PII policy exists** (`lib/metadata/registry.ts`: `attendee.email`/`attendee.phone`/`organizerUid` `sensitive: true`; name deliberately not) — but **no small-bucket suppression threshold** exists anywhere on the platform. Any future demographic bucket needs a policy decision, not an invented k. | policy gap |
| F-10 | Two "registrations per day" zone systems coexist: Analytics rollups (IST, `REPORTING_TZ_OFFSET_MINUTES`) and `?trend=` mode (event timezone). Participants must use the Analytics rollups. | note |

**Verdict (§39): APPROVED WITH CONDITIONS** — for a deliberately small implementation: unhide the module only with what is provably true (registration composition by source, identity-honest framing, event-type presence counts where indexed), and keep demographics, uniqueness and returning participants in Tier 3 pending infrastructure phases.

---

## 2. Current participant architecture

```
registrations/{id}          canonical registration document (status, paymentStatus, attendee{name,email,phone,formResponses}, passId, registeredAt, registrationSource, uid?, type-specific fields)
registrationCounters/{slug} confirmed totals, passCounts, revenue, checkedInCount (+attendanceShards)
organizerDailyStats         IST daily rollups: confirmed / cancelled / revenue / checkedIn per event-day
crmContacts/{sha(uid:email)} DERIVED per-workspace contact: normalized email identity, totalRegistrations, totalCheckIns, lastEvent, tags, notes
crmActivities               DERIVED per-contact timeline (registration_created, checked_in, …), metadata.eventSlug
registrations/{id}/auditLog fire-and-forget lifecycle entries
events/{slug}.registrationForm  FormField[] (id, label, type, options, required, section, passVisibility)
```

Analytics: `EventAnalytics` (producer) → `normalizeEventAnalytics` → `AnalyticsResponse` with `registrations`, `operations`, `communications`, `revenue?`, `participants?` (never written). Module availability via `availableAnalyticsModules(ctx)`; `participants` gated on `ctx.hasParticipantData` which the overview route sets to `false`.

---

## 3. Registration source of truth

| Field | Nature | Notes |
|---|---|---|
| `status` | canonical, mutable | `confirmed/pending/cancelled/waitlisted/rejected` |
| `paymentStatus` | canonical, mutable | `not_required/pending/paid/refund_pending/refunded` |
| `amount`, `discountAmount`, `originalAmount`, `couponCode` | canonical at creation | money — Revenue's domain |
| `passId`, `passName` | canonical (`passName` denormalized) | category/pass |
| `attendee.name/email/phone` | canonical, PII | email lower-cased by all four writers (submit, walk-in, import, paid) |
| `attendee.formResponses` | canonical, opaque map keyed by field id | custom answers; no schema on the document |
| `registeredAt` | immutable creation instant (UTC) | the only universal timestamp |
| `registrationSource` | canonical; absent ⇒ `online` | `walkin` written by the gate route |
| `uid` | optional | Firebase Auth uid when the attendee was signed in — not universal |
| `checkedIn`, `checkedInAt/By/Source` | canonical, mutable | Operations' domain |
| `refundId/Amount/refundedAt` | canonical | Revenue's domain |
| `companyName/designation/website/industry/passType` | optional, free text | exhibition/conference templates |
| `bibNumber/bibCategory`, `identifier`, `timingTag` | optional | sports/identifier engine |
| `selectedSessions[]` | optional, mutable | conference sessions currently held |
| `registrationCounters` | derived/cached | confirmed totals; per-pass counts complete only post 2026-08-11 fix; `statsVersion` gate |
| `organizerDailyStats` | derived rollup | IST day keys; coverage marker `historySince` |
| `crmContacts` | derived, best-effort (`void … catch(()=>{})`), backfillable | identity = normalized email per workspace |

Not canonical for any participant metric: `eventName` (denormalized), `emailStatus/whatsappStatus` (communications), `ticket` (display).

---

## 4. Participant vs registration semantics

- One registration = one *seat*, not one *person*. Multiple registrations per person are a designed path (family/team, walk-in, CSV import, repeat entry) — `dedupeRecipients.ts` exists precisely because "one row per REGISTRATION … one person may legitimately hold several".
- `limitPerEmail`/`limitPerMobile` (event rules) reduce but do not eliminate duplicates: opt-in, non-cancelled only, fail-open, walk-in uses the event's rules but historical rows predate them.
- Cross-event: the same email registers for many events; CRM links them per workspace.
- Vocabulary the audit permits:
  - **Registrations** — rows (what Registrations already shows).
  - **Participants** — must be defined as *registrations* with an explicit "each seat is counted once; one person may hold several" caption, OR not used as a count at all. Recommended: the module is named Participants but its counts are labelled "registrations" and its composition metrics are shares of registrations.
  - **Unique participants** — UNSUPPORTED (F-4).
  - **Returning participants** — UNSUPPORTED until F-3 is fixed (Tier 3).

---

## 5. Identity / deduplication

| Mechanism | Exists | Canonical? | Confidence |
|---|---|---|---|
| `registrationId` | ✔ | seat identity | exact |
| `attendee.email` (lower-cased, trimmed) | ✔ | platform's email identity rule (four writers agree; CRM `normalizeEmail` matches; `dedupeRecipients` uses it) | high for *address*, not for *person* (shared family addresses; `+tags` deliberately NOT merged) |
| `attendee.phone` | ✔ | E.164 normalised by `lib/communication/phone` on WhatsApp paths; stored trimmed on registration | medium — not universally normalised at write |
| `uid` | optional | Firebase Auth | high when present; absent on guest/walk-in/import |
| CRM `contactId = sha256(organizerUid:email)` | ✔ | canonical per-workspace identity | high for identity, **incomplete population** (F-3) |
| `identifier` / `bibNumber` | optional | per-event credential | event-scoped only; sports/identifier events |
| name / address matching | — | — | forbidden |

Unique-participant counting would need either a distinct aggregate (none) or a maintained per-event rollup keyed by contactId — Tier 3.

---

## 6. Demographics

| Field | Exists | Canonical | Normalized | Completeness | Semantic reliability | PII | Analytics-safe |
|---|---|---|---|---|---|---|---|
| age (integer) | ✘ (only "Age Group" dropdown in cultural template) | — | — | — | option list is per-event | low | ✘ |
| date of birth | ✔ as template `date` field, custom id | ✘ (no semantic key) | ISO string? (widget-dependent) | per-event | unknown until mapped | high | ✘ |
| gender | ✔ as template `radio` field, custom id; options `Male / Female / Other / Prefer not to say` in defaults, editable per event | ✘ | ✘ | per-event | organizer may relabel/reorder | medium | ✘ |
| city | ✔ `city` field TYPE exists; storage is a string | ✘ | ✘ (no gazetteer; free text) | per-event | spelling variants | medium | ✘ |
| state / country | `state` type exists; no country list found | ✘ | ✘ | — | — | medium | ✘ |
| pincode | ✘ | | | | | high | ✘ |
| occupation / organization / designation / industry | `companyName/designation/industry` typed on document for exhibition/conference | partially | free text | per-event-type | free text | medium | presence-only at best |
| education | ✘ | | | | | | ✘ |
| custom profile fields | ✔ `formResponses[f_id]` | ✘ | ✘ | per-event | none without mapping | varies | ✘ |

No column qualifies today. The prerequisite is a **semantic role on `FormField`** (e.g. `role?: 'dob' | 'gender' | 'city' | …`) with a controlled option→category mapping, set by the organizer or the template, plus a rollup — a schema change, hence a separate phase.

---

## 7. Age

No canonical age. DOB exists only as an unmapped custom `date` field. Even when mapped, event-date age requires `events/{slug}` start instant (present) and the DOB parsed from a widget-formatted string; average/median would need row reads or a rollup. **Unsupported now; Tier 3 after F-1 + rollup.** Average age is additionally discouraged on completeness grounds (optional field; coverage unknown per event).

---

## 8. Gender / other demographics

Gender is a template `radio` with editable options; not structured, not mapped, not normalised. Categories present in defaults: `Male`, `Female`, `Other / Prefer not to say` (one combined option — the brief's `Other` and `Prefer not to say` are **not** separately represented). **Unsupported now; Tier 3.** No normalisation of free-text values may be attempted.

---

## 9. Geography

`city`/`state` widget types exist but store strings; no gazetteer, no hierarchy, no normalisation, no country field. Heatmaps and city distributions are **unsupported**; a "top cities" table would rank spelling variants. Tier 3 after a structured location field (controlled list) and rollup.

---

## 10. Category / pass intelligence

Canonical source: `passId` on the registration; `pricing.passes` on the event for labels. Already served by Registrations (`byPass` from counters with `byPassBasis`, `aggregateValueByPass`, cancelled-by-pass). Participants must **not** duplicate it. Pass *share* (pct of confirmed) is a pure derivation over existing `byPass` — Tier 1 only as a presentation of existing data, and only if placed in Participants rather than repeated.

Conference `selectedSessions` per-session counts: `array-contains` + `eventSlug` equality — index-merge support for array-contains is not confirmed by a declared composite; classify **Tier 2 conditional on emulator + index verification**, else Tier 3.

---

## 11. Registration status

Exact definitions (from `RegistrationStatus` and the writers):

- `confirmed` — seat held; counted in counters and rollups.
- `pending` — awaiting manual approval (`approvalMode: 'manual'`); not a seat yet.
- `waitlisted` — queue (platform-wide `WAITLIST_ENABLED=false` today).
- `cancelled` — seat released (by organizer/attendee); counters decremented, rollup `cancelled` +1 on the day.
- `rejected` — manual-approval refusal; never a seat.

All five are already published by Registrations from `aggregateRegistrationStatusCounts`. Participants may segment by them but must not merge them into "inactive".

---

## 12. Payment segmentation

`paid / free / paymentPending / refunded / refundPending` already published by Registrations from `getRegistrationSplit`. `free` = `paymentStatus == 'not_required'` — semantically distinct and useful. Participants adds nothing here; do not re-read.

---

## 13. Returning participants

CRM defines it (`totalRegistrations >= 2` per contact, workspace-wide, any status, any event, includes same-event duplicates). Limitations:

1. **F-3** — paid registrations never reach the CRM live path; only `lib/crm/backfill.ts` (organizer-triggered rebuild) makes contacts complete.
2. Workspace-level only; `computeAnalytics` scans ≤ `CRM_SCAN_CAP` (5,000) contacts with a `truncated` flag — a capped source.
3. Per-event "returning" needs contacts ∩ event registrations: activities carry `metadata.eventSlug` but only `(contactId, createdAt)` is indexed; the join is a scan.
4. `totalRegistrations` counts creations, never decrements on cancel.

Classification: **Tier 3** — requires (a) CRM emit on the paid path, (b) a backfill run per workspace, (c) a per-event rollup (`returningCount` written at registration time from the contact's prior count, or a contact→event membership index).

---

## 14. Event-to-event participation

Possible only through CRM activities per contact (workspace-scoped by `organizerUid` — cross-workspace is structurally impossible since `contactId` embeds the workspace uid). Any cross-event metric (participants in ≥2 events, affinity) needs the same infrastructure as §13 plus a per-event membership index. **Tier 3.**

---

## 15. Cohorts

Deterministic cohorts available from canonical data: **registration month** (from `registeredAt`, IST), **pass**, **status**, **payment status**, **registration source**. Not available: first-event, edition, geography, participant type, returning/new (identity-dependent). Cohort *retention* (did cohort X return) is unsupported (§13–14, §16).

---

## 16. Event editions

No linkage field of any kind in `events`, `eventDrafts` or the wizard config. "Returned from the previous edition" is **unsupported**. Not to be inferred from names or dates.

---

## 17. Participant trends

Registrations already publishes `byDay` (confirmed), `cancelledByDay`, and `period` vs baseline from IST rollups with coverage. Participants must reuse those series — no second read. New-participant / returning-participant / demographic trends: unsupported (identity/demographics). Registration-source trend (walk-ins per day) would need a rollup field the daily stats do not carry (`stageDailyStatsIncrement` has no source dimension) → Tier 3; lifetime and windowed *totals* by source are feasible (§27–28).

---

## 18. Date/time semantics

| Timestamp | Meaning | Use |
|---|---|---|
| `registeredAt` | creation instant (UTC) | registration/participant windows; indexed with `organizerUid`+`eventSlug`(+`status`/`paymentStatus`/`passId`/`checkedIn`) |
| `checkedInAt` | admission | Operations only |
| `refundedAt` | refund completion | Revenue only |
| `updatedAt` | last mutation | never a metric |
| `auditLog.timestamp` | lifecycle entries | not indexed; not for aggregates |
| CRM `firstSeenAt/lastSeenAt` | epoch ms | workspace-level recency only |
| rollup `day` | IST key | trend, period, baseline |

Windowing rule: `istRangeBounds(range)` on `registeredAt` (23:45 UTC → next IST day), exactly as 12-26/12-28. No Reports UTC `rangeBounds`; no event-timezone `?trend=` semantics inside Analytics.

---

## 19. Completeness / coverage

| Metric | Coverage |
|---|---|
| status / payment / pass counts | complete (aggregates / counters; per-pass complete post 2026-08-11) |
| daily trend | rollup coverage marker (`historySince`, `coveragePartial`) |
| `registrationSource` | complete by definition (absent ⇒ online) |
| `uid` presence | partial by nature (guest flows) — presence share is a fact, not a gap |
| CRM | best-effort + paid-path gap (F-3) + 5,000 scan cap |
| custom demographics | optional per event; unknown per-event fill rate; no coverage instrumentation |

Any demographic metric would need a per-metric `known / unknown / unavailable` triple; none exists today, which is a further reason to keep demographics Tier 3.

---

## 20. PII / privacy

PII fields: `attendee.name/email/phone`, `formResponses` (may hold DOB, address, emergency contact, medical consent, blood group — template fields exist for all), `companyName/designation/website`, `uid`, `bibNumber`+name, `attendeePhotoKey`. Registry policy marks email/phone/organizerUid `sensitive`. Analytics must remain aggregate-only: no names, lists, or raw responses. Small-cohort leakage is real for any future bucket (a 1-person "Other" gender bucket on a 12-person event identifies someone) — **no suppression threshold exists on the platform**; adopting one is a product/policy decision for the demographics phase, not to be invented now.

---

## 21. Permissions

Roles: `owner`, `admin`, `manager`, `finance`, `checkin_staff`, `checkin_lead`. Analytics route: `authorizeAnyWorkspace` + event scope; gate roles 403; `financeAllowed = transactions`. CRM: role-based (`checkin_staff` denied; `finance` donations-only, read-only).

| Data | owner | admin | manager | finance | gate |
|---|---|---|---|---|---|
| aggregate registration composition (status/pass/source) | ✔ | ✔ | ✔ | ✔ (already sees Registrations) | ✘ |
| demographic aggregates (future) | ✔ | ✔ | ✔ | ✔ — but see note | ✘ |
| cross-event / returning (future, CRM-derived) | ✔ | ✔ | ✔ | ✘ recommended (CRM gives finance donations-only) | ✘ |
| participant-level details | ✘ in Analytics for everyone — belongs to Registrations/CRM screens under their own permissions | | | | |
| money inside any participant widget (pass revenue) | `transactions` only | | | | |

No broadening. A pass-share widget must carry counts only; pass *value* stays in Revenue.

---

## 22. Event-type behaviour

Event types in the wizard: `awards, community, conference, cultural, custom, exhibition, fundraising, meetup, sports, workshop`. Universal facts: status, payment status, pass, `registeredAt`, `registrationSource`, `uid` presence. Type-specific: sports (`bibCategory`, identifier, timing), conference (`selectedSessions`, attendee type option field), exhibition (`companyName/industry/passType`, visitor type), fundraising (donor type, donation amount field — Revenue/Donations domain), cultural ("Age Group" option field). Nothing type-specific is a universal metric; presence-based counts must be gated by event type/capability and by index availability (§25).

---

## 23. Custom registration fields

Definitions: `FormField { id (random), label, type, options, required, visible, section, conditionalLogic, passVisibility }` stored on the event draft's `registrationForm`; responses stored as `formResponses[id]` (string / array / boolean, widget-dependent). Historical schema: field ids persist per event; editing a field's options after registrations exist leaves old values un-remapped. No semantic registry (F-1). **Custom-field intelligence: Tier 3 / unsupported.**

---

## 24. Scale

| Read | Bound | Fit for a metric? |
|---|---|---|
| `aggregateRegistrationStatusCounts` | 7 count() | ✔ |
| `getRegistrationSplit` | 1 + N count() | ✔ |
| `registrationCounters` + shard fold | 1 doc + shards | ✔ |
| `organizerDailyStats` per window | one doc per day | ✔ |
| `registrationSource == 'walkin'` count | equality merge (`eventSlug`+`registrationSource`) — no composite needed | ✔ (Tier 1) |
| windowed source count | needs `(organizerUid, eventSlug, registrationSource, registeredAt)` — **not declared** | ✘ without index |
| `uid` presence count | needs `orderBy('uid')` + composite `(eventSlug, uid)` — not declared | ✘ |
| `selectedSessions array-contains` | index-merge support unverified | Tier 2 conditional |
| CRM `computeAnalytics` | 5,001-row scan, `truncated` | ✘ for analytics |
| CRM `where('totalRegistrations','>=',2).count()` | needs `(organizerUid, totalRegistrations)` — not declared | ✘ |
| registrations list/export | 51-row page / bounded export | not analytics |
| distinct email | no aggregate | ✘ |

No raw scan is acceptable; no proposal below needs one.

---

## 25. CRM integration

CRM is the platform's authoritative *identity* (normalized email per workspace, deterministic ids, idempotent activities, backfill). It is not authoritative for *counts* until F-3 is fixed and a backfill has run. Analytics must never re-implement identity; when returning/cross-event metrics are built, they must read CRM-derived rollups, not recompute from emails.

---

## 26. Reports consistency

Reports catalogue (`transactions, settlements, wallet-ledger, donations, refunds, broadcast-usage, gst, payout-statement`) contains **no participant/demographic report**; the registrations export (`lib/registrations/exportColumns`) is an operational PII export under `registrations` permission with UTC/event semantics of its own. No contradiction to reconcile; no Reports change proposed.

---

## 27. Tier 1 — safe now

Facts provable from canonical aggregates, none of them a duplicate of Registrations:

1. **Registration source composition** — `walkin` count (equality aggregate) and online = total − walkin; lifetime; universal; shares of registrations (F-7).
2. **Signed-in share** — *only if* an index-free formulation exists; it does not (§24) → moved to Tier 3. (Listed here to record the decision.)
3. **Identity-honest framing** — a module header stating "counts are registrations (seats); one person may hold several" and the `limitPerEmail`/`limitPerMobile` state of the event (from `registrationRules`, already read for capabilities) as a *fact panel*, not a metric.
4. **Pass share** and **status share** — pure percentages over the `registrations.byPass` / status counts the payload already carries; rendered in Participants only if Registrations does not already show shares (it shows counts) — presentation-only, no read.

Honest assessment: Tier 1 is thin. That is the finding, not a failure of the audit.

---

## 28. Tier 2 — safe with small bounded implementation

1. **Registration-source by status** (`eventSlug + registrationSource + status` equality counts, ≤ 10 aggregates) — e.g. walk-ins confirmed vs cancelled.
2. **Conference session occupancy** (`selectedSessions array-contains sessionId` + `eventSlug`) — conditional on an emulator + declared-index verification that array-contains merges with equality without a composite; else Tier 3.
3. **Registration-month cohort sizes** — from the IST rollups already read for the trend (sum of `confirmed` per month) — pure derivation, no read.
4. **Module gate** — replace the hard-coded `hasParticipantData: false` with a truthful capability: true when the event has any Tier 1/2 fact to show (always, for source composition) — a one-line producer change plus the module component.

---

## 29. Tier 3 — new infrastructure

- Demographics (age, gender, city/state/country) — needs a semantic role on `FormField` + controlled option mapping + per-event rollups + coverage triple + suppression policy.
- Unique participants per event — distinct-email rollup (or contactId membership) maintained at write time.
- Returning / first-time participants, lifetime event count, event-to-event affinity — CRM emit on the paid path, backfill guarantee, per-event contact membership index/rollup.
- Edition retention — edition linkage on the event model.
- Windowed registration-source trend — rollup dimension or `(organizerUid, eventSlug, registrationSource, registeredAt)` index.
- Signed-in share — `(eventSlug, uid)` composite or rollup.
- Exhibition/conference profile presence (company, industry, attendee type) — indexes or rollups; free-text values never bucketed.
- Cohort retention, lifetime participant value, predictive scoring, normalised geography.

---

## 30. Unsupported metrics

Unique participants; returning participants (per event or workspace, until F-3 + rollup); edition retention; average/median age, age bands; gender distribution; city/state/country distribution or heatmap; demographic trends; new-vs-returning trend; participant lifetime value; any metric from `formResponses`; any cross-workspace figure; any participant-level list inside Analytics.

Each is unsupported because the data is unmapped, unindexed, or incomplete — not because the query is hard.

---

## 31. Failure / absence contract

Existing conventions apply unchanged: `Count = number | null`; absent key = not applicable to this event; `null` = read failed; `0` = measured; `limits.*` for capped sources; `coverage.partial` for rollups. For any future demographic: a `{ known, unknown, unavailable }` triple per metric so a 60 %-filled field never describes 100 % of participants, and an absent optional answer is `unknown`, never a category. No new vocabulary needed for Tier 1/2.

---

## 32. Comparison contract

- Previous period: available for rollup-backed series (already in Registrations); Participants must reuse `registrations.period` rather than recompute.
- Previous event: `mode: 'event'` declared but unwired (12-26, 12-28) — not to be built here.
- Previous edition: unsupported (§16).
- Source composition: lifetime only in Tier 1/2 (no windowed index).

---

## 33. Security / IDOR

Route: `authorizeAnyWorkspace` → `resolveAnalyticsEventIdentity(eventId)` → deny when `identity.organizerUid !== authz.workspaceUid` or `!requireEventScope(...)`; gate roles 403; all reads take `organizerUid` from the authorized context. Registration reads are `eventSlug`(+`organizerUid`)-scoped; CRM ids embed the workspace uid; no participant identity leaves the server. Any new read must add `organizerUid` equality (as 12-28 did). Enumeration risk: none for aggregates; would arise only if a future widget listed contacts — forbidden here.

---

## 34. Required tests (for the implementation phase)

Counts: zero / positive source composition; walk-in + online = total; null propagation. Identity: the module header states seats ≠ people; no code path equates registrations with unique participants (source assertion); no email/phone/name read in the participants path. Demographics/geography: source assertions that no `formResponses`, `ageBuckets`, `genderBuckets`, `cityBuckets` are produced (contract keys remain absent). Returning: `participants.returning` remains absent; no CRM read in the analytics path. Dates: not applicable to lifetime Tier 1; if Tier 2.3 cohorts ship, IST month boundaries from rollup day keys. Coverage: `limits`/`coverage` passthrough unchanged. Permissions: five roles as in 12-28; no `spend`/money inside participants. Scale: 20k fixture; only `count()` in the new source; no `.limit(`/`.get()` on a page. Event-type: session occupancy only for conference with sessions configured; absent otherwise. Isolation: two events, two workspaces.

---

## 35. Browser QA (for the implementation phase)

1440 / 834 / 390; owner, finance, admin, manager, gate-staff; assert: module visible only when the gate is true; "registrations, not people" caption present; source composition figures match seeded arithmetic (n walk-ins); no `NaN/Infinity/undefined/null`; no names/emails/phones in DOM; no money without `transactions`; `main` and `documentElement` overflow 0 (the 12-28 lesson); definition text readable at 390px (no truncation of caveats); no console errors.

---

## 36. Exact implementation boundary (RD-12-29)

**Build:**
- `readRegistrationSourceCounts(organizerUid, eventSlug)` — equality aggregates for `registrationSource == 'walkin'` (lifetime) and, per status, the ≤10-aggregate split; online = total − walkin; `null` on failure.
- `ParticipantAnalytics` contract extension: `composition: { walkin: Count; online: Count; byStatus?: … ; basis: 'registration_source_field' }`, `identity: { limitPerEmail: boolean|null; limitPerMobile: boolean|null; basis: 'registration_rules' }`, `passShare`/`statusShare` pure derivations. Existing optional keys (`returning`, `ageBuckets`, `genderBuckets`, `cityBuckets`) stay declared and **absent**.
- Producer: `hasParticipantData` becomes truthful (composition always available); reason string kept in a comment.
- Session occupancy only after the index-merge verification passes on the emulator **and** a declared-index review; otherwise excluded.
- `components/analytics/participants/ParticipantsAnalytics.tsx` + page route, reusing `ModuleChrome`, `Section`, `RailMetric`, `DefinitionRows`-style rows, with the seats≠people caption in the header.
- Tests per §34; QA per §35.

**Do not build:** anything in §29/§30; any read of `formResponses`, `attendee.*`, CRM collections; any index, collection, rollup, schema or `FormField` change; any Reports change; any change to Registrations/Revenue/Operations/Communications modules; no per-event comparison.

**Separate future phases (named, not started):** (A) Form-field semantic roles + demographic rollups + suppression policy; (B) CRM paid-path emit + backfill guarantee + per-event returning rollup; (C) edition linkage on the event model.

---

## 37. Risks / open questions

1. Whether a Participants module with only source composition + identity facts is worth shipping ahead of phases A/B — product call; the audit's position is that an honest thin module beats a hidden one, but shipping nothing is also defensible.
2. F-3 severity outside analytics: the CRM page's "repeat attendees" and retention are wrong for paid-heavy workspaces until backfilled — a CRM hardening item independent of this phase.
3. `duplicateCheck` fail-open — registration hardening item.
4. array-contains + equality index-merge behaviour must be verified before Tier 2.2.
5. Small-bucket suppression policy — needed before any demographic bucket exists.

---

## 38. Worktree verification

HEAD `b7e5fdf` unchanged; 0 staged; only file created: `docs/RD-ANALYTICS-12-29-PARTICIPANT-INTELLIGENCE-AUDIT.md`. No source, test, rules, index, schema, config, commit, push, deploy, emulator write or build. Concurrently modified registration/CRM files inspected in place, unmodified.

---

## 39. Final verdict

**APPROVED WITH CONDITIONS.**

- C-1 Implement only §36; the module's counts are registrations and say so; no metric may be labelled "participants", "unique" or "returning".
- C-2 No demographics, geography, age, gender, uniqueness, returning, edition or cross-event metric until phases A/B/C exist.
- C-3 No read of `formResponses`, `attendee.*`, `crmContacts`, `crmActivities` in the analytics path; no new index, collection or schema.
- C-4 Session occupancy ships only with emulator + index verification recorded in the implementation report.
- C-5 F-3 (paid path never emits CRM) and the fail-open duplicate check are recorded as separate hardening items.

STOP. Awaiting review before RD-12-29 implementation.

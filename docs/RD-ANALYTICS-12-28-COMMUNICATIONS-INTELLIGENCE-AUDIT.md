# RD-ANALYTICS-12-28 — COMMUNICATIONS INTELLIGENCE AUDIT

**Type:** AUDIT ONLY — no source, test, rules, index, schema, data or deployment changes.
**Date:** 2026-09-11
**Baseline:** HEAD `b7e5fdf`, 0 staged, 798 worktree entries (captured to `$TEMP/rd1228-baseline.txt`). `firestore.rules` / `firestore.indexes.json` modifications predate this workstream (mtimes 3 Sep / 8 Sep) and were inspected in place, not touched.
**Concurrent-change note:** the auth/login workstream has uncommitted edits in `app/(dashboard)/dashboard/communications/**`, `app/api/organizer/email-logs/route.ts`, `app/(admin)/admin/communication-center/PageClient.tsx` and the Razorpay webhook routes. Every observation below about those files is from the in-place worktree content; none was modified.
**Predecessors:** RD-ANALYTICS-11 (Communications module — aggregates, unknown ≠ failed), RD-PLATFORM-COMMS-01 Phase 4F/4G (admin timeline + projection), WA-2 (Meta status webhook), RD-LAUNCH-05 (SES suppression), RD-WA-LOGS-02/03, RD-ANALYTICS-12-26 (IST windows, comparison model).

---

## 1. Executive summary

RegisterDesk already ships a **Communications analytics module** (RD-ANALYTICS-11) that is more honest than most commercial products: per-channel `sent / delivered / failed / unknown / queued / skipped` from `count()` aggregates, delivery rate over *confirmed outcomes* only, transport timeouts reported as `unknown` rather than folded into `failed`, SMS/Push declared `not_implemented` rather than zero, and spend absent without `transactions`. 37 unit pins protect that behaviour.

What this audit establishes is **what can be added on top of it without lying**, and the answer is narrower than the brief's candidate list:

| # | Finding | Sev |
|---|---|---|
| F-1 | `emailLogs` is written **best-effort** (`writeEmailLog` never throws, returns `''` on failure) and every caller `void`s it. The log is the only per-message record. It is therefore *near-complete*, not canonical; no metric derived from it may be presented as an exact provider truth. | P2 (constraint) |
| F-2 | Delivery-status webhooks (SES/Resend) fall back to matching **by recipient email, up to 50 rows, with no event/organizer/date filter** when the provider message id does not match. A Delivery or Bounce for one message can mark up to 50 rows to the same address — across events and workspaces — `delivered` or `failed`. Rare path (only when `providerMessageId` is absent or unmatched), but it breaks event isolation of *status*, not of rows. Pre-existing; out of scope to change here. | P2 |
| F-3 | **Three spend figures disagree by design.** Analytics `spend` = Σ `emailLogs.costPaise` (per-message allocation, written only on `sent` rows); the wallet ledger `walletTransactions/broadcast_<id>` charges the **full campaign upfront** with no reversal for failures; `communicationUsage` records `quantity: successCount` against `costPaise: actualCostPaise` (whole campaign). Analytics spend therefore **understates what the organizer was charged** whenever a broadcast has failures. | P2 (semantic) |
| F-4 | A dead computation survives in the engine: the `.limit(CAP+1)` `emailLogs` page still builds `byTemplate`, which no contract field, normaliser or component consumes. It costs one capped read per analytics call for nothing except the spend fallback. | P3 |
| F-5 | Reports "Broadcast Usage" labels `successCount` as **"Delivered"**. `successCount` is provider-*accepted* (sent), not delivered. Analytics and Reports disagree on the word. | P3 (Reports; do not change here) |
| F-6 | Organizer-directed system messages (`organizerWhatsApp.ts`, templateKey = notification type, `eventId: eventSlug`) land in the same event bucket as attendee messages. "Messages sent" for an event includes alerts sent *to the organizer*. Direction (attendee vs organizer) is not stored. | P3 |
| F-7 | Windowed (date-ranged) communication counts are index-constrained: `(organizerUid, eventSlug, status, createdAt)` and `(organizerUid, channel, eventSlug, status, createdAt)` are declared, so per-status windowed counts are feasible; **no index carries `deliveryUnknown` with `createdAt`**, so a windowed `unknown` count needs a new index and is Tier 3. | design constraint |
| F-8 | `broadcastCampaigns` is a durable, event-scoped campaign collection with `(organizerUid, eventSlug, status)` and `(organizerUid, eventSlug, sentAt DESC)` indexes. The RD-11 module declined to publish a campaign count because it reasoned from *distinct `campaignId` in emailLogs*; a `count()` on `broadcastCampaigns` answers it exactly. | opportunity |
| F-9 | Reminders are still read as a `.limit(500)` page and counted in memory; `scheduledReminders` supports equality `count()` by `eventId` + `status`. | P3 |
| F-10 | A second analytics projection exists (`lib/communications/analytics`, admin Communication Center): capped scan, server-local `setHours` bucketing, and a status vocabulary with `opened/clicked` that nothing ever emits. It is admin-only and must **not** be reused for organizer analytics. | note |

**Verdict (§30): APPROVED WITH CONDITIONS.**

---

## 2. Current communication architecture

```
                 ┌──────────────────────────── emailLogs (one row per message, any channel) ──────────────────────┐
                 │  written best-effort by 23 call sites; mutated by SES/Resend/Meta webhooks and by the retry route  │
                 └───────────────────────────────────────────────────────────────────────────────────────────────────┘
   transactional ─┐                                       ▲                                        ▲
   sendConfirmationEmail / sendApproval / sendCancellation │                                        │ status advance
   sendRefund / sendRejection / waitlist* / certificates   │  writeEmailLog / updateEmailLog       │ (delivered, failed, waStatus)
   sendWhatsAppConfirmation / certificates/whatsapp        │                                        │
   organizerWhatsApp (TO the organizer)                    │                             /api/webhooks/ses  /api/webhooks/resend
   reminders/dispatch (templateKey event_reminder)         │                             /api/whatsapp/webhook → applyWhatsAppDeliveryStatus
   platform mail (otp, review, settlement) eventId ''      │
   broadcast ─────────────────────────────────────────────┘
   broadcastCampaigns ──► chargeAndStartCampaign (walletTransactions broadcast_<id>) ──► emailJob | whatsappJob ──► finalizeBroadcast
                                                                                          (rows: templateKey 'broadcast', campaignId)   (successCount/failCount/sentAt, communicationUsage best-effort)
   scheduledReminders ──► /api/cron/reminders ──► reminders/dispatch ──► emailLogs rows + reminder.counts
```

Transports: **Email** (SES primary, Resend alternative, per-event provider via `resolveEventEmailProvider`), **WhatsApp** (Meta Cloud API, `lib/whatsapp`). **SMS**: priced (`COMM_PRICING.sms.domestic = 25`), typed in `BroadcastChannel`/`ReminderChannel`, **no transport** (no sender module; `lib/notifications/channels.ts` names it). **Push**: named only; no FCM/token/device code anywhere in `lib` or `app`.

Analytics consumer: `lib/analytics/communicationsSources.ts` → `eventAnalytics.ts` → `normalize.ts` → `CommunicationsAnalytics` contract → `components/analytics/communications/CommunicationsAnalytics.tsx`, with pure derivations in `communicationsModel.ts`.

---

## 3. Source-of-truth matrix

| Channel / object | Collection | Write path | Read path (analytics) | Event scope | Workspace scope | Date field | Status fields | Provider | Cost data | Nature |
|---|---|---|---|---|---|---|---|---|---|---|
| Email message | `emailLogs` | `writeEmailLog` (best-effort), `updateEmailLog` (webhooks, retry) | `count()` by `eventId` + `status` | `eventId` = **slug** (`''` for platform mail) | `organizerUid` | `createdAt` (serverTimestamp, UTC); `updatedAt` on status change; **no `deliveredAt` for email** | `status ∈ queued/sent/delivered/failed/skipped`, `error ∈ 'bounce'/'complaint'/free text` | `provider` string | `costPaise` absent/0 | near-complete, **mutable**, provider-dependent for `delivered` |
| WhatsApp message | `emailLogs` (`channel:'whatsapp'`) | same + `applyWhatsAppDeliveryStatus` (transactional, monotonic) | same, plus `deliveryUnknown == true` | slug | `organizerUid` | `createdAt`; `deliveredAt`/`readAt`/`failedAt`/`statusUpdatedAt` from Meta | `status`, `waStatus ∈ sent/delivered/read/failed`, `deliveryUnknown` | `'meta'` | `costPaise` on `sent` rows (50 p utility, or campaign share) | near-complete, mutable-monotonic, provider-dependent |
| Broadcast campaign | `broadcastCampaigns` | create route; `chargeAndStartCampaign`; `finalizeBroadcast` | **not read by analytics** (Reports only) | `eventId` + `eventSlug` | `organizerUid` | `createdAt`, `scheduledFor`, `sentAt` | `status ∈ draft/scheduled/sending/sent/partial/failed/cancelled`, `recipientCount/successCount/failCount` | `channel` | `estimatedCostPaise`, `actualCostPaise` (charged upfront) | **canonical for campaign identity**, mutable until final |
| Broadcast billing | `walletTransactions/broadcast_<campaignId>` | one atomic txn | not read | via campaign | `organizerUid` | `createdAt` | — | — | charged amount | canonical ledger, append-only, idempotent id |
| Usage record | `communicationUsage` | `finalizeBroadcast` (`.catch(()=>{})`) | not read | slug | uid | `createdAt` | — | — | `costPaise` (whole campaign) vs `quantity: successCount` | best-effort, **inconsistent units** |
| Scheduled reminder | `scheduledReminders` | reminders service; cron dispatch | `.limit(500)` page, counted in memory | `eventId` = slug or `null` (account-level) | `organizerUid` | `sendAt`, `sentAt` | `status ∈ scheduled/sending/sent/partial/failed/cancelled/skipped`, `counts{recipients,sent,failed,skipped}` | `channel` | — | canonical for the job; **capped read** |
| Suppression | `emailSuppressions` (platform-wide + organizer) | SES/Resend webhooks, unsubscribe | not read | none | platform / uid | `suppressedAt` | reason `bounce/complaint/unsubscribe` | — | — | append-ish, not event-scoped |
| Admin timeline | projection over `emailLogs` | — | `limit`ed scan, server-local `setHours` | none | none | `createdAt` | superset vocabulary (`opened/clicked` never emitted) | — | — | derived, capped, **admin only** |

`emailLogs` has **no `eventId` composite indexes**; the lifetime aggregates work through Firestore's equality-only zig-zag merge over single-field indexes. Every declared composite uses `eventSlug` (with `organizerUid` prefix). `eventId` and `eventSlug` hold the same slug value on every event-scoped writer inspected (confirmation, WhatsApp confirmation, certificates, reminders, broadcasts, organizer WhatsApp), so a windowed query must filter on `organizerUid` + `eventSlug` to hit an index.

---

## 4. Email findings

| Metric | Classification | Basis |
|---|---|---|
| Emails queued | AVAILABLE | `status == 'queued'` count (email = all − whatsapp, exact) |
| Emails attempted (sent+delivered+failed) | AVAILABLE | RD-11 `sent` definition |
| Emails sent (left the platform) | AVAILABLE | same |
| Emails delivered | AVAILABLE WITH CONDITIONS | only after an SES/Resend Delivery webhook; absent webhook config ⇒ 0 delivered is a *measured* zero of confirmations, not of deliveries — the UI must keep saying "confirmed by provider" |
| Emails failed | AVAILABLE | provider rejection, bounce or complaint (`status == 'failed'`, `deliveryUnknown` absent on email rows) |
| Hard bounce vs soft bounce | UNSUPPORTED | the webhook marks **both** permanent and transient bounces `failed` with `error:'bounce'`; `bounceType` is stored only on the suppression record, never on the log |
| Bounce count (any) | AVAILABLE WITH CONDITIONS | `error == 'bounce'` equality count is index-feasible; includes transient bounces |
| Complaint count | AVAILABLE WITH CONDITIONS | `error == 'complaint'` |
| Delivery rate | AVAILABLE | `deliveryRate()` over confirmed outcomes — already shipped |
| Failure rate | AVAILABLE | complement — shipped |
| Bounce rate | PARTIAL | bounce ÷ attempted, but the numerator mixes hard/soft |
| Unique recipients | UNSUPPORTED (analytics) | requires distinct `recipientEmail` — a row scan; the broadcast-time `dedupeRecipients` count is not persisted per campaign |
| Duplicate recipients / suppression applied | UNSUPPORTED | `dedupeEmails` flag is stored; the number collapsed is not |
| Campaigns / broadcasts | AVAILABLE (F-8) | `broadcastCampaigns` count by `eventSlug` (+`channel == 'email'`) |
| Scheduled emails | AVAILABLE WITH CONDITIONS | `broadcastCampaigns.status == 'scheduled'` + `scheduledReminders` by status (§17) |
| Transactional emails | AVAILABLE WITH CONDITIONS | rows where `templateKey != 'broadcast'` — Firestore `!=` count works but excludes rows lacking the field (none: every writer sets it) |
| Event-triggered emails | PARTIAL | by `templateKey in [...]` catalogue (≤30 values); catalogue is code, not data |
| Open rate / click rate | UNSUPPORTED — UNSAFE TO PRESENT | no tracking pixel, no link wrapping, no field, no writer (pinned by test 14) |
| Unsubscribe rate | UNSUPPORTED per event | unsubscribes land in the suppression list, not on logs, not event-scoped |
| Reply rate | UNSUPPORTED | no inbound email path |
| Provider response status | AVAILABLE (row-level only) | `providerResponse` string; not aggregatable |
| Provider delivery webhook status | AVAILABLE WITH CONDITIONS | `status` advance; subject to F-2 fallback matching |
| Email cost (any breakdown) | AVAILABLE, measured zero | `COMM_PRICING.email = 0`; the sum aggregate returns 0 for email-only events — a **true** zero, may be shown as "Email is free" not as "spend ₹0" without context |

---

## 5. SMS findings

| Item | Status |
|---|---|
| Sending | **Not implemented** — no transport module; `BroadcastChannel`/`ReminderChannel` type it, `COMM_PRICING.sms` prices it, nothing sends |
| Scheduling / broadcasts / transactional | not implemented (a campaign with `channel:'sms'` is gated in the UI; nothing dispatches it) |
| Delivery / failure tracking, webhooks, timestamps, message ids, cost tracking, recipient counts, dedupe, retry | none |

Analytics correctly publishes `{ key:'sms', support:'not_implemented' }` with no `delivery` block (test 7, 10, 30). **No SMS metric may be shown as 0.** If SMS is ever wired, the channel flips to `supported` in exactly one place (`SUPPORTED_CHANNELS`).

---

## 6. WhatsApp findings

- **Enabled:** when the `META_*` env set is complete (`lib/whatsapp/config.ts`); the platform charges 50 p per utility message from the organizer wallet.
- **Message types:** transactional confirmation (`sendWhatsAppConfirmation`), certificate-ready, broadcast (`whatsappJob`), organizer alerts (`organizerWhatsApp` — recipient is the organizer).
- **Broadcast behaviour:** recipients resolved from the audience at send (or at cron time for scheduled), phone normalised to E.164 (`lib/communication/phone`), invalid numbers logged `failed` with `costPaise: 0`, already-`sent` recipients skipped on chunk resume, `dedupePhones` flag persisted (roadmap item; **not** exercised or changed here — it affects only *row count*, not status semantics, so it has no bearing on the metrics recommended below).
- **Delivery state machine (monotonic, transactional):** `sent(1) → failed(2) → delivered(3) → read(4)`; a later-ranked status never regresses; `failed` cannot supersede `delivered/read`. Coarse `status` mirrors it (`read ⇒ 'delivered'`). Timestamps `deliveredAt/readAt/failedAt/statusUpdatedAt` are Meta's, stored as Firestore Timestamps.
- **Unknown:** transport timeout ⇒ `status:'failed'` + `deliveryUnknown:true`. RD-11 subtracts these from `failed` and publishes `unknown`. This audit **confirms the four-state split must survive**: `delivered` / `failed` / `unknown` / `not attempted` (`queued`+`skipped`).
- **Read:** `waStatus == 'read'` is countable (equality) — a WhatsApp-only engagement signal; it must never be labelled "opened" alongside email.
- **Retry:** `lib/email-logs/whatsappRetry.ts` re-sends on the same row (mutable); attempts are not multiplied.
- **Webhook:** `/api/whatsapp/webhook` → `applyWhatsAppDeliveryStatus` matches by `providerMessageId == wamid` only (limit 10) — **no recipient fallback**, so F-2 does not apply to WhatsApp.
- **Cost:** per-row `costPaise` on `sent` rows only; broadcast rows carry `actualCostPaise / total` allocation; **failed and unknown rows carry 0 although the wallet was charged for them** (F-3).
- **Message ids / campaign ids / scopes:** `providerMessageId` (wamid), `campaignId`, `eventId`/`eventSlug` (slug), `organizerUid`.

| Metric | Classification |
|---|---|
| sent / delivered / failed / unknown / queued / skipped | AVAILABLE (shipped) |
| read count | AVAILABLE WITH CONDITIONS (WhatsApp-only label) |
| wallet-skipped count | AVAILABLE WITH CONDITIONS (`status=='skipped'` ∧ `error=='Insufficient wallet balance'` — equality on both; `isWalletSkippedWhatsAppLog` is the canonical matcher) |
| delivery latency (`deliveredAt − createdAt`) | UNSUPPORTED in aggregate (needs rows) |
| unique numbers reached | UNSUPPORTED (needs rows) |
| cost per delivered | UNSAFE TO PRESENT until F-3 is resolved (numerator understated) |

---

## 7. Push findings

No push infrastructure exists: no FCM/APNs client, no device-token store, no subscription UI, no dispatcher. Every push metric is **UNSUPPORTED**; the module's `{ key:'push', support:'not_implemented' }` is the correct and only representation.

---

## 8. Transactional vs broadcast

The **only stored discriminator** is `templateKey === 'broadcast'` (+ `campaignId` present) — `BROADCAST_TEMPLATE_KEY` in `lib/email-logs/types.ts` is the declared constant. Everything else is transactional or system:

- attendee transactional: `registration`, `registration_confirmation`, `registration_approved`, `ticket`, `updated`, `cancelled`, `rejected`, `refund`, `waitlist_joined`, `application`, `certificate`, `certificate_ready`, `event_reminder`, `custom` (reminders);
- organizer/system (still event-scoped when a slug exists): organizer WhatsApp alert types, `review`;
- platform (`eventId: ''`, never in an event's analytics): `otp`, `welcome`, `settlement`.

| Metric | Classification |
|---|---|
| total communications (event) | AVAILABLE (shipped as `totalMessages`) |
| broadcast messages | AVAILABLE — `templateKey == 'broadcast'` equality count |
| transactional messages | AVAILABLE WITH CONDITIONS — total − broadcast (exact, one extra aggregate), **includes organizer-directed alerts** (F-6); label as "Automatic messages", not "attendee messages" |
| scheduled communications | AVAILABLE WITH CONDITIONS — union of `broadcastCampaigns.status=='scheduled'` and `scheduledReminders.status=='scheduled'`; two objects, two counts, must not be summed into one "scheduled" figure without saying what it counts |
| attendee vs organizer direction | UNSUPPORTED as a stored fact; catalogue-based `in` split is fragile and belongs to a later phase that stores `recipientType` at write time |

---

## 9. Event / workspace scoping

- Analytics `eventId` is the **slug** (`events/{slug}`); every event-scoped writer stores that slug in both `eventId` and `eventSlug`. `readCommunicationCounts` filters on `eventId` **only** — no `organizerUid` clause. Slugs are globally unique (`events/{slug}` is a single collection) and the route has already proven the caller's workspace owns the slug (`identity.organizerUid !== authz.workspaceUid` ⇒ denied), so rows cannot cross workspaces via this read. A defensive `organizerUid` equality would cost nothing and is recommended when the read is next touched (it is also what the indexes need for windowed queries, §13).
- Platform mail (`eventId: ''`) never matches an event.
- Broadcast campaigns carry `eventId`, `eventSlug`, `organizerUid`; reminders carry slug-or-null + `organizerUid`.
- **F-2** is the one isolation defect: webhook fallback matching by `recipientEmail` mutates *status* on rows of any event/workspace sharing that address. Rows never move between events; their `delivered/failed` flag can. Bounded (≤50 rows × ≤5 addresses per webhook), rare (needs a missing/unmatched `providerMessageId`), pre-existing, outside this phase.
- Conceptual test: Event A rows never appear in Event B counts — holds by equality filter. Workspace A never sees Workspace B — holds by route authz + slug ownership.

---

## 10. Permission matrix

Roles (`lib/team/types.ts`): `owner` (all), `admin` (`events, registrations, broadcasts, certificates, checkin, walkin, participants`), `manager` (`events, registrations, checkin, walkin, participants`), `finance` (`wallet, settlements, transactions`), `checkin_staff` (`checkin`), `checkin_lead` (`checkin, walkin`).

| Data | owner | admin | manager | finance | checkin_* | Gate in code |
|---|---|---|---|---|---|---|
| Operational counts (sent/delivered/failed/unknown, channels, reminders, certificates) | ✔ | ✔ | ✔ | ✔ | ✘ (403) | `authorizeAnyWorkspace` + event scope; no permission beyond workspace membership (test 21) |
| Communication spend (`spend`) | ✔ | ✘ | ✘ | ✔ | ✘ | `transactions` → `includeFinancial`; aggregate not issued otherwise (tests 17–20) |
| Communication Log rows (recipient email/phone, subject, provider response) | ✔ | ✔ | ✘ | ✘ | ✘ | `/api/organizer/email-logs` requires `broadcasts` |
| Broadcast campaigns list (recipient counts, cost) | ✔ | ✔ | ✘ | ✘ | ✘ | `broadcasts` |
| Reports "Broadcast Usage" (workspace, cost column) | ✔ | ✘ | ✘ | ✔ | ✘ | `wallet` |
| Provider metadata (message ids, responses) | row-level only, via the log route | | | | | never in analytics |

Notes: `finance` sees operational counts but not the log (correct — counts carry no PII). `admin` sees cost on the campaign list (`actualCostPaise` via `broadcasts`) but **not** `spend` in Analytics — an existing asymmetry; the Analytics gate is the stricter of the two and must stay `transactions`. No broadening is proposed.

---

## 11. PII findings

- The analytics contract carries **no PII**: counts, labels, `MaybeMoney`. `communicationsModel.ts` and the component add no data access (test 26).
- Existing PII surfaces: `/api/organizer/email-logs` (recipient email, phone, name, subject, `providerMessageId`, `providerResponse`, `error`) — appropriate for the Communication Log under `broadcasts`, **not** for analytics; `/api/organizer/broadcasts` (`html` body, subject); admin Communication Center timeline (`recipient` string, template ids).
- Risk to avoid in implementation: "unique recipients", "top recipients", "latency" all require row reads and would pull addresses into the analytics path. They are marked UNSUPPORTED for that reason as much as for scale.
- `campaignId` and `templateKey` are not PII and may appear in aggregates; message bodies and template content must not.

---

## 12. Date/time semantics

| Field | Meaning | Type | Zone |
|---|---|---|---|
| `emailLogs.createdAt` | when the platform attempted / queued the message | serverTimestamp | UTC instant |
| `emailLogs.updatedAt` | last mutation (status advance, retry) | serverTimestamp | UTC instant — **not** a delivery time |
| `emailLogs.deliveredAt/readAt/failedAt` | Meta's status timestamp | Timestamp | UTC instant (provider-normalised by `webhookStatus.ts`) — WhatsApp only |
| `broadcastCampaigns.createdAt / scheduledFor / sentAt` | creation / planned / finalised | Timestamp | UTC instants |
| `scheduledReminders.sendAt / sentAt` | planned / executed | Timestamp | UTC instants |
| Reports `rangeBounds` | filter window | — | **UTC** day boundaries |
| Analytics `istRangeBounds` (12-26) | filter window | — | **IST** (+330) day boundaries |
| Admin timeline `setHours(0,0,0,0)` | filter window | — | **server-local** — neither |

**Rule for Communications Analytics:** bucket by `createdAt` (the attempt instant) using `istRangeBounds` / `dayKey`. A message at 2026-09-10 23:45 UTC is 2026-09-11 05:15 IST and belongs to **11 Sep**. Do not reuse Reports' `rangeBounds`. Delivery *date* for email is unavailable (only `updatedAt`), so "delivered in window" for email must mean "attempted in window and since confirmed", never "confirmed in window".

---

## 13. Date range / comparison support

Current module: **lifetime only**, no ranges, no comparison chips (component §1 comment: "Lifetime counts, so no comparison chips").

Feasibility of windowed counts (`count()` with `createdAt >= from && < to`) against declared composites:

| Query | Index needed | Declared? |
|---|---|---|
| per-status, all channels: `organizerUid, eventSlug, status, createdAt` | `(organizerUid, eventSlug, status, createdAt DESC)` | **yes** |
| per-status, per-channel: `organizerUid, channel, eventSlug, status, createdAt` | `(organizerUid, channel, eventSlug, status, createdAt DESC)` | **yes** |
| any status in window (`organizerUid, eventSlug, createdAt`) | `(organizerUid, eventSlug, createdAt)` | **no** — derive as Σ of the 5 per-status counts |
| unknown in window (`deliveryUnknown == true` + range) | `(organizerUid, [channel,] eventSlug, deliveryUnknown, createdAt)` | **no** (F-7) |
| broadcast in window (`templateKey == 'broadcast'` + range) | `(organizerUid, eventSlug, templateKey, createdAt)` | **no** — only `(organizerUid, templateKey, createdAt)` and `(organizerUid, channel, templateKey, createdAt)` exist, both without event |
| campaigns in window | `(organizerUid, eventSlug, createdAt DESC)` / `(…, sentAt DESC)` on `broadcastCampaigns` | **yes** |

The email channel still needs the "all − whatsapp" subtraction inside the window (pre-`channel` rows), so a windowed email figure is 2 aggregates per status. Cost per window: 5 statuses × 2 = 10 aggregates + 5 WhatsApp = 15, ×2 for a baseline = 30 zero-document aggregates. Acceptable.

Consequences: 7/30/90/custom windows and previous-period comparison are **feasible for `sent`, `delivered`, `failed(raw)`, `queued`, `skipped` and campaign count**; **not** for `unknown` (so windowed true-`failed` = raw − unknown is also not derivable) until an index is approved. Comparison must ride `compareMetric` with `coveragePartial` / `baselineOutsideCoverage`; coverage for logs has no rollup `historySince`, so the baseline reason must be derived from the event's creation date (a baseline window before the event existed is `baselineOutsideCoverage`).

Distinguish: zero rows in window = measured 0; aggregate threw = `null`; index absent = `null` (must not be 0); provider data missing (no webhook) = `delivered` measured but low, disclosed by the existing "confirmed by provider" basis text.

---

## 14. Delivery-state semantics

| Channel | Guaranteed transitions | Provider-specific | Mutable? | Overlap? | Retries |
|---|---|---|---|---|---|
| Email (SES/Resend) | `queued→sent` (writer), `sent→delivered` (Delivery webhook), `sent/queued→failed` (Bounce/Complaint or send error). `failed` is never overridden by `delivered` | `delivered` requires webhook config; bounce type not distinguished | yes (`updateEmailLog`); retry flips `failed→sent` on the **same row** | no — one `status` per row | one row, N attempts invisible |
| WhatsApp (Meta) | monotonic rank `sent<failed<delivered<read`; transaction-guarded | `read`; `deliveryUnknown` (RegisterDesk-side, not Meta) | yes, monotonic | no; `unknown` is a flag over `failed` and is subtracted | same-row retry (`whatsappRetry.ts`) |
| Broadcast campaign | `draft/scheduled→sending→sent|partial|failed`; `cancelled` | — | until final | `successCount+failCount == recipientCount` | none |
| Reminder | `scheduled→sending→sent|partial|failed|skipped|cancelled` | — | until final | `counts` sums | none |

**No single universal funnel.** The honest shared shape is the RD-11 one: *attempted* → {*delivered* | *failed* | *unknown*} with *queued* and *skipped* outside. Email has no `unknown` producer today (always 0, a measured zero); WhatsApp has no email-style bounce. A "Queued → Attempted → Sent → Delivered" ladder would put `sent` and `delivered` in sequence when the data has them as siblings of one `status` — do not build it.

---

## 15. Recipient / duplicate semantics

- Raw recipient count: `broadcastCampaigns.recipientCount` (after `dedupeEmails`/`dedupePhones` when set; the pre-dedupe number is **not stored**).
- Rows per campaign: `emailLogs` where `campaignId == id` (index `(organizerUid, channel, campaignId, createdAt)` exists for the log view) — equals `recipientCount` when logging did not drop rows (F-1).
- Unique / normalised / cross-campaign / event-level unique recipients: **UNSUPPORTED** — require distinct-by-address over rows.
- Reproducibility: a campaign's audience is not snapshotted as a list; `recipientCount` + `registrationDateFilter` + `audience` are the only provenance. Recipient counts are reproducible as *numbers*, not as *sets*.

---

## 16. Campaign / broadcast support

`broadcastCampaigns` is durable and uncapped in storage. Feasible now via `count()` / `sum()`:

| Metric | Classification | Query |
|---|---|---|
| campaigns (lifetime / window / by status) | AVAILABLE | `organizerUid, eventSlug[, status]` (+`createdAt` range, indexed) |
| recipients across campaigns | AVAILABLE WITH CONDITIONS | `sum('recipientCount')` — sum needs an index carrying the field; the declared `(organizerUid, eventSlug, status, successCount)` covers `successCount`, **not** `recipientCount`; treat as `gone('requires_index')` on failure, never 0 |
| accepted across campaigns | AVAILABLE | `sum('successCount')` over `(organizerUid, eventSlug, status, successCount)` with a status equality |
| failures across campaigns | PARTIAL | `sum('failCount')` — not in any declared index; same `gone` rule |
| delivery per campaign | AVAILABLE WITH CONDITIONS | `successCount` is **accepted**, not delivered (F-5); true delivered per campaign = `emailLogs` `campaignId == id ∧ status == 'delivered'` |
| campaign duration | UNSUPPORTED in aggregate (`sentAt − createdAt` per row) |
| campaign cost | AVAILABLE (`actualCostPaise`, `transactions`-gated) — this is the **charged** figure, unlike Analytics `spend` (F-3) |
| top / recent campaigns | UNSUPPORTED for analytics (needs rows; the Broadcasts screen already lists them under `broadcasts`) |

---

## 17. Scheduled communication support

- `scheduledReminders`: status vocabulary `scheduled/sending/sent/partial/failed/cancelled/skipped`; `counts{recipients,sent,failed,skipped}`; `eventId` slug or null; declared index only `(status, sendAt)` for the cron. Equality `count()` by `eventId` + `status` works through merge joins (no composite needed), so the engine's `.limit(500)` page (F-9) can be replaced by 7 aggregates; `counts.recipients` sum would need `sum()` over an index carrying it (not declared) — keep it from the page only while the page is complete, as spend already does.
- `broadcastCampaigns.status == 'scheduled'`: countable.
- Placement: scheduled work is **execution state**, not delivery. Keep it in Communications (it is there today as "Scheduled reminders — execution, never delivery"), do not mirror it into Operations, and do not sum reminders with campaigns.

---

## 18. Cost / financial semantics

| Source | What it measures | Unit | Actual/estimated | Date | Event | Reversal |
|---|---|---|---|---|---|---|
| `emailLogs.costPaise` (Analytics `spend`) | per-message wallet charge **recorded on sent rows**; broadcast rows carry `actualCostPaise/total` allocation; failed/unknown rows 0 | paise, INR | allocation | `createdAt` | slug | none |
| `walletTransactions/broadcast_<id>` | amount **debited** for the campaign (unit × recipientCount) at start | paise | actual | ledger `createdAt` | via campaign | none — failures are not credited back |
| `broadcastCampaigns.actualCostPaise` | same as ledger | paise | actual | `sentAt` | slug | none |
| transactional WhatsApp `deductWhatsAppCharge` | per message, at send, only if balance allows (else `skipped`) | paise | actual | `createdAt` | slug | none |
| `communicationUsage` | `quantity: successCount` vs `costPaise: actualCostPaise` | paise | inconsistent | `createdAt` | slug | best-effort write |

Provider cost vs organizer charge: the platform stores only the **organizer charge** (`COMM_PRICING`); Meta/SES invoice cost is not modelled. Email is ₹0 (true zero).

Existing canonical combination: `profitEstimate = net − refunds − commMoney` in `eventAnalytics.ts` (published under `financial.profitEstimate`, `transactions`-gated). That is the **only** approved place spend meets revenue; do not add another.

Recommendation: leave `spend` as is but rename its basis text to "wallet charges recorded on sent messages"; do **not** publish "cost per delivered message" until charged-vs-allocated is reconciled (F-3) — a rate whose numerator omits charged failures flatters the organizer's unit cost.

---

## 19. Scale analysis

| Read | Mechanism | 100 | 1k | 5k | 20k+ | Long history |
|---|---|---|---|---|---|---|
| RD-11 channel counts | 16 `count()` aggregates, zero docs | ✔ | ✔ | ✔ | ✔ | ✔ (lifetime, no window) |
| `spend` | 1 `sum()` | ✔ | ✔ | ✔ | ✔ | ✔ |
| engine `.limit(CAP+1)` page (F-4) | 5 001-doc read | ✔ | ✔ | truncates at 5 001 → `limits.communications=false`, breakdown withheld, spend fallback withheld | same | same |
| reminders `.limit(500)` (F-9) | page | ✔ | ✔ | silently capped at 500 reminders (no `+1` detection; `limits.reminders` is a catch flag) | | |
| certificates `.limit(CAP)` | page | ✔ | ✔ | silently capped at 5 000 (no `+1`) | | |
| Reports Broadcast Usage | `fetchScoped` with `truncated` flag | ✔ | ✔ | flagged | flagged | flagged |
| Admin timeline / projection | `limit` scan | — admin only | | | | |
| Webhook matching | ≤50 rows per id / address | bounded | | | | |
| Proposed windowed counts | ≤30 aggregates | ✔ | ✔ | ✔ | ✔ | ✔ |
| Proposed campaign counts/sums | ≤8 aggregates | ✔ | ✔ | ✔ | ✔ | ✔ |

The reminders and certificates pages are the two reads that can still change historical figures silently at scale (500 / 5 000). They are outside the RD-11 fix and are listed as Tier 2 replacements. No raw scan is proposed anywhere.

---

## 20. Failure / unavailable contract

| Case | Count metric | Money metric | Channel with no transport |
|---|---|---|---|
| A measured zero | `0` | `money(0)` (email-only event: true ₹0) | — |
| B measured positive | `n` | `money(n)` | — |
| C read failure | `null` per field; whole block `null` only when every aggregate failed | `gone('query_failed')` | — |
| D unauthorized | operational counts still returned (no PII); `spend` key **absent** | absent | — |
| E provider unsupported | — | — | `support:'not_implemented'`, no `delivery` key |
| F partial / capped | `limits.communications=false` for the breakdown page; counts unaffected | fallback withheld when truncated | — |
| G index missing (windowed / sum) | `null` | `gone('requires_index')` | — |
| H webhook not configured | `delivered` is a measured count of confirmations (possibly 0) with the "confirmed by provider" basis; rate becomes `NO_RATE('No message has a confirmed outcome yet')` when nothing confirmed | — | — |

These are the existing conventions (`Count`, `MaybeMoney`, absent-vs-null, `ChannelSupport`). No new absence vocabulary is needed for Tier 1/2.

---

## 21. Existing Analytics contract integration

- `Count = number | null` — every new count.
- `MaybeMoney` — every new money (`spend`, campaign cost), `transactions`-gated at the producer, key absent otherwise.
- `RevenueState` — **not** applicable (it encodes an entitlement dimension that operational counts lack; do not import it into Communications).
- `compareMetric` / `ComparisonUnavailable` (`coveragePartial`, `baselineOutsideCoverage`) — for any windowed comparison; baseline reason derived from event creation date and index availability.
- `istRangeBounds` (12-26) — window boundaries.
- `AnalyticsLimits.communications / reminders / certificates` — already declared; keep populating.
- `capabilities` — Communications has no per-event capability gate today and needs none (every event can send email); WhatsApp is an *organizer* capability (Meta env + wallet), already expressed through `support`.
- Route: `app/api/organizer/analytics/[eventId]` — no new endpoint; the module nav (`AnalyticsModuleNav`) already lists Communications.
- The admin `lib/communications/analytics` projection is a separate, capped, admin-only architecture (F-10) and must not be merged with or imported by organizer analytics.

---

## 22. Event-type behaviour

Event types found in code: sports/marathon, conference, community, workshop, exhibition, cultural, awards, fundraising (`/campaign/[slug]` donation pages), meetup, application-based events (`templateKey 'application'`). Communications analytics reads only `emailLogs` / `broadcastCampaigns` / `scheduledReminders`, none of which carry `eventType`, BIB, timing or identifier fields; the component uses channel and status vocabulary only. Verified universal; no sports terminology present. Fundraising adds `donor` as a recipient type in the admin timeline only — invisible to organizer analytics.

---

## 23. Reports consistency

| Aspect | Analytics Communications | Reports "Broadcast Usage" |
|---|---|---|
| Source | `emailLogs` aggregates (per message) | `broadcastCampaigns` rows (per campaign) |
| Date | lifetime (window proposal: IST `createdAt`) | UTC `rangeBounds` on `createdAt` |
| Permission | workspace (counts) / `transactions` (spend) | `wallet` |
| Scope | one event | workspace, optional `eventSlug` filter |
| "Delivered" | provider-confirmed | **`successCount` = accepted** (F-5) |
| Cost | Σ allocated `costPaise` on sent rows | `actualCostPaise` charged |
| Cap | none for counts | `fetchScoped` truncation flagged |

The differences are intentional in origin (message-level vs campaign-level; finance vs analytics) but the **"Delivered" label and the two cost bases are contradictions**, not intentions. Recommended for a later Reports phase: relabel to "Accepted", and footnote cost as "charged". Not changed here.

---

## 24. Recommended metrics

### Tier 1 — safe now (already shipped, or one equality aggregate on existing data)
1. sent / delivered / failed / unknown / queued / skipped per channel and overall *(shipped)*
2. delivery rate, failure rate, unconfirmed share with denominators *(shipped)*
3. total messages *(shipped)*
4. spend (`transactions`) *(shipped; basis text to be corrected — see Tier 2.7)*
5. **campaign count** (lifetime, by status) — `broadcastCampaigns` `count()` (F-8)
6. **broadcast vs automatic message split** — `templateKey == 'broadcast'` count; automatic = total − broadcast
7. **bounce / complaint counts** (email) — `error == 'bounce'` / `'complaint'`, labelled "bounces (any type)"
8. **WhatsApp read count** — `waStatus == 'read'`, WhatsApp-only label
9. **wallet-skipped WhatsApp count** — `status=='skipped' ∧ error==WHATSAPP_WALLET_SKIP_REASON`

### Tier 2 — safe with small bounded implementation
1. **Windowed sent/delivered/queued/skipped + raw failed** per channel over 7/30/90/custom, IST, via declared `(organizerUid, [channel,] eventSlug, status, createdAt)` indexes; `null` on index absence
2. **Previous-period comparison** for the Tier 2.1 figures via `compareMetric`, baseline outside coverage when before event creation
3. **Communication velocity** (messages attempted per day in window) — pure function over 2.1, mirrors `revenueVelocity`
4. **Channel mix** (share of attempted by channel) — pure over Tier 1
5. **Campaign accepted total** — `sum('successCount')` with status equality (indexed); recipients/failures sums only where an index carries the field, else `gone('requires_index')`
6. **Reminders by status via aggregates** replacing the 500-page (F-9); certificates issued via `count()` replacing the 5 000-page (downloaded stays from the page while complete, or becomes `null`)
7. Basis-text corrections: spend = "wallet charges recorded on sent messages"; automatic messages "including alerts sent to you" (F-6)
8. Remove the dead `byTemplate` computation or publish it (F-4) — recommend remove, keeping the page solely as the documented spend fallback

### Tier 3 — requires new data infrastructure
1. Windowed `unknown` (and therefore windowed true-`failed`) — new index `(organizerUid, channel, eventSlug, deliveryUnknown, createdAt)`
2. Windowed broadcast split — new index `(organizerUid, eventSlug, templateKey, createdAt)`
3. Cost per delivered message / spend vs charged reconciliation — needs failure credit or a stored charged-per-row (F-3)
4. Hard vs soft bounce — store `bounceType` on the log at webhook time
5. Attendee vs organizer direction — store `recipientType` at write time
6. Delivery latency, unique recipients, duplicate-suppressed counts — need per-campaign rollups written at finalize
7. Delivery date for email — store `deliveredAt` in `updateEmailLog`
8. Daily communication rollups (`organizerDailyStats`-style) if windowed reads outgrow the aggregate budget

### Unsupported (§25)

---

## 25. Unsupported metrics

Open rate, click rate, unsubscribe rate (per event), reply rate, hard/soft bounce split, unique recipients, duplicate recipients, cross-campaign reach, per-campaign delivery latency, campaign duration, top/recent campaigns inside analytics, SMS anything, Push anything, provider (Meta/SES) invoice cost, cost per delivered message, a sequential Queued→Sent→Delivered funnel, attempts per recipient (retries reuse the row), any "engagement" figure combining WhatsApp `read` with email.

Each is unsupported because **no writer produces the fact**, not because the query is hard. None may be rendered as 0.

---

## 26. Exact RD-12-28 implementation boundary

**Must:**
- Reuse `communicationsSources.ts` / `eventAnalytics.ts` / `normalize.ts` / `contract.ts` / `communicationsModel.ts` / `CommunicationsAnalytics.tsx`; one route; existing nav.
- Keep `authorizeAnyWorkspace` + event scope; keep `spend` and any campaign cost behind `transactions` with the aggregate not issued otherwise.
- Use `istRangeBounds` for windows; `compareMetric` for deltas; `Count`/`MaybeMoney` absence discipline; `gone('requires_index')` where an index is undeclared.
- Every new read is a `count()`/`sum()` against declared indexes or equality-only merges; no new document pages.
- Add `organizerUid` equality to communication reads when touching them (required for windowed indexes anyway).

**Must not:**
- Add indexes, collections, rules, rollups, webhooks or provider changes (all Tier 3 → separate infrastructure phase).
- Change `writeEmailLog` semantics, broadcast dedupe (`dedupeEmails`/`dedupePhones`), billing, finalize, retry, or webhook matching (F-2 and F-3 are reported, not fixed, here).
- Touch Check-in, Revenue, Operations, Reports, or the admin Communication Center.
- Render SMS/Push as anything but `not_implemented`; render `unknown` inside `failed`; render opens/clicks; render a windowed `unknown` as 0 when its index is absent.

If the review decides Tier 2.1/2.2 are wanted with `unknown` inside the window, that is an **index approval** and belongs to a dedicated infrastructure phase, not RD-12-28.

---

## 27. Risks / open questions

1. **Index deployment is unverifiable from the repo** (as in 12-27). Windowed counts must degrade to `null` if the composite is not live; the emulator does not enforce indexes, so the implementation phase must include an explicit `requires_index` path test.
2. F-2 fallback matching — should the webhook constrain the fallback by `status in ['sent','queued']` and a recency bound? (Separate hardening phase.)
3. F-3 — should failed broadcast recipients be credited, or should `costPaise` be written on failed rows as charged? Product decision; affects the meaning of `spend`.
4. Whether `organizerWhatsApp` alert rows should carry the event slug at all (F-6) — product decision.
5. `communicationUsage` appears to have no reader; confirm before relying on or deleting it.
6. Retention/pruning of `emailLogs` — the SES webhook comment mentions "pruned log"; if a pruning job exists, lifetime counts are bounded by it (not found in this audit; open).

---

## 28. Test requirements for implementation

Only for behaviours this audit found supported:

- Zero communications → every count `0`, rates `NO_RATE`, no chips.
- Measured communications → counts, rates with denominators.
- Delivery failure vs unknown → `failed` excludes `deliveryUnknown`; `unknown` cell separate (extend existing 3/11/28).
- Provider unsupported → SMS/Push `not_implemented`, no `delivery` key (existing 7/10/30).
- Campaign count from `broadcastCampaigns`, by status; never from distinct `campaignId` rows (source assertion).
- Broadcast vs automatic split: automatic = total − broadcast; null when either null.
- Bounce/complaint counts are equality aggregates on `error`; label contains "any type".
- Windowed counts: IST boundaries (23:45 UTC → next IST day), per-status Σ for "all", email = all − whatsapp inside the window, `null` (not 0) on aggregate throw / missing index.
- Previous-period comparison: baseline before event creation → `baselineOutsideCoverage`; no delta from a `null` side.
- Windowed `unknown` **not published** (source assertion) until its index exists.
- Event isolation: two events' rows never mix (equality filter on slug + `organizerUid`).
- Workspace isolation: existing route tests.
- Role isolation: manager/admin/finance see counts; `spend` and campaign cost absent without `transactions`; gate roles 403.
- Financial gating: campaign cost aggregate not issued without `transactions` (mirror of existing 20).
- Reminders/certificates via aggregates: no `.limit(500)` / `.limit(CAP)` for issued counts (source assertion); `downloaded` withheld or from a complete page only.
- 20k-recipient fixture: counts come from aggregates — assert no `.get()` on a document page in the counting path (extend 22).
- No false zero: every `.catch` in the new reads resolves to `null`/`gone`, never `0`.
- Spend basis text and "including alerts sent to you" wording pinned.

---

## 29. Worktree / change-safety verification

- HEAD `b7e5fdf` unchanged; 0 staged before and after.
- Only file created: `docs/RD-ANALYTICS-12-28-COMMUNICATIONS-INTELLIGENCE-AUDIT.md`.
- No source, test, rules, index, schema, data, migration, workflow or config edits; no commit/push/deploy; no emulator writes; no production access.
- Concurrently-modified communication files inspected in place; none modified, formatted or restored.
- Dashboard revenue contract, Check-in, Operations, Reports untouched.

---

## 30. Final verdict

**APPROVED WITH CONDITIONS.**

Conditions for the implementation phase:

- C-1 Tier 1 and Tier 2 only; every Tier 3 item and every index/collection/webhook change is deferred to a separate infrastructure phase.
- C-2 Windowed figures cover `sent/delivered/queued/skipped/raw failed` and campaigns only; `unknown` stays lifetime, and windowed true-`failed` is not derived.
- C-3 `spend` keeps its `transactions` gate and gains the "charges recorded on sent messages" basis; no cost-per-delivered metric.
- C-4 Broadcast vs automatic split labelled to include organizer-directed alerts; no attendee/organizer split.
- C-5 Reminders and certificates move to aggregates or degrade to `null`; no silent page caps remain in the communications path.
- C-6 F-2, F-3, F-5 are recorded as separate hardening items (webhook matching, billing reconciliation, Reports label) and are not fixed inside RD-12-28.

STOP. Awaiting review of this audit before any implementation.

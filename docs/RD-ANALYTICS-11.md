# RD-ANALYTICS-11 — Communications Intelligence

**Status:** **BLOCKED on repository stability.** Audit, implementation, browser QA and
documentation are complete, and every validation gate passes. The phase is not signed off
because another session is editing this working tree while the suites run — four of its files
changed inside the last validation window (§6.3). One clean emulator re-run against a still
tree is all that is outstanding. Not committed, not pushed, not deployed.
**Scope:** communication analytics only. No change to sending, broadcast execution, WhatsApp,
email, SMS, Push, templates, permissions, payments, routes or schema.

---

## 1 · Audit findings

### 1.1 The canonical store: `emailLogs`

Despite the name, `emailLogs` is the **multi-channel** communication log. `lib/email-logs/types.ts`
is the shared type, and it is unusually honest already:

```ts
export type EmailLogStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped'
export type CommunicationChannel = 'email' | 'whatsapp'      // absent ⇒ 'email'
export type WhatsAppDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed'
```

Every row carries `organizerUid`, `eventId`, `eventSlug`, `templateKey`, `status`, `provider`,
`costPaise?`, `campaignId?`, and — for WhatsApp — `waStatus?`, `deliveredAt?`, `readAt?`,
`failedAt?`.

### 1.2 The `deliveryUnknown` flag — the most important field in this phase

```ts
/**
 * True when the send ended in a TRANSPORT failure (timeout / network) rather than a
 * decision by Meta — i.e. RegisterDesk aborted before Meta answered, so delivery is
 * UNKNOWN, not failed. `status` deliberately stays 'failed' so every existing consumer
 * behaves exactly as before; this flag is purely additive and is what lets the WhatsApp
 * surface say 'unknown' instead of asserting non-delivery.
 */
deliveryUnknown?: boolean
```

The product already made the §4 distinction and recorded it. `status: 'failed'` therefore
covers **two different facts** — Meta rejected the message, and RegisterDesk never heard
back. Any failure count that does not subtract `deliveryUnknown` asserts non-delivery it
cannot know. This module separates them.

### 1.3 Channel support — data-driven, not UI-driven

`lib/notifications/channels.ts` declares four channels and states plainly that only some
have transports:

> *"Only EMAIL is wired today … WHATSAPP, SMS and PUSH are declared for the Provider
> Resolver to grow into — no transport exists for them yet."*

That comment is now partly stale: WhatsApp **is** wired (`lib/broadcasts/whatsappJob.ts`,
`lib/certificates/whatsapp.ts` both write `channel: 'whatsapp'` rows with `waStatus`).
SMS and Push remain unimplemented — no sender, no log writer, no rows.

| channel | transport | log rows | analytics |
|---|---|---|---|
| Email | SES-style provider | yes | **supported** |
| WhatsApp | Meta, with a status webhook | yes | **supported**, incl. `read` and `unknown` |
| SMS | **none** | none | **not supported** — never a zero |
| Push | **none** | none | **not supported** — never a zero |

### 1.4 Opens and clicks do not exist

`EmailLog` has no `openedAt`, `clickedAt`, or engagement field, and nothing writes one. Per
§15 **no open/click analytics are built.** `readAt` exists for WhatsApp only and is a Meta
delivery state, not an email open — the two are not comparable and are not combined.

### 1.5 **DEFECT — the producer's communication read is capped and publishes the partial as complete**

```ts
const logs = await adminDb.collection('emailLogs').where('eventId', '==', eventId).limit(CAP).get()
for (const l of logs.docs) { … }        // CAP = 5000
```

`limits.communications` is set from `commOk` — a `catch` flag — so it is **true** for a
truncated read. An event with more than 5,000 messages publishes the first 5,000 as its
totals, exactly the class of defect RD-ANALYTICS-09 removed from the payment ledger. It also
scales with message volume, which every other analytics read stopped doing in
RD-ANALYTICS-03.

Also worth stating: the loop counts `sent` as **sent + delivered** (a delivered message was
necessarily sent). That is defensible, and it must be labelled precisely rather than left
implicit.

### 1.6 The scalable replacement exists without any new index

The metrics this module needs are all equality-filtered counts over `emailLogs`:
`(eventId)`, `(eventId, status)`, `(eventId, channel)`, `(eventId, channel, status)`,
`(eventId, deliveryUnknown)`. Firestore serves equality-only aggregates by merging
single-field indexes — **no composite to deploy**, and `count()` transfers zero documents.

Communication spend is `sum('costPaise')` under the same filters. That aggregate may fail
`FAILED_PRECONDITION` where an index does not carry the field; the answer is `gone`, never a
zero.

### 1.7 Reminders

`scheduledReminders`, read with `.limit(500)` and a `remOk` flag. Its statuses are
`scheduled | sending | sent | partial | failed`, with a `counts.recipients` snapshot. It
records **execution**, not delivery — per §7 "executed" is never called "delivered".

### 1.8 Broadcasts and recipient snapshots

`lib/broadcasts/` owns campaign execution. A job carries `estimatedCostPaise` "computed at
creation from channel + recipients", and log rows carry `campaignId`, so per-campaign
grouping is possible. Recipient counts are snapshotted at creation — §6's requirement that
historical broadcasts not be recomputed from today's registrations is already the product's
behaviour, and nothing here reconstructs an audience.

`lib/broadcasts/dedupeRecipients.ts` exists and is the current production behaviour; this
phase neither changes nor extends it, and does **not** implement duplicate WhatsApp-number
suppression.

### 1.9 Existing communication analytics

`lib/communications/analytics/resolve.ts` aggregates a **bounded 500-entry timeline window**
for the operational Communications surface. It is deliberately a recent-activity view, not an
event-total view, and is not a suitable source for event-scoped totals. It is left untouched.

### 1.10 Range, comparison, coverage, finance

Unchanged and reused: 7/30/90 presets, `previousPeriod` + `compareMetric`, the coverage
model, and the `transactions` boundary with RD-02 omission semantics. There is **no daily
communication rollup**, so a per-day communication trend cannot be produced from a bounded
source — see the limitations.

### 1.11 Event scoping

`emailLogs` rows carry `eventId`; every aggregate is filtered on it, and authorization
happens in the route before any read, exactly as in RD-08/09/10.

---

## 2 · What the audit implies for the build

Three findings decided the shape of everything below.

**The producer's communication figures were a capped page.** `emailLogs` was read with
`.limit(5000)` and counted in memory, then published as the event's totals with
`limits.communications` still true. This is the same defect RD-ANALYTICS-09 removed from the
payment ledger and RD-ANALYTICS-03 removed from registrations, and it is worse here: a
5,000-message event is an ordinary mid-sized conference, not an outlier.

**`status: 'failed'` covers two different facts.** Meta rejected the message, and RegisterDesk
never heard back because the send timed out. The second carries `deliveryUnknown: true` and
keeps `status: 'failed'` for backward compatibility. Counted together, a transport timeout is
reported as a rejected message — a claim about non-delivery that nobody established.

**`channel` is absent on every row written before WhatsApp shipped.** Absent means email.
Firestore cannot express "missing or equal to", so an equality filter on `channel == 'email'`
would silently drop the entire pre-WhatsApp history.

---

## 3 · Implementation

### 3.1 `lib/analytics/communicationsSources.ts` (new)

Every count is a `count()` aggregate and spend is a `sum()`. Firestore answers both from the
index and transfers **zero documents**, so there is no cap to overflow and the cost does not
move with message volume. All filters are equality-only, which Firestore serves by merging
single-field indexes — **no composite index is declared or required**, and the emulator suite
proves it (section 6, case 6).

| Figure | How | Why not otherwise |
|---|---|---|
| `sent` | `count(status='sent') + count(status='delivered')` | A delivered message was sent. Reporting them as rivals invites subtracting one from the other. |
| `delivered` | `count(status='delivered')` | Only ever a positive provider confirmation. Never inferred. |
| `failed` | `count(status='failed')` minus `count(deliveryUnknown=true)` | A timeout is not a rejection. |
| `unknown` | `count(deliveryUnknown=true)` | Reported in its own right, in neither rate's divisor. |
| `queued`, `skipped` | one `count()` each | Distinct states, never folded into sent. |
| email | (all minus whatsapp) per state | An equality filter loses the pre-WhatsApp history. |
| spend | `sum('costPaise')` | Issued **only** when the caller holds `transactions`. |

`readCommunicationCounts` returns **null** when the collection could not be read at all — the
RD-ANALYTICS-01 block-level contract. A *partial* read still returns the object, with the
aggregates that answered as real numbers and the ones that did not as `null`, because "we know
delivered but not skipped" is a different and more useful fact than "we know nothing".

### 3.2 The one remaining bounded read

The **template breakdown** has no aggregate — Firestore cannot group by a field — so it still
reads a page. It now reads `CAP + 1` and DETECTS its own overflow (the RD-09 pattern): over
the cap, the breakdown is withheld entirely and `limits.communications` goes false. The
aggregate-derived counts beside it are unaffected, because they never came from that page.

### 3.3 Messaging spend

```
commSpend?.ok              -> the aggregate            (exact, uncapped)
commOk && !commTruncated   -> the page's in-memory sum  (exact only because COMPLETE)
otherwise                  -> gone('out_of_budget' | 'query_failed')
```

A truncated page never contributes a money total. A caller without `transactions` never
reaches this at all: the aggregate is not issued, `spend` is **omitted** from the payload
rather than nulled, and the `financial` block is absent as in RD-02.

### 3.4 `lib/analytics/communicationsModel.ts` (new, pure)

Every rate carries its own denominator as data, because the objection in the brief's section 13
is that "92% delivered" is meaningless until the reader knows whether the unknowns were in the
divisor.

| Rate | Divisor | Reasoning |
|---|---|---|
| delivery | `delivered + failed` | Of the messages whose fate the provider told us, how many landed. Dividing by `sent` would count every unknown as a failure. |
| failure | `delivered + failed` | The same divisor, so the two are complements and can be added. |
| unconfirmed | `sent` | How much of the population the rates do **not** cover. |

No confirmed outcome yields **no rate**, never 0%. A 100% delivery rate over 4 known outcomes
out of 5,000 sent is not a good delivery rate; it is a missing webhook, and `unconfirmedShare`
is the figure that says so on screen beside it.

### 3.5 Channels

Four channels are published. `email` and `whatsapp` are `supported` and carry a `delivery`
object; `sms` and `push` are `not_implemented` and carry **no delivery key at all** — the
platform has no transport for them, and a `0` would be a claim about this event rather than
about the platform. The list is data from `SUPPORTED_CHANNELS` / `UNSUPPORTED_CHANNELS`, never
inferred from `eventType`.

`channelState()` distinguishes four situations a blank cell cannot:
`unsupported`, `unreadable`, `silent` (measured zero), `active`.

### 3.6 Reminders and certificates

`scheduledReminders` records whether a reminder **ran**, not whether its messages arrived. The
labels therefore say "Executed", and nothing computes a reminder delivery rate. Certificates
are issuance counts, not messages.

---

## 4 · What is deliberately NOT published

| Asked for | Why not |
|---|---|
| Broadcast/campaign count | Needs a count of DISTINCT `campaignId`, which Firestore has no aggregate for. Obtainable only by reading the rows — the scan this phase exists to remove. One broadcast to 5,000 recipients is one campaign and 5,000 messages; presenting either as the other is the error the brief's section 5 warns about. |
| Open rate, click rate | `EmailLog` has no engagement field and nothing writes one. WhatsApp's `readAt` is a Meta delivery state for one channel; it is not an email open and is never combined into an "engagement" figure. The UI says so explicitly rather than leaving a blank. |
| Per-day communication trend | There is no daily communication rollup. A per-day series could only come from an unbounded scan. |
| Previous-period comparison of messages | Same reason: the aggregates are event-total, and `sentAt` range filters would need a composite index this phase may not declare. |
| SMS / Push figures | No transport exists. Reported as unsupported. |

Each of these is the brief's section 29 applied literally: *if a communication metric cannot be
produced honestly at scale, prefer unavailable/deferred over an approximate number.*

---

## 5 · UI

`components/analytics/communications/CommunicationsAnalytics.tsx`, mounted at
`/dashboard/analytics/communications` beside Overview, Registrations, Revenue and Operations.
Nothing is replaced and no route is migrated.

- **KPI row** — Messages sent, Delivered, Failed, and **Unknown as its own cell**, captioned
  "Send timed out" and "Provider rejected — excludes timeouts".
- **Overall rates** — each printed with its denominator on screen, not in a tooltip.
- **Channel panels** — one per channel, rendering the four states distinctly. An unsupported
  channel says "Not available on this platform ... this is not a count of zero."
- **Reminders / Certificates** — execution and issuance, labelled as such.
- **Spend** — rendered only when the payload carried a `spend` key.
- **Trust notice** — what the figures mean and what is not measured.

An unmeasured count renders `UNAVAILABLE_MARK`; there is no `?? 0` anywhere in the module.

---

## 6 · Tests and exact results

| Gate | Result |
|---|---|
| focused — `tests/unit/analyticsCommunications.test.ts` | **35 passed, 0 failed** |
| all analytics suites (10 files matching `tests/unit/analytics`) | **359 passed, 0 failed** |
| the same 10 plus `communicationAnalytics.test.ts` | **364 passed, 0 failed** |
| full unit suite — `vitest run tests/unit` | **321 files, 8,710 collected: 8,708 passed, 1 skipped, 1 failed** |
| emulator suite — `npm run test:emu` | **43 files, 817 collected: 816 passed, 1 failed** |
| emulator — `communicationsScale.emu.test.ts` alone | **8 passed** |
| TypeScript — `tsc --noEmit` | clean |
| ESLint | clean |
| production build — `next build` | **exit 0**, `/dashboard/analytics/communications` present |
| browser QA — `rd-analytics-11-shots.mjs` | 5 events × 3 viewports × 5 roles, **0 issues** |

Figures above are from the 2026-09-06 13:00–13:19 validation snapshot. Every gate except the
last one ran against a provably unchanged tree; see §6.3 for exactly which, and for why this
phase is not being called complete despite them.

### 6.1 The failures, named

None is this phase's, and none is being waved past.

**`tests/emulator/capturedRecovery.emu.test.ts` — 15 · "a duplicate-email refusal creates NO
registration and refunds in full".** The known pre-existing payments-recovery failure. It was
failing before this phase began and the standing instruction is not to modify payments
recovery code to fix it. Every other emulator file passes.

**`tests/unit/homepageEventSections.test.ts` — "an event ending TODAY renders as upcoming".**
This one appeared *during* the phase and is worth being precise about, because a failure that
arrives mid-phase looks like a regression. It is not:

- The test hardcodes `const TODAY = '2026-09-05'` and asserts that an event ending on that date
  renders as upcoming. `upcomingSoonest` compares against the real clock.
- The full suite passed at 01:20 IST (= 19:50 UTC on 05 Sept) and fails at 10:57 IST
  (= 05:27 UTC on 06 Sept). The UTC date rolled over in between and the hardcoded constant
  expired.
- Nothing in this phase touches the homepage, discovery, or date-range code.

The fix is to derive `TODAY` from the clock rather than pin it, but that is a different
module's test semantics and outside this phase's scope, so it is reported rather than changed.

**`tests/unit/landingDesignSystem.test.ts` — "the landing primary CTA keeps its existing
radius token".** It passed in the 10:56 full run and failed in the 11:14 one. The reason is
that `components/discovery/home/HomeSearch.tsx` — the file it reads — has a modification time
of **11:14**, i.e. it was edited on this machine *while the suite was running*, from outside
this session. Its CTA now carries `rounded-md` where the guard expects `rounded-xl`. This
phase never opened `components/discovery`, and the only tools running here at that moment were
vitest and eslint, both read-only. Someone else's landing-page work is in flight; it is theirs
to finish, and it is left untouched.

### 6.2 Difference from the last recorded figure

RD-ANALYTICS-09 recorded *318 files, 8,563 passed, 1 skipped* for `tests/unit`. This phase ends
at *8,702 collected* there, and *10,035 collected* for the whole `vitest run`. Three more unit
files: RD-10's operations suite, this phase's communications suite, and one other added between
phases.

**+35 of the growth is this phase's own focused suite**, and the analytics glob accounts for
exactly the rest of what this phase authored: 358 → 359 (the `sent`-invariant case that browser
QA forced, §8.3) and, with `communicationAnalytics.test.ts`, 363 → 364 (the empty-state copy
guard). **No test was deleted, skipped or disabled in this phase.**

Everything beyond that is not attributable to this phase, and the cause is now established
rather than guessed. `tests/unit` collected 8,694 cases at 01:17, 8,701 at 10:58 and 8,710 at
11:19, while only one case of mine was added in that window. Over the same period six files in
`components/discovery/home/` **and** `tests/unit/landingDesignSystem.test.ts` acquired
modification times between 11:14 and 11:19 — during the runs, from outside this session.
Another session is editing the landing page in this working tree. That is what moved the
collected count, and it is what made `landingDesignSystem` fail at 11:14 and pass again at
11:19 once its guard was updated to match. Full-suite figures taken from this tree are
therefore a snapshot of a moving repository, not of this phase alone.

Two intermediate runs reported extra failures — 3 in one, 4 in another. Every one was
`Test timed out in 5000ms` on the FIRST case of a file, with the Firebase emulator (JVM) and a
`next start` server resident: those runs' transform times were 138s and 175s against a typical
35s. With both stopped the suite returns to the failures named in §6.1. The collected case
count is stable across every run, so nothing is being conditionally skipped.

### 6.3 Repository stability at validation time — why this is not signed off

RD-11's implementation and browser QA are finished. What is not finished is the *evidence*,
because the working tree this phase is validated against is being edited by another session
while the suites run.

**The evidence.** A fingerprint of every file (path, size, mtime) was taken at 13:00:39 and
again at 13:20:13. Four files appeared or changed in between that this session did not write:

| Time | File |
|---|---|
| 13:14:52 | `.rd-hero.mjs` (new — a Playwright hero-measurement script against `:3000`) |
| 13:16:00 | `components/discovery/home/heroSlides.ts` |
| 13:17:46 | `components/discovery/home/HeroCarousel.tsx` |
| 13:18:42 | `components/discovery/home/HeroHighlights.tsx` |

And `.rd-fit.mjs` was created at 13:20:49, after the window closed — the other session was
still working as this was written. This is the same activity that produced the earlier
11:14–11:47 burst, the `landingDesignSystem` failure that repaired itself once its guard caught
up, and the `tests/unit` collected count moving 8,694 → 8,701 → 8,710 while one case was
authored here.

**What that does and does not contaminate.** Every gate except the full emulator suite
completed before 13:14:52, against a tree whose only changes were this session's own gitignored
build side-effects:

| Gate | Ran | Tree state |
|---|---|---|
| focused, analytics ×2 | ~13:01 | stable |
| full unit suite | ~13:02–13:03 | stable |
| `tsc`, ESLint | ~13:03–13:04 | stable |
| production build | 13:04–13:06 | stable |
| `communicationsScale.emu` | 13:07 | stable |
| full emulator suite | 13:08–13:19 | **overlapped the external writes** |

The overlap is almost certainly harmless — the files written are landing-page components that
no emulator test imports, and the suite returned 816/817 with the same single known failure as
two independent earlier runs. "Almost certainly" is not the standard for signing off a phase,
so it is recorded as overlapped rather than argued away.

**What was NOT done, deliberately.** The other session's landing/discovery work was not
touched, reverted, stashed or overwritten, and `homepageEventSections` and
`landingDesignSystem` were not "fixed". No RD-11 code was changed to obtain a cleaner count.
Nothing was committed, pushed or deployed.

**To close this out**, the emulator suite needs one re-run against a tree that holds still for
its duration. Nothing else is outstanding.

### 6.4 Working-tree accounting

`git status` at 13:00:39 and at 13:20:13, against `b7e5fdf feat(finance): add finance control
center and analytics`:

| | Before | After |
|---|---|---|
| entries | 526 | 527 |
| modified / deleted / untracked | 238 / 19 / 269 | 238 / 19 / 270 |

The single difference is `?? .rd-hero.mjs`, the other session's file. **No RD-11 file changed
state during validation.** The tree carries many phases of uncommitted work; RD-11's share is
two modified tracked files (`lib/analytics/eventAnalytics.ts`,
`app/(admin)/admin/events/[slug]/PageClient.tsx`) and the rest untracked.

`tsconfig.json` is restored: it is `M` against HEAD, but its entire diff is earlier phases'
dist-dir entries (`prodqa`, `precheck`, `rd04`–`rd06b`) and it contains **zero** `next-rd11`
entries. Every `.next-rd11*` build directory this phase created has been deleted. `.next` and
`.next-emulator` remain and are both gitignored and script-managed, not artifacts of this
phase. The four files this session touched during validation — `next-env.d.ts`,
`tsconfig.tsbuildinfo`, `firebase-debug.log`, `firestore-debug.log` — are all gitignored build
and emulator side-effects.

### 6.5 Existing tests re-anchored (and why none was weakened)

| Guard | Change | Why it is not a weakening |
|---|---|---|
| `analyticsRegistrations` 29, `analyticsNormalize` 33, `analyticsOverview` 30 | `limit(CAP + 1)` may now belong to `emailLogs` as well as `platformTransactions` | Widening the collection list alone would have been a weakening, so the rule the guard always *meant* is now asserted directly: **every** bounded read detects its own overflow (`ledgerTruncated = true`, `commTruncated = true`). |
| `analyticsAuthorization` — nullable blocks | regex now spans lines | The block's members became independently nullable, so the declaration no longer fits on one line. The block itself is still asserted nullable, plus `communicationCounts`. |
| `analyticsNormalize` 7 | `channels` exempt from the walk-and-null rule | `channels` is structural — which channels the platform can send on does not depend on this event having been read. The rule is applied where it belongs: every *figure* is null, on every channel. |
| `analyticsUnavailable` fake | `where()` now honours equality; `aggregate()` added | The fake ignored filters, which was harmless while every read was a scan the producer re-filtered in memory. With `count()` aggregates an ignored `where` makes every status return the whole collection — the fake would answer questions Firestore never would. Fixture rows gained the `eventId` / `entityId` they always needed. |
| `analyticsFinancialTruth` fake | `aggregate()` sums the requested FIELD | It summed `amount` whatever was asked for. `sum('costPaise')` would have reported every event's messaging as free — a zero the producer would then have published as a measurement. |

---

## 7 · Browser QA — what was actually looked at

Emulator + `rd-analytics-11-seed.mjs` + `emu:build` + `emu:serve` on 3187 + Playwright, viewport
screenshots only (never `fullPage` — it composites a view no user ever sees). Below-the-fold
sections are captured by scrolling the last element into view, because the dashboard shell
scrolls an inner container and `window.scrollTo` does nothing here.

Five fixture events, each chosen because it renders a state the others cannot:

| Event | Shape | What it had to prove |
|---|---|---|
| `a11-email-heavy` | 1,775 rows, email only | The ordinary case reads correctly |
| `a11-whatsapp-heavy` | 1,440 rows, 70 rejections + 180 timeouts | Timeouts are NOT rejections |
| `a11-mixed` | 5,200 rows, both channels | Counts exact past the 5,000 cap; breakdown withdraws |
| `a11-quiet` | published, never sent | Measured zero, not "unavailable" |
| `a11-thin-webhook` | 5,000 sent, 4 confirmed outcomes | The flattering rate, told honestly |

### 7.1 What the screenshots show

**`a11-thin-webhook`** is the case the module exists for. Side by side on one line:

```
DELIVERY RATE 100%                          UNCONFIRMED 100%
of 4 messages with a confirmed outcome      of 5,000 messages sent
```

A reader cannot mistake that for a healthy event. Email is `active`; WhatsApp says "No
WhatsApp messages have been sent for this event" (silent); SMS and Push say "Not available on
this platform — this is not a count of zero" (unsupported). Three different absences, three
different sentences.

**`a11-whatsapp-heavy`** — `FAILED 70` and `UNKNOWN 180` as separate KPI cells. Under the old
reading both would have been 250 rejections.

**`a11-quiet`** — every KPI a measured `0`, and every rate an em-dash with "No message has a
confirmed outcome yet" / "Nothing sent". No 0% anywhere.

**`a11-mixed`, owner, foot of page** — Reminders (Scheduled 1 / Executed 2, "not a delivery
confirmation"), Certificates (30 / 12), Messaging spend **₹707**, and the trust notice ending
"Additionally, the per-template breakdown exceeded its read limit for this event." The
truncation is disclosed on screen, and the counts beside it are still exact.

**`a11-mixed`, manager, foot of page** — identical, except the Messaging spend section is not
there at all. Omitted, not shown as unavailable.

### 7.2 Roles

| Caller | Module | Spend | Endpoint |
|---|---|---|---|
| owner | renders | **₹707** | 200 |
| manager (`events`, no `transactions`) | renders in full | **absent** | 200 |
| finance (`transactions`, no `events`) | refused | — | **403** |
| checkin_staff | refused | — | **403** |
| signed out | redirected to login | — | **401** |

**There is no "manager with transactions" in this product.** `ROLE_PERMISSIONS` grants
`transactions` to `owner` and `finance` only, and `finance` does not hold `events`, so it
cannot open the analytics workspace at all — the route refuses it before any money question is
asked. The owner is therefore the only caller who can see messaging spend. This is the
existing permission model, not something this phase introduced or changed; it is recorded here
because the brief's QA matrix assumed such a role exists.

### 7.3 Viewports and presets

1440 / 834 / 390 on the two richest events: no horizontal overflow at any width, no console
errors, no page errors. At 390 the KPI rail stacks and every rate keeps its denominator on its
own line. 7D / 30D / 90D all load; the communication totals are event-lifetime figures and do
not move with the range, which is correct and is why the module shows no comparison chips on
them.

---

## 8 · Defects this phase FOUND and fixed

Three, two of which existed in code written earlier in this same phase and were caught by the
browser rather than by a green test suite.

### 8.1 A failed spend aggregate discarded an exact number it already had

`commMoney` was `commSpend ?? (fallback)`. `??` only fires on `null`, and a *failed*
aggregate is `{ok: false}`, not null — so a caller entitled to money whose `sum()` failed got
`gone` even when the complete in-memory page held the exact figure. Now the aggregate is
preferred, the complete page is the fallback, and `gone` is last.

### 8.2 A total failure returned an object of nulls instead of null

`readCommunicationCounts` always returned a `CommunicationCounts`, so an unreadable
`emailLogs` produced `{sent: null, …}` where the RD-ANALYTICS-01 contract says the whole
`communication` block is `null`. Restored, while keeping the object for a *partial* read —
"we know delivered but not skipped" is a different fact from "we know nothing".

### 8.3 `sent` did not contain the population its own rates measured — found in the browser

`sent` was `sentOnly + delivered`, which left rejections and timeouts OUTSIDE the total they
were being measured against. `unconfirmedShare` then subtracted `failed` from a denominator
that never held it and understated how much of the event went unconfirmed — on
`a11-email-heavy`, 15% instead of 18%. `sent` is now every ATTEMPT (`sentOnly + delivered +
failedRaw`), so `delivered`, `failed` and `unknown` are all subsets of it and
`sent + queued + skipped === total`. The emulator suite now asserts that identity directly.

A fourth was a copy defect, also browser-only: the rate line rendered
`"1,440 of messages sent have no delivery confirmation yet"` — the denominator read as the
count, reporting a 31% share as if the whole population were unconfirmed. `basis` is now a
noun phrase and the UI prints `of {n} {basis}`.

None of these was visible in a passing test suite. §8.3 in particular was invisible to unit
tests because the fixture happened to encode the intended invariant rather than the shipped
one.

---

## 9 · Known limitations

1. **No per-day communication trend and no previous-period comparison.** There is no daily
   communication rollup, and range-filtering `sentAt` would need a composite index this phase
   may not declare. The module therefore presents event-lifetime figures and says so, rather
   than implying a windowed series.
2. **Broadcast/campaign count is not published.** It needs DISTINCT `campaignId`, which has no
   aggregate.
3. **Opens and clicks do not exist.** Nothing records them; the UI says so permanently.
4. **The per-template breakdown is still capped** at 5,000 rows, because grouping has no
   aggregate. It detects its own overflow and withdraws — it never publishes a partial.
5. **Messaging spend reaches only the owner**, for the permission-model reason in §7.2.
6. **`emailLogs` is the sole source.** WhatsApp's `readAt` is recorded but is not surfaced as
   an engagement metric, because it exists for one channel only and would not be comparable.

---

## 10 · Strict scope — what was NOT touched

No change to: sending, broadcast execution, WhatsApp, email, SMS, Push, templates, the
notification engine, reminder execution, certificate generation, payments, Razorpay, refunds,
payouts, check-in, timing, identifiers, permissions, `ROLE_PERMISSIONS`, Firestore rules,
Firestore indexes, the schema, any collection, or any route. No new collection, no new field,
no migration. `/dashboard/reports`, `/dashboard/analytics`, `/dashboard/finance/reports` and
`/analytics/overview/[eventId]` are untouched. Nothing was committed, pushed or deployed.

# RD-DASHBOARD-05 · Dashboard Final Data + UI Audit

**Scope of this change:** the Organizer Dashboard (`/dashboard`) now follows the global Event
Selector. Every event-scopable figure describes the selected event; everything that cannot be
divided by event is labelled instead of quietly mixed in. Plus per-user show/hide section
controls and the UI corrections that fell out of the visual pass.

**Verification status (after RD-DASHBOARD-06, below):** `tsc` clean · ESLint clean ·
**5,062 unit tests pass** (263 files) · production build succeeds · **46/46 real-browser checks
pass** against the Firebase emulator with two dissimilar events, one draft, and one deliberately
malformed registration.

---

## 1 · The one rule, and how it is enforced

> **The Event Selector is the single source of truth. A number is either the selected event's,
> or it says which scope it belongs to.**

| Layer | Enforcement |
|---|---|
| Client | The page reads `selectedEventId` from `EventContext` and **nothing else**. No `useSearchParams`, no private storage read, no "first event" default. A test asserts it does not even hold the context's event *list*. |
| Transport | `GET /api/organizer/dashboard?eventId=<draftId>` |
| Server | The id is resolved against `users/{workspaceUid}/eventDrafts/{eventId}`. Ownership is proven **by the path** — an event another organizer owns does not exist there. |
| Refusal | A bad id returns `404 EVENT_NOT_IN_WORKSPACE`, and never falls back to "all events." ~~An unpublished one returns `409 EVENT_NOT_PUBLISHED`.~~ **Superseded by RD-DASHBOARD-06 §3** — a draft is selectable, so it is now served as a scope state. |
| Label | The header badge names the applied scope, read from the server's echo (`data.scope`), never from the client's request. |

### Security posture — unchanged

Nothing in this change weakens authorization, and the audit re-verified each guarantee:

- The workspace uid still comes from `authorizeAnyWorkspace(req)` → `authz.workspaceUid`. The
  scope parameter did **not** introduce a second, client-supplied identity. A test asserts the
  route never reads `uid` / `organizerId` / `workspaceUid` from the query string.
- `eventId` is a **request, not an authorization**. A forged id cannot widen the result set,
  because the document it names does not exist under the caller's own path.
- The finance gate is untouched: still `authz.permissions.includes('transactions')`, still
  **omission not zeroing** for callers without it.
- Hiding a section is a **view** preference. `lib/dashboard/sections.ts` contains no reference
  to permissions, `finance.allowed`, or `restricted` — a test enforces that, so the control can
  never become a path to a gated figure.
- Organizer ⇄ Super Admin separation is not touched by this change at all.

---

## 2 · What scopes, what cannot, and why

### Scopes to the selected event (free — the counters are already per-event)

`registrationCounters/{slug}` is keyed by event slug, so narrowing the slug list scopes these
with **no extra read and no new index**:

Total registrations · confirmed revenue · today's registrations / revenue / check-ins ·
month-to-date · pass distribution · registration status · coupon performance · the 7/30/90 trend ·
period deltas · attention signals · upcoming deadlines · the activity feed · event status.

### Scopes, and needed new infrastructure

**The 90-day trend.** `organizerDailyStats` was workspace-keyed (`{uid}__{day}`). There is no way
to derive one event's daily series from a workspace total, so the dimension had to exist **at
write time**:

- Document id is now `{uid}__{eventId}__{YYYY-MM-DD}`; `__all__` is the workspace sentinel.
- Both rows are written in the **same transaction** as `registrationCounters`, so the two scopes
  can never disagree with each other or with the counting SSOT.
- The read is still one `getAll` of computed ids — **cost is the number of DAYS, not registrations.**
- `scripts/backfill-organizer-daily-stats.ts` now fills **both** scopes in one pass. Without
  that, a backfilled organizer would have workspace history and empty per-event history while the
  coverage marker claimed full coverage — a worse lie than an honest "history starts here",
  because it is indistinguishable from real data.

### Cannot be scoped — LABELLED, never mixed in

The server names these in `data.scope.workspaceOnly` and the UI reads that list rather than
keeping its own copy, so the label cannot drift from what the payload actually did:

| Section | Why it is not divisible | How it is shown |
|---|---|---|
| Wallet balance | One `organizerWallets/{uid}` doc | Context line: *Workspace total, all events* |
| Finance summary | One `organizerRevenueWallets/{uid}`; ticket revenue **is** scoped, the payout position is not | `All events` pill in the header |
| ~~Communication usage~~ | **Superseded by RD-DASHBOARD-06 §1** — the composite indexes now exist and this card is event-scoped. | — |
| Workspace health | Setup completeness is a property of the workspace | `All events` pill |
| Pending review | License approvals are workspace-level | Context line |

> **Superseded.** This originally recorded a decision to leave communications workspace-labelled
> rather than add indexes. RD-DASHBOARD-06 §1 reverses it at your direction: the three composite
> indexes are added and the card scopes.

### The one cross-event exception

**Event Performance** compares the organizer's events against each other. Scoping it would reduce
it to a single bar and destroy the only thing it is for. It is computed from a **separate
cross-event pass** on the server (`crossEventAnalytics`) and its own subtitle now reads
*"Confirmed registrations · compared across all your events"* — so the exception reads as a
feature, not a leak. Every other breakdown follows the scoped set.

---

## 3 · Defects found and fixed during this pass

**1 · The archived-event zero (HIGH — would have shipped).**
`scopedSlugs` was `slugList.filter(sl => sl === selectedSlug)`. `slugList` deliberately excludes
anything filed under the Archived tab — which includes **completed** events. So an organizer
opening a finished race would have been answered with an empty set: *0 registrations, ₹0* under
that event's own name. Fixed by making the scoped set the selected slug **itself**, and by adding
a `lookupDrafts` set (`dashboardDrafts` + the deliberately selected event) that the per-event
lookups are built from. `slugList` is untouched, so an archived event still contributes nothing to
any workspace aggregate.

**2 · `comm_payment_pending` was scope-ambiguous.** The alert text names one event
(*"Complete payment to publish X"*) but the record carried `eventSlug: null`. Under scoping it
would have appeared on every event's screen. It now carries its real slug.

**3 · A rounded percentage could render as zero for a non-zero count.** *"Checked in today: 2"*
sat beside *"0% of all registrations"* (2/420 → 0). It now renders `<1%`. A percentage that
contradicts the number next to it is the same class of defect as the ₹0-for-unavailable case.

**4 · A stretched, empty settlement card.** The detail row used the grid default (`stretch`), so
the four-row Finance summary was painted as an empty bordered box half a screen tall beside the
ten-row activity feed — indistinguishable from a section that failed to load. Now `items-start`.

**5 · Chart subtitles lied under scoping.** Pass distribution and Registration status said
*"all events, all time"* unconditionally. They now name the actual scope.

### Found, NOT fixed — out of scope, reported for your decision

**`Permissions-Policy` is malformed platform-wide.** `next.config.ts:126` sets
`camera=(); microphone=(); geolocation=()`. The header grammar requires **commas**, not
semicolons, so Chrome rejects the whole header and logs a parse error on **every page of the
site** — meaning camera, microphone and geolocation are **not actually disabled anywhere**. It is
a one-character-class fix (`;` → `,`) but it is a security header touching the whole platform and
predates this work, so I have not changed it. It is filtered out of the browser QA's console-error
check *as pre-existing*, with that reason written into the script — not swallowed.

**The activity feed 500s on a malformed registration.** `route.ts:791` reads `r.attendee.name`
unguarded; a legacy document without an `attendee` map takes the **entire dashboard** down with a
500 rather than degrading one card. My first fixture hit this and it is how I found it. Real
documents always have the field, so this is latent, not active — but it is a whole-page failure
from one bad row. Pre-existing; not touched.

---

## 4 · Show / hide sections

Twelve toggleable sections, one **locked** (Key metrics — a dashboard with everything switched off
is an empty page that reads as broken). The locked row renders disabled with its reason visible
rather than silently ignoring a click.

- **Persisted per user** (`rd:dashboard:sections:{uid}`), so two accounts on one machine cannot
  inherit each other's layout.
- **Read once, before first paint**, via `useSyncExternalStore` — not `useState` + effect, which
  paints the default layout for a frame first and trips `react-hooks/set-state-in-effect`.
- **Storage is not trusted.** Unknown ids are dropped, malformed values fall back to visible, and
  a section missing from storage **defaults to visible** — so a section added in a later release
  ships visible for everyone rather than silently absent for every existing operator.
- **Cross-tab aware** via the `storage` event.
- The trigger shows an **"N hidden"** count, so a missing section reads as a choice rather than a
  failure to load. A test asserts every non-locked id in the model is actually gated on the page —
  a menu row that toggles nothing is the "lying control" defect this project has fixed before.

---

## 5 · Evidence

### Unit — `tests/unit/dashboardEventScope.test.ts`, 46 assertions in 9 groups
Selector-is-SSOT · server-side validation and refusal codes · the rollup event dimension (both
scopes, one transaction; backfill parity; idempotency) · every scopable figure actually scopes ·
the cross-event exception · server-named workspace-only labelling · stale-data defence · the
finance gate untouched · the visibility model.

Three pre-existing suites were updated rather than suppressed:
`dashboardFinanceGate.test.ts` (the `/dashboard stays GLOBAL` group inverted — the reversal is
recorded in the file), `dashboardArchivedScope.test.ts` (lookup set), `couponFilterAndPerformance.test.ts`
and `dashboardDailyStats.test.ts` (3-arg doc id). Where a test pinned an exact source literal it was
rewritten to match **intent**, so a rename cannot fail a test about something else.

### Browser — `scripts/profiling/verify-dashboard-scope.mjs`, 19/19
Two seeded events an order of magnitude apart on every axis
(`scripts/emulator/seed-dashboard-scope.mjs`): **Coastal Marathon 2026** — 420 registrations,
₹6,93,000 — and **Hill Trail Run 2026** — 37, ₹26,640.

The central assertion is that after switching, event A's figures are **gone** — everywhere except
the cross-event chart, excluded by DOM subtree rather than by string so the exclusion cannot
swallow a real leak. Also proven in the browser: the switch costs **exactly one** dashboard read
and carries `eventId=`; the workspace pills render; hiding a section removes it, surfaces the
count, and **survives a reload**; no console errors.

Screenshots: `e2e/.shots/dashboard-scope/`.

### Cost
Unchanged or better. Counter-derived scoping is free (the counters are already per-event). The
trend read is 90 documents either way. In event mode the activity, check-in and coupon reads all
**shrink**. The one addition is a single `.get()` to validate the selected draft.

---

## 6 · Open items

1. ~~**`emailLogs` composite index**~~ — **DONE** in RD-DASHBOARD-06 §1.
2. **`Permissions-Policy`** — one-character-class fix, whole-platform security header, awaiting
   your call. STILL OPEN.
3. ~~**Unguarded `r.attendee.name`**~~ — **FIXED** in RD-DASHBOARD-06 §2.
4. **Per-event pace in `buildAttention`** now *can* be computed (the rollups carry the dimension);
   it is still workspace-derived. Not wrong, just not yet as sharp as it could be. STILL OPEN.


---

# RD-DASHBOARD-06 · Targeted follow-ups

Four changes on top of the approved scoping work. The `selectedEventId` architecture and the
event-isolation implementation are untouched.

## 1 · Communication Usage is now event-scoped

Three composite indexes added to `firestore.indexes.json`:

    emailLogs           (organizerUid, eventSlug, status, createdAt DESC)
    registrations       (organizerUid, eventSlug, emailStatus)
    broadcastCampaigns  (organizerUid, eventSlug, status)

All four aggregates go through **one** narrowing helper, `withEventSlug(query, slug)`, rather
than a ternary per call site — four hand-written conditionals is four chances to forget the
narrowing or to write `.where('eventSlug','==',null)`, which silently matches nothing.

**No unscoped fallback.** When the selection has no slug the query is not run at all: it is
guarded by `scopedNoSlug` *before* the query is built, so a draft can never reach the workspace
query. All-events mode is byte-identical to before — `selectedSlug` is null there, the helper is
a no-op, and the existing workspace indexes serve it.

`communications` consequently **left** `scope.workspaceOnly`. Because the UI reads that
server-owned list rather than a hardcoded copy, the "All events" pill disappeared from that card
on its own — which is the reason the list is server-owned.

Communication *spend* is now computed twice, deliberately: the settlement card wants the
workspace payout position, the usage card wants this event's spend. Same field name, two
meanings, so neither can borrow the other's.

## 2 · A malformed registration can no longer 500 the Dashboard

`r.attendee.name` was unguarded. `RegistrationDocument` types `attendee` as present so
TypeScript was satisfied, but Firestore has no schema: one legacy row without the map threw
inside a `forEach`, escaped the handler, and returned 500 for the **whole** endpoint.

Blast radius is now one feed row:

- `toActivity()` cannot throw — it returns `null` instead.
- `doc.data()` is inside the guard too, so a corrupt snapshot costs one row.
- A missing name renders **"Unnamed attendee"**, not `''`. The event, pass and timestamp on that
  row are real, and `"  registered"` reads as a rendering bug rather than an incomplete record.
- A shorter feed is **disclosed** via `activitySkipped`, never silently shorter.

Regression-tested both ways: a registration with no `attendee` map is seeded into the fixture,
and the browser suite asserts the API returns **200** with the feed intact.

## 3 · Drafts are selectable, so drafts are now servable

**Verified first, as instructed.** The Event Selector's contract:

- `EventContextProvider` fetches `/api/organizer/events?limit=100` with **no `tab` parameter**,
  which takes the route's unfiltered path — every draft the organizer owns.
- `presentEventStatus` has a dedicated `'Draft'` branch with its own status dot.
- Confirmed against the live API: the fixture's four events come back including two drafts.

The Selector therefore **intentionally includes unpublished events**, so per your instruction the
409 is gone. An unpublished event is now a scope *state*:

- `scope.eventPublished: false` and `scope.eventLifecycle` travel with the payload.
- The zeros are **true**, not a fallback — no public slug means no registration page, no counter
  document, no rollup row, no email log, so nothing can have happened.
- The UI states the cause: a `Name · Draft` badge, a **"Not published yet — setup incomplete"**
  notice with a *Continue setup* action, `"Registration has not opened"` in place of
  `"No registrations yet today"`, and a trend empty-state that stops implying an open page.

Three latent bugs surfaced while making drafts servable, each of which would have shown one
event's data under another's name:

| Bug | Why it mattered |
|---|---|
| `scoped` was keyed off the **slug** | A draft would have fallen back to workspace mode — a workspace total under one draft's heading. Now keyed off `requestedEventId`. |
| `selectedDraft` was found by **slug** | Every unpublished draft has a null slug, so the match bound to whichever draft came first. Now found by **id**. |
| Alerts were filtered by **slug** | Same null collision: one draft's alert would have matched every other draft's. Alerts now carry `eventDraftId`. |
| `readDailyStats(uid, selectedSlug ?? ALL_EVENTS, …)` | For a draft this read the **workspace** rollup row and would have drawn the workspace trend under the draft's name. Now returns its own empty series. |

## 4 · Data-isolation verification — 46/46 in a real browser

Fixture: two published events an order of magnitude apart, **one genuine draft**, and one
deliberately malformed registration. Section-level checks read the **API payload** rather than
the DOM, because the payload proves what each section was actually given.

| Section | Event A | Event B | All Events | Draft |
|---|---|---|---|---|
| Pass Distribution | A's 3 passes only | B's 2 passes only | — | empty |
| Registration Status | 420 | 37 | **457 = sum** | 0 |
| Recent Activity | A's attendees only | B's only | — | none borrowed |
| Communication Usage | 31 sent · 4 failed · 5 campaigns | 6 · 1 · 2 | **37 sent** (workspace) | 0 |
| Finance (ticket revenue) | ₹6,93,000 | ₹26,640 | — | ₹0 |
| Finance (payout position) | workspace-labelled | workspace-labelled | unlabelled | workspace-labelled |
| Event Performance | **both events** | **both events** | both | both |
| `scope.workspaceOnly` | wallet, settlement, health, pendingReview | same | **`[]`** | same |

Also proven in-browser: an event switch costs **exactly one** dashboard read and carries
`eventId=`; no stale event-A figure survives the switch (checked by DOM subtree, excluding only
the cross-event chart); the malformed record returns 200 with an 11-row feed; no new console
errors.

## Reads

Unchanged or lower. The communication aggregates were already indexed `count()`/`sum()` calls
that transfer no documents — they now carry one more equality filter. Selecting a **draft**
*removes* five reads (trend rollups, check-in count, three communication aggregates) because
each is skipped rather than run with a null filter.

## Still open after RD-DASHBOARD-06

1. ~~**`Permissions-Policy`**~~ — **FIXED** in RD-DASHBOARD-07 below.
2. ~~**No "All events" affordance in the Selector**~~ — **DONE** in RD-DASHBOARD-07 below.

---

# RD-DASHBOARD-07 · Final closure

## 1 · Permissions-Policy — fixed, and the intended policy corrected

**The syntax bug.** `Permissions-Policy` is a Structured Field **Dictionary** (RFC 8941), whose
members are comma-separated. The value used **semicolons**, borrowed from CSP — a different
grammar — so Chrome failed to parse it and discarded the header **entirely**. The policy had
therefore been enforcing nothing, anywhere on the site, since the day it was written.

**The part a blind fix would have broken.** The header's comment said "features not used by this
application". That was true when written and is **not true now** — and because the header was
being discarded, both features kept working and the drift went unnoticed:

| Feature | Actually used by |
|---|---|
| `camera` | The **gate check-in QR scanner**. `@zxing/browser`'s `decodeFromVideoDevice` opens a video device, so the dependency calls `getUserMedia` on our behalf — which is why a source search for `getUserMedia` finds nothing. `app/(dashboard)/dashboard/events/[eventId]/checkin/QrScanner.tsx` |
| `geolocation` | **"Use my location"** on the public events discovery page. `components/marketing/discovery/LocationPicker.tsx` |
| `microphone` | Nothing. Genuinely unused. |

Swapping only the separator would have shipped `camera=()` **enforced**, silently killing QR
check-in at the gate on race day with no error an operator could act on.

**Final value:**

    camera=(self), microphone=(), geolocation=(self)

`(self)` is a **restriction**, not a new capability: it permits same-origin documents and denies
every embedded third-party iframe, which is the job of this header. Nothing gains an ability it
was not already exercising. `microphone=()` stays fully disabled and is now genuinely enforced.

**Verified in a real browser**, not just in source:

- No `Permissions-Policy` parse error in the console (previously logged on every page load).
- The served response header is exactly `camera=(self), microphone=(), geolocation=(self)`.
- `document.featurePolicy.allowsFeature()` reports **camera: true, geolocation: true,
  microphone: false** — the policy is parsed *and* applied as intended.

The browser suite's console-error filter that had been ignoring this message as "pre-existing"
was **removed**, so a regression would now fail the suite rather than be swallowed.

New regression suite: `tests/unit/securityHeaders.test.ts` (13 tests). It reads the real
`headers()` output, parses the value with a deliberately **strict** hand-written
structured-field parser (a lenient check would have accepted the broken version too), rejects
wildcards, and ties each grant to the code that needs it — so deleting the scanner fails the test
as an instruction to tighten the header, and tightening the header while the scanner exists fails
as a warning that it is about to break. It also pins HSTS, nosniff, X-Frame-Options,
Referrer-Policy, CSP and the dashboard no-store rule, which had **no tests at all** before.

## 2 · "All events" in the global Event Selector

The workspace-wide mode was implemented, tested and verified at the API — and no button reached
it. A capability nothing leads to is indistinguishable from one that does not exist.

**Design.** An explicit sentinel, `ALL_EVENTS_SELECTION = '__all__'`, carried through storage and
the URL. `eventId: null` already meant "nothing selected or selectable"; "the organizer chose all
events" is a **different state** that happens to produce the same scope, and only the deliberate
one may be remembered. `resolveSelectedEvent` turns the sentinel into
`{ eventId: null, source: 'all' }`, so **no downstream consumer learns a new shape** — the
Dashboard's existing "no `eventId` ⇒ all events" request already does the right thing.

**It is the GLOBAL selector.** No Dashboard-local control was added; a test asserts the Dashboard
page renders no `<EventSelector>` of its own and still reads `useEventContext`.

**Default selection is untouched.** Verified in a genuinely fresh browser context (empty
storage): the organizer lands on **Hill Trail Run 2026**, the soonest upcoming event, exactly as
before. All events is opt-in and never becomes the default — but once chosen it **outranks** the
default ranking on the next visit, or the option would feel broken rather than remembered.

**Every event state remains listed and selectable** — verified in the browser against a fixture
seeded with all four:

    All events            Workspace totals across 6 events
    Hill Trail Run 2026   Upcoming  · 28 Aug 2026 · 37 registered
    Coastal Marathon 2026 Upcoming  · 16 Sept 2026 · 420 registered
    Monsoon 10K 2027      Draft     · 11 Mar 2027
    Lakeside Run 2025     Completed · 25 Apr 2026
    Old City Dash 2024    Archived  · 19 Jul 2025

A test asserts the selector's **only** filter is the name search — a state filter there would
silently hide events the organizer owns.

**Edge case handled:** "All events" cannot be expressed while standing on one event's page, since
the path itself names an event. Selecting it there navigates to the canonical all-events surface
rather than leaving a contradicting selector above event-specific content.

**No new reads.** The selector still fetches nothing; the option is derived from the event list
the shell already loads. Selecting it costs exactly **one** dashboard request, carrying no
`eventId`.

## 3 · Verification

**Unit — 5,102 tests pass** (265 files), up 40 from the previous closure:
`securityHeaders.test.ts` (13) and `eventSelectorAllEvents.test.ts` (27), the latter covering all
15 requested items — option present/selectable, `selectedEventId = null`, specific-event
selection, default preserved, draft/completed/archived selectable, every switch direction, stale
data, section scoping, Event Performance cross-event, header validity, security unchanged.

**Browser — 69/69 checks** against the Firebase emulator:

| | Result |
|---|---|
| Event A → Event B | A's figures **gone** (DOM-subtree check, excluding only the cross-event chart) |
| All events → Event A → All events | Correct in both directions; workspace total gone under one event |
| All events choice | Survives a reload |
| Draft | Served with honest zeros, `· Draft` badge, "Not published yet" notice |
| Completed | Selectable, loads, borrows nothing |
| Event Performance | Cross-event under every scope |
| Communication Usage | 31/4/5 vs 6/1/2 vs 37 workspace |
| Malformed registration | 200, feed intact, one labelled row |
| Permissions-Policy | Accepted, served correctly, enforced as intended |
| Reads per switch | Exactly one |

**`tsc` clean · every file touched by this change is ESLint-clean · production build succeeds**
(307 static pages).

> Repo-wide `eslint .` reports 40 files with pre-existing errors. **None** are files this work
> touched; they are untouched template and admin components and predate all of this.

## 4 · One observation, deliberately NOT fixed

In All-events mode the "Active events" tile footer reads **"0 completed"** while a completed event
exists. `data.events` intersects `visibleStatuses` (which includes `completed`) with
`!isArchivedTabEvent` — and `completed` **is** an archived-tab state, so that branch is
unreachable. It is consistent with the documented rule that terminal events do not feed workspace
aggregates, it predates this work, and fixing it means touching the archive-rule interaction.
Flagged for a future pass rather than changed under a "two final items" brief.

## 5 · Tooling note

The production build can fail with `Type error: Unexpected keyword or identifier` in
`.next-emulator/dev/types/routes.d.ts`. That is a **generated dev artifact left truncated** when
the emulator dev server is hard-killed — not a code defect. `rm -rf .next-emulator` clears it.
Worth knowing alongside the existing build/dist isolation rule.

---

# DASHBOARD = COMPLETE

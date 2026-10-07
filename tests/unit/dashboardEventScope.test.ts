// RD-DASHBOARD-05 · The Dashboard follows the global Event Selector.
//
// ═══ WHAT THIS SUITE IS PROTECTING ═══════════════════════════════════════════
// One rule, stated three ways because each way fails differently:
//
//   1. ONE SOURCE OF TRUTH — the shell's Event Selector decides the scope. Nothing on
//      this page may derive a second selection from the URL, from storage, or from
//      "the first event", because two selectors eventually disagree and the page then
//      shows event A's revenue under event B's name.
//
//   2. NO MIXED SCOPES — every figure is either the selected event's, or it is LABELLED
//      workspace-level. A wallet balance sitting unlabelled beside one event's
//      registrations is read as that event's money. It is not.
//
//   3. NO SILENT FALLBACK — a bad or unpublished event id REFUSES with a code. Falling
//      back to "all events" would put a workspace total under an event heading, which is
//      the exact fabrication the whole change set exists to remove.
//
// Assertions are behavioural where the behaviour is testable without a database (the
// pure section model, the rollup id scheme) and source-shaped only where the guarantee
// lives in wiring that has no runtime seam — the same split the rest of the dashboard
// suites use. Source-shaped assertions are written against INTENT (a regex that admits
// renames) rather than an exact literal, because a test pinned to a source string fails
// on formatting and teaches nothing.

import { describe, it, expect } from 'vitest'
import fs   from 'node:fs'
import path from 'node:path'

import {
  ALL_EVENTS, dailyStatsDocId,
} from '@/lib/dashboard/dailyStats'
import {
  DASHBOARD_SECTIONS, defaultVisibility, normalizeVisibility, toggleSection,
  hiddenCount, visibilityStorageKey,
} from '@/lib/dashboard/sections'

const read  = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')
/** Comments stripped, so a test can never pass on the strength of a doc comment. */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

// RD-DASH-03: the activity feed moved to lib/dashboard/activityFeed (shared with the
// paging endpoint). ROUTE spans both so a guard cannot pass merely because the code it
// checks was extracted.
const ROUTE    = strip(read('app/api/organizer/dashboard/route.ts'))
  + strip(read('lib/dashboard/activityFeed.ts'))
  + strip(read('app/api/organizer/dashboard/activity/route.ts'))
  + strip(read('lib/dashboard/activityCursor.ts'))
// RD-DASH-03: Recent Activity moved to components/dashboard/RecentActivityCard.
const PAGE     = strip(read('app/(dashboard)/dashboard/page.tsx'))
  + strip(read('components/dashboard/RecentActivityCard.tsx'))
const CHARTS   = strip(read('components/dashboard/DashboardCharts.tsx'))
const CARD     = strip(read('components/dashboard/SectionCard.tsx'))
const ADMIN    = strip(read('lib/dashboard/dailyStatsAdmin.ts'))
const BACKFILL = strip(read('scripts/backfill-organizer-daily-stats.ts'))

// ═══ 1. THE SELECTOR IS THE SINGLE SOURCE OF TRUTH ═══════════════════════════

describe('1 · the global Event Selector decides the scope', () => {
  it('the page reads the shared event context and nothing else', () => {
    expect(PAGE).toContain('useEventContext')
    expect(PAGE).toMatch(/selectedEventId,/)
  })

  it('the page does NOT derive a second selection of its own', () => {
    // A private useSearchParams/localStorage read here is how two controls end up
    // disagreeing about which event you are looking at.
    expect(PAGE).not.toMatch(/useSearchParams\(/)
    expect(PAGE).not.toMatch(/localStorage\.getItem\(\s*['"]rd:selectedEvent/)
    // It must not even hold the CONTEXT's event LIST — a page carrying `events` is one
    // refactor away from picking a default out of it and quietly becoming a second
    // selector. It reads `selectedEventId` and nothing else.
    expect(PAGE).not.toMatch(/^\s+events,$/m)
  })

  it('the selected event travels to the server as ?eventId=', () => {
    expect(PAGE).toMatch(/\/api\/organizer\/dashboard\?eventId=\$\{encodeURIComponent\(reqEvent\)\}/)
  })

  it('the fetch waits for the selector to resolve, so one open is ONE dashboard read', () => {
    // Firing before the selection settles issues an unscoped request and then
    // immediately a scoped one: two full dashboard reads, and a visible flash of
    // workspace numbers under an event heading in between.
    expect(PAGE).toMatch(/if \(eventsLoading \|\| !user\) return/)
    expect(PAGE).toMatch(/\}, \[attempt, selectedEventId, eventsLoading, user, getToken\]\)/)
  })
})

// ═══ 2. THE SERVER, NOT THE CLIENT, DECIDES WHAT THE ID MAY REACH ════════════

describe('2 · the client id is a request, never an authorization', () => {
  it('ownership is proven by the PATH under the caller’s own workspace', () => {
    // users/{workspaceUid}/eventDrafts/{eventId} — an event another organizer owns
    // simply does not exist there, so a forged id cannot widen the result set.
    expect(ROUTE).toMatch(/adminDb\.doc\(`users\/\$\{uid\}\/eventDrafts\/\$\{requestedEventId\}`\)/)
  })

  it('the workspace uid still comes from the verified caller, never from the query', () => {
    // The scope parameter must not have introduced a second, client-supplied identity.
    expect(ROUTE).not.toMatch(/searchParams\.get\('(uid|organizerId|workspaceUid)'\)/)
    expect(ROUTE).toMatch(/const authz = await authorizeAnyWorkspace\(req\)/)
    expect(ROUTE).toMatch(/const uid = authz\.workspaceUid/)
  })

  it('an unknown event REFUSES — it never falls back to "some event"', () => {
    expect(ROUTE).toContain("code: 'EVENT_NOT_IN_WORKSPACE'")
    expect(ROUTE).toMatch(/status: 404/)
  })

  it('the client renders the refusal as its own explained state, not "try again"', () => {
    // Retrying cannot fix an event that is not in the workspace, so it does not offer to.
    expect(PAGE).toContain("errorCode === 'EVENT_NOT_IN_WORKSPACE'")
  })
})

// ═══ 2b. A DRAFT IS SELECTABLE, SO A DRAFT IS SERVABLE ═══════════════════════
//
// This group REPLACES an earlier assertion that an unpublished event returned
// 409 EVENT_NOT_PUBLISHED. That was wrong, and the Event Selector's own contract is what
// proves it: `/api/organizer/events` is called with NO tab filter, so every draft the
// organizer owns is listed, and `presentEventStatus` has a dedicated "Draft" branch to
// render them. An organizer whose only event is a draft would have met a hard failure on
// their own dashboard.

describe('2b · an unpublished event is a scope STATE, not an error', () => {
  it('the Event Selector genuinely lists drafts — this is the premise, so it is asserted', () => {
    const PROVIDER = strip(read('components/dashboard/EventContextProvider.tsx'))
    const CTX      = strip(read('lib/events/eventContext.ts'))
    // No tab filter on the LIST REQUEST ⇒ the server's unfiltered path ⇒ all drafts.
    // (`?tab=` does appear elsewhere in this file, for deep-linking into an event page —
    // hence matching the fetch URL itself rather than the whole source.)
    const fetchUrl = PROVIDER.match(/`\/api\/organizer\/events\?[^`]*`/)?.[0] ?? ''
    expect(fetchUrl, 'the events-list fetch URL').toContain('limit=')
    expect(fetchUrl).not.toContain('tab=')
    // And the presenter has a Draft branch, so drafts are meant to be shown, not hidden.
    expect(CTX).toMatch(/label: 'Draft'/)
  })

  it('the route no longer refuses a draft', () => {
    expect(ROUTE).not.toContain('EVENT_NOT_PUBLISHED')
    expect(ROUTE).not.toMatch(/status: 409/)
  })

  it('a draft still SCOPES — it does not fall back to workspace mode', () => {
    // Keying `scoped` off the slug would silently drop an unpublished selection back to
    // all-events, putting a workspace total under one draft's name.
    expect(ROUTE).toMatch(/const scoped = requestedEventId !== null/)
    expect(ROUTE).toMatch(/const scopedNoSlug = scoped && selectedUnpublished/)
  })

  it('every slug-keyed read is SKIPPED for a draft, never run with a null filter', () => {
    // A null filter matches nothing (a wasted read) or, worse, falls through to the
    // unscoped query. Both branches of the trend and of today's check-ins are guarded.
    expect(ROUTE).toMatch(/scopedNoSlug\s*\n?\s*\? Promise\.resolve\(buildSeries\(trendKeys, new Map\(\)\)\)/)
    // RD-DASH-13 · the draft branch still SKIPS the query; it now resolves to a MEASURED
    // zero rather than to `null`, because `null` also meant "the read failed" and the
    // consumer's `?? 0` could not tell the two apart. The skip itself is unchanged.
    expect(ROUTE).toMatch(/scopedNoSlug\s*\n?\s*\? Promise\.resolve\(\{ ok: true as const, n: 0 \}\)\s*\n?\s*: \(selectedSlug/)
    expect(ROUTE).toMatch(/const scopedSlugs = scoped \? \(selectedSlug \? \[selectedSlug\] : \[\]\) : slugList/)
  })

  it('the selected draft is resolved by ID, never by slug', () => {
    // Every unpublished draft has a null slug, so a slug match would bind the selection to
    // whichever draft came first — another event's data under this one's name.
    expect(ROUTE).toMatch(/const selectedDraft = scoped \? drafts\.find\(d => d\.id === requestedEventId\) \?\? null : null/)
  })

  it('the payload says the event is unpublished, so the UI can explain the zeros', () => {
    expect(ROUTE).toMatch(/eventPublished: scoped \? !selectedUnpublished : true/)
    expect(ROUTE).toMatch(/eventLifecycle: selectedLifecycle/)
  })

  it('the page renders a draft NOTICE and never presents the zeros as a result', () => {
    expect(PAGE).toMatch(/const draftMode\s+= scoped && !data\.scope\.eventPublished/)
    expect(PAGE).toContain('Not published yet — setup incomplete')
    expect(PAGE).toMatch(/draftMode \? 'Registration has not opened'/)
    // And the trend's empty state stops implying an open registration page.
    expect(PAGE).toMatch(/emptyNote=\{draftMode/)
  })
})

// ═══ 3. THE ROLLUPS CARRY AN EVENT DIMENSION ═════════════════════════════════

describe('3 · organizerDailyStats can answer "this event" without inventing it', () => {
  it('the document id separates every scope', () => {
    const ws = dailyStatsDocId('u', ALL_EVENTS,      '2026-08-23')
    const a  = dailyStatsDocId('u', 'city-marathon', '2026-08-23')
    const b  = dailyStatsDocId('u', 'trail-run',     '2026-08-23')
    expect(new Set([ws, a, b]).size).toBe(3)
  })

  it('BOTH scopes are written in the SAME transaction as registrationCounters', () => {
    // The workspace row is maintained alongside the event rows rather than derived from
    // them at read time — deriving it would need a query over an unknown set of events.
    // Same transaction ⇒ the two scopes can never disagree with each other or with the
    // counting SSOT.
    expect(ADMIN).toMatch(/const scopes = eventId \? \[ALL_EVENTS, eventId\] : \[ALL_EVENTS\]/)
    expect(ADMIN).toMatch(/for \(const scope of scopes\)[\s\S]{0,400}txn\.set\(/)
  })

  it('a null event writes ONLY the workspace row — never a guessed attribution', () => {
    expect(ADMIN).toMatch(/eventId \? \[ALL_EVENTS, eventId\] : \[ALL_EVENTS\]/)
  })

  it('the trend reads the EVENT’s row when scoped and the workspace row otherwise', () => {
    expect(ROUTE).toMatch(/readDailyStats\(uid, selectedSlug \?\? ALL_EVENTS, trendKeys\)/)
  })

  it('the backfill fills BOTH scopes, so event history is not left empty', () => {
    // A backfill that wrote only the workspace rows would leave every event-scoped trend
    // flat at zero while the coverage marker claimed full history — a worse lie than an
    // honest "history starts here", because it is indistinguishable from real data.
    expect(BACKFILL).toMatch(/bumpScope\(ALL_EVENTS, day, field, by\)/)
    expect(BACKFILL).toMatch(/if \(slug\) bumpScope\(slug, day, field, by\)/)
    expect(BACKFILL).toMatch(/dailyStatsDocId\(uid, scope, day\)/)
  })

  it('the backfill stays idempotent — absolute set, never increment', () => {
    // Re-running must produce the same numbers. An increment-based backfill
    // double-counts on retry and the double-count is undetectable afterwards.
    expect(BACKFILL).not.toMatch(/FieldValue\.increment/)
  })
})

// ═══ 4. EVERY EVENT-SCOPABLE FIGURE ACTUALLY SCOPES ══════════════════════════

describe('4 · no workspace figure is presented as an event figure', () => {
  it('counter-derived totals follow the scoped slug set', () => {
    expect(ROUTE).toMatch(/const scopedSlugs = scoped \? \(selectedSlug \? \[selectedSlug\] : \[\]\) : slugList/)
    expect(ROUTE).toMatch(/const totalRegs\s+= scopedSlugs\.reduce/)
    // RD-DASH-13 · the same scoped reduce, now behind an unavailability guard: one
    // unmeasured event makes the WHOLE revenue figure unmeasured rather than understating
    // it. The SCOPE — which slugs are summed — is unchanged, and that is what this checks.
    expect(ROUTE).toMatch(/const revenueUnavailable = scopedSlugs\.some/)
    expect(ROUTE).toMatch(/: scopedSlugs\.reduce\(\(s, slug\) => s \+ \(revBySlug\.get\(slug\) \?\? 0\), 0\)/)
  })

  it('the scoped set is the selected slug ITSELF, not slugList narrowed by it', () => {
    // Narrowing would produce an EMPTY set — and therefore zeros — for an event the
    // archive rule excludes, which is exactly the case an operator reviewing a finished
    // event is in. "0 registrations" for a completed race is a fabrication.
    expect(ROUTE).not.toMatch(/scopedSlugs = scoped \? slugList\.filter/)
  })

  it('today’s check-in count is an indexed per-event aggregate, not a workspace one', () => {
    expect(ROUTE).toMatch(/scope\.eventSlug\) return \{ q: base\.where\('eventSlug', '==', scope\.eventSlug\), inQuery: true \}/)
  })

  it('the activity feed shows only the selected event’s attendees', () => {
    expect(ROUTE).toMatch(/where\('eventSlug', '==', scope\.eventSlug\)/)
    expect(ROUTE).toMatch(/where\('eventSlug', 'in', scope\.dashboardSlugs\)/)
  })

  it('attention signals and upcoming deadlines are scoped to the selected event', () => {
    expect(ROUTE).toMatch(/const signalSource = scoped \? \(selectedDraft \? \[selectedDraft\] : \[\]\) : drafts/)
    expect(ROUTE).toMatch(/buildAttention\(\{ events: signalEvents/)
    expect(ROUTE).toMatch(/buildUpcoming\(signalEvents/)
  })

  it('legacy alerts are filtered by DRAFT ID, and every one names its event', () => {
    // Identity is the draft id, not the slug. Every unpublished event has a null slug, so
    // `a.eventSlug === selectedSlug` would make one draft's alert match all of them at once
    // the moment drafts became selectable.
    expect(ROUTE).toMatch(/\.filter\(a => !scoped \|\| a\.eventDraftId === requestedEventId\)/)
    expect(ROUTE).toMatch(/eventDraftId: string \| null/)
    expect(ROUTE).not.toMatch(/type: 'comm_payment_pending'[\s\S]{0,200}eventSlug: null/)
  })

  it('the "Active events" count is still scoped server-side', () => {
    // RD-DASHBOARD-12 retired the Event Status TILE (Fees & Payout took its slot in the
    // primary row), but the scoped count itself is unchanged and still feeds the payload.
    expect(ROUTE).toMatch(/const activeEvents = scoped/)
  })
})

// ═══ 4b. COMMUNICATION USAGE SCOPES — WITH NO UNSCOPED FALLBACK ══════════════

describe('4b · Communication Usage follows the scope', () => {
  // RD-DASH-06 moved these queries out of the route and into lib/dashboard/
  // communicationUsageAdmin, so the scope rule is asserted where it now lives. The RULE is
  // unchanged: one narrowing helper, applied to every source, with no unscoped fallback.
  const READER = read('lib/dashboard/communicationUsageAdmin.ts')
  const INDEXES = JSON.parse(read('firestore.indexes.json')) as {
    indexes: { collectionGroup: string; fields: { fieldPath: string; order?: string }[] }[]
  }
  const hasIndex = (group: string, paths: string[]) =>
    INDEXES.indexes.some(i =>
      i.collectionGroup === group &&
      i.fields.length === paths.length &&
      i.fields.every((f, n) => f.fieldPath === paths[n]))

  it('every scoped communication query has its composite index', () => {
    // Without these Firestore refuses the query at runtime. A missing index would surface
    // as an empty card — indistinguishable from "nothing was sent", which is exactly the
    // silent-zero failure this dashboard is built to avoid. RD-DASH-06 found precisely that
    // live in production: three of these aggregates were throwing FAILED_PRECONDITION and
    // the .catch was turning it into 0.
    expect(hasIndex('emailLogs', ['organizerUid', 'eventSlug', 'channel', 'createdAt'])
        || hasIndex('emailLogs', ['organizerUid', 'channel', 'eventSlug', 'createdAt']),
      'emailLogs channel split, event-scoped').toBe(true)
    expect(hasIndex('emailLogs', ['organizerUid', 'eventSlug', 'status', 'createdAt']),
      'emailLogs (organizerUid, eventSlug, status, createdAt)').toBe(true)
    expect(hasIndex('broadcastCampaigns', ['organizerUid', 'eventSlug', 'status']),
      'broadcastCampaigns (organizerUid, eventSlug, status)').toBe(true)
    // The SUMMED field must be in the index. Omitting it is what made a missing
    // "recipients reached" report the campaign COUNT as zero.
    expect(hasIndex('broadcastCampaigns', ['organizerUid', 'eventSlug', 'status', 'successCount']),
      'broadcastCampaigns aggregation index, event-scoped').toBe(true)
  })

  it('the workspace-mode indexes are still there — all-events mode is unchanged', () => {
    expect(hasIndex('emailLogs', ['organizerUid', 'status', 'createdAt'])).toBe(true)
    expect(hasIndex('emailLogs', ['organizerUid', 'channel', 'createdAt'])).toBe(true)
    expect(hasIndex('broadcastCampaigns', ['organizerUid', 'status'])).toBe(true)
    expect(hasIndex('broadcastCampaigns', ['organizerUid', 'status', 'successCount'])).toBe(true)
  })

  it('every aggregate goes through the ONE narrowing helper', () => {
    // A hand-written ternary at each call site is a chance to forget the narrowing, or to
    // write `.where('eventSlug','==',null)`. Both collections get exactly one builder, and
    // every query is derived from it.
    expect((READER.match(/slug \? q\.where\('eventSlug', '==', slug\) : q/g) ?? []).length).toBe(2)
    // Seven aggregates, all built from logs() or camps() — never from a bare collection().
    expect((READER.match(/\b(logs|camps)\(\)/g) ?? []).length).toBeGreaterThanOrEqual(7)
    expect(READER).not.toMatch(/adminDb\.collection\('(emailLogs|broadcastCampaigns)'\)\s*\.where\('organizerUid'[\s\S]{0,80}\.where\('status'/)
  })

  it('EVENT MODE narrows every communication source', () => {
    for (const col of ['emailLogs', 'broadcastCampaigns']) {
      expect(READER, col).toMatch(new RegExp(`adminDb\\.collection\\('${col}'\\)\\.where\\('organizerUid'`))
    }
    // RD-DASH-06 — the `registrations` source is GONE. It counted registrations whose
    // `emailStatus` said sent, one per registration, and was labelled "Emails sent".
    expect(ROUTE).not.toMatch(/emailStatus'?,\s*'=='/)
    expect(ROUTE).toContain('readCommunicationUsage(uid, { scoped, slug: selectedSlug })')
  })

  it('ALL-EVENTS mode stays workspace-wide — the helper is a no-op without a slug', () => {
    // `slug` is null in all-events mode, so the builder returns the query untouched and the
    // workspace indexes above serve it exactly as before.
    expect(READER).toMatch(/slug \? q\.where\('eventSlug', '==', slug\) : q/)
  })

  it('there is NO unscoped fallback for an event with no slug', () => {
    // An event can be SELECTED while still unpublished, and an unpublished event has no
    // public slug. Passing that null through would drop every filter and read the WHOLE
    // WORKSPACE's volume, then print it under that one event's name. So scope reaches the
    // reader as an INTENTION, not as a slug that might be missing, and the guard runs
    // BEFORE any query is built.
    expect(READER).toContain('scope: { scoped: boolean; slug: string | null }')
    expect(READER).toContain('if (scoped && !slug) {')
    // Zero is PROVEN here rather than assumed: every row in both collections carries an
    // eventSlug, so an event without one cannot have a row attributed to it.
    expect(READER).toMatch(/if \(scoped && !slug\) \{[\s\S]{0,240}loggedTotal: 0/)
    // …and the guard precedes the query builders, so nothing unscoped can be constructed.
    expect(READER.indexOf('if (scoped && !slug)')).toBeLessThan(READER.indexOf("adminDb.collection('emailLogs')"))
  })

  it('communication SPEND is computed per scope, not shared between two meanings', () => {
    // The settlement card wants the workspace payout position; the usage card wants this
    // event's spend. Same field name, two scopes — so they are computed separately.
    expect(ROUTE).toMatch(/costPaise:\s+scoped\s*\n?\s*\? commSpendOf\(selectedDraft\)/)
    expect(ROUTE).toMatch(/const communicationCostPaise = dashboardDrafts\.reduce\(\(s, d\) => s \+ commSpendOf\(d\)/)
  })
})

// ═══ 4c. ONE MALFORMED REGISTRATION CANNOT CRASH THE DASHBOARD ═══════════════

describe('4c · malformed registration safety', () => {
  it('no unguarded attendee access remains', () => {
    // `r.attendee.name` threw inside a forEach and escaped the handler as a 500 — every
    // KPI, chart and alert gone because one row in a twenty-row feed was incomplete.
    expect(ROUTE).not.toMatch(/r\.attendee\.name/)
    expect(ROUTE).not.toMatch(/r\.attendee\.email/)
  })

  it('the feed builder cannot throw', () => {
    expect(ROUTE).toMatch(/async function readStream\(/)
    expect(ROUTE).toMatch(/\} catch \{\s*\n?\s*return null\s*\n?\s*\}/)
  })

  it('a missing name is STATED, not blanked', () => {
    // "  registered" reads as a rendering bug; "Unnamed attendee registered" reads as the
    // incomplete record it is, and keeps the event/pass/time that ARE real.
    expect(ROUTE).toContain("'Unnamed attendee'")
  })

  it('.data() is inside the guard too — a corrupt snapshot costs one row', () => {
    expect(ROUTE).toMatch(/try \{ r = doc\.data\(\) as Partial<RegistrationDocument> \} catch \{ skipped\+\+; continue \}/)
    // RD-DASHBOARD-11 carries the doc id alongside the projected data — it is the
    // activity's stable identity and link destination, and neither survives `.data()`.
    // RD-ANALYTICS-12-17 · the name is now CONDITIONAL — projected only for a caller
    // holding `registrations` or `transactions`. The property this case defends is
    // unchanged: a fixed field list, never a whole registration document.
    expect(ROUTE).toMatch(/\.select\(field, 'eventSlug', 'eventName', 'passName',/)
    expect(ROUTE).toMatch(/scope\.canReadAttendeeName \? \['attendee\.name'\]/)
  })

  it('a shorter feed is DISCLOSED, not silently shorter', () => {
    expect(ROUTE).toMatch(/activitySkipped\?: number/)
    expect(ROUTE).toMatch(/\.\.\.\(activitySkipped > 0 \? \{ activitySkipped \} : \{\}\)/)
    expect(PAGE).toMatch(/skipped=\{data\.activitySkipped \?\? 0\}/)
    expect(PAGE).toMatch(/\{skipped > 0 && \(/)
    expect(PAGE).toContain('could not be read')
  })
})

// ═══ 5. THE CROSS-EVENT EXCEPTION, STATED OUT LOUD ═══════════════════════════

describe('5 · Event Performance is the documented exception', () => {
  it('it is computed from the FULL slug set even in event mode', () => {
    // Scoping a cross-event comparison reduces it to a single bar and destroys the only
    // thing it is for.
    expect(ROUTE).toMatch(/const crossEventAnalytics = scoped\s*\n?\s*\? buildDashboardAnalytics\(slugList\.map/)
    expect(ROUTE).toMatch(/eventPerformance:\s+\(crossEventAnalytics \?\? analytics\)\.eventPerformance/)
  })

  it('every OTHER breakdown follows the scoped set', () => {
    expect(ROUTE).toMatch(/const analytics = buildDashboardAnalytics\(scopedSlugs\.map/)
  })

  it('the panel says it is a comparison, so the exception cannot read as a bug', () => {
    expect(CHARTS).toMatch(/subtitle="Confirmed registrations · compared across all your events"/)
  })

  it('the two scoped panels name the scope they actually cover', () => {
    // They used to say "all events, all time" unconditionally. A false denominator
    // invites the reader to compare one event's split against a workspace total.
    expect(CHARTS).not.toMatch(/all events, all time"/)
    expect(CHARTS).toMatch(/\$\{scopeLabel\}, all time/)
    expect(PAGE).toMatch(/scopeLabel=\{scoped && scopeName \? scopeName : 'all events'\}/)
  })
})

// ═══ 6. WHAT CANNOT BE SCOPED IS LABELLED, NOT MIXED IN ══════════════════════

describe('6 · workspace-level sections are labelled by the server, not guessed by the UI', () => {
  it('the payload NAMES which sections stayed workspace-level', () => {
    expect(ROUTE).toMatch(/workspaceOnly: scoped/)
    for (const id of ['wallet', 'settlement', 'health', 'pendingReview']) {
      expect(ROUTE, id).toContain(`'${id}'`)
    }
  })

  it('communications LEFT that list once it could be scoped', () => {
    // The list is server-owned precisely so this works: the "All events" pill disappeared
    // from the Communication Usage card without touching the UI. A hardcoded client copy
    // would still be claiming the card is workspace-wide.
    // The list is now conditional (settlement leaves it too when the ledger scopes), so the
    // assertion reads EVERY branch rather than a single literal array.
    const block = ROUTE.slice(ROUTE.indexOf('workspaceOnly: scoped'), ROUTE.indexOf('workspaceOnly: scoped') + 400)
    expect(block).not.toContain('communications')
    expect(block).toContain('wallet')
  })

  it('settlement ALSO left the list once it could be scoped per event', () => {
    // platformTransactions is per-event (entityId = eventSlug) with an index built for the
    // aggregate, so a selected event's settlement is its own — not workspace-lifetime.
    // That mixed scope was the direct cause of the reported revenue mismatch.
    // The ledger is now read in BOTH modes (Fees & Payout needs the platform-vs-gateway
    // split), so the scope travels as a conditional rather than a literal slug.
    expect(ROUTE).toMatch(/eventSlug:\s+scoped \? selectedSlug : null/)
    expect(ROUTE).toMatch(/\? \['wallet', 'health', 'pendingReview'\]/)
    // …and it stays labelled when the ledger could NOT be read.
    expect(ROUTE).toMatch(/: \['wallet', 'settlement', 'health', 'pendingReview'\]/)
  })

  it('an unmeasurable ledger figure is never read as zero', () => {
    // MaybeMoney is a discriminated union; `ok: false` means "could not measure".
    expect(ROUTE).toMatch(/m && m\.ok \? m\.paise : null/)
    // RD-DASH-02 retired `usingLedger`, the flag that chose between an event ledger and
    // the wallet rollup. Both stored fees as gross − net, so both reported ₹0 under an
    // attendee-pays model. Every settlement figure is now a named resolver field, and
    // `ledgerMoney` still maps an unmeasurable one to null rather than to zero.
    expect(ROUTE).not.toMatch(/const usingLedger/)
    expect(ROUTE).not.toMatch(/scopedGross\s*-\s*scopedNet/)
    expect(ROUTE).toMatch(/platformFeeTotalPaise:\s+ledger \? ledgerMoney\(ledger\.platformFeeTotal\)/)
  })

  it('the client reads that list rather than hardcoding its own copy', () => {
    // A second copy in the UI drifts: the day communications gains its composite index
    // and starts scoping, a hardcoded pill would keep claiming it did not.
    expect(PAGE).toMatch(/new Set\(data\.scope\.workspaceOnly\)/)
    expect(PAGE).toMatch(/workspaceOnly\.has\(id\)/)
  })

  it('each unscopable section carries a visible scope pill', () => {
    expect(CARD).toMatch(/scopeNote\?:\s+string/)
    // RD-FIN-02 · the server's note still wins; all-events adds the card's own lifetime scope.
    expect(PAGE).toMatch(/scopeNote=\{wsNote\('settlement'\) \?\? /)
    expect(PAGE).toMatch(/scopeNote=\{wsNote\('health'\)\}/)
  })

  it('Communication usage asks for no pill, because it IS scoped', () => {
    // The server dropped `communications` from `workspaceOnly` once the composite indexes
    // existed, so `wsNote('communications')` had already been returning undefined — a call
    // that rendered nothing, beside a comment claiming the opposite. RD-DASH-06 removed
    // both and the card now names its own scope on the line under its primary figure.
    expect(PAGE).not.toContain("wsNote('communications')")
    expect(ROUTE).not.toMatch(/workspaceOnly[\s\S]{0,200}'communications'/)
    expect(read('components/dashboard/CommunicationPanel.tsx')).toContain('{scopeLabel} · all time')
  })

  it('the wallet and pending-review KPIs say which scope their number belongs to', () => {
    expect(PAGE).toMatch(/wsContext\('wallet'\)/)
    expect(PAGE).toMatch(/wsContext\('pendingReview'\)/)
  })

  it('the header states the applied scope in ALL THREE modes', () => {
    // RD-DASHBOARD-08 moved the scope out of PageHeader's badge slot and into the header's
    // own subtitle + identity line, so it can carry the event name, its state and its
    // configured taxonomy together. The RULE is unchanged and is what is asserted: the
    // scope is stated on screen in every mode, never left implied.
    expect(PAGE).toMatch(/scoped\s*\n?\s*\? "Here's what's happening for this event today\."/)
    expect(PAGE).toMatch(/: "Here's what's happening across all your events today\."/)
    // RD-DASHBOARD-12 moved the event NAME beside the Event Selector — one statement of
    // scope, visible on every page — and left only the DRAFT flag on this page, because
    // that qualifies the zeros below rather than restating identity.
    const IDENT = strip(read('components/dashboard/SelectedEventIdentity.tsx'))
    expect(IDENT).toMatch(/isAllEvents \? 'All events' : selectedEvent\?\.name/)
    expect(PAGE).toMatch(/Draft — not published yet/)
  })

  it('the label is read from the SERVER’s echo, not the client’s request', () => {
    // Labelling from selectedEventId would let the heading claim a scope the payload
    // does not have — for instance when an older response settles last.
    expect(PAGE).toMatch(/const scoped\s+= data\.scope\.mode === 'event'/)
    expect(PAGE).toMatch(/const scopeName\s+= data\.scope\.eventName/)
  })
})

// ═══ 7. AN EVENT SWITCH NEVER SHOWS THE PREVIOUS EVENT'S NUMBERS ═════════════

describe('7 · stale data cannot survive an event switch', () => {
  it('the settled result is stamped with the event it was fetched for', () => {
    expect(PAGE).toMatch(/eventId: string \| null/)
    expect(PAGE).toMatch(/settled\.eventId === selectedEventId/)
  })

  it('the loading state names the event being loaded', () => {
    // So a switch reads as progress against THAT event rather than "the page went blank".
    expect(PAGE).toMatch(/Loading \$\{selectedEvent\.name\}…/)
  })
})

// ═══ 8. SCOPING CHANGED NOTHING ABOUT AUTHORIZATION ══════════════════════════

describe('8 · the finance gate is untouched by scoping', () => {
  it('it is still resolved server-side from the caller’s own permissions', () => {
    expect(ROUTE).toMatch(/const financeAllowed = authz\.permissions\.includes\('transactions'\)/)
  })

  it('money is OMITTED for a caller without the permission, never zeroed', () => {
    // A ₹0 for an unauthorized caller is a claim about the business, not a permission
    // state. The key is absent instead.
    expect(ROUTE).toMatch(/financeAllowed \?/)
    expect(PAGE).toMatch(/restricted=\{!finance\.allowed\}/)
  })

  it('hiding a section is a VIEW preference and can never reveal a gated figure', () => {
    // The visibility model touches no payload — it only decides whether an already
    // gated section is rendered at all.
    const SECTIONS = strip(read('lib/dashboard/sections.ts'))
    expect(SECTIONS).not.toMatch(/permission|finance\.allowed|restricted/)
  })
})

// ═══ 9. SHOW / HIDE SECTIONS — BEHAVIOURAL, NO DOM NEEDED ════════════════════

describe('9 · section visibility is a real, persisted preference', () => {
  it('defaults to everything visible', () => {
    const v = defaultVisibility()
    expect(DASHBOARD_SECTIONS.every(s => v[s.id])).toBe(true)
    expect(hiddenCount(v)).toBe(0)
  })

  it('a stored preference is honoured', () => {
    const v = normalizeVisibility({ coupons: false, health: false })
    expect(v.coupons).toBe(false)
    expect(v.health).toBe(false)
    expect(v.activity).toBe(true)
    expect(hiddenCount(v)).toBe(2)
  })

  it('a NEW section ships visible for existing operators', () => {
    // Storage is a partial record, not an allow-list. Treating it as an allow-list would
    // make every section added later invisible to everyone who ever touched the control.
    const v = normalizeVisibility({ coupons: false })
    for (const s of DASHBOARD_SECTIONS) {
      if (s.id !== 'coupons') expect(v[s.id], s.id).toBe(true)
    }
  })

  it('junk from storage cannot produce an invalid layout', () => {
    for (const junk of [null, 'nonsense', 42, [], { kpis: 'yes' }, { notASection: false }]) {
      const v = normalizeVisibility(junk)
      expect(Object.keys(v).sort()).toEqual(DASHBOARD_SECTIONS.map(s => s.id).sort())
      expect(Object.values(v).every(x => typeof x === 'boolean')).toBe(true)
    }
  })

  it('the locked section cannot be hidden — not by storage, not by a toggle', () => {
    // A dashboard with every section switched off is an empty page that reads as broken.
    expect(normalizeVisibility({ kpis: false }).kpis).toBe(true)
    const v = defaultVisibility()
    expect(toggleSection(v, 'kpis')).toBe(v)          // same reference ⇒ genuine no-op
    expect(hiddenCount({ ...v, kpis: false })).toBe(0) // locked never counts as hidden
  })

  it('toggling is pure — it returns a new map and mutates nothing', () => {
    const v = defaultVisibility()
    const next = toggleSection(v, 'coupons')
    expect(next.coupons).toBe(false)
    expect(v.coupons).toBe(true)
    expect(toggleSection(next, 'coupons').coupons).toBe(true)
  })

  it('the preference is keyed per user, so two accounts cannot share a layout', () => {
    expect(visibilityStorageKey('uidA')).not.toBe(visibilityStorageKey('uidB'))
    expect(visibilityStorageKey('uidA')).toContain('uidA')
  })

  it('every section id in the model is actually gated on the page', () => {
    // A section listed in the menu but not gated is a control that does nothing — the
    // "lying control" class of defect this project has already had to fix once.
    for (const s of DASHBOARD_SECTIONS) {
      if (s.locked) continue
      expect(PAGE, s.id).toMatch(new RegExp(`visible\\.${s.id}\\b`))
    }
  })

  it('the hidden count is surfaced, so a missing section reads as a choice', () => {
    // Otherwise a hidden section is indistinguishable from one that failed to load.
    const MENU = strip(read('components/dashboard/SectionVisibilityMenu.tsx'))
    expect(MENU).toMatch(/\{hidden\} hidden/)
  })
})

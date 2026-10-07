// RD-DASHBOARD-07 · "All events" in the GLOBAL Event Selector.
//
// ═══ THE DEFECT THIS CLOSES ══════════════════════════════════════════════════
// The Dashboard API has always supported a workspace-wide mode (`selectedEventId = null`
// ⇒ no `?eventId=` ⇒ `scope.mode: 'all'`), and it was verified working. But the Event
// Selector always resolved to SOME event whenever the organizer owned one, so the mode was
// unreachable through the actual UI. A shipped, tested, documented capability that no
// button leads to is indistinguishable from one that does not exist.
//
// ═══ THE ONE RULE THIS SUITE PROTECTS ════════════════════════════════════════
// "All events" is an EXPLICIT choice. It must never become the default, and it must never
// be confused with "this workspace has no events" — those produce the same scope but mean
// opposite things, and only one of them is a preference worth remembering.

import { describe, it, expect } from 'vitest'
import fs   from 'node:fs'
import path from 'node:path'
import {
  ALL_EVENTS_SELECTION, isAllEventsSelection, resolveSelectedEvent, presentEventStatus,
  type EventSummary,
} from '@/lib/events/eventContext'

const read  = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf-8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const SELECTOR = strip(read('components/dashboard/EventSelector.tsx'))
const PROVIDER = strip(read('components/dashboard/EventContextProvider.tsx'))

const NOW = Date.parse('2026-08-23T12:00:00.000Z')
const DAY = 86_400_000

function ev(over: Partial<EventSummary> & { draftId: string }): EventSummary {
  return {
    name: `Event ${over.draftId}`,
    slug: over.draftId,
    status: 'published',
    lifecycleStatus: 'published',
    startDate: null,
    endDate: null,
    totalRegistrations: 0,
    totalCapacity: null,
    updatedAt: new Date(NOW).toISOString(),
    ...over,
  }
}

const live    = ev({ draftId: 'live',    startDate: new Date(NOW - DAY).toISOString(), endDate: new Date(NOW + DAY).toISOString() })
const draft   = ev({ draftId: 'draft',   status: 'draft',  lifecycleStatus: 'draft' })
const done    = ev({ draftId: 'done',    lifecycleStatus: 'completed' })
const archive = ev({ draftId: 'archive', lifecycleStatus: 'archived' })
const ALL     = [live, draft, done, archive]

const resolve = (over: Partial<Parameters<typeof resolveSelectedEvent>[0]> = {}) =>
  resolveSelectedEvent({ urlEventId: null, storedEventId: null, events: ALL, now: NOW, ...over })

// ═══ 1–3 · THE OPTION EXISTS, IS SELECTABLE, AND MEANS null ══════════════════

describe('1–3 · All events is a real, selectable option', () => {
  it('1 · the GLOBAL selector renders it — not a Dashboard-local control', () => {
    // It must live here, in the one selector the whole shell shares. A second selector
    // inside the Dashboard would be a second source of truth.
    expect(SELECTOR).toContain('All events')
    expect(SELECTOR).toMatch(/selectEvent\(ALL_EVENTS_SELECTION\)/)
    // And no rival selector exists on the dashboard page.
    // RD-DASH-03: Recent Activity moved to components/dashboard/RecentActivityCard.
const PAGE = strip(read('app/(dashboard)/dashboard/page.tsx'))
  + strip(read('components/dashboard/RecentActivityCard.tsx'))
    expect(PAGE).not.toMatch(/<EventSelector/)
    expect(PAGE).toContain('useEventContext')
  })

  it('2 · it is a real option with selected state, not decoration', () => {
    expect(SELECTOR).toMatch(/role="option"\s*\n?\s*aria-selected=\{isAllEvents\}/)
    expect(SELECTOR).toMatch(/isAllEvents && <Check/)
  })

  it('3 · choosing it resolves to selectedEventId = null', () => {
    const r = resolve({ storedEventId: ALL_EVENTS_SELECTION })
    expect(r.eventId).toBeNull()
    expect(r.source).toBe('all')
  })

  it('3b · null-from-choice is distinguishable from null-from-empty-workspace', () => {
    // Same eventId, opposite meanings. Only the deliberate one is a preference.
    const chosen = resolve({ storedEventId: ALL_EVENTS_SELECTION })
    const empty  = resolve({ events: [] })
    expect(chosen.eventId).toBeNull()
    expect(empty.eventId).toBeNull()
    expect(chosen.source).toBe('all')
    expect(empty.source).toBe('none')
  })

  it('3c · the sentinel cannot collide with a real draft id', () => {
    expect(isAllEventsSelection(ALL_EVENTS_SELECTION)).toBe(true)
    expect(isAllEventsSelection('live')).toBe(false)
    expect(isAllEventsSelection(null)).toBe(false)
    // Firestore ids are alphanumeric and never contain underscores.
    expect(ALL_EVENTS_SELECTION).toMatch(/^__.+__$/)
  })
})

// ═══ 4–5 · SPECIFIC EVENTS AND THE DEFAULT ARE UNCHANGED ════════════════════

describe('4–5 · specific selection and default behaviour are preserved', () => {
  it('4 · a specific event still produces its own id', () => {
    expect(resolve({ urlEventId: 'done' })).toMatchObject({ eventId: 'done', source: 'url' })
    expect(resolve({ storedEventId: 'draft' })).toMatchObject({ eventId: 'draft', source: 'stored' })
  })

  it('5 · the DEFAULT is still the ranked event — All events never becomes it', () => {
    // The whole risk of adding this option: it must be opt-in. A fresh visit with nothing
    // stored still lands on the live event, exactly as before.
    const r = resolve()
    expect(r.source).toBe('default')
    expect(r.eventId).toBe('live')
  })

  it('5b · a remembered All-events choice OUTRANKS the default', () => {
    // Otherwise the organizer is silently put back onto one event every visit, and the
    // option would feel broken rather than remembered.
    expect(resolve({ storedEventId: ALL_EVENTS_SELECTION })).toMatchObject({ source: 'all' })
  })

  it('5c · the URL still outranks storage, for both kinds of selection', () => {
    expect(resolve({ urlEventId: 'done', storedEventId: ALL_EVENTS_SELECTION }))
      .toMatchObject({ eventId: 'done', source: 'url' })
    expect(resolve({ urlEventId: ALL_EVENTS_SELECTION, storedEventId: 'done' }))
      .toMatchObject({ eventId: null, source: 'all' })
  })

  it('5d · a forged event id STILL refuses rather than falling back', () => {
    // The sentinel check must not have opened a path where an unknown id degrades to
    // all-events — that would show workspace totals under a URL naming one event.
    const r = resolve({ urlEventId: 'not-mine' })
    expect(r.eventId).toBeNull()
    expect(r.source).toBe('none')
    expect(r.urlEventMissing).toBe(true)
  })

  it('5e · only a VALIDATED selection is remembered', () => {
    expect(PROVIDER).toMatch(/if \(isAllEvents\) writeStoredEventId\(ALL_EVENTS_SELECTION\)/)
    expect(PROVIDER).toMatch(/else if \(selectedEventId\) writeStoredEventId\(selectedEventId\)/)
  })
})

// ═══ 6–7 · EVERY EVENT STATE REMAINS SELECTABLE ═════════════════════════════

describe('6–7 · no event state was excluded', () => {
  it('6 · a draft is still resolvable', () => {
    expect(resolve({ urlEventId: 'draft' })).toMatchObject({ eventId: 'draft' })
  })

  it('7 · completed and archived are still resolvable', () => {
    // An organizer must be able to reach a finished event to pull its reports. The
    // ranking pushes them DOWN; it must never remove them.
    expect(resolve({ urlEventId: 'done' })).toMatchObject({ eventId: 'done' })
    expect(resolve({ urlEventId: 'archive' })).toMatchObject({ eventId: 'archive' })
  })

  it('7b · the selector filters ONLY by the search box, never by state', () => {
    // The single filter in this component is the name search. A state filter here would
    // silently hide events the organizer owns.
    expect(SELECTOR).toMatch(/events\.filter\(e => e\.name\.toLowerCase\(\)\.includes\(q\)\)/)
    expect(SELECTOR).not.toMatch(/\.filter\([^)]*lifecycleStatus/)
    expect(SELECTOR).not.toMatch(/\.filter\([^)]*status === 'published'/)
  })

  it('7c · every state has a label the row can show', () => {
    for (const [e, label] of [
      [live, 'Live'], [draft, 'Draft'], [done, 'Completed'], [archive, 'Archived'],
    ] as Array<[EventSummary, string]>) {
      expect(presentEventStatus(e, NOW).label, e.draftId).toBe(label)
    }
    // And the row actually renders it.
    expect(SELECTOR).toMatch(/const status = presentEventStatus\(event, now\)/)
    expect(SELECTOR).toMatch(/\{status\.label\}/)
  })
})

// ═══ 8–11 · SWITCHING IN EVERY DIRECTION ════════════════════════════════════

describe('8–11 · switching between scopes', () => {
  it('8 · Event A → Event B', () => {
    expect(resolve({ urlEventId: 'live' })).toMatchObject({ eventId: 'live' })
    expect(resolve({ urlEventId: 'done' })).toMatchObject({ eventId: 'done' })
  })

  it('9 · All events → Event A', () => {
    expect(resolve({ storedEventId: ALL_EVENTS_SELECTION })).toMatchObject({ source: 'all' })
    expect(resolve({ urlEventId: 'live', storedEventId: ALL_EVENTS_SELECTION }))
      .toMatchObject({ eventId: 'live', source: 'url' })
  })

  it('10 · Event A → All events', () => {
    expect(resolve({ urlEventId: ALL_EVENTS_SELECTION, storedEventId: 'live' }))
      .toMatchObject({ eventId: null, source: 'all' })
  })

  it('11 · every switch bumps the generation that discards stale responses', () => {
    // The generation counter is what makes an in-flight response for the PREVIOUS scope
    // unable to paint over the new one.
    expect(PROVIDER).toMatch(/setGeneration\(g => g \+ 1\)/)
    // Re-picking the current scope is a no-op for BOTH shapes, so it cannot churn.
    expect(PROVIDER).toMatch(/if \(toAll \? isAllEvents : eventId === selectedEventId\) return/)
  })

  it('11b · All events cannot be selected while standing on one event’s page', () => {
    // The path itself names an event; leaving the organizer there with a contradicting
    // selector is exactly the mixed-scope confusion this work removed.
    expect(PROVIDER).toMatch(/if \(toAll\) \{ router\.push\(ALL_EVENTS_HREF\); return \}/)
  })

  it('11c · the choice travels in the URL, so Back/Forward move it', () => {
    expect(PROVIDER).toMatch(/toAll \? ALL_EVENTS_SELECTION : eventId/)
  })
})

// ═══ 12–13 · THE DASHBOARD CONTRACT IS UNCHANGED ════════════════════════════

describe('12–13 · Dashboard scoping is untouched by this change', () => {
  // RD-DASH-03: the activity feed moved to lib/dashboard/activityFeed (shared with the
// paging endpoint). ROUTE spans both so a guard cannot pass merely because the code it
// checks was extracted.
const ROUTE = strip(read('app/api/organizer/dashboard/route.ts'))
  + strip(read('lib/dashboard/activityFeed.ts'))
  + strip(read('app/api/organizer/dashboard/activity/route.ts'))
  + strip(read('lib/dashboard/activityCursor.ts'))
  const PAGE  = strip(read('app/(dashboard)/dashboard/page.tsx'))

  it('12 · event-specific sections still follow the scoped set', () => {
    expect(ROUTE).toMatch(/const scopedSlugs = scoped \? \(selectedSlug \? \[selectedSlug\] : \[\]\) : slugList/)
    expect(ROUTE).toMatch(/const analytics = buildDashboardAnalytics\(scopedSlugs\.map/)
    expect(ROUTE).toMatch(/where\('eventSlug', '==', scope\.eventSlug\)/)
    expect(ROUTE).toMatch(/where\('eventSlug', 'in', scope\.dashboardSlugs\)/)
  })

  it('12b · no eventId ⇒ all-events mode, which is what the option produces', () => {
    expect(ROUTE).toMatch(/const scoped = requestedEventId !== null/)
    expect(PAGE).toMatch(/const url = reqEvent\s*\n?\s*\? `\/api\/organizer\/dashboard\?eventId=/)
    expect(PAGE).toMatch(/: '\/api\/organizer\/dashboard'/)
  })

  it('13 · Event Performance stays cross-event in BOTH modes', () => {
    expect(ROUTE).toMatch(/const crossEventAnalytics = scoped\s*\n?\s*\? buildDashboardAnalytics\(slugList\.map/)
    expect(ROUTE).toMatch(/eventPerformance:\s+\(crossEventAnalytics \?\? analytics\)\.eventPerformance/)
  })

  it('13b · the draft state is not regressed', () => {
    expect(ROUTE).not.toContain('EVENT_NOT_PUBLISHED')
    expect(ROUTE).toMatch(/eventPublished: scoped \? !selectedUnpublished : true/)
    expect(PAGE).toContain('Not published yet — setup incomplete')
  })
})

// ═══ PERFORMANCE ════════════════════════════════════════════════════════════

describe('the option costs nothing', () => {
  it('the selector still performs NO fetching of its own', () => {
    // It renders summaries already in the context from the ONE /api/organizer/events call
    // the shell makes. A control opened dozens of times a day must not be a query.
    expect(SELECTOR).not.toMatch(/\bfetch\(/)
    expect(SELECTOR).not.toMatch(/useEffect\([^)]*api\//)
  })

  it('the option is derived from the list already loaded', () => {
    expect(SELECTOR).toMatch(/events\.length\.toLocaleString\('en-IN'\)/)
  })
})

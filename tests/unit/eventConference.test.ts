// RD-EVENT-17 · the Conference workspace.
//
// ═══ WHAT THESE PIN ══════════════════════════════════════════════════════════
//
// 1. TIME WAS THE BROWSER'S. `fmtTime`/`dayKey` formatted with `en-IN` and no timeZone,
//    so an organiser abroad read the agenda against their own clock — and an evening
//    session in Asia/Kolkata grouped onto the wrong day.
//
// 2. "0% NO-SHOW" FOR AN EMPTY SESSION. `registeredCount > 0 ? … : 0` printed a confident
//    zero for a session nobody had registered for, which reads as perfect attendance.
//
// 3. CANCELLED SESSIONS VANISHED. The tab filtered to `status === 'published'`, so
//    cancelling made a row disappear and the empty state then claimed "No sessions yet"
//    about an event with several.
//
// 4. NO LIFECYCLE CHECK. The sessions route accepted writes on a cancelled or archived
//    event.
//
// 5. THE ATTENDEE EXPORT READ EVERY REGISTRATION. One session's CSV scanned the whole
//    event's registrations — full name, email and phone each — and filtered in memory.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// The route's module graph reaches the Admin SDK. These tests exercise the PURE view
// module plus source contracts, so the SDK is doubled rather than booted.
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

import {
  CONFERENCE_VIEWS, SESSION_STATE_LABEL, UNAVAILABLE, capacityView, conferenceEditable,
  conferenceEmptyMessage, conferenceLockReason, conferenceSummary, filterSessions,
  formatDuration, formatSessionDay, formatSessionRange, groupByDay, groupBySpeaker,
  groupByTrack, hallUsage, isConferenceView, isStatusFilter, noShowPercent, sessionDayKey,
  sessionMinutes, sessionState, speakerNames, trackName, hallName,
} from '@/lib/sessions/conferenceView'
import type { SessionView, EventHallDoc, EventTrackDoc, EventSpeakerDoc } from '@/lib/sessions/types'

const root = resolve(__dirname, '../..')
const read = (p: string) => readFileSync(resolve(root, p), 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

const TAB     = read('app/(dashboard)/dashboard/events/[eventId]/tabs/ConferenceTab.tsx')
const ROUTE   = read('app/api/organizer/events/[eventId]/sessions/route.ts')
const QUERIES = read('lib/sessions/queries.ts')
const SCOPE   = read('lib/sessions/eventScope.ts')
const VIEW    = read('lib/sessions/conferenceView.ts')
const SHELL   = read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx')

const IST = 'Asia/Kolkata'
/** 2026-09-14 21:00 UTC = 2026-09-15 02:30 IST — a different calendar day in each zone. */
const LATE_UTC = Date.UTC(2026, 8, 14, 21, 0)

function sess(o: Partial<SessionView> = {}): SessionView {
  return {
    sessionId: 's1', title: 'Opening keynote', description: '',
    trackId: null, hallId: null, speakerIds: [],
    startTime: Date.UTC(2026, 8, 14, 4, 0), endTime: Date.UTC(2026, 8, 14, 5, 0),
    capacity: null, status: 'published', registeredCount: 0, checkedInCount: 0, ...o,
  }
}
const hall = (o: Partial<EventHallDoc>): EventHallDoc =>
  ({ hallId: 'h1', organizerUid: 'u', eventSlug: 'e', name: 'Hall A', capacity: null, createdAt: null, ...o })
const track = (o: Partial<EventTrackDoc>): EventTrackDoc =>
  ({ trackId: 't1', organizerUid: 'u', eventSlug: 'e', name: 'Product', color: null, createdAt: null, ...o })
const speaker = (o: Partial<EventSpeakerDoc>): EventSpeakerDoc =>
  ({ speakerId: 'p1', organizerUid: 'u', eventSlug: 'e', name: 'Priya', title: '', bio: '', photoUrl: null, createdAt: null, ...o })

// ═══ 1 · Time is the EVENT's, not the browser's ══════════════════════════════

describe('times are formatted in the event timezone', () => {
  it('a late-evening UTC session lands on the NEXT day in Asia/Kolkata', () => {
    expect(sessionDayKey(LATE_UTC, IST)).toBe('2026-09-15')
    expect(sessionDayKey(LATE_UTC, 'UTC')).toBe('2026-09-14')
  })

  it('the day heading follows the same zone', () => {
    expect(formatSessionDay(LATE_UTC, IST)).toContain('15')
    expect(formatSessionDay(LATE_UTC, 'UTC')).toContain('14')
  })

  it('grouping by day uses the event zone, not UTC', () => {
    const groups = groupByDay([sess({ startTime: LATE_UTC, endTime: LATE_UTC + 3.6e6 })], IST)
    expect(groups).toHaveLength(1)
    expect(groups[0].key).toBe('2026-09-15')
  })

  it('an unknown timezone falls back instead of taking the agenda down', () => {
    expect(() => formatSessionDay(LATE_UTC, 'Not/AZone')).not.toThrow()
    expect(formatSessionDay(LATE_UTC, 'Not/AZone')).not.toBe(UNAVAILABLE)
    expect(sessionDayKey(LATE_UTC, 'Not/AZone')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('a null timezone is tolerated', () => {
    expect(formatSessionRange(LATE_UTC, LATE_UTC + 3.6e6, null)).toContain('–')
  })

  it('an unusable instant is a dash, never a fabricated time', () => {
    expect(formatSessionDay(NaN, IST)).toBe(UNAVAILABLE)
    expect(formatSessionRange(NaN, 1, IST)).toBe(UNAVAILABLE)
    expect(sessionDayKey(NaN, IST)).toBe('')
  })

  it('the tab formats with the EVENT timezone, never a bare locale call', () => {
    const s = strip(TAB)
    expect(s).toMatch(/const tz = event\.timezone/)
    // `toLocaleString('en-IN')` on a NUMBER is fine and used for counts. What must never
    // appear is a DATE formatted without the event's zone — that was the old bug.
    expect(s).not.toMatch(/new Date\([^)]*\)\.toLocale(String|DateString|TimeString)\(/)
    expect(s).not.toMatch(/toLocaleDateString\('en-IN'/)
    expect(s).not.toMatch(/toLocaleTimeString\('en-IN'/)
  })
})

describe('duration', () => {
  it('reports hours and minutes', () => {
    expect(sessionMinutes(0, 90 * 60000)).toBe(90)
    expect(formatDuration(90)).toBe('1 hr 30 min')
    expect(formatDuration(60)).toBe('1 hr')
    expect(formatDuration(45)).toBe('45 min')
  })

  it('an end at or before the start has NO duration', () => {
    expect(sessionMinutes(100, 100)).toBeNull()
    expect(sessionMinutes(100, 50)).toBeNull()
    expect(formatDuration(null)).toBe(UNAVAILABLE)
  })
})

// ═══ 2 · A percentage of nothing is not zero ═════════════════════════════════

describe('noShowPercent', () => {
  it('is null when nobody registered', () => {
    expect(noShowPercent(0, 0)).toBeNull()
    expect(noShowPercent(-1, 0)).toBeNull()
  })

  it('is the share who did not check in', () => {
    expect(noShowPercent(10, 10)).toBe(0)
    expect(noShowPercent(10, 5)).toBe(50)
    expect(noShowPercent(10, 0)).toBe(100)
  })

  it('cannot go negative when check-ins exceed registrations', () => {
    expect(noShowPercent(10, 15)).toBe(0)
  })

  it('the summary reports it as absent, not as zero', () => {
    const s = conferenceSummary([sess()], IST)
    expect(s.registered).toBe(0)
    expect(s.noShowPct).toBeNull()
  })

  it('the tab renders a dash for an absent share', () => {
    expect(strip(TAB)).toMatch(/s\.noShowPct === null \? UNAVAILABLE/)
  })
})

// ═══ 3 · Capacity ═══════════════════════════════════════════════════════════

describe('capacityView', () => {
  it('an uncapped session has no proportion to draw', () => {
    const c = capacityView(sess({ capacity: null, registeredCount: 7 }))
    expect(c.capacity).toBeNull()
    expect(c.percent).toBeNull()
    expect(c.remaining).toBeNull()
  })

  it('reports remaining seats and the share taken', () => {
    const c = capacityView(sess({ capacity: 50, registeredCount: 40 }))
    expect(c.remaining).toBe(10)
    expect(c.percent).toBe(80)
    expect(c.over).toBe(false)
  })

  // A capacity lowered after sign-ups leaves a session genuinely over — clamping the
  // FIGURE would hide the one case worth seeing. Bar widths clamp at the point of drawing.
  it('the percentage is NOT clamped, and remaining floors at zero', () => {
    const c = capacityView(sess({ capacity: 20, registeredCount: 25 }))
    expect(c.percent).toBe(125)
    expect(c.remaining).toBe(0)
    expect(c.over).toBe(true)
  })

  it('a zero or negative capacity is treated as unlimited, not as a full room', () => {
    expect(capacityView(sess({ capacity: 0, registeredCount: 3 })).capacity).toBeNull()
  })
})

// ═══ 4 · State ══════════════════════════════════════════════════════════════

describe('sessionState', () => {
  const s = sess({ startTime: 1000, endTime: 2000 })

  it('is upcoming, live then ended as the clock passes', () => {
    expect(sessionState(s, 500)).toBe('upcoming')
    expect(sessionState(s, 1000)).toBe('live')
    expect(sessionState(s, 1999)).toBe('live')
    expect(sessionState(s, 2000)).toBe('ended')
  })

  it('cancelled outranks the clock', () => {
    expect(sessionState({ ...s, status: 'cancelled' }, 1500)).toBe('cancelled')
  })

  it('every state has a word', () => {
    for (const k of ['cancelled', 'live', 'ended', 'upcoming'] as const) {
      expect(SESSION_STATE_LABEL[k].length).toBeGreaterThan(0)
    }
  })
})

// ═══ 5 · Cancelled sessions are not erased ══════════════════════════════════

describe('cancelled sessions', () => {
  const rows = [sess({ sessionId: 'a' }), sess({ sessionId: 'b', status: 'cancelled' })]
  const base = { query: '', trackId: null, hallId: null }

  it('are excluded from the scheduled view but still counted', () => {
    const s = conferenceSummary(rows, IST)
    expect(s.scheduled).toBe(1)
    expect(s.cancelled).toBe(1)
  })

  it('are reachable through their own filter', () => {
    expect(filterSessions(rows, { ...base, status: 'scheduled' }).map(x => x.sessionId)).toEqual(['a'])
    expect(filterSessions(rows, { ...base, status: 'cancelled' }).map(x => x.sessionId)).toEqual(['b'])
    expect(filterSessions(rows, { ...base, status: 'all' })).toHaveLength(2)
  })

  it('do not count towards places taken or room load', () => {
    const s = conferenceSummary(
      [sess({ registeredCount: 5 }), sess({ sessionId: 'b', status: 'cancelled', registeredCount: 99 })], IST)
    expect(s.registered).toBe(5)
  })

  // "All cancelled" is its own sentence — never "No sessions yet".
  it('an all-cancelled schedule says so', () => {
    const msg = conferenceEmptyMessage({ ...base, status: 'scheduled' }, 0, 3)
    expect(msg).toContain('cancelled')
    expect(msg).not.toMatch(/No sessions on the schedule yet/)
  })

  it('a genuinely empty schedule says THAT', () => {
    expect(conferenceEmptyMessage({ ...base, status: 'scheduled' }, 0, 0))
      .toBe('No sessions on the schedule yet.')
  })

  it('each empty reason is its own sentence', () => {
    const msgs = new Set([
      conferenceEmptyMessage({ ...base, status: 'scheduled' }, 0, 0),
      conferenceEmptyMessage({ ...base, status: 'scheduled', query: 'x' }, 3, 0),
      conferenceEmptyMessage({ ...base, status: 'scheduled', trackId: 't' }, 3, 0),
      conferenceEmptyMessage({ ...base, status: 'cancelled' }, 3, 0),
      conferenceEmptyMessage({ ...base, status: 'scheduled' }, 0, 2),
    ])
    expect(msgs.size).toBe(5)
  })
})

// ═══ 6 · Summary ════════════════════════════════════════════════════════════

describe('conferenceSummary', () => {
  it('counts distinct days in the event zone', () => {
    const s = conferenceSummary([
      sess({ sessionId: 'a', startTime: LATE_UTC, endTime: LATE_UTC + 3.6e6 }),
      sess({ sessionId: 'b', startTime: Date.UTC(2026, 8, 14, 4, 0), endTime: Date.UTC(2026, 8, 14, 5, 0) }),
    ], IST)
    // 02:30 IST on the 15th and 09:30 IST on the 14th — two days.
    expect(s.days).toBe(2)
  })

  it('sums scheduled minutes and leaves them null when nothing is usable', () => {
    expect(conferenceSummary([sess({ startTime: 0, endTime: 60 * 60000 })], IST).minutes).toBe(60)
    expect(conferenceSummary([sess({ startTime: 5, endTime: 5 })], IST).minutes).toBeNull()
  })

  it('flags full sessions and sessions with no room', () => {
    const s = conferenceSummary([
      sess({ sessionId: 'a', capacity: 10, registeredCount: 10, hallId: 'h1' }),
      sess({ sessionId: 'b', capacity: null, hallId: null }),
    ], IST)
    expect(s.full).toBe(1)
    expect(s.withoutHall).toBe(1)
  })

  it('an empty schedule is all genuine zeroes', () => {
    const s = conferenceSummary([], IST)
    expect(s).toMatchObject({ scheduled: 0, cancelled: 0, days: 0, registered: 0, checkedIn: 0 })
    expect(s.minutes).toBeNull()
    expect(s.noShowPct).toBeNull()
  })
})

// ═══ 7 · Room utilisation — the one chart ═══════════════════════════════════

describe('hallUsage', () => {
  const rows = [
    sess({ sessionId: 'a', hallId: 'h1', registeredCount: 30, startTime: 0, endTime: 3.6e6 }),
    sess({ sessionId: 'b', hallId: 'h1', registeredCount: 45, startTime: 4e6, endTime: 7.6e6 }),
  ]

  // The sum across a day would exceed the room's seats without anyone being crowded.
  it('measures the BUSIEST single session, not the day total', () => {
    const [r] = hallUsage(rows, [hall({ hallId: 'h1', capacity: 50 })])
    expect(r.percent).toBe(90)      // 45 of 50, not (30+45) of 50
    expect(r.sessions).toBe(2)
  })

  // No denominator, no chart — the surface omits itself rather than inventing one.
  it('returns nothing when no room has a seat count', () => {
    expect(hallUsage(rows, [hall({ hallId: 'h1', capacity: null })])).toEqual([])
  })

  it('a room with no capacity keeps a null percentage alongside capped rooms', () => {
    const out = hallUsage(rows, [hall({ hallId: 'h1', capacity: 50 }), hall({ hallId: 'h2', capacity: null, name: 'B' })])
    expect(out).toHaveLength(2)
    expect(out[1].percent).toBeNull()
  })

  it('cancelled sessions do not load a room', () => {
    const [r] = hallUsage(
      [sess({ hallId: 'h1', status: 'cancelled', registeredCount: 99 })],
      [hall({ hallId: 'h1', capacity: 50 })])
    expect(r.percent).toBe(0)
  })
})

// ═══ 8 · Grouping and filtering ═════════════════════════════════════════════

describe('grouping', () => {
  it('orders days chronologically and sessions within a day by start', () => {
    const g = groupByDay([
      sess({ sessionId: 'late', startTime: Date.UTC(2026, 8, 14, 8, 0), endTime: Date.UTC(2026, 8, 14, 9, 0) }),
      sess({ sessionId: 'early', startTime: Date.UTC(2026, 8, 14, 4, 0), endTime: Date.UTC(2026, 8, 14, 5, 0) }),
      sess({ sessionId: 'nextday', startTime: Date.UTC(2026, 8, 15, 4, 0), endTime: Date.UTC(2026, 8, 15, 5, 0) }),
    ], IST)
    expect(g.map(x => x.key)).toEqual(['2026-09-14', '2026-09-15'])
    expect(g[0].sessions.map(x => x.sessionId)).toEqual(['early', 'late'])
  })

  it('groups by track and surfaces untracked sessions rather than dropping them', () => {
    const g = groupByTrack(
      [sess({ sessionId: 'a', trackId: 't1' }), sess({ sessionId: 'b', trackId: null })],
      [track({ trackId: 't1', name: 'Product' })])
    expect(g.map(x => x.label)).toEqual(['Product', 'No track'])
  })

  it('groups by speaker and surfaces unassigned sessions', () => {
    const g = groupBySpeaker(
      [sess({ sessionId: 'a', speakerIds: ['p1'] }), sess({ sessionId: 'b', speakerIds: [] })],
      [speaker({ speakerId: 'p1', name: 'Priya' })])
    expect(g.map(x => x.label)).toEqual(['Priya', 'No speaker assigned'])
  })

  it('omits empty groups', () => {
    expect(groupByTrack([], [track({})])).toEqual([])
  })
})

describe('filtering', () => {
  const speakers = [speaker({ speakerId: 'p1', name: 'Priya Subramanian' })]
  const rows = [
    sess({ sessionId: 'a', title: 'Opening keynote', trackId: 't1', hallId: 'h1', speakerIds: ['p1'] }),
    sess({ sessionId: 'b', title: 'Closing panel', trackId: 't2', hallId: 'h2' }),
  ]
  const base = { query: '', trackId: null, hallId: null, status: 'scheduled' as const }

  it('matches title, description and speaker name, case-insensitively', () => {
    expect(filterSessions(rows, { ...base, query: 'KEYNOTE' }, speakers).map(x => x.sessionId)).toEqual(['a'])
    expect(filterSessions(rows, { ...base, query: 'subramanian' }, speakers).map(x => x.sessionId)).toEqual(['a'])
    expect(filterSessions(rows, { ...base, query: 'zzz' }, speakers)).toEqual([])
  })

  it('combines track, room and text filters', () => {
    expect(filterSessions(rows, { ...base, trackId: 't2' }).map(x => x.sessionId)).toEqual(['b'])
    expect(filterSessions(rows, { ...base, hallId: 'h1' }).map(x => x.sessionId)).toEqual(['a'])
    expect(filterSessions(rows, { ...base, trackId: 't1', query: 'closing' }, speakers)).toEqual([])
  })

  it('an all-whitespace query filters nothing out', () => {
    expect(filterSessions(rows, { ...base, query: '   ' })).toHaveLength(2)
  })

  it('does not mutate its input', () => {
    const before = rows.map(r => r.sessionId)
    filterSessions(rows, { ...base, query: 'keynote' }, speakers)
    expect(rows.map(r => r.sessionId)).toEqual(before)
  })
})

describe('bundle name lookups', () => {
  const bundle = { tracks: [track({ trackId: 't1', name: 'Product' })], halls: [hall({ hallId: 'h1', name: 'Hall A' })], speakers: [speaker({ speakerId: 'p1', name: 'Priya' })] }

  it('return null rather than a dash, so the caller chooses the words', () => {
    expect(trackName(bundle, 't1')).toBe('Product')
    expect(trackName(bundle, null)).toBeNull()
    expect(trackName(bundle, 'gone')).toBeNull()
    expect(hallName(bundle, 'h1')).toBe('Hall A')
  })

  it('drop speaker ids that no longer resolve rather than rendering blanks', () => {
    expect(speakerNames(bundle, ['p1', 'ghost'])).toEqual(['Priya'])
  })
})

// ═══ 9 · Lifecycle ══════════════════════════════════════════════════════════

describe('lifecycle', () => {
  it.each(['cancelled', 'archived'])('%s is read-only', s => {
    expect(conferenceEditable(s)).toBe(false)
    expect(conferenceLockReason(s)).toBeTruthy()
  })

  // Mirrors `isLocked` in lib/eventSetup/readiness — completed stays editable there too,
  // because post-event corrections and exports remain useful.
  it.each(['draft', 'pending_review', 'changes_requested', 'published', 'registration_closed', 'completed', null, 'anything-new'])(
    '%s stays editable', s => {
      expect(conferenceEditable(s)).toBe(true)
      expect(conferenceLockReason(s)).toBeNull()
    })

  it('the route refuses schedule writes on a locked event', () => {
    const s = strip(ROUTE)
    expect(s).toMatch(/conferenceEditable\(event\.lifecycleStatus\)/)
    expect(s).toMatch(/EVENT_LOCKED/)
    // The attendee-side allocation path is exempt — its own service gates it.
    expect(s).toMatch(/action !== 'set_registration_sessions'/)
  })

  it('the lifecycle costs no extra read — it rides on the draft already fetched', () => {
    expect(strip(SCOPE)).toMatch(/lifecycleStatus/)
    expect((strip(SCOPE).match(/adminDb\.doc\(/g) ?? []).length).toBe(1)
  })

  it('the route tells the client, so the UI cannot offer what the server refuses', () => {
    expect(strip(ROUTE)).toMatch(/editable: conferenceEditable/)
    expect(strip(TAB)).toMatch(/bundle\?\.editable !== false/)
  })
})

// ═══ 10 · Read plan and PII ═════════════════════════════════════════════════

describe('the attendee export no longer scans every registration', () => {
  it('queries the holders directly', () => {
    const s = strip(QUERIES)
    expect(s).toMatch(/where\('selectedSessions', 'array-contains', sessionId\)/)
    // The old whole-event scan is gone.
    expect(s).not.toMatch(/collection\('registrations'\)\s*\n?\s*\.where\('organizerUid', '==', uid\)\.where\('eventSlug', '==', slug\)\.get\(\)/)
  })

  it('still checks ownership on every row it returns', () => {
    expect(strip(QUERIES)).toMatch(/r\.organizerUid !== uid \|\| r\.eventSlug !== slug/)
  })

  it('scopes the session check-in read to the workspace', () => {
    expect(strip(QUERIES)).toMatch(/where\('organizerUid', '==', uid\)/)
  })

  it('a malformed eventId is a 404, not a 500', () => {
    const s = strip(SCOPE)
    expect(s).toMatch(/catch \{\s*return null/)
  })
})

describe('the tab does not refetch what the shell already has', () => {
  it('takes the event object rather than an id + a second request', () => {
    expect(strip(TAB)).toMatch(/export default function ConferenceTab\(\{ event, token \}/)
    expect(strip(SHELL)).toMatch(/<ConferenceTab event=\{event\} token=\{token\} \/>/)
    // No event-detail request of its own.
    expect(strip(TAB)).not.toMatch(/fetch\(`\/api\/organizer\/events\/\$\{eventId\}`/)
  })

  it('issues exactly one schedule request per load, and none on a timer', () => {
    const s = strip(TAB)
    expect(s).not.toMatch(/setInterval|setTimeout\([^,]*,\s*\d{4,}\)/)
    // The loader GETs and mutations POST to the same base — exactly one call site each.
    expect((s.match(/fetch\(base, \{ headers:/g) ?? []).length).toBe(1)
    expect((s.match(/fetch\(base, \{ method: 'POST'/g) ?? []).length).toBe(1)
  })

  it('filtering happens in memory over a complete set, not over a server page', () => {
    expect(strip(TAB)).toMatch(/filterSessions\(bundle\.sessions/)
    expect(VIEW).toMatch(/no second page a client-side filter could/)
  })
})

// ═══ 11 · Honest states, and no shell duplication ═══════════════════════════

describe('the workspace', () => {
  it('does not repeat the shell — no event name, status, revenue or capacity', () => {
    const s = strip(TAB)
    expect(s).not.toMatch(/event\.name/)
    expect(s).not.toMatch(/event\.totalRegistrations/)
    expect(s).not.toMatch(/confirmedRevenuePaise|totalCapacity|checkedInCount:/)
    expect(s).not.toMatch(/lifecycleStatus.*badge|EventCommandHeader/)
  })

  it('labels session figures as SESSION figures', () => {
    expect(TAB).toMatch(/Session places taken/)
    expect(TAB).toMatch(/separate from the event&apos;s own registration total/)
  })

  it('has a skeleton, an error state with a real retry, and distinct empties', () => {
    const s = strip(TAB)
    expect(s).toMatch(/aria-busy="true"/)
    expect(s).toMatch(/role="status"/)
    expect(s).toMatch(/onClick=\{reload\}/)
    expect(s).toMatch(/conferenceEmptyMessage\(filters/)
    expect(s).not.toMatch(/window\.location\.reload/)
  })

  it('never renders a raw server code', () => {
    const s = strip(TAB)
    expect(s).toMatch(/function actionMessage/)
    expect(s).not.toMatch(/d\?\.error \?\? 'Failed'/)
    expect(s).not.toMatch(/e instanceof Error \? e\.message/)
  })

  it('confirms before cancelling a session or removing an entity', () => {
    const s = strip(TAB)
    expect((s.match(/await confirm\(\{/g) ?? []).length).toBeGreaterThanOrEqual(2)
    expect(s).toMatch(/tone: 'danger'/)
    // The confirmation names the people who lose the session.
    expect(TAB).toMatch(/this session in their schedule/)
  })

  it('uses design tokens, not raw palette classes or inline gradients', () => {
    const s = strip(TAB)
    expect(s).not.toMatch(/bg-(emerald|amber|rose|red|green|blue)-\d{2,3}/)
    expect(s).not.toMatch(/text-\[\d/)
    expect(s).not.toMatch(/backgroundImage: 'var\(--primary-gradient\)'/)
    expect(s).toMatch(/accent\(/)
  })

  it('keeps view and filters in the URL', () => {
    const s = strip(TAB)
    expect(s).toMatch(/useSearchParams/)
    for (const k of ['cv', 'cs', 'cq', 'ct', 'ch']) expect(s).toMatch(new RegExp(`params\\.get\\('${k}'\\)`))
    expect(s).toMatch(/router\.push/)
    expect(s).toMatch(/router\.replace/)
  })

  it('offers a usable speaker picker, not a multi-select', () => {
    expect(strip(TAB)).not.toMatch(/<select multiple/)
    expect(strip(TAB)).toMatch(/aria-pressed=\{on\}/)
  })

  it('every icon-only control has an accessible name', () => {
    const iconButtons = (TAB.match(/className=\{cn\(ICON_BTN/g) ?? []).length
    expect(iconButtons).toBeGreaterThan(0)
    expect((TAB.match(/aria-label=/g) ?? []).length).toBeGreaterThanOrEqual(iconButtons)
  })
})

// ═══ 12 · No event-type assumptions ═════════════════════════════════════════

describe('no sports vocabulary anywhere in the feature', () => {
  const BANNED = /\b(runner|runners|bib|bibs|race|races|marathon|finisher|finishers|lane)\b/i

  it.each([
    ['the tab', TAB],
    ['the view module', VIEW],
    ['the route', ROUTE],
    ['the query layer', QUERIES],
  ])('%s uses no sports-specific word', (_n, src) => {
    expect(BANNED.test(strip(src))).toBe(false)
  })

  it('nothing branches on eventType', () => {
    for (const src of [TAB, VIEW]) {
      expect(strip(src)).not.toMatch(/eventType\s*===/)
    }
  })

  it('the view list is the data model\'s own vocabulary', () => {
    expect(CONFERENCE_VIEWS.map(v => v.key)).toEqual(['agenda', 'track', 'speaker'])
    expect(isConferenceView('agenda')).toBe(true)
    expect(isConferenceView('nope')).toBe(false)
    expect(isStatusFilter('cancelled')).toBe(true)
    expect(isStatusFilter('deleted')).toBe(false)
  })
})

// ═══ 13 · An unpublished draft is a STATE, not a failed read ════════════════
//
// Sessions are keyed by `eventSlug`, which an event only gets at publish. That collapsed
// into the same `null` as "no such event", so the tab rendered "The schedule couldn't be
// loaded" on a perfectly healthy draft — the exact EMPTY/ERROR/NOT-CONFIGURED conflation
// the brief calls out.

describe('an unpublished draft', () => {
  it('is distinguished from a missing event at the resolver', () => {
    const s = strip(SCOPE)
    expect(s).toMatch(/export const UNPUBLISHED/)
    // RD-CE-FIX C1 — the slug is the OWNERSHIP-VERIFIED one; an unverified pointer reads as unpublished.
    expect(s).toMatch(/const slug = await resolveOwnedEventSlug\(workspaceUid, eventId, d as Record<string, unknown>\)/)
    expect(s).toMatch(/if \(!slug\) return UNPUBLISHED/)
    // A draft that does not exist is still null.
    expect(s).toMatch(/if \(!snap\.exists\) return null/)
  })

  it('answers GET with an empty schedule, not a 404', () => {
    const s = strip(ROUTE)
    expect(s).toMatch(/if \(event === UNPUBLISHED\)/)
    expect(s).toMatch(/published: false/)
    expect(s).toMatch(/published: true/)
  })

  it('refuses writes with a reason rather than a not-found', () => {
    expect(strip(ROUTE)).toMatch(/EVENT_UNPUBLISHED/)
  })

  it('the tab renders its own state, never the error screen', () => {
    const s = strip(TAB)
    expect(s).toMatch(/if \(bundle\.published === false\)/)
    expect(TAB).toMatch(/The schedule opens once this event is published/)
  })
})

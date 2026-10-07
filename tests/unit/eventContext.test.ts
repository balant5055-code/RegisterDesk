// RD-ORG-FOUNDATION — the selected-event rules.
//
// These cover the decisions that are invisible when right and dangerous when wrong:
// which event a fresh visit lands on, whether a remembered id can resurrect access
// the caller no longer has, and whether a forged `?eventId=` can silently swap the
// organizer onto another event's data.

import { describe, it, expect } from 'vitest'
import {
  EVENT_PARAM,
  eventIdFromPathname,
  fillPercent,
  isEventScopedPath,
  presentEventStatus,
  rankEventsForDefault,
  resolveSelectedEvent,
  withEventParam,
  type EventSummary,
} from '@/lib/events/eventContext'

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

// ─── The param name is part of the contract ───────────────────────────────────

describe('EVENT_PARAM', () => {
  it('is eventId — the spelling already in the product, not a second one', () => {
    // A change here silently breaks /dashboard/registrations, which reads this name.
    expect(EVENT_PARAM).toBe('eventId')
  })
})

// ─── Default selection ────────────────────────────────────────────────────────

describe('rankEventsForDefault', () => {
  it('prefers an event happening RIGHT NOW over one starting later', () => {
    const live     = ev({ draftId: 'live',     startDate: new Date(NOW - DAY).toISOString(), endDate: new Date(NOW + DAY).toISOString() })
    const upcoming = ev({ draftId: 'upcoming', startDate: new Date(NOW + 7 * DAY).toISOString() })
    expect(rankEventsForDefault([upcoming, live], NOW)[0].draftId).toBe('live')
  })

  it('prefers the SOONEST upcoming event, not the most recently edited', () => {
    const soon = ev({ draftId: 'soon', startDate: new Date(NOW + 2 * DAY).toISOString(), updatedAt: new Date(NOW - 90 * DAY).toISOString() })
    const late = ev({ draftId: 'late', startDate: new Date(NOW + 60 * DAY).toISOString(), updatedAt: new Date(NOW).toISOString() })
    expect(rankEventsForDefault([late, soon], NOW)[0].draftId).toBe('soon')
  })

  it('ranks a draft below a published upcoming event', () => {
    const draft    = ev({ draftId: 'draft', status: 'draft', lifecycleStatus: 'draft', updatedAt: new Date(NOW).toISOString() })
    const upcoming = ev({ draftId: 'upcoming', startDate: new Date(NOW + 3 * DAY).toISOString(), updatedAt: new Date(NOW - 30 * DAY).toISOString() })
    expect(rankEventsForDefault([draft, upcoming], NOW)[0].draftId).toBe('upcoming')
  })

  it('never auto-selects a cancelled or archived event over a working one', () => {
    const cancelled = ev({ draftId: 'cancelled', lifecycleStatus: 'cancelled', updatedAt: new Date(NOW).toISOString() })
    const archived  = ev({ draftId: 'archived',  lifecycleStatus: 'archived',  updatedAt: new Date(NOW).toISOString() })
    const draft     = ev({ draftId: 'draft', status: 'draft', lifecycleStatus: 'draft', updatedAt: new Date(NOW - 400 * DAY).toISOString() })
    // The draft is a year staler and still wins — recency must not resurrect a dead event.
    expect(rankEventsForDefault([cancelled, archived, draft], NOW)[0].draftId).toBe('draft')
  })

  it('does not mutate the caller array', () => {
    const list = [ev({ draftId: 'b' }), ev({ draftId: 'a' })]
    const before = list.map(e => e.draftId)
    rankEventsForDefault(list, NOW)
    expect(list.map(e => e.draftId)).toEqual(before)
  })
})

// ─── Resolution priority ──────────────────────────────────────────────────────

describe('resolveSelectedEvent', () => {
  const events = [ev({ draftId: 'a' }), ev({ draftId: 'b' })]

  it('URL wins over a remembered event', () => {
    const r = resolveSelectedEvent({ urlEventId: 'b', storedEventId: 'a', events, now: NOW })
    expect(r).toMatchObject({ eventId: 'b', source: 'url', urlEventMissing: false })
  })

  it('a remembered event wins over the ranked default', () => {
    const r = resolveSelectedEvent({ urlEventId: null, storedEventId: 'b', events, now: NOW })
    expect(r).toMatchObject({ eventId: 'b', source: 'stored' })
  })

  it('falls back to the ranked default when nothing is remembered', () => {
    const r = resolveSelectedEvent({ urlEventId: null, storedEventId: null, events, now: NOW })
    expect(r.source).toBe('default')
    expect(['a', 'b']).toContain(r.eventId)
  })

  // ═══ The two that actually matter ═══════════════════════════════════════════

  it('IGNORES a remembered event the caller can no longer reach', () => {
    // A team member removed from a workspace still has its id in localStorage.
    // It must not resolve — membership is tested against the authorized list.
    const r = resolveSelectedEvent({ urlEventId: null, storedEventId: 'gone', events, now: NOW })
    expect(r.eventId).not.toBe('gone')
    expect(r.source).toBe('default')
  })

  it('a forged ?eventId= selects NOTHING rather than a different event', () => {
    // The dangerous alternative is falling through to the default: the organizer
    // would then read another event's numbers under a URL naming someone else's.
    const r = resolveSelectedEvent({ urlEventId: 'forged', storedEventId: 'a', events, now: NOW })
    expect(r.eventId).toBeNull()
    expect(r.urlEventMissing).toBe(true)
  })

  it('resolves to nothing, not a crash, for an empty workspace', () => {
    const r = resolveSelectedEvent({ urlEventId: null, storedEventId: 'x', events: [], now: NOW })
    expect(r).toMatchObject({ eventId: null, source: 'none', urlEventMissing: false })
  })
})

// ─── URL helpers ──────────────────────────────────────────────────────────────

describe('eventIdFromPathname', () => {
  it('reads the id from the event workspace path', () => {
    expect(eventIdFromPathname('/dashboard/events/abc123')).toBe('abc123')
  })

  it('treats the wizard as NOT an event', () => {
    // /dashboard/events/new is the create wizard; reading "new" as an event id would
    // make the shell hunt for an event called "new" on every create.
    expect(eventIdFromPathname('/dashboard/events/new')).toBeNull()
    expect(eventIdFromPathname('/dashboard/events/new/visibility')).toBeNull()
  })

  it('returns null for the events list and unrelated routes', () => {
    expect(eventIdFromPathname('/dashboard/events')).toBeNull()
    expect(eventIdFromPathname('/dashboard/finance')).toBeNull()
  })
})

describe('withEventParam', () => {
  it('preserves the query parameters the destination already relies on', () => {
    // /dashboard/registrations?status=pending must keep its filter when scoped.
    const out = withEventParam('/dashboard/registrations?status=pending', 'e1')
    expect(out).toContain('status=pending')
    expect(out).toContain('eventId=e1')
  })

  it('replaces rather than appends an existing event id', () => {
    const out = withEventParam('/dashboard/registrations?eventId=old', 'new')
    expect(out).toBe('/dashboard/registrations?eventId=new')
  })

  it('STRIPS the parameter for a null event instead of writing "null"', () => {
    expect(withEventParam('/dashboard/registrations?eventId=old', null)).toBe('/dashboard/registrations')
  })

  it('keeps the hash fragment', () => {
    expect(withEventParam('/dashboard/finance#payouts', 'e1')).toBe('/dashboard/finance?eventId=e1#payouts')
  })
})

describe('isEventScopedPath', () => {
  const prefixes = ['/dashboard/registrations', '/dashboard/check-in']

  it('matches the route itself and its children', () => {
    expect(isEventScopedPath('/dashboard/registrations', prefixes)).toBe(true)
    expect(isEventScopedPath('/dashboard/check-in/operations', prefixes)).toBe(true)
  })

  it('does not match a route that merely shares a prefix string', () => {
    // '/dashboard/check-in-extra' starts with '/dashboard/check-in' as a STRING but
    // is a different route; matching it would scope an unrelated page to an event.
    expect(isEventScopedPath('/dashboard/check-in-extra', prefixes)).toBe(false)
  })

  it('returns false for global routes', () => {
    expect(isEventScopedPath('/dashboard/settings', prefixes)).toBe(false)
  })
})

// ─── Presentation ─────────────────────────────────────────────────────────────

describe('presentEventStatus', () => {
  it('calls a published event that has started Live, and one that has not Upcoming', () => {
    expect(presentEventStatus(ev({ draftId: 'a', startDate: new Date(NOW - DAY).toISOString() }), NOW).tone).toBe('live')
    expect(presentEventStatus(ev({ draftId: 'b', startDate: new Date(NOW + DAY).toISOString() }), NOW).tone).toBe('upcoming')
  })

  it('reports cancelled and archived distinctly from completed', () => {
    expect(presentEventStatus(ev({ draftId: 'c', lifecycleStatus: 'cancelled' }), NOW).label).toBe('Cancelled')
    expect(presentEventStatus(ev({ draftId: 'd', lifecycleStatus: 'completed' }), NOW).label).toBe('Completed')
  })
})

describe('fillPercent', () => {
  it('is null for an unlimited event rather than 0 or 100', () => {
    // A fabricated 0% would read as "nobody registered" for an event with no cap.
    expect(fillPercent(ev({ draftId: 'a', totalCapacity: null, totalRegistrations: 500 }))).toBeNull()
    expect(fillPercent(ev({ draftId: 'b', totalCapacity: 0, totalRegistrations: 500 }))).toBeNull()
  })

  it('clamps oversold events to 100 rather than reporting above capacity', () => {
    expect(fillPercent(ev({ draftId: 'c', totalCapacity: 100, totalRegistrations: 130 }))).toBe(100)
  })

  it('rounds to a whole percent', () => {
    expect(fillPercent(ev({ draftId: 'd', totalCapacity: 3, totalRegistrations: 1 }))).toBe(33)
  })
})

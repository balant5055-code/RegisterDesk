// RD-COMM-04 — event-scoped email history.
//
// RD-COMM-02 routed `?event=<slug>` to this page. The parameter arrived and
// narrowed nothing, so an organizer who clicked "View communication history" from
// one event saw every event's mail. What is pinned here:
//
//   1. THE FILTER IS SERVER-SIDE, applied to the Firestore query BEFORE the limit
//      — never to the rows after they arrive.
//   2. OWNERSHIP IS THE SERVER'S. The slug narrows; it never widens, and it can
//      never reach another workspace.
//   3. THE SAME PARAMETER RD-COMM-02 INTRODUCED, not a second one.
//   4. AN UNKNOWN EVENT IS SAID SO — never silently widened to "all events".

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const ROUTE  = code(read('app/api/organizer/email-logs/route.ts'))
const CLIENT = code(read('app/(dashboard)/dashboard/communications/email-logs/EmailLogsClient.tsx'))
const WA     = code(read('app/api/organizer/whatsapp-logs/route.ts'))

// ════════════════════════════════════════════════════════════════════════════
// 1 — SERVER-SIDE, BEFORE THE LIMIT
// ════════════════════════════════════════════════════════════════════════════

describe('1 — the event narrows the QUERY, not the results', () => {
  it('the filter is a Firestore predicate', () => {
    expect(ROUTE).toContain("searchParams.get('eventSlug')")
    expect(ROUTE).toContain("query.where('eventSlug',   '==', eventFilter)")
  })

  it('it is applied BEFORE the limit, so a filtered page is a full page', () => {
    const build = ROUTE.slice(ROUTE.indexOf('let query = adminDb'), ROUTE.indexOf('.limit(limit).get()'))
    expect(build).toContain("where('eventSlug'")
  })

  it('the rows are NOT filtered by event after they arrive', () => {
    // The one in-memory filter that legitimately exists is the WhatsApp channel
    // exclusion, which is documented and unrelated. No event filtering may join it.
    expect(ROUTE).not.toMatch(/\.filter\([^)]*eventSlug/)
  })

  it('the client sends the event to the server rather than filtering locally', () => {
    expect(CLIENT).toContain("params.set('eventSlug',   eventSlug)")
    // The client-side pass is search only — it must not also sift by event.
    expect(CLIENT).not.toMatch(/logs\.filter\([^)]*eventSlug/)
  })

  it('a change of event re-fetches from the server', () => {
    expect(CLIENT).toContain('}, [status, templateKey, dateFrom, dateTo, eventSlug])')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — OWNERSHIP STAYS SERVER-SIDE
// ════════════════════════════════════════════════════════════════════════════

describe('2 — a slug can narrow, never widen or cross a workspace', () => {
  it('the query is anchored on the authenticated organizer', () => {
    const build = ROUTE.slice(ROUTE.indexOf('let query = adminDb'), ROUTE.indexOf('.limit(limit).get()'))
    expect(build).toContain("where('organizerUid', '==', uid)")
    // `uid` comes from the workspace authorization, never from the request body.
    expect(ROUTE).toContain("authorizeWorkspace(req, 'broadcasts')")
    expect(ROUTE).toContain('const uid = authz.workspaceUid')
  })

  it('the event options come from the organizer\'s own events endpoint', () => {
    // NOT from slugs observed in the logs, which would leak names across events.
    expect(CLIENT).toContain("fetch('/api/organizer/events'")
  })

  it('the organizer scope is never taken from the query string', () => {
    expect(ROUTE).not.toMatch(/searchParams\.get\('organizerUid'\)/)
    expect(ROUTE).not.toMatch(/searchParams\.get\('uid'\)/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — ONE PARAMETER, ONE PATTERN
// ════════════════════════════════════════════════════════════════════════════

describe('3 — it reuses what already exists', () => {
  it('the URL parameter is the one RD-COMM-02 introduced', () => {
    expect(CLIENT).toContain("searchParams.get('event')")
    // No second event parameter invented alongside it.
    expect(CLIENT).not.toMatch(/searchParams\.get\('eventId'\)/)
    expect(CLIENT).not.toMatch(/searchParams\.get\('slug'\)/)
  })

  it('changing the filter writes the SAME parameter back to the URL', () => {
    expect(CLIENT).toContain("next.set('event', slug)")
    expect(CLIENT).toContain("next.delete('event')")
    expect(CLIENT).toContain('router.replace(')
  })

  it('the predicate matches the WhatsApp logs route, on the same collection', () => {
    // One pattern for `emailLogs`, not two implementations of event scoping.
    expect(WA).toContain("q.where('eventSlug',   '==', eventSlug)")
    expect(ROUTE).toContain("query.where('eventSlug',   '==', eventFilter)")
  })

  it('no new collection and no new route were introduced', () => {
    expect(ROUTE).toContain("adminDb.collection('emailLogs')")
    expect(ROUTE).not.toMatch(/collection\('emailLogsByEvent'\)/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — HONEST STATES
// ════════════════════════════════════════════════════════════════════════════

describe('4 — the empty list keeps its event context', () => {
  it('an unknown event is reported, never widened to all events', () => {
    expect(CLIENT).toContain('const unknownEvent  = Boolean(eventSlug) && eventsLoaded && selectedEvent === null')
    expect(CLIENT).toContain('That event is not available in your workspace.')
    expect(CLIENT).toContain('Event not available')
  })

  it('an event with no history says so in the event\'s own name', () => {
    expect(CLIENT).toContain('No email history for ${selectedEvent.name}')
    expect(CLIENT).toContain('No email communication has been sent for this event yet.')
  })

  it('the unfiltered empty state is unchanged', () => {
    expect(CLIENT).toContain("'No email logs found'")
    expect(CLIENT).toContain('Email logs will appear here once emails are sent.')
  })

  it('the unknown slug stays visible in the control rather than snapping back', () => {
    expect(CLIENT).toContain('Unavailable event')
  })

  it('the filter is labelled for a person, never as a slug or an id', () => {
    expect(CLIENT).toContain('All events')
    expect(CLIENT).toContain('aria-label="Filter by event"')
    // No internal vocabulary in the control's own copy.
    expect(CLIENT).not.toMatch(/>\s*(eventSlug|Slug|Workspace ID)\s*</)
  })
})

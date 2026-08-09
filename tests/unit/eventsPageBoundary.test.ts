// /events server page — THE root-cause regression.
//
// The page used to do:
//
//   const { events, stats, nextCursor } = await listPublishedEvents({ limit: 48 })
//     .catch(() => ({ events: [], stats: {…zeros}, nextCursor: null }))
//
// That turned a REJECTED query into a SUCCESSFUL render of an empty page. Because /events is
// ISR (`revalidate = 60`), Next.js writes a successful render to the page cache and serves it
// to every visitor until the next revalidation — so a single transient Firestore blip during
// one background regeneration blanked the Upcoming Events section for everyone, including on
// a hard refresh, and then healed by itself. That is exactly the intermittent report.
//
// A render that THROWS is never cached: the last good page keeps being served and the next
// request retries, and the root app/error.tsx boundary surfaces a recoverable screen.
//
// This file must mock lib/firebase/firestore/publicEvents, so it cannot share a file with
// the data-layer tests in eventsDiscovery.test.ts (which exercise the real implementation).

import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/firebase/firestore/publicEvents', () => ({
  listPublishedEvents: listMock,
}))

// Stand-in for the client island: returns the props it was handed so they can be asserted.
vi.mock('@/app/events/DiscoveryClient', () => ({
  DiscoveryClient: (props: unknown) => ({ __client: true, props }),
}))

import EventsDiscoveryPage from '@/app/events/page'

const OK_STATS = { totalEvents: 1, totalRegistrations: 5, totalCities: 0, totalOrganizers: 1 }
const ZERO_STATS = { totalEvents: 0, totalRegistrations: 0, totalCities: 0, totalOrganizers: 0 }

beforeEach(() => listMock.mockReset())

describe('/events page — a failed query is never rendered as "no events"', () => {
  it('propagates the query failure instead of resolving to an empty page', async () => {
    listMock.mockRejectedValueOnce(new Error('7 PERMISSION_DENIED: Firestore unavailable'))
    await expect(EventsDiscoveryPage()).rejects.toThrow(/PERMISSION_DENIED/)
  })

  it('never hands the client an empty list when the query rejected', async () => {
    listMock.mockRejectedValueOnce(new Error('network'))
    const result = await EventsDiscoveryPage().catch((e: unknown) => e)
    expect(result).toBeInstanceOf(Error)
    // The old behaviour produced a renderable element carrying initialEvents: [].
    expect(result).not.toHaveProperty('props')
  })

  it('logs the underlying cause server-side without leaking it into the render', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    listMock.mockRejectedValueOnce(new Error('service account expired'))

    await expect(EventsDiscoveryPage()).rejects.toThrow()
    expect(spy).toHaveBeenCalledWith('[events/page] discovery query failed:', expect.any(Error))
    spy.mockRestore()
  })
})

describe('/events page — the success path is unchanged', () => {
  it('passes the fetched events straight through to the client', async () => {
    const events = [{ slug: 'noyyal-marathon-2026' }]
    listMock.mockResolvedValueOnce({ events, stats: OK_STATS, nextCursor: null })

    const el = await EventsDiscoveryPage() as unknown as { props: Record<string, unknown> }
    expect(el.props.initialEvents).toBe(events)
    expect(el.props.initialStats).toBe(OK_STATS)
    expect(el.props.initialNextCursor).toBeNull()
  })

  it('forwards a pagination cursor when there is another page', async () => {
    listMock.mockResolvedValueOnce({ events: [{ slug: 'a' }], stats: OK_STATS, nextCursor: 'a' })
    const el = await EventsDiscoveryPage() as unknown as { props: Record<string, unknown> }
    expect(el.props.initialNextCursor).toBe('a')
  })

  it('renders a genuinely empty database as an empty list, NOT an error', async () => {
    // Zero events must still be a normal render — the fix must not turn "nothing published"
    // into an error screen.
    listMock.mockResolvedValueOnce({ events: [], stats: ZERO_STATS, nextCursor: null })
    const el = await EventsDiscoveryPage() as unknown as { props: Record<string, unknown> }
    expect(el.props.initialEvents).toEqual([])
    expect(el.props.initialStats).toBe(ZERO_STATS)
  })

  it('queries exactly once per render, for exactly one page', async () => {
    // Guards against "fix by refetching" and against duplicate queries from effects/StrictMode.
    listMock.mockResolvedValueOnce({ events: [], stats: ZERO_STATS, nextCursor: null })
    await EventsDiscoveryPage()
    expect(listMock).toHaveBeenCalledTimes(1)
    expect(listMock).toHaveBeenCalledWith({ limit: 48 })
  })

  it('is safe to render repeatedly — hard refresh and client navigation are identical', async () => {
    // Both entry points re-invoke the same server component; there is no module-level state,
    // so N renders produce N identical prop sets.
    const events = [{ slug: 'noyyal-marathon-2026' }]
    for (let i = 0; i < 5; i++) {
      listMock.mockResolvedValueOnce({ events, stats: OK_STATS, nextCursor: null })
      const el = await EventsDiscoveryPage() as unknown as { props: Record<string, unknown> }
      expect(el.props.initialEvents).toBe(events)
    }
    expect(listMock).toHaveBeenCalledTimes(5)
  })
})

// RD-FIN-SCOPE-01 — /dashboard/finance follows the GLOBAL Event Selector. Behaviour of the pure rules
// (lib/finance/viewScope, lib/events/eventContext) + source contracts for the client wiring (the node
// test environment cannot render the page). Server behaviour on real Firestore:
// tests/emulator/financeEventScope.emu.test.ts.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { financeViewScope, financeScopeParam, createLatestGate } from '@/lib/finance/viewScope'
import { resolveSelectedEvent, selectionRewritesUrl, ALL_EVENTS_SELECTION, type EventSummary } from '@/lib/events/eventContext'
import { EVENT_SCOPED_PREFIXES } from '@/config/workspaceNav'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')
const PAGE = read('app/(dashboard)/dashboard/finance/page.tsx')
const FCC  = read('components/dashboard/finance/FinanceControlCenter.tsx')
const TX   = read('app/api/organizer/finance/transactions/route.ts')
const AN   = read('app/api/organizer/finance/analytics/route.ts')
const SCOPE = read('lib/finance/eventScope.ts')
const PROVIDER = read('components/dashboard/EventContextProvider.tsx')

const snap = (o: Partial<Parameters<typeof financeViewScope>[0]>) => financeViewScope({
  loading: false, urlEventMissing: false, selectedEventId: null, isAllEvents: false, selectedEventName: null, ...o,
})
const ev = (draftId: string, name: string): EventSummary => ({
  draftId, name, slug: `${draftId}-slug`, status: 'published', lifecycleStatus: 'published', startDate: null, endDate: null,
  totalRegistrations: 0, totalCapacity: null, updatedAt: '2026-10-01T00:00:00Z',
} as EventSummary)
const EVENTS = [ev('evA', 'Event A'), ev('evB', 'Event B')]

describe('RD-FIN-SCOPE-01 · the header selection IS the Finance scope', () => {
  it('Event A selected → Finance scope A; Event B → B (the event id the server will authorize)', () => {
    const a = snap({ selectedEventId: 'evA', selectedEventName: 'Event A' })
    expect(a).toEqual({ kind: 'event', eventId: 'evA', name: 'Event A' })
    expect(financeScopeParam(a)).toBe('evA')
    expect(financeScopeParam(snap({ selectedEventId: 'evB', selectedEventName: 'Event B' }))).toBe('evB')
  })
  it('All events → workspace scope, sent as the explicit all-events sentinel', () => {
    const all = snap({ isAllEvents: true })
    expect(all).toEqual({ kind: 'all' })
    expect(financeScopeParam(all)).toBe(ALL_EVENTS_SELECTION)
  })
  it('loading, or a URL naming an event this workspace cannot see → NO scope (never all events)', () => {
    expect(snap({ loading: true, selectedEventId: 'evA' })).toBeNull()
    expect(snap({ urlEventMissing: true })).toBeNull()
    expect(financeScopeParam(null)).toBeNull()
  })
  it('a header change is a new scope key → every scoped section refetches', () => {
    expect(financeScopeParam(snap({ selectedEventId: 'evA' }))).not.toBe(financeScopeParam(snap({ selectedEventId: 'evB' })))
    expect(PAGE).toContain('}, [token, filter, scopeKey, fetchTransactions])')
    expect(FCC).toContain('useEffect(() => { setData(null); setLoading(true) }, [scopeKey])')
  })
})

describe('RD-FIN-SCOPE-01 · late responses from the old selection are dropped', () => {
  it('after A → B, A\'s (older) response is not the latest and may not write', () => {
    const g = createLatestGate()
    const forA = g.take(), forB = g.take()
    expect(g.isLatest(forA)).toBe(false)
    expect(g.isLatest(forB)).toBe(true)
  })
  it('both the page ledger and the Control Center check the gate before every write', () => {
    expect(PAGE.match(/if \(!txnGate\.current\.isLatest\(mine\)\) return/g)?.length).toBe(3)
    expect(FCC.match(/if \(!gate\.current\.isLatest\(mine\)\) return/g)?.length).toBe(2)
    expect(PAGE).toContain('if (!append) setTransactions([])')      // a failure clears the old rows
  })
})

describe('RD-FIN-SCOPE-01 · URL vs remembered selection (established precedence)', () => {
  it('direct navigation: a valid URL event wins; else the remembered choice; else the best default', () => {
    expect(resolveSelectedEvent({ urlEventId: 'evB', storedEventId: 'evA', events: EVENTS, now: 0 })).toMatchObject({ eventId: 'evB', source: 'url' })
    expect(resolveSelectedEvent({ urlEventId: null, storedEventId: 'evA', events: EVENTS, now: 0 })).toMatchObject({ eventId: 'evA', source: 'stored' })
    expect(resolveSelectedEvent({ urlEventId: ALL_EVENTS_SELECTION, storedEventId: 'evA', events: EVENTS, now: 0 })).toMatchObject({ eventId: null, source: 'all' })
  })
  it('an inaccessible URL event is reported missing — never swapped for another event or all events', () => {
    const r = resolveSelectedEvent({ urlEventId: 'foreign', storedEventId: 'evA', events: EVENTS, now: 0 })
    expect(r).toEqual({ eventId: null, source: 'none', urlEventMissing: true })
    expect(snap({ urlEventMissing: r.urlEventMissing })).toBeNull()
  })
  it('a switch ON Finance rewrites ?eventId=, so a stale URL can never outrank the newer choice', () => {
    expect(selectionRewritesUrl('/dashboard/finance', EVENT_SCOPED_PREFIXES)).toBe(true)
    expect(selectionRewritesUrl('/dashboard/wallet', EVENT_SCOPED_PREFIXES)).toBe(true)
    expect(selectionRewritesUrl('/dashboard/settings', EVENT_SCOPED_PREFIXES)).toBe(false)
    expect(PROVIDER).toContain('if (selectionRewritesUrl(pathname, EVENT_SCOPED_PREFIXES)) {')
  })
})

describe('RD-FIN-SCOPE-01 · one selector, no second dropdown; workspace-wide figures labelled', () => {
  it('the Control Center has no event <select>; its scope comes from the page', () => {
    expect(FCC).not.toContain('aria-label="Filter by event"')
    expect(FCC).not.toContain('setEventSlug(')
    expect(FCC).toContain('scope: viewScope }: { token: string; scope: FinanceViewScope }')
    expect(PAGE).toContain('<FinanceControlCenter token={token} scope={viewScope} />')
    expect(PAGE).toContain('useEventContext()')
  })
  it('read-only scope labels; wallet / settlements / ledger titles say what they cover', () => {
    expect(PAGE).toContain('data-testid="finance-page-scope"')
    expect(FCC).toContain('data-testid="finance-scope"')
    expect(PAGE).toContain('Workspace wallet · all events.')
    expect(PAGE).toContain('title="Settlement Requests · all events"')
    expect(PAGE).toContain("'Revenue Ledger · all events'")
  })
  it('an unavailable event link shows a notice instead of data — no event-scoped section renders', () => {
    expect(PAGE).toContain('{urlEventMissing && (')
    // browser QA 2026-10-27: an empty "Revenue Ledger · all events" table rendered under the notice
    expect(PAGE).toMatch(/Revenue Ledger ── RD-FIN-SCOPE-01[\s\S]{0,300}\{viewScope && \(\s*<DashboardCard/)
    expect(PAGE).toContain('{!error && token && viewScope && <FinanceControlCenter')
  })
  it('the ledger route exports only route handlers (Next rejects other exports at build)', () => {
    expect(TX).not.toMatch(/^export const (?!dynamic|runtime|revalidate|maxDuration|fetchCache|preferredRegion)\w+/m)
  })
})

describe('RD-FIN-SCOPE-01 · server: one resolver, never widened, no new index', () => {
  it('the resolver proves ownership twice and refuses rather than widening', () => {
    expect(SCOPE).toContain('adminDb.doc(`users/${workspaceUid}/eventDrafts/${raw}`).get()')
    expect(SCOPE).toContain('resolveOwnedEventSlug(workspaceUid, raw,')
    expect(SCOPE).toContain("if (!snap.exists) return { kind: 'invalid' }")
    expect(SCOPE).toContain('status: 404')
  })
  it('both routes resolve eventId through it before reading any money', () => {
    for (const s of [TX, AN]) {
      expect(s).toContain('resolveFinanceEventScope(uid,')
      expect(s).toContain('financeScopeRefusal(')
    }
    expect(TX.indexOf('financeScopeRefusal(eventScope)')).toBeLessThan(TX.indexOf("collection('platformTransactions')"))
  })
  it('the per-event ledger read uses equality filters only (no orderBy ⇒ no composite index), bounded, truncation reported', () => {
    const ev = TX.slice(TX.indexOf('if (eventSlug) {'), TX.indexOf('} else {', TX.indexOf('if (eventSlug) {')))
    expect(ev).toContain('filteredQ.limit(EVENT_LEDGER_SCAN_CAP + 1).get()')
    expect(ev).not.toContain('orderBy(')
    expect(TX).toContain("const scopedQ = eventSlug ? baseQ.where('entityId', '==', eventSlug) : baseQ")
    expect(PAGE).toContain('setLedgerTruncated(data.scope?.truncated === true)')
  })
  it('the all-events ledger query is unchanged (same indexed orderBy); coverage is event-scoped', () => {
    expect(TX).toContain("let q = filteredQ.orderBy('paidAt', 'desc').limit(limit + 1)")
    expect(TX).toContain('loadFinanceCoverage(uid, transactions.length, eventSlug)')
  })
})

// RD-REPORT-02 · where registration figures are allowed to come from.
//
// The emulator test proves the SERVER answers correctly. This one pins the CLIENT, because
// the defect was never a wrong query — it was a correct query whose answer was ignored in
// favour of counting an array that happened to be in memory.
//
// Four rules, each one a bug that actually shipped:
//
//   1. No Reports surface may derive a total from an array length.
//   2. The hub may not read the capped endpoints it used to average over.
//   3. Unknown must not be coerced to 0.
//   4. The trend must be a slice of server rollups, not a client re-bucketing.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const TAB   = code(read('app/(dashboard)/dashboard/events/[eventId]/tabs/ReportsTab.tsx'))
const HUB   = code(read('app/(dashboard)/dashboard/reports/page.tsx'))
const SHELL = code(read('app/(dashboard)/dashboard/events/[eventId]/ManageEventClient.tsx'))
const ROUTE = code(read('app/api/organizer/events/[eventId]/registrations/route.ts'))
const LIST  = code(read('app/api/organizer/registrations/route.ts'))

// ════════════════════════════════════════════════════════════════════════════
// 1 — A TOTAL IS NEVER AN ARRAY LENGTH
// ════════════════════════════════════════════════════════════════════════════

describe('1 — no Reports figure is counted from a page', () => {
  it('the event Reports tab reads the server aggregate', () => {
    expect(TAB).toContain('const stats = data?.stats ?? null')
    expect(TAB).toContain('value={fmtCount(stats?.total)}')
    expect(TAB).toContain('value={fmtCount(stats?.confirmed)}')
    expect(TAB).toContain('value={fmtCount(stats?.cancelled)}')
    expect(TAB).toContain('value={fmtCount(stats?.pending)}')
  })

  it('the tab counts NOTHING itself', () => {
    // The precise shape of the original bug: `registrations.length`, and
    // `registrations.filter(...).length` for each status.
    expect(TAB).not.toMatch(/registrations\.length/)
    expect(TAB).not.toMatch(/registrations\s*\.filter\([^)]*\)\s*\.length/)
    expect(TAB).not.toMatch(/\.reduce\(\s*\(\s*sum/)
  })

  it('the tab no longer receives a rows array at all', () => {
    // It cannot count what it is not given. The prop is the whole response.
    expect(TAB).toContain('data:  RegistrationsApiResponse | null')
    expect(TAB).not.toMatch(/registrations:\s*SerializedRegistration\[\]/)
    // RD-REPORT-03 re-anchored the shell assertion from the exact JSX to the rule it
    // protects. The tab gained an `eventId` prop (for the BIB overview fetch), which
    // pinning the literal would have failed on — while what actually matters is that
    // `data` is passed whole and no rows array is handed over to be counted.
    expect(SHELL).toMatch(/<ReportsTab[^>]*\bdata=\{regData\}/)
    expect(SHELL).not.toMatch(/<ReportsTab[^>]*registrations=\{/)
  })

  it('the pass breakdown comes from server aggregates, not grouping', () => {
    expect(TAB).toContain('data?.passStats ?? []')
    // The old implementation built a Map and incremented it per row.
    expect(TAB).not.toMatch(/new Map</)
  })

  it('the shell asks for the shape the tab needs — aggregates, no rows', () => {
    expect(SHELL).toContain("activeTab === 'registrations' || activeTab === 'reports' ? 'summary' : 'rows'")
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 2 — THE HUB READS WHOLE-WORKSPACE FIGURES
// ════════════════════════════════════════════════════════════════════════════

describe('2 — the hub no longer averages over a capped sample', () => {
  it('it stopped reading the two capped endpoints', () => {
    // 25 events and 300 unordered rows. Neither may come back.
    expect(HUB).not.toContain("fetch('/api/organizer/events'")
    expect(HUB).not.toContain("fetch('/api/organizer/registrations'")
  })

  it('it reads the aggregate endpoint instead', () => {
    expect(HUB).toContain("'/api/organizer/dashboard'")
    expect(HUB).toContain('as DashboardData')
  })

  it('totals come from the server-resolved registration totals', () => {
    expect(HUB).toContain('data?.registrationTotals ?? null')
    expect(HUB).toContain('registrations: totals?.total ?? null')
  })

  it('event scope is resolved by the SERVER, not by filtering arrays', () => {
    expect(HUB).toContain('`/api/organizer/dashboard?eventId=${encodeURIComponent(selectedEventId)}`')
    // The old page filtered its two fetched arrays instead.
    expect(HUB).not.toMatch(/registrations\.filter\(r => r\.eventSlug/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 3 — UNKNOWN IS NOT ZERO
// ════════════════════════════════════════════════════════════════════════════

describe('3 — an unmeasured figure renders as unknown', () => {
  it('the tab has ONE formatter and it emits an em dash', () => {
    expect(TAB).toContain("typeof n === 'number' ? n.toLocaleString('en-IN') : '—'")
  })

  it('the tab does not coerce a missing stat to 0', () => {
    expect(TAB).not.toMatch(/stats\?\.\w+\s*\?\?\s*0/)
  })

  it('a rate with no denominator is withheld, not shown as 0%', () => {
    expect(TAB).toContain('if (eligible <= 0) return null')
    expect(TAB).toContain("conversion !== null ? `${conversion}%` : '—'")
  })

  it('the hub withholds a revenue total it could not fully read', () => {
    // RD-ANALYTICS-12-21 (F1) · the predicate got STRICTER, not looser. It used to withhold
    // only when a figure was withheld by permission (`null`); it now also withholds when a
    // figure was unreadable, whose `0` on the wire is a placeholder that would otherwise be
    // summed into a total presented as exact.
    // RD-ANALYTICS-12-24 · the predicate is unchanged; the field it reads was renamed to the
    // canonical `confirmedRevenuePaise`, and the expression wrapped across two lines.
    expect(HUB).toContain("e.confirmedRevenuePaise !== null && !e.revenueUnavailable")
    expect(HUB).toContain("summary.totalRevPaise !== null ? fmtINR(summary.totalRevPaise) : '—'")
  })

  it('the hub surfaces partial-read and trend failures instead of absorbing them', () => {
    expect(HUB).toContain('data.analyticsUnavailable')
    expect(HUB).toContain('data.trendUnavailable')
    expect(HUB).toContain('Trend data could not be loaded')
  })

  it('a per-pass aggregate that failed stays null on the wire', () => {
    expect(ROUTE).toContain('.catch(() => null)')
    expect(ROUTE).toContain('confirmed: number | null; cancelled: number | null')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// 4 — TRENDS AND ORDER
// ════════════════════════════════════════════════════════════════════════════

describe('4 — the trend is read, not re-derived', () => {
  it('the chart is a slice of the server rollups', () => {
    expect(HUB).toContain('function sliceTrend(')
    expect(HUB).toContain('sliceTrend(data?.trendDays ?? [], dateRange)')
  })

  it('the browser no longer buckets registrations by date itself', () => {
    expect(HUB).not.toContain('function buildBuckets')
    expect(HUB).not.toContain('function getBucketKey')
    expect(HUB).not.toMatch(/bucket\.registrations\+\+/)
  })

  it('week-over-week velocity is the server\'s resolved delta', () => {
    // RE-ANCHORED (RD-ANALYTICS-04). The INVARIANT is unchanged: the velocity claim is the
    // server's pre-resolved delta over the daily rollups, never a percentage the browser
    // computed from a sample. What moved is WHERE the rule lives — out of this page's
    // useMemo and into lib/dashboard/insights.ts, beside the pure, tested engine the
    // dashboard already used, because a rule that decides what an organizer is told does
    // not belong in a render function.
    //
    // The page is still checked for READING the server delta; the wording rule that used
    // to sit here is now checked in the engine that owns it.
    expect(HUB).toContain('data?.trendRanges?.find(r => r.days === 7)')
    expect(HUB).toContain('buildPerformanceInsights')

    const ENGINE = read('lib/dashboard/insights.ts')
    // The percentage sign is carried by the word, so the number is absolute.
    expect(ENGINE).toContain('Math.abs(delta.pct)}% more registrations')
    expect(ENGINE).toContain('Math.abs(delta.pct)}% fewer registrations')
  })

  it('no window is offered that the rollups cannot cover exactly', () => {
    // 'All' drew 12 months from 90 days of data.
    expect(HUB).toContain("type DateRange = '7d' | '30d' | '90d'")
    expect(HUB).not.toMatch(/value:\s*'all'/)
  })

  it('the participant list endpoint now has a deterministic order', () => {
    // It had `.limit(300)` with no orderBy — the first 300 by document id.
    expect(LIST).toContain(".orderBy('registeredAt', 'desc').limit(300)")
  })

  it('registeredAt is the timestamp used, not updatedAt', () => {
    // updatedAt moves when an unrelated field changes, which would silently reshape history.
    expect(LIST).toContain("orderBy('registeredAt'")
    expect(ROUTE).toContain("where('registeredAt', '>='")
    expect(ROUTE).not.toMatch(/where\('updatedAt',\s*'>='/)
  })
})

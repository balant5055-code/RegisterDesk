// RD-ANALYTICS-FAILCLOSED (2026-10-11) — the four licence figures in admin analytics fail CLOSED,
// independently: a failed query makes only its own figure null (and lists it in `unavailable`),
// never a fabricated 0. Successful results and the ID-badge exclusion are unchanged, unrelated
// metrics keep their existing behaviour, and no caller turns a null back into 0.

import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r/g, '')

type F = { field: string; value: unknown }
/** The licence queries a test can make fail. */
type Failing = 'paidCount' | 'refundedCount' | 'revenueSum' | 'discountSum' | 'badge'

/** A chainable fake Firestore. licenseOrders: 10 paid (₹500), 1 refunded, discount ₹30, badges 2 paid (₹50). */
function fakeDb(fail: Set<Failing>, opts: { zero?: boolean; precondition?: boolean } = {}) {
  // RD-PRINT-P8 (W7) — `zero`: a successful EMPTY dataset; `precondition`: failures look like Firestore's
  // missing-index answer (gRPC 9, its message quoting the query and an index-creation link).
  const err = () => opts.precondition
    ? Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index. You can create it here: https://console.firebase.google.com/v1/r/project/demo/firestore/indexes?create_composite=SECRETISH'), { code: 9 })
    : new Error('index')
  const z = (n: number) => (opts.zero ? 0 : n)
  const isLicence = (n: string) => n === 'licenseOrders'
  const has = (fs: F[], field: string, value?: unknown) => fs.some(f => f.field === field && (value === undefined || f.value === value))
  const query = (name: string, filters: F[] = []): Record<string, unknown> => ({
    where: (field: string, _op: string, value: unknown) => query(name, [...filters, { field, value }]),
    orderBy: () => query(name, filters), limit: () => query(name, filters),
    get: async () => ({ docs: [], size: 0, empty: true }),
    count: () => ({ get: async () => {
      if (isLicence(name) && has(filters, 'purpose')) { if (fail.has('badge')) throw err(); return { data: () => ({ count: z(2) }) } }
      if (isLicence(name) && has(filters, 'status', 'paid')) { if (fail.has('paidCount')) throw err(); return { data: () => ({ count: z(10) }) } }
      if (isLicence(name) && has(filters, 'status', 'refunded')) { if (fail.has('refundedCount')) throw err(); return { data: () => ({ count: z(1) }) } }
      return { data: () => ({ count: 7 }) }                                       // every unrelated count
    } }),
    aggregate: (spec: Record<string, { field?: string } & Record<string, unknown>>) => ({ get: async () => {
      const field = String((Object.values(spec)[0] as { _field?: { segments?: string[] } })?._field?.segments?.join('.') ?? JSON.stringify(spec))
      if (isLicence(name) && has(filters, 'purpose')) { if (fail.has('badge')) throw err(); return { data: () => ({ s: z(5_000) }) } }
      if (isLicence(name) && field.includes('discountPaise')) { if (fail.has('discountSum')) throw err(); return { data: () => ({ s: z(3_000) }) } }
      if (isLicence(name) && field.includes('amountPaise')) { if (fail.has('revenueSum')) throw err(); return { data: () => ({ s: z(50_000) }) } }
      return { data: () => ({ s: 123 }) }                                         // every unrelated sum
    } }),
  })
  return { collection: (name: string) => query(name), doc: () => ({ get: async () => ({ exists: false }) }), getAll: async () => [] }
}

async function analyticsWith(fail: Failing[], opts: { zero?: boolean; precondition?: boolean } = {}) {
  vi.resetModules()
  vi.doMock('@/lib/firebase/admin', () => ({ adminDb: fakeDb(new Set(fail), opts) }))
  vi.doMock('@/lib/organizer/identity', () => ({ organizersQuery: (db: { collection: (n: string) => unknown }) => db.collection('users') }))
  const { getAdminAnalytics } = await import('@/lib/analytics/adminAnalytics')
  return getAdminAnalytics()
}

afterEach(() => {
  vi.doUnmock('@/lib/firebase/admin'); vi.doUnmock('@/lib/organizer/identity')
  vi.doUnmock('@/lib/analytics/adminAnalytics'); vi.doUnmock('@/lib/admin/licenseCouponService')
  vi.doUnmock('@/lib/monitoring/sentry')
})

describe('RD-PRINT-P8 (W7) — zero vs failure vs missing index', () => {
  /** Records what reaches monitoring and the console for a run. */
  async function observed(fail: Failing[], opts: { zero?: boolean; precondition?: boolean } = {}) {
    const captured: Array<{ message: string; ctx: Record<string, unknown> }> = []
    vi.doMock('@/lib/monitoring/sentry', async orig => ({
      ...(await orig<typeof import('@/lib/monitoring/sentry')>()),
      captureError: (e: unknown, ctx: Record<string, unknown>) => { captured.push({ message: e instanceof Error ? e.message : String(e), ctx }) },
    }))
    const logs: unknown[][] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logs.push(a) })
    try { return { a: await analyticsWith(fail, opts), captured, logs } } finally { spy.mockRestore() }
  }

  it('a successful EMPTY dataset is a valid zero — shown as 0, nothing unavailable, nothing reported', async () => {
    const { a, captured } = await observed([], { zero: true })
    expect(a.licenseSales).toMatchObject({ paidCount: 0, revenuePaise: 0, discountGivenPaise: 0, refundedCount: 0, unavailable: [] })
    expect(captured).toEqual([])
  })

  it('a generic aggregate failure ⇒ that figure is null (Unavailable), tagged query_failed', async () => {
    const { a, captured } = await observed(['revenueSum'])
    expect(a.licenseSales).toMatchObject({ revenuePaise: null, unavailable: ['revenuePaise'] })
    expect(captured).toEqual([{ message: 'analytics_query_failed', ctx: { scope: 'analytics.licence_figure', figure: 'revenuePaise', tag: 'query_failed' } }])
  })

  it('a MISSING INDEX (FAILED_PRECONDITION) ⇒ null, tagged missing_index — and the raw message (query + index link) is never logged', async () => {
    const { a, captured, logs } = await observed(['revenueSum', 'discountSum'], { precondition: true })
    expect(a.licenseSales).toMatchObject({ revenuePaise: null, discountGivenPaise: null })
    expect(captured.map(c => [c.ctx.figure, c.ctx.tag]).sort()).toEqual([['discountGivenPaise', 'missing_index'], ['revenuePaise', 'missing_index']])
    expect(JSON.stringify([captured, logs])).not.toMatch(/console.firebase|create_composite|SECRETISH|requires an index/)
  })

  it('the badge exclusion failing on a missing index ⇒ paid totals unavailable, tagged on the exclusion', async () => {
    const { a, captured } = await observed(['badge'], { precondition: true })
    expect(a.licenseSales).toMatchObject({ paidCount: null, revenuePaise: null, badgeExclusion: 'unavailable' })
    expect(captured).toContainEqual({ message: 'analytics_missing_index', ctx: { scope: 'analytics.licence_figure', figure: 'badgeExclusion', tag: 'missing_index' } })
  })

  it('classification is by error code / form only', async () => {
    const { analyticsFailureKind } = await import('@/lib/analytics/adminAnalytics')
    expect(analyticsFailureKind(Object.assign(new Error('x'), { code: 9 }))).toBe('missing_index')
    expect(analyticsFailureKind(Object.assign(new Error('x'), { code: 'failed-precondition' }))).toBe('missing_index')
    expect(analyticsFailureKind(new Error('9 FAILED_PRECONDITION: The query requires an index'))).toBe('missing_index')
    expect(analyticsFailureKind(Object.assign(new Error('deadline'), { code: 4 }))).toBe('query_failed')
    expect(analyticsFailureKind('boom')).toBe('query_failed')
    expect(analyticsFailureKind(null)).toBe('query_failed')
  })
})

describe('admin analytics — licence figures fail closed, independently', () => {
  it('all queries succeed ⇒ the same figures as before (badge orders excluded)', async () => {
    const a = await analyticsWith([])
    expect(a.licenseSales).toMatchObject({
      paidCount: 8, revenuePaise: 45_000, discountGivenPaise: 3_000, refundedCount: 1,
      badgeExclusion: 'applied', unavailable: [],
    })
  })

  const cases: Array<[Failing, string, Record<string, unknown>]> = [
    ['paidCount',     'paidCount',          { paidCount: null, revenuePaise: 45_000, discountGivenPaise: 3_000, refundedCount: 1 }],
    ['revenueSum',    'revenuePaise',       { paidCount: 8, revenuePaise: null, discountGivenPaise: 3_000, refundedCount: 1 }],
    ['discountSum',   'discountGivenPaise', { paidCount: 8, revenuePaise: 45_000, discountGivenPaise: null, refundedCount: 1 }],
    ['refundedCount', 'refundedCount',      { paidCount: 8, revenuePaise: 45_000, discountGivenPaise: 3_000, refundedCount: null }],
  ]
  it.each(cases)('%s failing ⇒ ONLY that figure is null (never 0) and listed as unavailable', async (fail, figure, expected) => {
    const a = await analyticsWith([fail])
    expect(a.licenseSales).toMatchObject({ ...expected, badgeExclusion: 'applied', unavailable: [figure] })
  })

  it('the badge exclusion failing still makes paid count and revenue unavailable (unchanged P4.4 rule)', async () => {
    const a = await analyticsWith(['badge'])
    expect(a.licenseSales).toMatchObject({ paidCount: null, revenuePaise: null, discountGivenPaise: 3_000, refundedCount: 1, badgeExclusion: 'unavailable' })
    expect(a.licenseSales.unavailable.sort()).toEqual(['paidCount', 'revenuePaise'])
  })

  it('all four failing ⇒ all four null, nothing fabricated', async () => {
    const a = await analyticsWith(['paidCount', 'revenueSum', 'discountSum', 'refundedCount'])
    expect(a.licenseSales).toMatchObject({ paidCount: null, revenuePaise: null, discountGivenPaise: null, refundedCount: null })
    expect(a.licenseSales.unavailable.sort()).toEqual(['discountGivenPaise', 'paidCount', 'refundedCount', 'revenuePaise'])
  })

  it('unrelated metrics are untouched by licence failures (platform totals, comms, reminders)', async () => {
    const ok = await analyticsWith([])
    const failed = await analyticsWith(['paidCount', 'revenueSum', 'discountSum', 'refundedCount'])
    expect(failed.platform).toEqual(ok.platform)
    expect(failed.communication).toEqual(ok.communication)
    expect(failed.reminders).toEqual(ok.reminders)
    expect(failed.platform).toMatchObject({ organizers: 7, lifetimeGrossPaise: 123 })
  })

  it('the shared lenient helpers are unchanged; licence figures use only the strict ones', () => {
    const s = read('lib/analytics/adminAnalytics.ts')
    expect(s).toContain('try { return (await q.count().get()).data().count } catch { return 0 }')
    expect(s).toContain('try { return (await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0 } catch { return 0 }')
    const block = s.slice(s.indexOf('// ── License sales ──'), s.indexOf('const byTier'))
    expect(block).not.toMatch(/\b(countOf|sumOf)\(/)
    expect(block).not.toContain('equality-only queries, no index')               // the stale comment is gone
    for (const idx of ['(status, amountPaise)', '(status, discountPaise)', '(purpose, status, amountPaise)']) expect(block).toContain(idx)
  })
})

describe('callers never turn a null licence figure back into 0', () => {
  it('license centre overview: nulls stay null and the health lines say Unavailable', async () => {
    vi.resetModules()
    const countQ = { count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }), where: () => countQ, limit: () => countQ, get: async () => ({ docs: [] }) }
    vi.doMock('@/lib/firebase/admin', () => ({ adminDb: { collection: () => countQ } }))
    vi.doMock('@/lib/admin/licenseCouponService', () => ({ listCoupons: async () => [] }))
    vi.doMock('@/lib/analytics/adminAnalytics', () => ({ getAdminAnalytics: async () => ({
      licenseSales: {
        paidCount: null, refundedCount: null, revenuePaise: null, discountGivenPaise: null, byTier: [], badgeExclusion: 'applied',
        couponRedemptions: 0, topCoupons: [], byCampaign: [], unavailable: ['paidCount', 'revenuePaise', 'discountGivenPaise', 'refundedCount'],
      },
    }) }))
    const { getLicenseCenterOverview } = await import('@/lib/admin/licenseCenterService')
    const o = await getLicenseCenterOverview()
    expect(o.revenue).toMatchObject({ licenseRevenuePaise: null, paidCount: null, refundedCount: null, discountGivenPaise: null })
    const byKey = Object.fromEntries(o.health.map(h => [h.key, h.detail]))
    expect(byKey.payments).toContain('unavailable')
    expect(byKey.revenue).toMatch(/^Unavailable/)
    expect(byKey.discount_budget).toMatch(/^Unavailable/)
    expect(JSON.stringify(o.health)).not.toMatch(/₹0 given|null/)
  })

  it('no `?? 0` (or similar) on the four figures anywhere they are consumed; UIs render Unavailable', () => {
    const svc = read('lib/admin/licenseCenterService.ts')
    expect(svc).not.toMatch(/sales\?\.(revenuePaise|paidCount|refundedCount|discountGivenPaise) \?\? 0/)
    const pm = read('lib/admin/platformMonitorService.ts')
    expect(pm).not.toMatch(/(paidCount|refundedCount|revenuePaise|discountGivenPaise) \?\? 0/)
    const lc = read('app/(admin)/admin/license-center/PageClient.tsx')
    expect(lc).toContain("o.revenue.discountGivenPaise === null ? 'Unavailable'")
    expect(lc).toContain("ls.refundedCount === null ? 'Unavailable'")
    expect(lc).toContain("ls.discountGivenPaise === null ? 'Unavailable'")
    expect(read('app/(admin)/admin/analytics/PageClient.tsx')).toContain("data.licenseSales.refundedCount ?? 'Unavailable'")
  })
})

// ── Health indicators with partially unavailable licence figures (2026-10-11 follow-up) ──────────
type Sales = { paidCount: number | null; revenuePaise: number | null; refundedCount: number | null; discountGivenPaise: number | null }
const salesOf = (s: Partial<Sales>) => ({
  paidCount: 8, revenuePaise: 45_000, refundedCount: 1, discountGivenPaise: 3_000, ...s,
  byTier: [], badgeExclusion: 'applied', couponRedemptions: 0, topCoupons: [], byCampaign: [], unavailable: [],
})
const countQ: Record<string, unknown> = {
  count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }),
  aggregate: () => ({ get: async () => ({ data: () => ({}) }) }),
  where: () => countQ, orderBy: () => countQ, limit: () => countQ, get: async () => ({ docs: [], size: 0, empty: true }),
}

async function servicesWith(sales: ReturnType<typeof salesOf> | null) {
  vi.resetModules()
  vi.doMock('@/lib/firebase/admin', () => ({ adminDb: { collection: () => countQ } }))
  vi.doMock('@/lib/analytics/adminAnalytics', () => ({ getAdminAnalytics: async () => (sales ? { licenseSales: sales } : null) }))
  vi.doMock('@/lib/analytics/adminCommunications', () => ({ getAdminCommunications: async () => null }))
  vi.doMock('@/lib/admin/operationsCenterService', () => ({ ENGINES: [] }))
  const { getPlatformServices } = await import('@/lib/admin/platformMonitorService')
  const out = await getPlatformServices()
  vi.doUnmock('@/lib/analytics/adminCommunications'); vi.doUnmock('@/lib/admin/operationsCenterService')
  return Object.fromEntries(out.map(s => [s.key, s]))
}

async function discountBudgetWith(sales: ReturnType<typeof salesOf>) {
  vi.resetModules()
  vi.doMock('@/lib/firebase/admin', () => ({ adminDb: { collection: () => countQ } }))
  vi.doMock('@/lib/admin/licenseCouponService', () => ({ listCoupons: async () => [] }))
  vi.doMock('@/lib/analytics/adminAnalytics', () => ({ getAdminAnalytics: async () => ({ licenseSales: sales }) }))
  const { getLicenseCenterOverview } = await import('@/lib/admin/licenseCenterService')
  return (await getLicenseCenterOverview()).health.find(h => h.key === 'discount_budget')!
}

describe('platform monitor — Payments tile', () => {
  it('all figures available: unchanged (healthy; warning when refunds exceed paid; unavailable at ₹0 revenue)', async () => {
    expect((await servicesWith(salesOf({}))).payments).toMatchObject({ level: 'healthy', detail: '8 paid · 1 refunded', metric: '₹450' })
    expect((await servicesWith(salesOf({ refundedCount: 9 }))).payments).toMatchObject({ level: 'warning', detail: '8 paid · 9 refunded' })
    expect((await servicesWith(salesOf({ revenuePaise: 0 }))).payments).toMatchObject({ level: 'unavailable', metric: '₹0' })
  })
  it('refunded count unavailable ⇒ warning, never healthy, and says so', async () => {
    expect((await servicesWith(salesOf({ refundedCount: null }))).payments).toMatchObject({ level: 'warning', detail: '8 paid · refunded count unavailable', metric: '₹450' })
  })
})

describe('platform monitor — Licensing tile (paid count and revenue judged independently)', () => {
  it('all figures available: unchanged', async () => {
    expect((await servicesWith(salesOf({}))).licensing).toMatchObject({ level: 'healthy', detail: '8 paid licenses', metric: '8' })
    expect((await servicesWith(salesOf({ paidCount: 0 }))).licensing).toMatchObject({ level: 'unavailable', detail: '0 paid licenses', metric: null })
  })
  it('revenue unavailable, paid known ⇒ the paid count is still shown, as a warning naming the missing revenue', async () => {
    const t = (await servicesWith(salesOf({ revenuePaise: null }))).licensing
    expect(t).toMatchObject({ level: 'warning', detail: '8 paid licenses · revenue unavailable', metric: '8' })
    expect(JSON.stringify(t)).not.toContain('₹0')
  })
  it('paid count unavailable ⇒ warning, never a 0', async () => {
    const t = (await servicesWith(salesOf({ paidCount: null }))).licensing
    expect(t).toMatchObject({ level: 'warning', detail: 'Paid licence count unavailable', metric: null })
  })
  it('no analytics at all ⇒ unavailable, as before', async () => {
    expect((await servicesWith(null)).licensing).toMatchObject({ level: 'unavailable', detail: 'Unavailable' })
  })
})

describe('license centre — Discount Budget indicator', () => {
  it('revenue and discount available: unchanged (ratio and colour)', async () => {
    expect(await discountBudgetWith(salesOf({}))).toMatchObject({ level: 'green', detail: '₹30 given (6%)' })
    expect(await discountBudgetWith(salesOf({ revenuePaise: 10_000, discountGivenPaise: 20_000 }))).toMatchObject({ level: 'yellow', detail: '₹200 given (67%)' })
  })
  it('revenue unavailable ⇒ yellow, the percentage shown as Unavailable — never 0%', async () => {
    const h = await discountBudgetWith(salesOf({ revenuePaise: null }))
    expect(h).toMatchObject({ level: 'yellow', detail: '₹30 given (% of revenue: Unavailable)' })
    expect(h.detail).not.toContain('0%')
  })
  it('₹0 revenue with a positive discount ⇒ yellow, percentage Unavailable — never "(0%)"', async () => {
    const h = await discountBudgetWith(salesOf({ revenuePaise: 0, discountGivenPaise: 349_800 }))
    expect(h).toMatchObject({ level: 'yellow', detail: '₹3,498 given (% of revenue: Unavailable)' })
    expect(h.detail).not.toContain('(0%)')
  })
  it('₹0 revenue with ₹0 discount ⇒ unchanged (green, 0%)', async () => {
    expect(await discountBudgetWith(salesOf({ revenuePaise: 0, discountGivenPaise: 0 }))).toMatchObject({ level: 'green', detail: '₹0 given (0%)' })
  })
  it('discount unavailable ⇒ yellow Unavailable (unchanged)', async () => {
    expect(await discountBudgetWith(salesOf({ discountGivenPaise: null }))).toMatchObject({ level: 'yellow', detail: 'Unavailable — discount given could not be read' })
  })
})

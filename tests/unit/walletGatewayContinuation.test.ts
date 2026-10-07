// RD-WALLET-W2.d · G1/G2 — gateway evidence continuation. The service runs against an in-memory
// Firestore double and a stubbed S2 page (no emulator, no network); the console's continuation
// logic is the pure ./gatewayProgress module. Live gateway: still none — mock provider only.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({
  topups: new Map<string, Record<string, unknown>>(),
  pages:  new Map<string | null, { ids: string[]; nextCursor: string | null }>(),
  reads:  0,
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    doc: (path: string) => ({ path }),
    getAll: async (...refs: Array<{ path: string }>) => {
      h.reads += refs.length
      return refs.map(r => {
        const [col, id] = r.path.split('/')
        const d = col === 'walletTopups' ? h.topups.get(id) : undefined
        return { exists: !!d, data: () => d }
      })
    },
  },
}))
vi.mock('@/lib/reconciliation/walletTopups', async orig => ({
  ...(await orig<typeof import('@/lib/reconciliation/walletTopups')>()),
  // One S2 page of flagged top-ups per cursor (the real collector is covered by its own suites).
  reconcileTopupsPage: async ({ cursor }: { cursor?: string | null }) => {
    const p = h.pages.get(cursor ?? null) ?? { ids: [], nextCursor: null }
    return {
      findings: p.ids.map(orderId => ({ scope: 'topup', orderId, uid: 'u1', code: 'topup_stale_pending', confidence: 'inconclusive' })),
      scanned: p.ids.length, deferred: 0, nextCursor: p.nextCursor, complete: p.nextCursor === null, truncated: false,
    }
  },
}))

const { getReconciliationPage, isSafeId } = await import('@/lib/admin/walletManagementService')
const { createMockGatewayProvider, GATEWAY_REPORT_LIMITS } = await import('@/lib/reconciliation/walletTopupsGateway')
const {
  GATEWAY_START, gatewayRequestParams, nextGatewayPosition, mergeGatewayProgress, gatewayProgressText,
} = await import('@/app/(admin)/admin/wallet-management/gatewayProgress')
type Provider = import('@/lib/reconciliation/walletTopupsGateway').GatewayEvidenceProvider
type PageReport = import('@/lib/admin/walletManagementService').GatewayPageReport

const ids = (n: number, prefix = 'o') => Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(2, '0')}`)
const seed = (orderIds: string[]) => { for (const id of orderIds) h.topups.set(id, { uid: 'u1', amountPaise: 50_000, currency: 'INR', status: 'pending' }) }
/** A mock whose every order has an empty payment list (one call per pending order). */
const emptyLists = (orderIds: string[]) => createMockGatewayProvider({ orderPayments: Object.fromEntries(orderIds.map(id => [id, { items: [] }])) })
const run = async (provider: Provider | undefined, gatewayAfter: string | null, cursor: string | null = null) => {
  const page = await getReconciliationPage({ kind: 'topups', gateway: true, gatewayAfter, cursor }, provider ? { gatewayProvider: provider } : {})
  return page as typeof page & { gateway: PageReport; nextCursor: string | null }
}
const orderOf = (call: string) => call.split(':')[1]

beforeEach(() => { h.topups.clear(); h.pages.clear(); h.reads = 0 })

describe('G1 · server-side continuation', () => {
  it('25 flagged orders are all reachable in three manual requests — 10, 10, 5 — each checked exactly once', async () => {
    const all = ids(25); seed(all); h.pages.set(null, { ids: all, nextCursor: null })
    const mock = emptyLists(all)
    const r1 = (await run(mock, null)).gateway
    expect(r1).toMatchObject({ checked: 10, missing: 0, deferred: 15, pageCandidates: 25, pageComplete: false, nextAfter: 'o10' })
    const r2 = (await run(mock, r1.nextAfter)).gateway
    expect(r2).toMatchObject({ checked: 10, deferred: 5, pageCandidates: 15, pageComplete: false, nextAfter: 'o20' })
    const r3 = (await run(mock, r2.nextAfter)).gateway
    expect(r3).toMatchObject({ checked: 5, deferred: 0, pageCandidates: 5, pageComplete: true, nextAfter: null })
    expect(mock.calls.map(orderOf)).toEqual(all)                            // every order once, in order, none twice
    for (const r of [r1, r2, r3]) {
      expect(r.checked + r.missing + r.deferred).toBe(r.pageCandidates)
      expect(r.calls).toBeLessThanOrEqual(GATEWAY_REPORT_LIMITS.maxCalls)
      expect(r.checked).toBeLessThanOrEqual(GATEWAY_REPORT_LIMITS.maxOrders)
    }
  })

  it('an early DEADLINE stop resumes at the first unchecked order', async () => {
    const all = ids(12); seed(all); h.pages.set(null, { ids: all, nextCursor: null })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = emptyLists(all)
      const slow = { ...base, orderPayments: async (id: string) => { vi.setSystemTime(Date.now() + 7_000); return base.orderPayments(id) } }
      const r1 = (await run(slow, null)).gateway                             // 20 s: o01 (13 s left), o02 (6 s left) → stop
      expect(r1).toMatchObject({ checked: 2, pageComplete: false, nextAfter: 'o02', deferred: 10 })
      const r2 = (await run(slow, r1.nextAfter)).gateway
      expect(base.calls.map(orderOf)).toEqual(['o01', 'o02', 'o03', 'o04'])
      expect(r2.nextAfter).toBe('o04')
    } finally { vi.useRealTimers() }
  })

  it('an early CIRCUIT-BREAKER stop resumes at the first unchecked order', async () => {
    const all = ids(8); seed(all); h.pages.set(null, { ids: all, nextCursor: null })
    const failing = createMockGatewayProvider({ orderPayments: Object.fromEntries(all.map(id => [id, 'provider_error'])) })
    const r1 = (await run(failing, null)).gateway
    expect(r1).toMatchObject({ circuitOpen: true, checked: 3, nextAfter: 'o03', pageComplete: false })
    for (const f of r1.findings) expect(f.confidence).toBe('inconclusive')
    const healthy = emptyLists(all)
    const r2 = (await run(healthy, r1.nextAfter)).gateway
    expect(healthy.calls.map(orderOf)).toEqual(all.slice(3))               // o04 … o08: none skipped, none repeated
    expect(r2).toMatchObject({ checked: 5, pageComplete: true, nextAfter: null })
  })

  it('a missing top-up document never corrupts the position', async () => {
    const all = ids(14); seed(all.filter(id => id !== 'o02' && id !== 'o10')); h.pages.set(null, { ids: all, nextCursor: null })
    const mock = emptyLists(all)
    const r1 = (await run(mock, null)).gateway
    expect(r1).toMatchObject({ checked: 8, missing: 2, deferred: 4, nextAfter: 'o10', pageComplete: false })
    const r2 = (await run(mock, r1.nextAfter)).gateway
    expect(r2).toMatchObject({ checked: 4, missing: 0, pageComplete: true, nextAfter: null })
    expect(mock.calls.map(orderOf)).toEqual(all.filter(id => id !== 'o02' && id !== 'o10'))
  })

  it('… including a missing document right where an early stop happens', async () => {
    const all = ids(6); seed(all.filter(id => id !== 'o03')); h.pages.set(null, { ids: all, nextCursor: null })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const base = emptyLists(all)
      const slow = { ...base, orderPayments: async (id: string) => { vi.setSystemTime(Date.now() + 7_000); return base.orderPayments(id) } }
      const r1 = (await run(slow, null)).gateway                             // o01, o02 checked; o03 missing; stop before o04
      expect(r1).toMatchObject({ checked: 2, missing: 1, nextAfter: 'o03', deferred: 3 })
      await run(slow, r1.nextAfter)
      expect(base.calls.map(orderOf).slice(0, 3)).toEqual(['o01', 'o02', 'o04'])
    } finally { vi.useRealTimers() }
  })

  it('an invalid gatewayAfter is ignored (the batch starts at the first candidate)', async () => {
    const all = ids(3); seed(all); h.pages.set(null, { ids: all, nextCursor: null })
    for (const bad of ['o01/../x', '', 'a b', 'x'.repeat(200)]) {
      const mock = emptyLists(all)
      const r = (await run(mock, bad)).gateway
      expect(mock.calls.map(orderOf)).toEqual(all)
      expect(r).toMatchObject({ pageCandidates: 3, checked: 3, pageComplete: true })
    }
  })

  it('a gatewayAfter beyond every candidate checks nothing and reports the page complete', async () => {
    const all = ids(3); seed(all); h.pages.set(null, { ids: all, nextCursor: null })
    const mock = emptyLists(all)
    const r = (await run(mock, 'zz')).gateway
    expect(mock.calls).toEqual([])
    expect(r).toMatchObject({ checked: 0, calls: 0, pageCandidates: 0, deferred: 0, pageComplete: true, nextAfter: null })
    expect(h.reads).toBe(0)
  })

  it('the DISABLED provider (production) reads and calls nothing, whatever gatewayAfter is', async () => {
    const all = ids(12); seed(all); h.pages.set(null, { ids: all, nextCursor: null })
    for (const after of [null, 'o05', 'zz', 'bad/id']) {
      h.reads = 0
      const r = (await run(undefined, after)).gateway
      expect(h.reads).toBe(0)
      expect(r).toMatchObject({ enabled: false, source: 'disabled', reason: 'gateway_verification_not_enabled', checked: 0, calls: 0, findings: [] })
    }
  })
})

describe('G2 · console continuation (pure)', () => {
  const report = (over: Partial<PageReport> = {}): PageReport => ({
    enabled: true, source: 'mock', reason: null, findings: [], checked: 0, creditsVerified: 0, deferred: 0, calls: 0,
    circuitOpen: false, pageCandidates: 0, missing: 0, pageComplete: true, nextAfter: null, pageUnverifiable: 0, ...over,
  })
  const finding = (orderId: string, code: string, paymentId?: string) =>
    ({ scope: 'gateway' as const, source: 'mock' as const, orderId, code: code as PageReport['findings'][number]['code'], confidence: 'confirmed' as const, ...(paymentId ? { detail: { paymentId } } : {}) })

  it('"Check gateway evidence" starts at the first page, first order', () => {
    expect(gatewayRequestParams(GATEWAY_START)).toEqual({ view: 'reconciliation', kind: 'topups', gateway: '1', cursor: null, gatewayAfter: null })
  })
  it('"Check next" stays on the same reconciliation page with gatewayAfter while candidates remain', () => {
    const pos = { cursor: 'o30', after: 'o35' }
    const next = nextGatewayPosition(pos, report({ pageComplete: false, nextAfter: 'o45' }), 'o99')
    expect(next).toEqual({ cursor: 'o30', after: 'o45' })
    expect(gatewayRequestParams(next!)).toMatchObject({ cursor: 'o30', gatewayAfter: 'o45' })
  })
  it('… retries the same position when nothing on the page could be checked (early stop at its start)', () => {
    expect(nextGatewayPosition({ cursor: 'o30', after: null }, report({ pageComplete: false, nextAfter: null }), 'o99')).toEqual({ cursor: 'o30', after: null })
  })
  it('… then moves to the next reconciliation page via nextCursor, and stops when the scan is complete', () => {
    expect(nextGatewayPosition({ cursor: 'o30', after: 'o45' }, report({ pageComplete: true }), 'o99')).toEqual({ cursor: 'o99', after: null })
    expect(nextGatewayPosition({ cursor: 'o99', after: null }, report({ pageComplete: true }), null)).toBeNull()
  })
  it('the disabled provider never offers a continuation', () => {
    expect(nextGatewayPosition(GATEWAY_START, report({ enabled: false, source: 'disabled', pageComplete: false, nextAfter: null, pageCandidates: 5 }), 'o99')).toBeNull()
  })
  it('findings are de-duplicated by order + code across requests; checked counts add without overlap', () => {
    const p1 = mergeGatewayProgress(null, GATEWAY_START, report({ checked: 10, pageComplete: false, nextAfter: 'o10',
      findings: [finding('o01', 'gateway_amount_mismatch', 'p1'), finding('o01', 'gateway_amount_mismatch', 'p2'), finding('o02', 'gateway_multiple_captured')] }), null)
    expect(p1.findings).toHaveLength(3)                                     // two mismatched payments in ONE answer are both kept
    const p2 = mergeGatewayProgress(p1, p1.next!, report({ checked: 4, missing: 1,
      findings: [finding('o01', 'gateway_amount_mismatch', 'p1'), finding('o11', 'gateway_captured_without_credit')] }), null)
    expect(p2.findings.map(f => `${f.orderId}:${f.code}`)).toEqual([
      'o01:gateway_amount_mismatch', 'o01:gateway_amount_mismatch', 'o02:gateway_multiple_captured', 'o11:gateway_captured_without_credit',
    ])
    expect(p2).toMatchObject({ checked: 14, missing: 1, next: null })
  })
  it('progress wording reports what was checked — never "verified" or "clean"', () => {
    const more = mergeGatewayProgress(null, GATEWAY_START, report({ checked: 10, pageComplete: false, nextAfter: 'o10' }), null)
    const done = mergeGatewayProgress(null, GATEWAY_START, report({ checked: 3, missing: 1 }), null)
    const tripped = mergeGatewayProgress(null, GATEWAY_START, report({ checked: 3, circuitOpen: true, pageComplete: false, nextAfter: 'o03' }), null)
    expect(gatewayProgressText(more)).toBe('Flagged orders checked so far: 10 · more flagged orders to check')
    expect(gatewayProgressText(done)).toBe('Flagged orders checked so far: 3 · 1 no longer on record · no flagged orders left to check in the records scanned')
    expect(gatewayProgressText(tripped)).toContain('stopped after repeated failures')
    for (const p of [more, done, tripped]) expect(gatewayProgressText(p)).not.toMatch(/verified|clean/i)
  })
})

describe('F3 · unusable order ids are counted and reported — never sent, read, verified or used as a position', () => {
  const UNSAFE = ['bad id', 'x/y', 'z'.repeat(200)]                         // space, slash, too long — all fail isSafeId
  const unverifiable = (r: PageReport) => r.findings.filter(f => f.code === 'gateway_order_id_unverifiable')

  it('a mixed page: only safe ids reach the gateway / Firestore; unsafe ones are an inconclusive finding on the page’s FIRST request, counted on every request', async () => {
    const safe = ids(12); seed(safe); h.pages.set(null, { ids: [...safe.slice(0, 5), ...UNSAFE, ...safe.slice(5)], nextCursor: null })
    const mock = emptyLists(safe)
    const r1 = (await run(mock, null)).gateway
    expect(r1).toMatchObject({ checked: 10, pageCandidates: 12, deferred: 2, missing: 0, pageComplete: false, nextAfter: 'o10', pageUnverifiable: 3 })
    expect(unverifiable(r1).map(f => [f.orderId, f.confidence, f.detail])).toEqual([
      ['bad id', 'inconclusive', { reason: 'order_id_not_usable' }],
      ['x/y', 'inconclusive', { reason: 'order_id_not_usable' }],
      ['z'.repeat(200), 'inconclusive', { reason: 'order_id_not_usable' }],
    ])
    expect(h.reads).toBe(20)                                                   // 10 safe ids × (topup + record) — no unsafe read
    const r2 = (await run(mock, r1.nextAfter)).gateway
    expect(r2).toMatchObject({ checked: 2, pageCandidates: 2, pageComplete: true, nextAfter: null, pageUnverifiable: 3 })
    expect(unverifiable(r2)).toEqual([])                                       // not repeated on a continuation
    expect(mock.calls.map(orderOf)).toEqual(safe)                              // every safe id once; no unsafe id ever sent
    for (const r of [r1, r2]) expect(r.checked + r.missing + r.deferred).toBe(r.pageCandidates)
  })

  it('a page of ONLY unusable ids: nothing checked, nothing called or read; complete for checking, yet never reported as verified', async () => {
    h.pages.set(null, { ids: UNSAFE.slice(0, 2), nextCursor: null })
    const mock = emptyLists([])
    const page = await run(mock, null)
    expect(page.gateway).toMatchObject({ checked: 0, calls: 0, creditsVerified: 0, pageCandidates: 0, pageComplete: true, nextAfter: null, pageUnverifiable: 2 })
    expect(unverifiable(page.gateway)).toHaveLength(2)
    expect(mock.calls).toEqual([])
    expect(h.reads).toBe(0)
    const progress = mergeGatewayProgress(null, GATEWAY_START, page.gateway, page.nextCursor)
    expect(progress.unverifiable).toBe(2)
    expect(gatewayProgressText(progress)).toBe('Flagged orders checked so far: 0 · 2 could not be checked (unusable order id) · no flagged orders left to check in the records scanned')
    expect(gatewayProgressText(progress)).not.toMatch(/verified|clean/i)
  })

  it('safe ids only: unchanged (no unverifiable finding, count 0)', async () => {
    const safe = ids(3); seed(safe); h.pages.set(null, { ids: safe, nextCursor: null })
    const r = (await run(emptyLists(safe), null)).gateway
    expect(r).toMatchObject({ checked: 3, pageUnverifiable: 0, pageComplete: true })
    expect(unverifiable(r)).toEqual([])
  })

  it('the DISABLED provider still counts unusable ids — and still makes no finding, read or call', async () => {
    const safe = ids(4); seed(safe); h.pages.set(null, { ids: [...safe, ...UNSAFE], nextCursor: null })
    const r = (await run(undefined, null)).gateway
    expect(r).toMatchObject({ enabled: false, source: 'disabled', checked: 0, calls: 0, findings: [], pageCandidates: 4, deferred: 4, pageUnverifiable: 3 })
    expect(h.reads).toBe(0)
  })

  it('an early stop (circuit breaker) never resumes at an unusable id', async () => {
    const safe = ids(6); seed(safe); h.pages.set(null, { ids: ['bad id', ...safe, 'x/y'], nextCursor: null })
    const failing = createMockGatewayProvider({ orderPayments: Object.fromEntries(safe.map(id => [id, 'provider_error'])) })
    const r = (await run(failing, null)).gateway
    expect(r).toMatchObject({ circuitOpen: true, checked: 3, nextAfter: 'o03', pageComplete: false, pageUnverifiable: 2 })
    expect(failing.calls.map(orderOf)).toEqual(['o01', 'o02', 'o03'])
  })

  it('across pages: every "Check next" position is a usable id, every safe id is checked once, and each unusable id is counted once — even if a page is re-requested from its start', async () => {
    const p1 = ids(12, 'a'), p2 = ids(5, 'b'); seed([...p1, ...p2])
    h.pages.set(null, { ids: [...p1, 'bad id'], nextCursor: 'a12' })
    h.pages.set('a12', { ids: ['x/y', ...p2], nextCursor: null })
    const mock = emptyLists([...p1, ...p2])
    let pos: { cursor: string | null; after: string | null } | null = GATEWAY_START
    let progress: ReturnType<typeof mergeGatewayProgress> | null = null
    const positions: Array<string | null> = []
    for (let n = 0; pos && n < 20; n++) {
      const page = await run(mock, pos.after, pos.cursor)
      progress = mergeGatewayProgress(progress, pos, page.gateway, page.nextCursor)
      pos = progress.next
      if (pos) positions.push(pos.after)
    }
    expect(pos).toBeNull()
    for (const a of positions) if (a !== null) expect(isSafeId(a), a).toBe(true)
    expect(mock.calls.map(orderOf)).toEqual([...p1, ...p2])
    expect(progress).toMatchObject({ checked: 17, unverifiable: 2 })

    // a retry from the start of page 1 reports its unusable id again — counted once
    const again = await run(mock, null, null)
    const merged = mergeGatewayProgress(progress, GATEWAY_START, again.gateway, again.nextCursor)
    expect(merged.unverifiable).toBe(2)
  })
})

describe('G1–G3 · structural', () => {
  const code = (p: string) => readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  const route = code('app/api/admin/wallet-management/route.ts')
  const ui = code('app/(admin)/admin/wallet-management/PageClient.tsx')
  it('G3 · the route declares maxDuration = 60', () => {
    expect(route).toMatch(/^export const maxDuration = 60\r?$/m)
  })
  it('G1 · the route passes gatewayAfter as the raw query string — and never a provider', () => {
    expect(route).toContain("gatewayAfter: p.get('gatewayAfter')")
    expect(route).not.toMatch(/gatewayProvider|createMockGatewayProvider|walletTopupsGateway/)
  })
  it('G2 · a scope change outdates in-flight answers and clears the accumulated state', () => {
    expect(ui).toContain('onChange={changeKind}')
    expect(ui).toMatch(/const changeKind = \(k: ReconKind\) => \{\s*gatewayRun\.current\+\+\s*setGateway\(null\); setGatewayError\(null\); setGatewayLoading\(false\)/)
    expect(ui).toContain('if (run !== gatewayRun.current) return')
  })
  it('G2 · "Check next" is manual and only offered for enabled evidence', () => {
    expect(ui).toContain('const canContinue = !!(report?.enabled && onNext)')
    expect(ui).toContain('onNext={gateway?.next ? () => runGateway(gateway.next!, gateway) : null}')
    expect(ui).not.toMatch(/useEffect\([^\n]*runGateway/)                   // never from an effect
    expect((ui.match(/runGateway\(/g) ?? []).length).toBe(2)                // only the two button handlers call it
  })
})

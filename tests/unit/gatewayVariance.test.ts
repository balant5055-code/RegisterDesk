// RD-FEE-04 — Razorpay gateway variance: the pure arithmetic and the Super Admin gate.
//
// Variance = Σ frozen estimate − Σ Razorpay actual, over ONLY the rows that carry an actual.
// A row without an actual is never an actual of ₹0. Reporting only — nothing writes.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resolveGatewayVariance, type CoveredGatewayRows } from '@/lib/finance/gatewayFee'

const covered = (count: number, est: number, act: number, tax = 0): CoveredGatewayRows =>
  ({ count, sums: { gatewayFeeEstimatePaise: est, gatewayFeeActualPaise: act, gatewayTaxPaise: tax } })

describe('resolveGatewayVariance (pure)', () => {
  it('1 · estimate only — no Razorpay fee yet: nothing is compared, nothing reads as ₹0', () => {
    const v = resolveGatewayVariance({ total: 4, estimateAll: 8_000, covered: covered(0, 0, 0) })
    expect(v.reconciled).toBe(0)
    expect(v.actual).toEqual({ ok: false, reason: 'no_authoritative_field' })
    expect(v.variance).toEqual({ ok: false, reason: 'no_authoritative_field' })
    expect(v.estimatedAwaiting).toEqual({ ok: true, paise: 8_000 })
    expect(v.basis).toBe('estimated')
  })

  it('2/3 · every payment reconciled: estimate vs actual over the same rows (the ₹8,350.30 / ₹8,162.65 example)', () => {
    const v = resolveGatewayVariance({ total: 775, estimateAll: 835_030, covered: covered(775, 835_030, 816_265, 124_515) })
    expect(v.basis).toBe('actual')
    expect(v.estimatedReconciled).toEqual({ ok: true, paise: 835_030 })
    expect(v.actual).toEqual({ ok: true, paise: 816_265 })
    expect(v.variance).toEqual({ ok: true, paise: 18_765 })              // +₹187.65
    expect(v.actualTax).toEqual({ ok: true, paise: 124_515 })           // inside actual, not added
    expect(v.estimatedAwaiting).toEqual({ ok: true, paise: 0 })
  })

  it('4/5/6 · positive, negative and zero variance', () => {
    expect(resolveGatewayVariance({ total: 1, estimateAll: 2_000, covered: covered(1, 2_000, 1_960) }).variance).toEqual({ ok: true, paise: 40 })
    expect(resolveGatewayVariance({ total: 1, estimateAll: 2_000, covered: covered(1, 2_000, 2_360) }).variance).toEqual({ ok: true, paise: -360 })
    expect(resolveGatewayVariance({ total: 1, estimateAll: 2_000, covered: covered(1, 2_000, 2_000) }).variance).toEqual({ ok: true, paise: 0 })
  })

  it('7/8 · mixed: only the reconciled population is compared; the rest is "awaiting", never ₹0', () => {
    // 800 payments, 775 reconciled. The 25 unreconciled carry ₹500 of estimate between them.
    const v = resolveGatewayVariance({ total: 800, estimateAll: 835_030 + 50_000, covered: covered(775, 835_030, 816_265) })
    expect(v.basis).toBe('mixed')
    expect([v.reconciled, v.transactions]).toEqual([775, 800])
    expect(v.variance).toEqual({ ok: true, paise: 18_765 })              // NOT inflated by the 25
    expect(v.estimatedAwaiting).toEqual({ ok: true, paise: 50_000 })
    expect(v.estimatedAll).toEqual({ ok: true, paise: 885_030 })
  })

  it('an unavailable read says why, and never produces a figure', () => {
    for (const why of ['requires_index', 'out_of_budget', 'query_failed'] as const) {
      const v = resolveGatewayVariance({ total: null, estimateAll: null, covered: null, coveredUnavailable: why })
      expect(v.variance).toEqual({ ok: false, reason: why })
      expect(v.actual).toEqual({ ok: false, reason: why })
    }
  })
})

// ─── The API gate ────────────────────────────────────────────────────────────

const auth = vi.hoisted(() => ({ superUid: null as string | null, legacy: false, scopes: [] as unknown[] }))
vi.mock('@/lib/admin/auth', () => ({
  resolveSuperAdminUid: async () => auth.superUid,
  legacyAdminClaimOnly:  async () => auth.legacy,
}))
vi.mock('@/lib/finance/financeAnalytics', () => ({
  getGatewayVariance: async (scope: unknown) => { auth.scopes.push(scope); return resolveGatewayVariance({ total: 0, estimateAll: 0, covered: covered(0, 0, 0) }) },
}))
vi.mock('@/lib/firebase/admin', () => ({
  adminDb: { collection: () => ({ doc: (id: string) => ({ get: async () => ({ exists: id === 'evt-a', data: () => ({ uid: 'org-A' }) }) }) }) },
}))

const call = async (qs = '') => {
  const { GET } = await import('@/app/api/admin/finance/gateway-variance/route')
  const req = new Request(`http://localhost/api/admin/finance/gateway-variance${qs}`, { headers: { authorization: 'Bearer t' } })
  Object.assign(req, { nextUrl: new URL(req.url) })
  const res = await GET(req as never)
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('GET /api/admin/finance/gateway-variance — Super Admin only', () => {
  beforeEach(() => { auth.superUid = null; auth.legacy = false; auth.scopes = [] })

  it('13 · a Super Admin (ADMIN_UIDS) gets the platform-wide figure', async () => {
    auth.superUid = 'super-1'
    const r = await call()
    expect(r.status).toBe(200)
    expect(r.body.scope).toEqual({ kind: 'platform' })
    expect(auth.scopes).toEqual([{ kind: 'platform' }])
  })

  it('14 · an organizer (no ADMIN_UIDS) is refused, and nothing is read', async () => {
    const r = await call()
    expect(r.status).toBe(403)
    expect(auth.scopes).toEqual([])
  })

  it('a legacy admin:true claim alone is refused too (SUPER_ADMIN_REQUIRED)', async () => {
    auth.legacy = true
    const r = await call()
    expect(r.status).toBe(403)
    expect(r.body.code).toBe('SUPER_ADMIN_REQUIRED')
  })

  it('event scope resolves the OWNER server-side (the index scope); unknown events 404; bad ids 400', async () => {
    auth.superUid = 'super-1'
    const r = await call('?eventSlug=evt-a')
    expect(r.body.scope).toEqual({ kind: 'event', eventSlug: 'evt-a', organizerUid: 'org-A' })
    expect(auth.scopes).toEqual([{ kind: 'organizer', organizerUid: 'org-A', eventSlug: 'evt-a' }])
    expect((await call('?eventSlug=missing')).status).toBe(404)
    expect((await call('?eventSlug=../x')).status).toBe(400)
  })

  it('the route is read-only: GET is the only handler', async () => {
    const mod = await import('@/app/api/admin/finance/gateway-variance/route') as Record<string, unknown>
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(mod[verb]).toBeUndefined()
  })
})

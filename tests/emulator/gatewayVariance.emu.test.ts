// RD-FEE-04 — Razorpay gateway variance over REAL ledger rows (Firestore emulator).
//
// Runs in its OWN emulator project: the platform-wide figure reads every platformTransactions row,
// so it must not see (or be polluted by) any other suite's data.
//
// Seed — two organizers, three events, rows with and without Razorpay's actual fee:
//   org-A / evt-a1   r1  est ₹20.00  actual ₹19.60 (tax ₹2.99)   paid 2025-03
//                    r2  est ₹10.00  — awaiting —               paid 2026-09
//   org-A / evt-a2   r3  est ₹40.00  actual ₹44.00 (tax ₹6.71)   paid 2026-10
//   org-B / evt-b1   r4  est ₹5.00   actual ₹5.00  (tax ₹0.76)   paid 2026-10

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip
const OWN_PROJECT = 'demo-registerdesk-gateway-variance'
const T = 120_000

type Row = { id: string; org: string; evt: string; gross: number; est: number; act?: number; tax?: number; paid: string }
const ROWS: Row[] = [
  { id: 'ptx_r1', org: 'org-A', evt: 'evt-a1', gross: 100_000, est: 2_000, act: 1_960, tax: 299, paid: '2025-03-10T10:00:00Z' },
  { id: 'ptx_r2', org: 'org-A', evt: 'evt-a1', gross:  50_000, est: 1_000,                       paid: '2026-09-01T10:00:00Z' },
  { id: 'ptx_r3', org: 'org-A', evt: 'evt-a2', gross: 200_000, est: 4_000, act: 4_400, tax: 671, paid: '2026-10-01T10:00:00Z' },
  { id: 'ptx_r4', org: 'org-B', evt: 'evt-b1', gross:  25_000, est:   500, act:   500, tax:  76, paid: '2026-10-05T10:00:00Z' },
]
// Ledger economics exactly as settlement writes them: 0.5% platform + 18% GST, 2% gateway estimate.
const platformBase = (g: number) => Math.round(g * 0.005)
const platformGst  = (g: number) => Math.round(platformBase(g) * 0.18)
const net          = (r: Row) => r.gross - platformBase(r.gross) - platformGst(r.gross) - r.est

describeEmu('gateway variance over real ledger rows', () => {
  let adminDb: import('firebase-admin/firestore').Firestore
  let fa: typeof import('@/lib/finance/financeAnalytics')
  let before: string

  const dump = async () => JSON.stringify((await adminDb.collection('platformTransactions').orderBy('__name__').get()).docs.map(d => [d.id, d.data()]))

  beforeAll(async () => {
    vi.stubEnv('GCLOUD_PROJECT', OWN_PROJECT)
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    const { Timestamp } = await import('firebase-admin/firestore')
    fa = await import('@/lib/finance/financeAnalytics')
    const existing = await adminDb.collection('platformTransactions').get()
    await Promise.all(existing.docs.map(d => d.ref.delete()))
    for (const r of ROWS) {
      await adminDb.doc(`platformTransactions/${r.id}`).set({
        organizerUid: r.org, entityId: r.evt, entityType: 'event', type: 'event_registration', status: 'completed',
        grossAmountPaise: r.gross, platformFeeBasePaise: platformBase(r.gross), platformFeeGstPaise: platformGst(r.gross),
        platformFeeTotalPaise: platformBase(r.gross) + platformGst(r.gross), gatewayFeeEstimatePaise: r.est,
        netSettlementPaise: net(r), paidAt: Timestamp.fromDate(new Date(r.paid)),
        ...(r.act !== undefined ? { gatewayFeeActualPaise: r.act, gatewayTaxPaise: r.tax } : {}),
      })
    }
    before = await dump()
  }, T)

  afterAll(async () => {
    const existing = await adminDb.collection('platformTransactions').get()
    await Promise.all(existing.docs.map(d => d.ref.delete()))
    vi.unstubAllEnvs()
  }, T)

  it('platform-wide (all organizers, lifetime): compares the 3 reconciled rows; r2 is awaiting, not ₹0', async () => {
    const v = await fa.getGatewayVariance({ kind: 'platform' })
    expect([v.transactions, v.reconciled, v.basis]).toEqual([4, 3, 'mixed'])
    expect(v.estimatedReconciled).toEqual({ ok: true, paise: 2_000 + 4_000 + 500 })
    expect(v.actual).toEqual({ ok: true, paise: 1_960 + 4_400 + 500 })
    expect(v.variance).toEqual({ ok: true, paise: 6_500 - 6_860 })        // −₹3.60
    expect(v.actualTax).toEqual({ ok: true, paise: 299 + 671 + 76 })
    expect(v.estimatedAwaiting).toEqual({ ok: true, paise: 1_000 })
  }, T)

  it('9/10 · per organizer: org-A spans two events; org-B is exactly zero', async () => {
    const a = await fa.getGatewayVariance({ kind: 'organizer', organizerUid: 'org-A', eventSlug: null })
    expect([a.transactions, a.reconciled]).toEqual([3, 2])
    expect(a.variance).toEqual({ ok: true, paise: (2_000 + 4_000) - (1_960 + 4_400) })
    expect(a.estimatedAwaiting).toEqual({ ok: true, paise: 1_000 })
    const b = await fa.getGatewayVariance({ kind: 'organizer', organizerUid: 'org-B', eventSlug: null })
    expect([b.transactions, b.reconciled, b.basis]).toEqual([1, 1, 'actual'])
    expect(b.variance).toEqual({ ok: true, paise: 0 })
  }, T)

  it('12 · event filter: evt-a1 is +₹0.40 (and awaiting ₹10); evt-a2 is −₹4.00', async () => {
    const a1 = await fa.getGatewayVariance({ kind: 'organizer', organizerUid: 'org-A', eventSlug: 'evt-a1' })
    expect([a1.transactions, a1.reconciled]).toEqual([2, 1])
    expect(a1.variance).toEqual({ ok: true, paise: 40 })
    expect(a1.estimatedAwaiting).toEqual({ ok: true, paise: 1_000 })
    const a2 = await fa.getGatewayVariance({ kind: 'organizer', organizerUid: 'org-A', eventSlug: 'evt-a2' })
    expect(a2.variance).toEqual({ ok: true, paise: -400 })
  }, T)

  it('11 · dates: the figures are LIFETIME, like every ledger total — a 2025 row and 2026 rows are all included', async () => {
    const v = await fa.getGatewayVariance({ kind: 'platform' })
    expect(v.transactions).toBe(ROWS.length)
  }, T)

  it('15 · read-only: every ledger row is byte-identical afterwards (no write, no backfill)', async () => {
    await fa.getGatewayVariance({ kind: 'platform' })
    await fa.getGatewayVariance({ kind: 'organizer', organizerUid: 'org-A', eventSlug: 'evt-a1' })
    expect(await dump()).toBe(before)
  }, T)

  it('16/17/18 · payable and platform-fee revenue are unchanged; the gateway is never platform revenue', async () => {
    const t = await fa.getLedgerTotals({ organizerUid: 'org-A', eventSlug: null, from: null, to: null })
    const aRows = ROWS.filter(r => r.org === 'org-A')
    // payable = Σ frozen net (computed with the ESTIMATE) — the actual fee changes nothing
    expect(t.organizerPayable).toEqual({ ok: true, paise: aRows.reduce((s, r) => s + net(r), 0) })
    // RegisterDesk's fee = platform base + GST only — no gateway money in it
    expect(t.platformFeeTotal).toEqual({ ok: true, paise: aRows.reduce((s, r) => s + platformBase(r.gross) + platformGst(r.gross), 0) })
    expect(t.gatewayEstimate).toEqual({ ok: true, paise: 7_000 })        // the frozen estimates, untouched
  }, T)
})

// RD-WALLET-W2.g (G10) — held wallet top-ups appear in the Operations Center: counted per status
// (pending / needs_review / exhausted / duplicate_payment), never twice, kept apart from the
// auto-draining reconciliation queue, and surfaced as a (non-paging) warning. The real
// getOperationsHealth / getRecoveryHealth run against an in-memory Firestore double.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>
const h = vi.hoisted(() => ({ data: {} as Record<string, Doc[]>, failCounts: new Set<string>() }))

vi.mock('@/lib/firebase/admin', () => {
  type Filter = [string, string, unknown]
  const query = (col: string, filters: Filter[] = []): Record<string, unknown> => {
    const match = (d: Doc) => filters.every(([f, op, v]) => op === '==' ? d[f] === v : op === 'in' ? (v as unknown[]).includes(d[f]) : true)
    const rows = () => (h.data[col] ?? []).filter(match)
    const q: Record<string, unknown> = {
      where: (f: string, op: string, v: unknown) => query(col, [...filters, [f, op, v]]),
      orderBy: () => q, limit: () => q,
      count: () => ({ get: async () => {
        if (h.failCounts.has(`${col}:${filters.map(f => f[2]).join(',')}`)) throw new Error('count failed')
        return { data: () => ({ count: rows().length }) }
      } }),
      get: async () => {
        const docs = rows().map((d, i) => ({ id: `${col}_${i}`, data: () => d }))
        return { docs, empty: docs.length === 0, size: docs.length }
      },
    }
    return q
  }
  return { adminAuth: {}, adminDb: { collection: (c: string) => query(c), doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) } }
})
vi.mock('@/lib/operations/incidents', () => ({ countOpenIncidents: async () => 0 }))

const { getOperationsHealth, evaluateAlerts, heldWalletTopupCount } = await import('@/lib/operations/healthMetrics')
const { getRecoveryHealth } = await import('@/lib/operations/recovery')

const recs = (status: string, n: number) => Array.from({ length: n }, () => ({ status }))

beforeEach(() => {
  h.failCounts.clear()
  h.data = {
    walletTopupReconciliation: [
      ...recs('pending', 2), ...recs('needs_review', 3), ...recs('exhausted', 1), ...recs('duplicate_payment', 2),
      ...recs('resolved', 4), ...recs('skipped', 1),                                           // conclusive — never counted
    ],
    // an order-level hold: NOT counted on its own (its per-payment records above already are)
    walletTopups: [{ status: 'needs_review', holdReason: 'multiple_captured_payments' }, { status: 'pending' }],
    registrationFinancialReconciliation: recs('pending', 1),
  }
})

describe('Operations health — wallet top-up statuses', () => {
  it('each status is its own count; pending keeps its meaning; resolved / skipped / order holds are not counted', async () => {
    const { financial } = await getOperationsHealth()
    expect(financial).toMatchObject({
      pendingWalletTopups: 2, walletTopupsNeedsReview: 3, walletTopupsExhausted: 1, walletTopupDuplicatePayments: 2,
      pendingRegistrationReconciliation: 1,
    })
    // no double counting: the four disjoint statuses add up to exactly the open records
    const open = h.data.walletTopupReconciliation.filter(r => ['pending', 'needs_review', 'exhausted', 'duplicate_payment'].includes(String(r.status))).length
    expect(financial.pendingWalletTopups + heldWalletTopupCount(financial)).toBe(open)
  })

  it('held top-ups raise a WARNING (dashboard only — alert delivery pages critical alerts only)', async () => {
    const alerts = evaluateAlerts(await getOperationsHealth())
    expect(alerts.find(a => a.id === 'wallet_topups_held')).toEqual({
      id: 'wallet_topups_held', severity: 'warning', message: '6 wallet top-up(s) held for Super Admin review (Admin › Wallet Top-ups).',
    })
  })

  it('no held top-ups → no alert; a failed count (-1) never invents or hides held records', async () => {
    h.data.walletTopupReconciliation = recs('pending', 5)
    expect(evaluateAlerts(await getOperationsHealth()).some(a => a.id === 'wallet_topups_held')).toBe(false)
    expect(heldWalletTopupCount({ walletTopupsNeedsReview: -1, walletTopupsExhausted: -1, walletTopupDuplicatePayments: -1 })).toBe(0)
    expect(heldWalletTopupCount({ walletTopupsNeedsReview: -1, walletTopupsExhausted: 2, walletTopupDuplicatePayments: 0 })).toBe(2)

    h.data.walletTopupReconciliation = recs('needs_review', 1)
    h.failCounts.add('walletTopupReconciliation:exhausted')
    const health = await getOperationsHealth()
    expect(health.financial.walletTopupsExhausted).toBe(-1)                        // shown as a failed query, not 0
    expect(evaluateAlerts(health).find(a => a.id === 'wallet_topups_held')?.message).toMatch(/^1 wallet top-up/)
  })
})

describe('Recovery — held top-ups are their own manual queue', () => {
  it('"Held wallet top-ups" counts needs_review + exhausted + duplicate_payment; "Failed reconciliations" keeps only the auto-draining pending', async () => {
    const { deadLetter } = await getRecoveryHealth()
    expect(deadLetter.walletTopupsHeld).toMatchObject({ key: 'wallet_topups_held', label: 'Held wallet top-ups', count: 6 })
    expect(deadLetter.walletTopupsHeld.retry).toMatch(/Super Admin review/)
    expect(deadLetter.reconciliations.count).toBe(2 + 1)                           // wallet pending 2 + registration pending 1
    expect(deadLetter.reconciliations.retry).toMatch(/Auto-drains/)
  })
})

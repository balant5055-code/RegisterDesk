// Super Admin Wallet Management · Overview — the "Could not load wallet data" root cause (2026-10-06).
// The Overview used ONE aggregation summing TWO fields of mediaCreditWallets; Firestore needs a
// composite index for that, none was deployed, and the FAILED_PRECONDITION failed the page's default
// view. Every aggregation now sums at most one field, and each figure fails on its own (null + named,
// never a false 0).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const h = vi.hoisted(() => ({ fail: new Set<string>(), calls: [] as string[] }))
vi.mock('@/lib/monitoring/sentry', () => ({ captureError: () => undefined, captureFinancialError: () => undefined }))
vi.mock('@/lib/firebase/admin', () => {
  const query = (col: string, where = ''): unknown => ({
    where: (f: string, _op: string, v: string) => query(col, `${where}${f}=${v};`),
    count: () => ({ get: async () => {
      h.calls.push(`count ${col} ${where}`)
      if (h.fail.has(`count ${col}`)) throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 })
      return { data: () => ({ count: col === 'organizerWallets' ? 3 : 1 }) }
    } }),
    aggregate: (spec: Record<string, unknown>) => ({ get: async () => {
      const fields = Object.keys(spec)
      h.calls.push(`aggregate ${col} ${fields.length}`)
      // The real Firestore behaviour that broke the page: >1 sum in one aggregation needs a composite index.
      if (fields.length > 1) throw Object.assign(new Error('9 FAILED_PRECONDITION: The query requires an index.'), { code: 9 })
      if (h.fail.has(`sum ${col}`)) throw Object.assign(new Error('14 UNAVAILABLE'), { code: 14 })
      return { data: () => ({ s: col === 'organizerWallets' ? 12_345 : 70 }) }
    } }),
  })
  return { adminDb: { collection: (c: string) => query(c) } }
})

describe('Wallet Management Overview', () => {
  beforeEach(() => { h.fail.clear(); h.calls.length = 0 })

  it('loads: every aggregation sums at most ONE field (no composite index needed)', async () => {
    const { getWalletOverview } = await import('@/lib/admin/walletManagementService')
    const o = await getWalletOverview()
    expect(o.failed).toEqual([])
    expect(o.communication).toMatchObject({ wallets: 3, storedBalancePaise: 12_345 })
    expect(o.media).toMatchObject({ wallets: 1, balanceCredits: 70, heldCredits: 70 })
    expect(o.allowances.eventLedgers).toBe(1)
    expect(h.calls.filter(c => c.startsWith('aggregate')).every(c => c.endsWith(' 1'))).toBe(true)
  })

  it('one failing source is null and NAMED — never a false 0 — and the rest still load', async () => {
    h.fail.add('sum mediaCreditWallets')
    h.fail.add('count walletTopups')
    const { getWalletOverview } = await import('@/lib/admin/walletManagementService')
    const o = await getWalletOverview()
    expect(o.media.balanceCredits).toBeNull()
    expect(o.media.heldCredits).toBeNull()
    expect(o.communication.topupsByStatus.credited).toBeNull()
    expect(o.communication.wallets).toBe(3)                       // unaffected figures intact
    expect(o.failed).toEqual(expect.arrayContaining(['media-credit balances', 'media-credit holds', 'top-ups (credited)']))
  })

  it('source guard: no aggregation in the service sums two fields at once', () => {
    const src = readFileSync('lib/admin/walletManagementService.ts', 'utf8')
    for (const m of src.matchAll(/\.aggregate\(\{([^}]*)\}\)/g)) {
      expect((m[1].match(/AggregateField\.(sum|average)/g) ?? []).length, m[0]).toBeLessThanOrEqual(1)
    }
  })

  it('the page never shows a failed load as zeros or as an empty list', () => {
    const page = readFileSync('app/(admin)/admin/wallet-management/PageClient.tsx', 'utf8')
    expect(page).toContain("{tab === 'overview' && !(overviewError && !overview) && <OverviewSection data={overview} />}")
    expect(page).toContain('Some figures could not be loaded')
    for (const s of ['Could not load organizer wallets', 'Could not load transactions', 'Could not load media-credit refunds']) expect(page).toContain(s)
    expect((page.match(/<RetryError /g) ?? []).length).toBeGreaterThanOrEqual(7)
    const queue = readFileSync('app/(admin)/admin/wallet-management/ServiceRequestsQueue.tsx', 'utf8')
    expect(queue).toContain('Could not load requests — retry above.')
    // approved ≠ refunded
    expect(queue).toContain("if (kind === 'refund' && status === 'approved') return 'Approved · not refunded yet'")
  })
})

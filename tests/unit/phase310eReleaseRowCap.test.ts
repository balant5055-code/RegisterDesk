// Phase 3.10E — the manual release's explicit function limit and ROW-CAP feedback: response ⇔ audit consistency
// for every way a run ends, the administrator notice (never "complete" when rows were left, never a promise of an
// automatic release), and the Release Engine banner's source contract.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  result: { processed: 0, releasedAmountPaise: 0, failures: 0 } as Record<string, unknown>,
  audits: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
vi.mock('@/lib/admin/financialGuard', () => ({
  requireSuperAdmin: async () => ({ uid: 'super-1' }),
  parseFinancialReason: (r: unknown) => (typeof r === 'string' && r.trim() ? { ok: true, reason: r.trim() } : { ok: false, code: 'REASON_REQUIRED' }),
  reasonErrorResponse: () => new Response(JSON.stringify({ code: 'REASON_REQUIRED' }), { status: 400 }),
}))
vi.mock('@/lib/settlements/releaseFunds', () => ({ releaseEligibleFunds: async () => h.result }))
vi.mock('@/lib/admin/audit', () => ({ logAdminActionOrRecord: async (e: Record<string, unknown>) => { h.audits.push(e) } }))

const { releaseRunNotice, toReleaseFundsResponse } = await import('@/lib/settlements/releaseRunSummary')
const route = await import('@/app/api/admin/finance/release-funds/route')
const post = async () => {
  const res = await route.POST(new NextRequest('http://localhost/api/admin/finance/release-funds', { method: 'POST', body: JSON.stringify({ reason: 'r' }) }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}
const base = { releasedTransactions: 0, releasedAmountPaise: 0, skippedTransactions: 0 }

describe('Phase 3.10E · manual release: every way a run ends — response and audit agree', () => {
  beforeEach(() => { h.audits.length = 0 })
  const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['normal completion', { processed: 4, releasedAmountPaise: 9_000, failures: 0 }, { ...base, releasedTransactions: 4, releasedAmountPaise: 9_000 }],
    ['zero remaining (nothing eligible)', { processed: 0, releasedAmountPaise: 0, failures: 0 }, base],
    ['time-budget stop', { processed: 10, releasedAmountPaise: 500, failures: 1, stoppedByBudget: true, notStartedForBudget: 490 },
      { releasedTransactions: 10, releasedAmountPaise: 500, skippedTransactions: 1, stoppedByBudget: true, notStartedForBudget: 490 }],
    ['row-cap stop', { processed: 500, releasedAmountPaise: 70_000, failures: 0, stoppedByRowCap: true, rowCap: 500 },
      { releasedTransactions: 500, releasedAmountPaise: 70_000, skippedTransactions: 0, stoppedByRowCap: true, rowCap: 500 }],
    ['both stops', { processed: 3, releasedAmountPaise: 30, failures: 0, stoppedByBudget: true, notStartedForBudget: 497, stoppedByRowCap: true, rowCap: 500 },
      { releasedTransactions: 3, releasedAmountPaise: 30, skippedTransactions: 0, stoppedByBudget: true, notStartedForBudget: 497, stoppedByRowCap: true, rowCap: 500 }],
  ]
  for (const [name, result, want] of cases) {
    it(name, async () => {
      h.result = result
      const r = await post()
      expect(r.status).toBe(200)
      expect(r.body).toEqual(want)                                                       // exact: no stray fields
      expect(h.audits).toHaveLength(1)
      expect(h.audits[0]).toMatchObject({ actorRole: 'super_admin', action: 'finance.release_funds', reason: 'r' })
      expect(h.audits[0].metadata).toEqual(r.body)
    })
  }
  it('the route declares an explicit 60 s function limit, above the job budget', async () => {
    expect(route.maxDuration).toBe(60)
    const { RELEASE_RUN_BUDGET_MS } = await vi.importActual<typeof import('@/lib/settlements/releaseFunds')>('@/lib/settlements/releaseFunds')
    expect(RELEASE_RUN_BUDGET_MS).toBeLessThanOrEqual(route.maxDuration * 1_000 - 15_000)
  })
})

describe('Phase 3.10E · the administrator notice', () => {
  const notice = (r: Record<string, unknown>) => releaseRunNotice(toReleaseFundsResponse({ processed: 1, releasedAmountPaise: 1, failures: 0, ...r }))
  it('row cap only: stopped early, says the rest were NOT released and remain pending; count stated as "at least one"', () => {
    const n = notice({ stoppedByRowCap: true, rowCap: 500 })
    expect(n).toMatchObject({ stoppedEarly: true, title: 'Release stopped early — per-run limit reached' })
    expect(n.remainderNote).toBe('This run reached its limit of 500 transactions; more eligible transactions remain (at least one — not counted). They were not started and NOT released; they remain pending and eligible — run the release again to continue.')
  })
  it('both: the time-limit title, with the exact batch count AND the cap note', () => {
    const n = notice({ stoppedByBudget: true, notStartedForBudget: 12, stoppedByRowCap: true, rowCap: 500 })
    expect(n.title).toBe('Release stopped early — time limit reached')
    expect(n.remainderNote).toBe('12 eligible transactions were not started and NOT released. The run had also reached its limit of 500 transactions; more eligible transactions remain (at least one — not counted). They were not started and NOT released. All of them remain pending and eligible; run the release again to continue.')
  })
  it('time budget only keeps its 3.10D wording; completion is "Release Complete" with no note', () => {
    expect(notice({ stoppedByBudget: true, notStartedForBudget: 2 }).remainderNote).toBe('2 eligible transactions were not started and NOT released. They remain pending and eligible; run the release again to continue.')
    expect(notice({})).toEqual({ stoppedEarly: false, title: 'Release Complete', remainderNote: null })
  })
  it('never "complete" when stopped early, and never a promise of automatic processing', () => {
    for (const r of [{ stoppedByRowCap: true, rowCap: 1 }, { stoppedByBudget: true, notStartedForBudget: 0 }, { stoppedByBudget: true, notStartedForBudget: 3, stoppedByRowCap: true, rowCap: 9 }]) {
      const n = notice(r)
      expect(n.stoppedEarly).toBe(true)
      expect(n.title).not.toMatch(/complete/i)
      expect(n.remainderNote).toMatch(/NOT released/)
      expect(n.remainderNote).not.toMatch(/automatic|will be released|scheduled|cron|hourly|daily/i)
    }
  })
})

describe('Phase 3.10E · Release Engine banner (source contract)', () => {
  const src = readFileSync('app/(admin)/admin/finance/PageClient.tsx', 'utf8')
  it('the banner title and note come from the notice; "Release Complete" is never hard-coded; a stop renders amber', () => {
    expect(src).toMatch(/const notice = releaseRunNotice\(releaseResult\)/)
    expect(src).not.toMatch(/>\s*Release Complete\s*</)
    expect(src).toMatch(/notice\.stoppedEarly \? \(\s*<div role="status" className="[^"]*border-amber-200 bg-amber-50/)
    expect((src.match(/\{notice\.title\}/g) ?? []).length).toBe(2)
    expect(src).toMatch(/\{notice\.remainderNote\}/)
  })
})

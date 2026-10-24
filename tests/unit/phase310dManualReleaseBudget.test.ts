// Phase 3.10D — the MANUAL release under the job's time budget: the response's budget-stop fields, the audit
// metadata, and the administrator's notice (which never promises an automatic release).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  result: { processed: 0, releasedAmountPaise: 0, failures: 0 } as Record<string, unknown>,
  audits: [] as Array<Record<string, unknown>>,
  calls: [] as unknown[],
}))
vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
vi.mock('@/lib/admin/financialGuard', () => ({
  requireSuperAdmin: async () => ({ uid: 'super-1' }),
  parseFinancialReason: (r: unknown) => (typeof r === 'string' && r.trim() ? { ok: true, reason: r.trim() } : { ok: false, code: 'REASON_REQUIRED' }),
  reasonErrorResponse: () => new Response(JSON.stringify({ code: 'REASON_REQUIRED' }), { status: 400 }),
}))
vi.mock('@/lib/settlements/releaseFunds', () => ({ releaseEligibleFunds: async (...a: unknown[]) => { h.calls.push(a[0]); return h.result } }))
vi.mock('@/lib/admin/audit', () => ({ logAdminActionOrRecord: async (e: Record<string, unknown>) => { h.audits.push(e) } }))

const { toReleaseFundsResponse, releaseRunNotice } = await import('@/lib/settlements/releaseRunSummary')
const { POST } = await import('@/app/api/admin/finance/release-funds/route')
const post = async (body: unknown) => {
  const res = await POST(new NextRequest('http://localhost/api/admin/finance/release-funds', { method: 'POST', body: JSON.stringify(body) }))
  return { status: res.status, body: await res.json() as Record<string, unknown> }
}

describe('Phase 3.10D · manual release response', () => {
  beforeEach(() => { h.audits.length = 0; h.calls.length = 0 })

  it('a COMPLETED run: the response and audit keep their exact pre-3.10D shape (no budget fields)', async () => {
    h.result = { processed: 3, releasedAmountPaise: 4_500, failures: 1, held: 2 }
    const r = await post({ reason: 'month end' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ releasedTransactions: 3, releasedAmountPaise: 4_500, skippedTransactions: 1 })
    expect(h.calls).toEqual([undefined])                                                // the job's defaults: limit + time budget
    expect(h.audits).toHaveLength(1)
    expect(h.audits[0]).toMatchObject({ adminUid: 'super-1', actorRole: 'super_admin', action: 'finance.release_funds', reason: 'month end' })
    expect(h.audits[0].metadata).toEqual({ releasedTransactions: 3, releasedAmountPaise: 4_500, skippedTransactions: 1 })
  })

  it('a BUDGET-STOPPED run: processed and not-started counts are returned and audited', async () => {
    h.result = { processed: 120, releasedAmountPaise: 987_654, failures: 0, stoppedByBudget: true, notStartedForBudget: 380 }
    const r = await post({ reason: 'catch up' })
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ releasedTransactions: 120, releasedAmountPaise: 987_654, skippedTransactions: 0, stoppedByBudget: true, notStartedForBudget: 380 })
    expect(h.audits[0].metadata).toEqual(r.body)
  })

  it('existing error handling is unchanged: no reason ⇒ 400, the job never runs, nothing audited', async () => {
    const r = await post({})
    expect(r.status).toBe(400)
    expect(h.calls).toHaveLength(0)
    expect(h.audits).toHaveLength(0)
  })
})

describe('Phase 3.10D · the administrator notice', () => {
  it('completed ⇒ "Release Complete", no remainder note', () => {
    expect(releaseRunNotice(toReleaseFundsResponse({ processed: 2, releasedAmountPaise: 10, failures: 0 }))).toEqual({ stoppedEarly: false, title: 'Release Complete', remainderNote: null })
  })
  it('stopped ⇒ says the remaining rows were NOT released and remain eligible; never promises an automatic release', () => {
    const many = releaseRunNotice(toReleaseFundsResponse({ processed: 5, releasedAmountPaise: 10, failures: 0, stoppedByBudget: true, notStartedForBudget: 7 }))
    expect(many).toMatchObject({ stoppedEarly: true, title: expect.stringMatching(/stopped early/i) })
    expect(many.remainderNote).toBe('7 eligible transactions were not started and NOT released. They remain pending and eligible; run the release again to continue.')
    const one = releaseRunNotice(toReleaseFundsResponse({ processed: 0, releasedAmountPaise: 0, failures: 0, stoppedByBudget: true, notStartedForBudget: 1 }))
    expect(one.remainderNote).toBe('1 eligible transaction was not started and NOT released. It remains pending and eligible; run the release again to continue.')
    for (const n of [many, one]) expect(n.remainderNote).not.toMatch(/automatic|will be released|scheduled|cron/i)
  })
  it('a stop with no count still reports the stop (0 not started)', () => {
    expect(toReleaseFundsResponse({ processed: 0, releasedAmountPaise: 0, failures: 0, stoppedByBudget: true })).toMatchObject({ stoppedByBudget: true, notStartedForBudget: 0 })
  })
})

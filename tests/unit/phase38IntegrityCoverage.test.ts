// Phase 3.8 — the PURE evaluators of the read-only integrity coverage (no Firestore):
//   A · row-driven donation ledger / refund-record checks
//   B · stuck settlement-release classification (a replay of the release job's own rule)
//   C · registration refund reconciliation (incl. the known M4 gap)

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
vi.mock('@/lib/settlements/resolveSettlementConfig', () => ({ getSettlementConfig: async () => ({}) }))

const { evaluateLedgerRow, evaluateRefundRecordLink, parseDonationRowId } = await import('@/lib/reconciliation/donationLedgerRows')
const { classifyOverdueReleases, STUCK_RELEASE_GRACE_MS, STUCK_RELEASE_SCAN_CAP } = await import('@/lib/reconciliation/stuckReleases')
const { evaluateRegistrationRefunds, REFUND_COUNT_GRACE_MS, REGISTRATION_RECORDS_CAP } = await import('@/lib/reconciliation/registrationRefunds')

const fields = (v: { mismatches: Array<{ field: string }> }) => v.mismatches.map(m => m.field)
const reasons = (v: { unverifiable: Array<{ check: string; reason: string }> }) => v.unverifiable.map(u => u.reason)

// ═══ A ═══
describe('A · row-driven donation ledger checks', () => {
  const donation = { id: 'd1', refundedAmountPaise: 4_000, pendingRefundPaise: 0 }
  const inactive = { id: 'd1', refundedAmountPaise: 0, pendingRefundPaise: 0 }
  const reversal = { id: 'ptx_refund_r1', parentTransactionId: 'ptx_d1', grossAmountPaise: -4_000, netSettlementPaise: -3_800, refundId: 'r1' }
  const record = { id: 'r1', donationId: 'd1', amountPaise: 4_000, status: 'processed' }
  it('row ids parse into reversal / compensation', () => {
    expect(parseDonationRowId('ptx_refund_abc')).toEqual({ kind: 'reversal', refundId: 'abc' })
    expect(parseDonationRowId('ptx_refundcomp_abc')).toEqual({ kind: 'compensation', refundId: 'abc' })
    expect(parseDonationRowId('ptx_other')).toBeNull()
  })
  it('a consistent reversal row is clean', () => {
    expect(evaluateLedgerRow({ row: reversal, donation, refund: record, reversal: null })).toEqual({ mismatches: [], unverifiable: [] })
  })
  it('rows naming a missing donation, a missing refund record (on an active or an INACTIVE donation), or the wrong refund', () => {
    expect(fields(evaluateLedgerRow({ row: reversal, donation: null, refund: record, reversal: null }))).toEqual(['ledgerRowDonationMissing:ptx_refund_r1'])
    expect(fields(evaluateLedgerRow({ row: reversal, donation, refund: null, reversal: null }))).toEqual(['ledgerRowRefundMissing:ptx_refund_r1'])
    expect(fields(evaluateLedgerRow({ row: reversal, donation: inactive, refund: null, reversal: null }))).toEqual(['ledgerRowOnInactiveDonation:ptx_refund_r1'])
    expect(fields(evaluateLedgerRow({ row: { ...reversal, refundId: 'other' }, donation, refund: record, reversal: null }))).toEqual(['ledgerRowRefundIdMismatch:ptx_refund_r1'])
    expect(fields(evaluateLedgerRow({ row: reversal, donation, refund: { ...record, donationId: 'd2' }, reversal: null }))).toEqual(['ledgerRowRefundDonation:ptx_refund_r1'])
  })
  it('incompatible amounts, and a reversal for a refund never accounted', () => {
    expect(evaluateLedgerRow({ row: { ...reversal, grossAmountPaise: -4_001 }, donation, refund: record, reversal: null }).mismatches)
      .toEqual([expect.objectContaining({ entityType: 'donation', entityId: 'd1', field: 'ledgerRowAmount:ptx_refund_r1', expected: -4_000, actual: -4_001, repaired: false })])
    expect(fields(evaluateLedgerRow({ row: reversal, donation, refund: { ...record, status: 'pending' }, reversal: null }))).toEqual(['ledgerRowRefundNotAccounted:ptx_refund_r1'])
    expect(fields(evaluateLedgerRow({ row: reversal, donation, refund: { ...record, status: 'failed' }, reversal: null }))).toEqual(['ledgerRowRefundNotAccounted:ptx_refund_r1'])
  })
  it('compensating rows: clean when exact; flagged without a decision, without its reversal, or with a different net', () => {
    const comp = { id: 'ptx_refundcomp_r1', parentTransactionId: 'ptx_d1', grossAmountPaise: 4_000, netSettlementPaise: 3_800, compensatesTransactionId: 'ptx_refund_r1', refundId: 'r1' }
    const compensated = { ...record, status: 'failed', compensation: { ledgerId: comp.id } }
    expect(evaluateLedgerRow({ row: comp, donation, refund: compensated, reversal })).toEqual({ mismatches: [], unverifiable: [] })
    expect(fields(evaluateLedgerRow({ row: comp, donation, refund: record, reversal }))).toEqual(['compensationWithoutDecision:ptx_refundcomp_r1'])
    expect(fields(evaluateLedgerRow({ row: comp, donation, refund: compensated, reversal: null }))).toEqual(['compensationReversalMissing:ptx_refundcomp_r1'])
    expect(fields(evaluateLedgerRow({ row: { ...comp, netSettlementPaise: 3_801 }, donation, refund: compensated, reversal }))).toEqual(['compensationNet:ptx_refundcomp_r1'])
  })
  it('unreadable evidence is unverifiable, never clean', () => {
    expect(reasons(evaluateLedgerRow({ row: { ...reversal, parentTransactionId: 7 }, donation, refund: record, reversal: null }))).toEqual(['parent_unreadable'])
    expect(reasons(evaluateLedgerRow({ row: { ...reversal, id: 'ptx_weird' }, donation, refund: record, reversal: null }))).toEqual(['unknown_row_shape'])
    expect(reasons(evaluateLedgerRow({ row: reversal, donation, refund: { ...record, amountPaise: 'x' }, reversal: null }))).toEqual(['amount_unreadable'])
  })
  it('refund records must name an existing donation', () => {
    expect(fields(evaluateRefundRecordLink({ id: 'r9', donationId: 'gone' }, false))).toEqual(['refundRecordDonationMissing:r9'])
    expect(reasons(evaluateRefundRecordLink({ id: 'r9' }, null))).toEqual(['donation_id_unreadable'])
    expect(evaluateRefundRecordLink({ id: 'r9', donationId: 'd1' }, true)).toEqual({ mismatches: [], unverifiable: [] })
  })
})

// ═══ B ═══
describe('B · stuck settlement releases (replay of the release job, oldest first)', () => {
  const HOUR = 3_600_000
  const now = 1_000 * 24 * HOUR
  const config = { enabled: true, frozen: false, holdHours: 48, maximumSettlementsPerRun: 500 }
  const overduePaid = now - 48 * HOUR - STUCK_RELEASE_GRACE_MS - HOUR      // eligible, and past two daily runs
  const row = (id: string, net: number, paidAtMs = overduePaid, organizerUid: unknown = 'o1') => ({ id, organizerUid, netSettlementPaise: net, paidAtMs })
  it('pending that cannot cover a row (after the older rows take theirs) is STUCK; the rows it can cover are overdue without evidence', () => {
    const r = classifyOverdueReleases({ rows: [row('a', 8_000), row('b', 5_000)], pendingByOrganizer: new Map([['o1', 9_000]]), config, nowMs: now, scanCapped: false })
    expect(r.map(e => [e.ptxId, e.verdict, e.reason, e.evidence.pendingBeforeTurnPaise])).toEqual([
      ['a', 'unverifiable', 'no_failure_evidence', 9_000],
      ['b', 'stuck', 'pending_below_release', 1_000],
    ])
    expect(r[1]).toMatchObject({ amountPaise: 5_000, organizerUid: 'o1', evidence: { failureEvidencePersisted: false } })
    expect(r[1].overdueMs).toBeGreaterThan(0)
  })
  it('rows not yet overdue are not reported (but still consume pending in the replay)', () => {
    const fresh = now - 48 * HOUR - HOUR
    const r = classifyOverdueReleases({ rows: [row('a', 8_000, overduePaid - 1), row('n', 1_000, fresh)], pendingByOrganizer: new Map([['o1', 100]]), config, nowMs: now, scanCapped: false })
    expect(r.map(e => e.ptxId)).toEqual(['a'])
  })
  it('paused releases, unreadable rows / wallets, a backlog beyond one run and a capped scan are unverifiable', () => {
    expect(classifyOverdueReleases({ rows: [row('a', 1)], pendingByOrganizer: new Map([['o1', 0]]), config: { ...config, frozen: true }, nowMs: now, scanCapped: false })[0].reason).toBe('release_paused')
    expect(classifyOverdueReleases({ rows: [row('a', 1, overduePaid, null)], pendingByOrganizer: new Map(), config, nowMs: now, scanCapped: false })[0].reason).toBe('row_unreadable')
    expect(classifyOverdueReleases({ rows: [row('a', 1)], pendingByOrganizer: new Map([['o1', undefined]]), config, nowMs: now, scanCapped: false })[0].reason).toBe('wallet_unreadable')
    const backlog = classifyOverdueReleases({ rows: [row('a', 1), row('b', 1)], pendingByOrganizer: new Map([['o1', 10]]), config: { ...config, maximumSettlementsPerRun: 1 }, nowMs: now, scanCapped: true })
    expect(backlog.map(e => e.reason)).toEqual(['no_failure_evidence', 'beyond_run_limit', `scan_capped_at_${STUCK_RELEASE_SCAN_CAP}`])
  })
})

// ═══ C ═══
describe('C · registration refund reconciliation', () => {
  const now = 10 * 86_400_000
  const old = { toMillis: () => now - REFUND_COUNT_GRACE_MS - 1 }
  const young = { toMillis: () => now - 60_000 }
  const intent = (counted: Record<string, number>, fullBy?: string) => ({ id: 'o1', amount: 10_000, registrationId: 'reg1', gatewayRefundsPaise: counted, ...(fullBy ? { gatewayRefundFullBy: fullBy } : {}) })
  const rec = (id: string, amount: number, status = 'linked', createdAt: unknown = old) => ({ id, amountPaise: amount, status, createdAt })
  const ptx = (over: Record<string, unknown> = {}) => ({ id: 'ptx_reg1', status: 'completed', releaseStatus: 'pending', netSettlementPaise: 9_500, ...over })
  const base = { orderId: 'o1', recordsCapped: false, reversalQueued: false, nowMs: now }
  const ev = (over: Partial<Parameters<typeof evaluateRegistrationRefunds>[0]>) => evaluateRegistrationRefunds({ ...base, intent: intent({}), records: [], ptx: ptx(), registration: { id: 'reg1', paymentStatus: 'paid' }, ...over })

  it('no refunds: clean; a full refund reversed and marked: clean; a partial on an UNRELEASED, held settlement: clean', () => {
    expect(ev({})).toEqual({ mismatches: [], unverifiable: [] })
    expect(ev({ intent: intent({ rf: 10_000 }, 'rf'), records: [rec('rf', 10_000, 'processed')], ptx: ptx({ status: 'refunded' }), registration: { id: 'reg1', paymentStatus: 'refunded' } })).toEqual({ mismatches: [], unverifiable: [] })
    expect(ev({ intent: intent({ p1: 3_000 }), records: [rec('p1', 3_000)], ptx: ptx({ releaseStatus: 'held', releaseHold: { refundIds: ['p1'] } }) })).toEqual({ mismatches: [], unverifiable: [] })
  })
  it('a partial refund of RELEASED money is the known M4 gap (reported, with the marker check)', () => {
    const v = ev({ intent: intent({ p1: 3_000 }), records: [rec('p1', 3_000)], ptx: ptx({ releaseStatus: 'released', releaseHold: { refundIds: ['p1'], alreadyReleased: true } }) })
    expect(v.mismatches).toEqual([expect.objectContaining({ entityType: 'registration', entityId: 'reg1', field: 'm4PartialRefundOnReleasedFunds', expected: 0, actual: 3_000 })])
    expect(fields(ev({ intent: intent({ p1: 3_000 }), records: [rec('p1', 3_000)], ptx: ptx({ releaseStatus: 'released' }) }))).toEqual(['partialRefundMarkerMissing', 'm4PartialRefundOnReleasedFunds'])
  })
  it('missing ledger reversal on a full refund (queued ⇒ unverifiable); a partial not held; registration states', () => {
    expect(fields(ev({ intent: intent({ rf: 10_000 }, 'rf'), records: [rec('rf', 10_000)] }))).toEqual(['missingLedgerReversal', 'registrationNotRefunded'])
    const queued = ev({ intent: intent({ rf: 10_000 }, 'rf'), records: [rec('rf', 10_000)], reversalQueued: true, registration: { id: 'reg1', paymentStatus: 'refunded' } })
    expect(queued).toMatchObject({ mismatches: [], unverifiable: [expect.objectContaining({ check: 'ledger', reason: 'ledger_reversal_queued' })] })
    expect(fields(ev({ intent: intent({ p1: 3_000 }), records: [rec('p1', 3_000)] }))).toEqual(['partialRefundNotHeld'])
    expect(fields(ev({ intent: intent({ p1: 3_000 }), records: [rec('p1', 3_000)], ptx: ptx({ releaseStatus: 'held', releaseHold: { refundIds: ['p1'] } }), registration: { id: 'reg1', paymentStatus: 'refunded' } }))).toEqual(['registrationRefundedOnPartial'])
  })
  it('records vs counted refunds: not counted (young ⇒ unverifiable, old ⇒ mismatch), amount differs, failed but counted, counted without record', () => {
    expect(ev({ records: [rec('a', 500, 'linked', young)] })).toMatchObject({ mismatches: [], unverifiable: [expect.objectContaining({ reason: 'awaiting_gateway_webhook' })] })
    expect(fields(ev({ records: [rec('a', 500)] }))).toEqual(['refundNotCounted:a'])
    expect(fields(ev({ intent: intent({ a: 400 }), records: [rec('a', 500)], ptx: ptx({ releaseStatus: 'held', releaseHold: { refundIds: ['a'] } }) }))).toEqual(['refundAmount:a'])
    expect(fields(ev({ intent: intent({ f: 500 }), records: [rec('f', 500, 'failed')], ptx: ptx({ releaseStatus: 'held', releaseHold: { refundIds: ['f'] } }) }))).toEqual(['failedRefundCounted:f'])
    expect(fields(ev({ intent: intent({ x: 500 }), ptx: ptx({ releaseStatus: 'held', releaseHold: { refundIds: ['x'] } }) }))).toEqual(['countedWithoutRecord:x'])
  })
  it('cumulative: above the charge; the full marker missing or stale; a reversal with no refund at all', () => {
    expect(fields(ev({ intent: intent({ a: 6_000, b: 5_000 }, 'b'), records: [rec('a', 6_000), rec('b', 5_000)], ptx: ptx({ status: 'refunded' }), registration: { id: 'reg1', paymentStatus: 'refunded' } }))).toEqual(['cumulativeExceedsCharge'])
    expect(fields(ev({ intent: intent({ rf: 10_000 }), records: [rec('rf', 10_000)], ptx: ptx({ status: 'refunded' }), registration: { id: 'reg1', paymentStatus: 'refunded' } }))).toEqual(['fullRefundMarkerMissing'])
    expect(fields(ev({ intent: intent({ p1: 3_000 }, 'p1'), records: [rec('p1', 3_000)], ptx: ptx({ releaseStatus: 'held', releaseHold: { refundIds: ['p1'] } }) }))).toEqual(['fullRefundMarkerStale'])
    expect(fields(ev({ ptx: ptx({ status: 'refunded' }) }))).toEqual(['reversalWithoutRefund'])
    expect(ev({ ptx: ptx({ status: 'disputed' }) })).toEqual({ mismatches: [], unverifiable: [] })   // a dispute is not a refund
  })
  it('missing / capped / unreadable evidence is unverifiable', () => {
    expect(reasons(ev({ intent: null }))).toEqual(['not_found'])
    expect(reasons(ev({ recordsCapped: true }))).toEqual([`more_than_${REGISTRATION_RECORDS_CAP}`])
    expect(reasons(ev({ intent: { id: 'o1', amount: 'x' } }))).toEqual(['unreadable'])
    expect(reasons(ev({ intent: intent({ rf: 10_000 }, 'rf'), records: [rec('rf', 10_000)], ptx: null, registration: { id: 'reg1', paymentStatus: 'refunded' } }))).toEqual(['ledger_row_missing'])
  })
})

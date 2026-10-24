// Phase 3.6A — the PURE per-donation refund integrity evaluator (no Firestore): normal, partial, full,
// failed, compensated, duplicated, missing-record and legacy cases; refunded / reserved / failed /
// compensated / unresolved kept apart; missing evidence is unverifiable, never clean.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

const { evaluateDonationRefundIntegrity, DONATION_RECORDS_CAP } = await import('@/lib/reconciliation/donationRefunds')
type Facts = Parameters<typeof evaluateDonationRefundIntegrity>[0]

const D = 'don1'
/** A donation of `gross` with original net `net`, and the given records. */
function facts(over: Partial<Facts> & { gross?: number; net?: number; refunded?: number; reserved?: number; attempts?: Record<string, unknown> } = {}): Facts {
  const { gross = 10_000, net = 9_500, refunded = 0, reserved = 0, attempts, ...rest } = over
  return {
    donationId: D,
    donation: { amountPaise: gross, refundedAmountPaise: refunded, pendingRefundPaise: reserved, ...(attempts ? { refundAttempts: attempts } : {}) },
    refunds: [], ledgerRows: [], parent: { exists: true, netSettlementPaise: net }, capped: { refunds: false, ledgerRows: false },
    ...rest,
  }
}
const refund = (id: string, amount: number, status: string, extra: Record<string, unknown> = {}) => ({ id, amountPaise: amount, status, initiatedBy: 'org-uid', ...extra })
const reversal = (rid: string, amount: number, net: number) => ({ id: `ptx_refund_${rid}`, grossAmountPaise: -amount, netSettlementPaise: -net, refundId: rid, parentTransactionId: `ptx_${D}` })
const comp = (rid: string, amount: number, net: number) => ({ id: `ptx_refundcomp_${rid}`, grossAmountPaise: amount, netSettlementPaise: net, refundId: rid, compensatesTransactionId: `ptx_refund_${rid}` })
const fields = (v: ReturnType<typeof evaluateDonationRefundIntegrity>) => v.mismatches.map(m => m.field)
const checks = (v: ReturnType<typeof evaluateDonationRefundIntegrity>) => v.unverifiable.map(u => `${u.check}:${u.reason}`)

describe('normal, partial and full', () => {
  it('a donation with no refund activity is clean', () => {
    expect(evaluateDonationRefundIntegrity(facts())).toMatchObject({ status: 'clean', mismatches: [], unverifiable: [] })
  })
  it('a partial refund accounted with its reversal row is clean; amounts are kept apart', () => {
    const v = evaluateDonationRefundIntegrity(facts({ refunded: 4_000, refunds: [refund('r1', 4_000, 'processed')], ledgerRows: [reversal('r1', 4_000, 3_800)] }))
    expect(v.status).toBe('clean')
    expect(v.amounts).toMatchObject({ accountedPaise: 4_000, reservedPaise: 0, failedPaise: 0, compensatedPaise: 0, unresolvedPaise: 0, reversedNetPaise: 3_800 })
  })
  it('a full refund in three parts reversing exactly the net is clean (Phase 3.3 arithmetic)', () => {
    const v = evaluateDonationRefundIntegrity(facts({ gross: 100_000, net: 95_000, refunded: 100_000,
      refunds: [refund('a', 33_333, 'processed'), refund('b', 33_333, 'processed'), refund('c', 33_334, 'processed')],
      ledgerRows: [reversal('a', 33_333, 31_666), reversal('b', 33_333, 31_666), reversal('c', 33_334, 31_668)] }))
    expect(v.status).toBe('clean')
  })
  it('an insolvent reversal (row carries the full reversal; the wallet debit was partial) is still ledger-consistent', () => {
    expect(evaluateDonationRefundIntegrity(facts({ refunded: 2_000, refunds: [refund('r1', 2_000, 'processed', { insolvent: true, ledgerReversedPaise: 0 })], ledgerRows: [reversal('r1', 2_000, 1_900)] })).status).toBe('clean')
  })
})

describe('failed, unresolved, reserved and compensated', () => {
  it('a failed refund has no ledger rows and does not count as refunded', () => {
    const v = evaluateDonationRefundIntegrity(facts({ refunds: [refund('f1', 1_000, 'failed')] }))
    expect(v).toMatchObject({ status: 'clean', amounts: { failedPaise: 1_000, accountedPaise: 0 } })
  })
  it('a pending refund owned by a request holds its reservation; a webhook-originated or already-released one does not', () => {
    const v = evaluateDonationRefundIntegrity(facts({ reserved: 700, refunds: [
      refund('p1', 700, 'pending'), refund('p2', 300, 'pending', { initiatedBy: 'webhook' }), refund('p3', 200, 'pending', { reservationReleased: true }),
    ] }))
    expect(v).toMatchObject({ status: 'clean', amounts: { reservedPaise: 700, unresolvedPaise: 1_200 } })
  })
  it('open attempts hold their amounts; concluded ones do not', () => {
    const v = evaluateDonationRefundIntegrity(facts({ reserved: 800, attempts: {
      att_a: { status: 'unknown', amountPaise: 500 }, att_b: { status: 'submitting', amountPaise: 300 },
      att_c: { status: 'rejected', amountPaise: 900 }, att_d: { status: 'resolved_none', amountPaise: 100 },
    } }))
    expect(v).toMatchObject({ status: 'clean', amounts: { reservedPaise: 800 } })
  })
  it('a compensated refund (reversal + exact compensating row) is not refunded, and nets to zero', () => {
    const v = evaluateDonationRefundIntegrity(facts({ refunds: [refund('c1', 4_000, 'failed', { compensation: { ledgerId: 'ptx_refundcomp_c1' } })],
      ledgerRows: [reversal('c1', 4_000, 3_800), comp('c1', 4_000, 3_800)] }))
    expect(v).toMatchObject({ status: 'clean', amounts: { compensatedPaise: 4_000, accountedPaise: 0, reversedNetPaise: 0 } })
  })
  it('a conflicted refund is listed as such (still held elsewhere), and its record/ledger consistency still checked', () => {
    const v = evaluateDonationRefundIntegrity(facts({ refunded: 1_000, refunds: [refund('x1', 1_000, 'processed', { accountingRecovery: { state: 'needs_review', conflict: 'FAILED_EVENT_AFTER_PROCESSED' } })], ledgerRows: [reversal('x1', 1_000, 950)] }))
    expect(v).toMatchObject({ status: 'clean', amounts: { conflictedRefunds: ['x1'] } })
  })
})

describe('mismatches', () => {
  it('refundedAmountPaise and pendingRefundPaise disagreeing with the records', () => {
    const v = evaluateDonationRefundIntegrity(facts({ refunded: 4_001, reserved: 5, refunds: [refund('r1', 4_000, 'processed')], ledgerRows: [reversal('r1', 4_000, 3_800)] }))
    expect(v.status).toBe('mismatch')
    expect(v.mismatches).toEqual(expect.arrayContaining([
      expect.objectContaining({ entityType: 'donation', entityId: D, field: 'refundedAmountPaise', expected: 4_000, actual: 4_001, repaired: false }),
      expect.objectContaining({ field: 'pendingRefundPaise', expected: 0, actual: 5 }),
    ]))
  })
  it('missing records: an accounted refund without its reversal row; a linked attempt naming no record; a compensated refund without its compensating row', () => {
    expect(fields(evaluateDonationRefundIntegrity(facts({ refunded: 4_000, refunds: [refund('r1', 4_000, 'processed')] })))).toContain('reversalRow:r1')
    expect(fields(evaluateDonationRefundIntegrity(facts({ attempts: { att_x: { status: 'linked', amountPaise: 300, refundId: 'gone' } } })))).toContain('attemptLink:att_x')
    expect(fields(evaluateDonationRefundIntegrity(facts({ refunds: [refund('c1', 4_000, 'failed', { compensation: {} })], ledgerRows: [reversal('c1', 4_000, 3_800)] })))).toContain('compensationRow:c1')
  })
  it('duplicated / contradictory associations: two attempts claiming one refund; amounts differing; rows for failed refunds; orphan rows', () => {
    const v = evaluateDonationRefundIntegrity(facts({ refunded: 300, refunds: [refund('r1', 300, 'processed'), refund('f1', 200, 'failed')],
      attempts: { att_a: { status: 'linked', amountPaise: 300, refundId: 'r1' }, att_b: { status: 'linked', amountPaise: 250, refundId: 'r1' } },
      ledgerRows: [reversal('r1', 300, 285), reversal('f1', 200, 190), { id: 'ptx_refund_zzz', grossAmountPaise: -10, netSettlementPaise: -9 }] }))
    expect(fields(v)).toEqual(expect.arrayContaining(['attemptLinkDuplicate:r1', 'attemptAmount:att_b', 'unexpectedReversalRow:f1', 'orphanLedgerRow:ptx_refund_zzz']))
  })
  it('over-reversal and an out-of-proportion partial reversal', () => {
    expect(fields(evaluateDonationRefundIntegrity(facts({ refunded: 4_000, refunds: [refund('r1', 4_000, 'processed')], ledgerRows: [reversal('r1', 4_000, 9_600)] })))).toContain('reversedNetTotal')
    expect(fields(evaluateDonationRefundIntegrity(facts({ refunded: 4_000, refunds: [refund('r1', 4_000, 'processed')], ledgerRows: [reversal('r1', 4_000, 3_700)] })))).toContain('reversedNetProportion')
  })
  it('a fully refunded donation reversing less than its net by more than rounding can explain', () => {
    expect(fields(evaluateDonationRefundIntegrity(facts({ refunded: 10_000, refunds: [refund('r1', 10_000, 'processed')], ledgerRows: [reversal('r1', 10_000, 9_000)] })))).toEqual(['reversedNetTotal'])
  })
})

describe('legacy and unverifiable', () => {
  it('LEGACY rounding residue (pre-Phase-3.3 per-refund rounding: 3 × 317 for 999/950) is reported as its own kind', () => {
    const v = evaluateDonationRefundIntegrity(facts({ gross: 999, net: 950, refunded: 999,
      refunds: [refund('a', 333, 'processed'), refund('b', 333, 'processed'), refund('c', 333, 'processed')],
      ledgerRows: [reversal('a', 333, 317), reversal('b', 333, 317), reversal('c', 333, 317)] }))
    expect(v.mismatches).toEqual([expect.objectContaining({ field: 'legacyRoundingResidue', expected: 950, actual: 951 })])
  })
  it('capped reads, unreadable values, missing fields and a missing original row are UNVERIFIABLE — never clean', () => {
    const capped = evaluateDonationRefundIntegrity(facts({ capped: { refunds: true, ledgerRows: false }, refunds: [refund('r1', 1, 'processed')] }))
    expect(capped.status).toBe('unverifiable')
    expect(checks(capped)).toContain(`refunds:more_than_${DONATION_RECORDS_CAP}_records`)
    expect(capped.mismatches).toEqual([])                                     // no verdict from a partial read
    const unreadable = evaluateDonationRefundIntegrity(facts({ refunds: [refund('r1', 'lots' as never, 'processed')] }))
    expect(unreadable.status).toBe('unverifiable')
    const missingField = evaluateDonationRefundIntegrity({ ...facts({ refunds: [refund('r1', 500, 'failed')] }), donation: { amountPaise: 10_000 } })
    expect(checks(missingField)).toEqual(expect.arrayContaining(['refundedAmountPaise:field_missing', 'pendingRefundPaise:field_missing']))
    const noParent = evaluateDonationRefundIntegrity(facts({ refunded: 500, parent: { exists: false }, refunds: [refund('r1', 500, 'processed')], ledgerRows: [reversal('r1', 500, 475)] }))
    expect(noParent.status).toBe('unverifiable')
    expect(checks(noParent)).toContain('reversedNet:original_ledger_row_missing')
    const badAttempt = evaluateDonationRefundIntegrity(facts({ attempts: { att_q: { status: 'mystery', amountPaise: 5 } } }))
    expect(badAttempt.status).toBe('unverifiable')
  })
  it('a mismatch found by a completed check is kept even when another check is unverifiable', () => {
    const v = evaluateDonationRefundIntegrity(facts({ refunded: 1, attempts: { att_q: { status: 'mystery', amountPaise: 5 } } }))
    expect(v.status).toBe('mismatch')
    expect(fields(v)).toContain('refundedAmountPaise')
    expect(v.unverifiable.length).toBeGreaterThan(0)
  })
})

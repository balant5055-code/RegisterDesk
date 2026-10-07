// RD-WALLET-W2.d · S1 — the pure communication-wallet reconciliation classifiers.

import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {}, adminAuth: {} }))

const R = await import('@/lib/reconciliation/walletTopups')
const { ledgerSign, classifyTopup, classifyReconciliationRecord, startWalletChain, stepWalletChain, finishWalletChain } = R
const { isWalletCredit } = await import('@/lib/finance/txnMeta')
const { WALLET_TXN_TYPE_LABELS } = await import('@/lib/wallet/types')

const codes = (fs: Array<{ code: string; confidence: string }>) => fs.map(f => `${f.code}:${f.confidence}`).sort()

describe('ledgerSign — the approved sign map', () => {
  it('credit ⇔ txnMeta.isWalletCredit, for every declared type except the ambiguous one', () => {
    for (const t of Object.keys(WALLET_TXN_TYPE_LABELS)) {
      if (t === 'adjustment') continue
      expect(ledgerSign(t), t).toBe(isWalletCredit(t as never) ? 'credit' : 'debit')
    }
    expect(ledgerSign('fund_added')).toBe('credit')
    expect(ledgerSign('license_refund')).toBe('credit')
    expect(ledgerSign('refund')).toBe('credit')
    for (const t of ['whatsapp_charge', 'broadcast_sms', 'broadcast_whatsapp', 'certificate_charge', 'license_charge', 'email_charge', 'sms_charge']) {
      expect(ledgerSign(t), t).toBe('debit')
    }
  })
  it("'adjustment' is ambiguous — neither credit nor debit", () => {
    expect(ledgerSign('adjustment')).toBe('ambiguous')
  })
  it('undeclared, missing or non-string types are unknown', () => {
    for (const t of ['bonus', '', undefined, null, 5, 'FUND_ADDED']) expect(ledgerSign(t)).toBe('unknown')
  })
})

// ── per top-up ──────────────────────────────────────────────────────────────────────────────────
const topup = (over: Record<string, unknown> = {}) => ({ uid: 'u1', amountPaise: 50_000, status: 'credited', paymentId: 'pay_1', ...over })
const row = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, data: { organizerUid: 'u1', type: 'fund_added', amountPaise: 50_000, orderId: 'o1', paymentId: 'pay_1', status: 'completed', ...over } })
const check = (t: Record<string, unknown>, rows: Array<{ id: string; data: Record<string, unknown> }> = [row('topup_o1')], recon: Record<string, unknown> | null = null, complete = true) =>
  classifyTopup({ orderId: 'o1', topup: t, recon, ledgerRows: rows, ledgerEvidenceComplete: complete })

describe('classifyTopup', () => {
  it('a consistent credited top-up (and a consistent pending one) has no findings', () => {
    expect(check(topup(), [row('topup_o1')], { uid: 'u1', status: 'resolved' })).toEqual([])
    expect(check(topup({ status: 'pending', paymentId: undefined }), [])).toEqual([])
    expect(check(topup({ status: 'abandoned' }), [], { uid: 'u1', status: 'needs_review' })).toEqual([])
  })
  it('duplicate credit rows for one top-up → confirmed', () => {
    const f = check(topup(), [row('topup_o1'), row('legacy_dup_row')])
    expect(codes(f)).toEqual(['duplicate_credit:confirmed'])
    expect(f[0].detail).toMatchObject({ rows: 2 })
  })
  it('the same row seen twice (by id and by orderId) is NOT a duplicate', () => {
    expect(check(topup(), [row('topup_o1'), row('topup_o1')])).toEqual([])
  })
  it('reference mismatches → confirmed: amount, owner, payment, order', () => {
    expect(codes(check(topup(), [row('topup_o1', { amountPaise: 40_000 })]))).toEqual(['ledger_amount_mismatch:confirmed'])
    expect(codes(check(topup(), [row('topup_o1', { organizerUid: 'u2' })]))).toEqual(['ledger_owner_mismatch:confirmed'])
    expect(codes(check(topup(), [row('topup_o1', { paymentId: 'pay_other' })]))).toEqual(['ledger_payment_mismatch:confirmed'])
    expect(codes(check(topup(), [row('topup_o1', { orderId: 'o9' })]))).toEqual(['ledger_order_mismatch:confirmed'])
  })
  it('missing references → inconclusive, never confirmed', () => {
    expect(codes(check(topup(), [row('topup_o1', { paymentId: undefined })]))).toEqual(['ledger_reference_missing:inconclusive'])
    expect(codes(check(topup({ paymentId: undefined })))).toEqual(['credited_without_payment_id:inconclusive'])
    expect(codes(check(topup(), [row('topup_o1', { status: 'pending' })]))).toEqual(['ledger_status_unexpected:inconclusive'])
  })
  it('LEGACY: a credited top-up with no ledger row is inconclusive (Phase-1 credits wrote none) — never a loss', () => {
    expect(codes(check(topup(), []))).toEqual(['credit_without_ledger:inconclusive'])
  })
  it('a credit row without a credited top-up → confirmed; resolved-without-credit → confirmed', () => {
    expect(codes(check(topup({ status: 'pending' }), [row('topup_o1')]))).toEqual(['ledger_without_credit:confirmed'])
    expect(codes(check(topup({ status: 'pending' }), [], { uid: 'u1', status: 'resolved' }))).toEqual(['resolved_without_credit:confirmed'])
  })
  it('holds on a credited top-up: needs_review / exhausted → confirmed (stale hold); retry pending → probable', () => {
    expect(codes(check(topup(), [row('topup_o1')], { uid: 'u1', status: 'needs_review' }))).toEqual(['hold_on_credited_topup:confirmed'])
    expect(codes(check(topup(), [row('topup_o1')], { uid: 'u1', status: 'exhausted' }))).toEqual(['hold_on_credited_topup:confirmed'])
    expect(codes(check(topup(), [row('topup_o1')], { uid: 'u1', status: 'pending' }))).toEqual(['retry_pending_on_credited_topup:probable'])
  })
  it('reconciliation owner / status problems', () => {
    expect(codes(check(topup(), [row('topup_o1')], { uid: 'u2', status: 'resolved' }))).toEqual(['reconciliation_owner_mismatch:confirmed'])
    expect(codes(check(topup(), [row('topup_o1')], { uid: 'u1', status: 'mystery' }))).toEqual(['reconciliation_status_unknown:inconclusive'])
    expect(codes(check(topup(), [row('topup_o1')], { uid: 'u1' }))).toEqual(['reconciliation_status_unknown:inconclusive'])
  })
  it('malformed or unknown top-ups → inconclusive, and nothing else is judged', () => {
    for (const over of [{ uid: undefined }, { amountPaise: 0 }, { amountPaise: '50000' }, { amountPaise: 1.5 }, { status: 7 }]) {
      expect(codes(check(topup(over), [row('topup_o1'), row('x')]))).toEqual(['topup_malformed:inconclusive'])
    }
    expect(codes(check(topup({ status: 'weird' }), [row('topup_o1'), row('x')]))).toEqual(['topup_status_unknown:inconclusive'])
  })
  it('an unexpected row type and truncated evidence are inconclusive; truncation suppresses "no ledger"', () => {
    expect(codes(check(topup(), [row('topup_o1'), row('w', { type: 'whatsapp_charge' })]))).toEqual(['ledger_row_unexpected_type:inconclusive'])
    expect(codes(check(topup(), [], null, false))).toEqual(['ledger_evidence_truncated:inconclusive'])
  })
})

describe('classifyReconciliationRecord', () => {
  it('an existing top-up with a known status → nothing', () => {
    expect(classifyReconciliationRecord({ id: 'o1', data: { orderId: 'o1', status: 'pending' }, topupExists: true })).toEqual([])
  })
  it('no top-up behind it → probable; malformed → inconclusive; unknown status → inconclusive', () => {
    expect(codes(classifyReconciliationRecord({ id: 'dup_p', data: { orderId: 'o_gone', status: 'duplicate_payment' }, topupExists: false })))
      .toEqual(['reconciliation_without_topup:probable'])
    expect(codes(classifyReconciliationRecord({ id: 'x', data: { status: 'pending' }, topupExists: null }))).toEqual(['reconciliation_malformed:inconclusive'])
    expect(codes(classifyReconciliationRecord({ id: 'o1', data: { orderId: 'o1', status: 'odd' }, topupExists: true }))).toEqual(['reconciliation_status_unknown:inconclusive'])
  })
})

// ── per wallet: the ledger chain (rows arrive newest → oldest) ─────────────────────────────────
const L = (id: string, type: string, amountPaise: unknown, balancePaise: unknown, status = 'completed') => ({ id, data: { type, amountPaise, balancePaise, status } })
function walk(walletBalance: unknown, rows: ReturnType<typeof L>[], walkOpts: { allRowsSeen?: boolean; totalRows?: number | null } = {}) {
  let s = startWalletChain('u1', walletBalance === undefined ? null : { balancePaise: walletBalance })
  for (const r of rows) s = stepWalletChain(s, r)
  return finishWalletChain(s, { allRowsSeen: walkOpts.allRowsSeen ?? true, totalRows: walkOpts.totalRows === undefined ? rows.length : walkOpts.totalRows })
}
// history (oldest → newest): top-up +1000 (→1000), whatsapp −200 (→800), licence refund +300 (→1100)
const HISTORY = [L('r3', 'license_refund', 300, 1100), L('r2', 'whatsapp_charge', 200, 800), L('r1', 'fund_added', 1000, 1000)]

describe('wallet chain — balance claims only on a complete, unambiguous history', () => {
  it('an unbroken chain from 0 that ends at the stored balance → verified', () => {
    expect(walk(1100, HISTORY)).toEqual({ verdict: 'verified', finding: null })
  })
  it('an unbroken chain, stored balance differs → balance_mismatch, confirmed, with the delta', () => {
    const v = walk(1500, HISTORY)
    expect(v.verdict).toBe('mismatch')
    expect(v.finding).toMatchObject({ code: 'balance_mismatch', confidence: 'confirmed', detail: { walletBalancePaise: 1500, ledgerBalancePaise: 1100, deltaPaise: 400 } })
  })
  it('LEGACY: a history that does not start from 0 (unledgered past) → inconclusive, even if the balance agrees', () => {
    const legacy = [L('r2', 'whatsapp_charge', 200, 1300), L('r1', 'fund_added', 1000, 1500)]    // 500 existed before r1
    const v = walk(1300, legacy)
    expect(v).toMatchObject({ verdict: 'inconclusive', finding: { code: 'balance_unverifiable', confidence: 'inconclusive', detail: { reason: 'ledger_history_incomplete', balanceBeforeOldestPaise: 500 } } })
  })
  it('a gap between rows → inconclusive (never a confirmed loss)', () => {
    const gap = [L('r2', 'whatsapp_charge', 200, 700), L('r1', 'fund_added', 1000, 1000)]
    expect(walk(700, gap).finding).toMatchObject({ confidence: 'inconclusive', detail: { reason: 'ledger_chain_gap', atRowId: 'r1' } })
  })
  it("an 'adjustment' row makes the wallet unverifiable — its sign is never guessed", () => {
    const adj = [L('r2', 'adjustment', 100, 1100), L('r1', 'fund_added', 1000, 1000)]
    expect(walk(1100, adj).finding).toMatchObject({ confidence: 'inconclusive', detail: { reason: 'ledger_type_ambiguous', atRowId: 'r2' } })
  })
  it('unknown types, malformed rows and non-completed rows → inconclusive', () => {
    expect(walk(1000, [L('r1', 'bonus', 1000, 1000)]).finding?.detail?.reason).toBe('ledger_type_unknown')
    expect(walk(1000, [L('r1', 'fund_added', 0, 1000)]).finding?.detail?.reason).toBe('ledger_row_malformed')
    expect(walk(1000, [L('r1', 'fund_added', 1000, undefined)]).finding?.detail?.reason).toBe('ledger_row_malformed')   // legacy row without running balance
    expect(walk(1000, [L('r1', 'fund_added', 1000, '1000')]).finding?.detail?.reason).toBe('ledger_row_malformed')
    expect(walk(1000, [L('r1', 'fund_added', 1000, 1000, 'pending')]).finding?.detail?.reason).toBe('ledger_row_not_completed')
  })
  it('a truncated walk, or rows the ordered walk could not see, → inconclusive', () => {
    expect(walk(1100, HISTORY, { allRowsSeen: false }).finding?.detail?.reason).toBe('ledger_scan_truncated')
    expect(walk(1100, HISTORY, { totalRows: 4 }).finding).toMatchObject({ detail: { reason: 'ledger_rows_unaccounted', totalRows: 4 } })
  })
  it('a malformed wallet balance → inconclusive; no wallet doc reads as balance 0', () => {
    expect(walk('abc', HISTORY).finding?.detail?.reason).toBe('wallet_malformed')
    expect(walk(1.5, HISTORY).finding?.detail?.reason).toBe('wallet_malformed')
    expect(walk(undefined, [])).toEqual({ verdict: 'verified', finding: null })
  })
  it('no ledger rows: a zero balance is verified; a non-zero balance is unledgered history (inconclusive)', () => {
    expect(walk(0, [])).toEqual({ verdict: 'verified', finding: null })
    expect(walk(500, []).finding).toMatchObject({ confidence: 'inconclusive', detail: { reason: 'ledger_history_incomplete', balanceBeforeOldestPaise: 500 } })
  })
  it('negative balances (allowNegativeBalance) chain correctly', () => {
    const neg = [L('r2', 'broadcast_sms', 300, -100), L('r1', 'fund_added', 200, 200)]
    expect(walk(-100, neg)).toEqual({ verdict: 'verified', finding: null })
  })
  it('once broken, a chain stays broken whatever follows', () => {
    let s = startWalletChain('u1', { balancePaise: 1000 })
    s = stepWalletChain(s, L('r2', 'adjustment', 1, 1000))
    s = stepWalletChain(s, L('r1', 'fund_added', 1000, 1000))
    expect(s).toMatchObject({ broken: 'ledger_type_ambiguous', brokenAtRow: 'r2', rows: 1 })
  })
})

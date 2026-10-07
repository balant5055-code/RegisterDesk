// RD-F2 — a CAPTURED payment on a SUPERSEDED licence order is recorded as a manual-refund hold,
// never granted. Pure predicate + wiring; the behaviour through the real confirm routes and the real
// webhook (ordering, duplicates, concurrency, invalid payments) is in
// tests/emulator/serviceAllowances.emu.test.ts ("F2 ·").

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))
import { isSupersededUnheld } from '@/lib/licensing/manualRefundHold'

const read = (p: string) => readFileSync(p, 'utf8').replace(/\r\n/g, '\n')

describe('isSupersededUnheld', () => {
  it('only a failed + superseded order with no hold (or THIS hold) qualifies', () => {
    expect(isSupersededUnheld({ status: 'failed', failReason: 'superseded' })).toBe(true)
    expect(isSupersededUnheld({ status: 'failed', failReason: 'superseded', manualRefundHoldId: 'license_hold_A' }, 'license_hold_A')).toBe(true)
    for (const o of [
      undefined,
      { status: 'created' }, { status: 'paid' }, { status: 'refunded' },
      { status: 'failed', failReason: 'capacity_stale' },                                   // already its own hold path
      { status: 'failed', failReason: 'superseded', manualRefundHoldId: 'license_hold_OTHER' },
    ]) expect(isSupersededUnheld(o as never, 'license_hold_A'), JSON.stringify(o)).toBe(false)
  })
})

describe('wiring: hold only after the payment is verified; never a grant; one shared hold record', () => {
  const HOLD = read('lib/licensing/manualRefundHold.ts')
  const CAP  = read('app/api/licensing/capacity/confirm/route.ts')
  const CONF = read('app/api/licensing/checkout/confirm/route.ts')
  const WH   = read('app/api/webhooks/razorpay/route.ts')
  it('reuses the SAME manual-refund hold (deterministic id, same kind), re-checking the order IN the transaction', () => {
    expect(HOLD).toContain("reason: 'superseded_paid', source: input.source,")
    expect(HOLD).toContain("failReason: 'superseded',")
    expect(HOLD).toContain('const orderSnap = input.onlyIfOrder ? await txn.get(orderRef) : null')
    expect(HOLD).toContain('&& o?.razorpayOrderId === input.razorpayOrderId')
    expect(HOLD).toContain('&& o?.razorpayAmountPaise === input.amountPaise,')
    expect(HOLD).toContain('const holdId   = `license_hold_${input.orderDocId}`')
  })
  it('capacity confirm: only in the ineligible branch, i.e. AFTER signature + captured/amount/currency/order checks', () => {
    const at = CAP.indexOf('const held = await holdSupersededPayment(')
    expect(at).toBeGreaterThan(CAP.indexOf("if (payment.status !== 'captured' || !matches) {"))
    expect(at).toBeGreaterThan(CAP.indexOf("if (applied.kind === 'ineligible') {"))
  })
  it('add-on confirm: a superseded add-on is verified, then held — activateAddonOrder is never reached', () => {
    const hold = CONF.indexOf('if (supersededAddon) {')
    expect(hold).toBeGreaterThan(CONF.indexOf("if (!verifier.verifySignature({ orderId: aOrderId, paymentId: aPaymentId, signature: aSignature })) {"))
    expect(hold).toBeGreaterThan(CONF.indexOf('if (!ok) {'))
    expect(hold).toBeLessThan(CONF.indexOf('const result = await activateAddonOrder('))
  })
  it('webhook: payment.captured on a superseded order → amount/currency checked → hold; never applied', () => {
    // RD-F3 — the superseded branch now ends where the stale-hold retry-completion branch begins.
    const end = WH.indexOf('// RD-F3 — a capacity order ALREADY made terminal as stale')
    expect(end).toBeGreaterThan(0)
    const block = WH.slice(WH.indexOf('if (isSupersededUnheld(persisted as never'), end)
    expect(block).toContain("if (paymentCurrency !== 'INR' || paymentAmount !== heldAmount || heldAmount <= 0) {")
    expect(block).toContain('const held = await holdSupersededPayment(')
    expect(block).not.toMatch(/applyCapacityChange|activateAddonOrder|activateLicenseOrder|refund\(/)
  })
})

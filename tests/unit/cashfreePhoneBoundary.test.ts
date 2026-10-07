// RD-PAYMENT-CASHFREE-SANDBOX-05A — the Cashfree phone requirement, and its blast radius.
//
// ═══ THE PRODUCT DECISION BEING PINNED ═══════════════════════════════════════
// Cashfree refuses an order without a 10-digit `customer_phone`. RegisterDesk treats the
// attendee phone as optional — except where an event sets `limitPerMobile`, which already
// demands one.
//
// Making phone mandatory platform-wide to satisfy one gateway would change the product for
// every Razorpay event and every existing form. So the requirement is scoped to the Cashfree
// path. These cases exist to prove that scoping holds in BOTH directions: Cashfree refuses
// without a usable number, and Razorpay is entirely unaffected.
//
// The refusal behaviour matters as much as the validation. A payment provider that "helps"
// by substituting a placeholder sends real payment SMS and receipts to whoever owns that
// number. Every rejection path below is asserted to reject rather than improvise.

import { describe, it, expect } from 'vitest'
import { toCashfreeCustomerPhone } from '@/lib/payments/providers/cashfreeAdapter'
import { normalizePhoneNumber } from '@/lib/communication/phone'
import { readFileSync } from 'node:fs'

describe('RD-PAYMENT-CASHFREE-SANDBOX-05A · Cashfree customer phone', () => {
  describe('accepts what it can derive truthfully', () => {
    it.each([
      ['bare 10-digit national', '9363935055',      '9363935055'],
      ['+91 with spaces',        '+91 93639 35055', '9363935055'],
      ['91 prefix, no plus',     '919363935055',    '9363935055'],
      ['trunk zero',             '09363935055',     '9363935055'],
      ['hyphenated',             '93639-35055',     '9363935055'],
      ['already normalized',     '919363935055',    '9363935055'],
    ])('%s → %s', (_label, input, expected) => {
      expect(toCashfreeCustomerPhone(input)).toEqual({ ok: true, phone: expected })
    })

    it('is idempotent through the canonical normalizer', () => {
      // Reuse, not reimplementation: lib/communication/phone.ts is the documented single
      // source of truth, so its output must round-trip through this without drifting.
      const once = normalizePhoneNumber('93639 35055')
      expect(toCashfreeCustomerPhone(once)).toEqual({ ok: true, phone: '9363935055' })
    })
  })

  describe('refuses — and NEVER substitutes', () => {
    it.each([
      ['missing',        undefined],
      ['null',           null],
      ['empty',          ''],
      ['whitespace',     '   '],
      ['too short',      '93639'],
      ['too long',       '9363935055123456'],
      ['letters',        'not-a-phone'],
      ['landline-style', '4412345678'],   // Indian mobiles start 6-9
    ])('%s is rejected', (_label, input) => {
      const r = toCashfreeCustomerPhone(input as string | undefined)
      expect(r.ok).toBe(false)
      expect('reason' in r && r.reason).toBeTruthy()
    })

    it('refuses a NON-INDIAN number rather than truncating it', () => {
      // Taking the last 10 digits of a country code we do not handle would produce a real
      // number belonging to somebody else — and the gateway would accept it silently.
      const r = toCashfreeCustomerPhone('+1 650 555 1234')
      expect(r.ok).toBe(false)
      expect('reason' in r && r.reason).toMatch(/Indian/i)
    })

    it('never returns a placeholder, the support number, or zeros', () => {
      const FORBIDDEN = ['0000000000', '9999999999', '1234567890']
      for (const bad of ['', 'abc', '123', undefined]) {
        const r = toCashfreeCustomerPhone(bad as string | undefined)
        expect(r.ok).toBe(false)
        if ('phone' in r) expect(FORBIDDEN).not.toContain((r as { phone: string }).phone)
      }
    })
  })

  describe('blast radius — the gate is Cashfree-only', () => {
    it('create-order applies it ONLY on the cashfree path', () => {
      const src = readFileSync('app/api/registrations/create-order/route.ts', 'utf8')
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((l: string) => !l.trim().startsWith('//')).join('\n')
      // Guarded by the provider, not applied unconditionally.
      expect(code).toMatch(/if \(provider === 'cashfree'\)/)
      const guard = code.indexOf("if (provider === 'cashfree')")
      const call  = code.indexOf('toCashfreeCustomerPhone(')
      expect(call).toBeGreaterThan(guard)
    })

    it('the check runs BEFORE any provider order is opened', () => {
      // A rejection must leave nothing behind: no gateway order, no intent, no registration.
      const src = readFileSync('app/api/registrations/create-order/route.ts', 'utf8')
      const check = src.indexOf('toCashfreeCustomerPhone(')
      const open  = src.indexOf('.createOrder({')
      const intent = src.indexOf('await createPaymentIntent({')
      expect(check).toBeGreaterThan(-1)
      expect(check).toBeLessThan(open)
      expect(check).toBeLessThan(intent)
    })

    it('RAZORPAY REGRESSION — the existing optional-phone contract is untouched', () => {
      const src = readFileSync('app/api/registrations/create-order/route.ts', 'utf8')
      // The ONLY pre-existing phone requirement remains the event-level limitPerMobile rule.
      expect(src).toMatch(/regRules\?\.limitPerMobile && !attendee\.phone\?\.trim\(\)/)
      // And the intent still OMITS the field entirely when absent (RD-PAY-P0-1: an explicit
      // `undefined` makes the Admin SDK reject the whole write).
      expect(src).toMatch(/attendee\.phone\?\.trim\(\) \? \{ phone: attendee\.phone\.trim\(\) \} : \{\}/)
    })

    it('the payment intent still models phone as OPTIONAL', () => {
      const src = readFileSync('lib/firebase/firestore/paymentIntents.ts', 'utf8')
      expect(src).toMatch(/phone\?:\s+string/)
    })
  })
})

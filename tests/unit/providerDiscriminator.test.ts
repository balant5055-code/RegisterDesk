// RD-PAYMENT-PROVIDER-CONTRACT-04 — the provider discriminator, and its asymmetry.
//
// ═══ THE RULE, AND WHY IT IS NOT SYMMETRIC ═══════════════════════════════════
//   READS  — a record with no `provider` is Razorpay. That is a statement of fact: Razorpay
//            was the only possibility when it was written. It means zero backfill.
//   WRITES — a new payment must name its provider. Never inferred, never defaulted.
//
// The asymmetry is the safety property. A default on the write side would mean routing an
// attendee's money to a gateway nobody chose, and doing it silently — the failure would only
// surface when the money was already somewhere unexpected.
//
// The write half is enforced by the compiler (`provider` is required on
// `PaymentIntentRecord`, and `createPaymentIntent` takes `Omit<…>` of it), so the cases here
// pin the read half and prove the compile-time guarantee is actually in the type.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readProvider, LEGACY_PROVIDER, PAYMENT_PROVIDERS } from '@/lib/payments/providers/types'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

describe('RD-PAYMENT-PROVIDER-CONTRACT-04 · provider discriminator', () => {
  describe('reads — historical records stay readable', () => {
    it('an absent provider reads as razorpay', () => {
      expect(readProvider(undefined)).toBe('razorpay')
      expect(readProvider(null)).toBe('razorpay')
      expect(LEGACY_PROVIDER).toBe('razorpay')
    })

    it('a known provider is preserved exactly', () => {
      for (const p of PAYMENT_PROVIDERS) expect(readProvider(p)).toBe(p)
    })

    it('an unrecognised value reads as the legacy provider, not as itself', () => {
      // Garbage must not become a provider id that later fails to resolve deep inside a
      // settlement. Anything unknown is treated as the only provider that can have written it.
      for (const junk of ['stripe', '', 0, {}, [], true]) {
        expect(readProvider(junk)).toBe('razorpay')
      }
    })

    it('getPaymentIntent normalizes the stored value rather than trusting the cast', () => {
      const src = read('lib/firebase/firestore/paymentIntents.ts')
      expect(src).toMatch(/readProvider\(\(data as \{ provider\?: unknown \}\)\.provider\)/)
    })
  })

  describe('writes — a new payment must name its provider', () => {
    it('provider is REQUIRED on the payment intent record', () => {
      // Not `provider?:`. createPaymentIntent takes Omit<PaymentIntentRecord, …>, so a
      // required field makes an unnamed provider a compile error at every new-payment site.
      const src = read('lib/firebase/firestore/paymentIntents.ts')
      expect(src).toMatch(/^\s+provider:\s+PaymentProvider$/m)
      expect(src).not.toMatch(/^\s+provider\?:\s+PaymentProvider$/m)
    })

    it('create-order assigns the provider explicitly, not from a stored record', () => {
      const src = read('app/api/registrations/create-order/route.ts')
      // Phase B — resolved through the admin gateway switch. Still explicit, still assigned
      // at creation, and still never read back off a stored record.
      expect(src).toMatch(/const resolution = await resolveActivePaymentProviderForNewOrder\(\)/)
      expect(src).toMatch(/const provider\s+=\s+resolution\.provider/)
      expect(src).toMatch(/createPaymentIntent\(\{\s*\r?\n\s*orderId,\r?\n\s*provider,/)
    })

    it('an EXISTING order is queried at its own provider, not the active one', () => {
      // The subtle one. Reusing ACTIVE_PAYMENT_PROVIDER to ask about an order created
      // earlier would, after a provider switch, ask the wrong gateway whether money exists —
      // and a "no" from the wrong gateway looks exactly like an unpaid order.
      const src = read('app/api/registrations/create-order/route.ts')
      expect(src).toMatch(/findCapturedRegistrationPayment\(\s*\r?\n?\s*claim\.orderId,\s*existing\.amount,\s*existing\.provider,?\s*\r?\n?\s*\)/)
    })
  })

  describe('ledger', () => {
    it('provider is OPTIONAL on the TYPE, and always stamped on a NEW row', () => {
      // Still optional on the type — historical documents have no provider and must stay
      // readable. `readProvider` is what interprets their absence.
      expect(read('lib/fees/types.ts')).toMatch(/provider\?:\s*PaymentProvider/)

      // Phase A — the WRITE is no longer conditional. It used to be
      // `...(src.provider ? { provider: src.provider } : {})`, which left the field absent
      // whenever a caller did not supply one, while `gateway` was separately hardcoded to
      // 'razorpay'. Both now come from ONE normalized value, so a new row always states its
      // provider and the two fields cannot disagree. A caller that supplies nothing still
      // records 'razorpay' — the same meaning absence carried, now written down.
      const ledger = read('lib/payments/registrationLedger.ts')
      expect(ledger).toMatch(/const ledgerProvider = readProvider\(src\.provider\)/)
      expect(ledger).toMatch(/provider:\s+ledgerProvider/)
      expect(ledger).toMatch(/gateway:\s+ledgerProvider/)
      expect(ledger).not.toMatch(/gateway:\s*'razorpay'/)
    })

    it('settlement passes the intent\'s provider through without interpreting it', () => {
      const src = read('lib/payments/settleCapturedRegistration.ts')
      expect(src).toMatch(/provider:\s+intent\.provider/)
      // It must never branch on which provider it is — that is what keeps it independent.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
      expect(code).not.toMatch(/intent\.provider\s*===/)
    })
  })
})

// RD-PAYMENT-CHECKOUT-COPY-06.1 — the attendee checkout never names a gateway.
//
// ═══ WHY THIS IS A CORRECTNESS TEST, NOT A STYLE ONE ═════════════════════════
// The checkout used to promise "Encrypted payment via Razorpay" on every paid registration.
// RD-PAYMENT-CASHFREE-CHECKOUT-06 made the gateway a SERVER decision, so that sentence
// became a claim the page cannot substantiate: an order routed to Cashfree would still have
// told the attendee their money was going through Razorpay, on the screen where they decide
// to hand it over.
//
// The fix is provider-neutral wording rather than a provider-aware label, because these
// lines render BEFORE an order exists — there is no provider to name at that moment, and
// inventing a mechanism to carry one into a trust footnote would be the wrong trade.
//
// ═══ THE BOUNDARY THIS ALSO DEFENDS ══════════════════════════════════════════
// Razorpay is named legitimately elsewhere: licensing, wallet top-ups and media credits are
// Razorpay-ONLY by a frozen product decision, so their copy is accurate and must not be
// "fixed". This file asserts the split in both directions.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8')

/** Source with comments stripped — a comment explaining the old copy is not the copy. */
const rendered = (p: string) => read(p)
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')     // JSX comments
  .replace(/\/\*[\s\S]*?\*\//g, '')         // block comments
  .split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
  .join('\n')

// The attendee-facing checkout surface, and nothing else.
const CHECKOUT = [
  'app/events/[slug]/register/RegisterClient.tsx',
  'app/events/[slug]/register/CheckoutPanels.tsx',
  'app/events/[slug]/register/RegistrationUI.tsx',
]

describe('RD-PAYMENT-CHECKOUT-COPY-06.1 · the attendee checkout names no gateway', () => {
  it('none of the four provider-specific strings survives', () => {
    // Exactly the strings RD-PAYMENT-CASHFREE-CHECKOUT-06 found, listed individually so a
    // failure says WHICH one came back.
    const gone = [
      'Encrypted payment via Razorpay',
      'Secured by Razorpay',
      'You will be taken to Razorpay',
      'Secure payment via Razorpay',
    ]
    for (const file of CHECKOUT) {
      const src = rendered(file)
      for (const phrase of gone) {
        expect(src, `${file} still renders "${phrase}"`).not.toContain(phrase)
      }
    }
  })

  it('no VISIBLE string in the checkout mentions a payment provider by name', () => {
    // Broader than the four known phrases: catches a new one being introduced. Only string
    // and JSX-text occurrences count — identifiers like `prefetchRazorpay` are code.
    for (const file of CHECKOUT) {
      const src = rendered(file)
      const offenders = src.split('\n').filter(raw => {
        // The DISCRIMINANT literals are code: `provider: 'razorpay'` is the contract's own
        // vocabulary, not a sentence shown to anybody. Remove them first, then ask whether a
        // provider name still appears — what survives is prose.
        const line = raw.replace(/(['"`])(razorpay|cashfree)\1/g, '$1$1')
        if (!/Razorpay|Cashfree/i.test(line)) return false
        // Code, not copy: imports, types, identifiers, object keys, URLs.
        if (/^\s*(import|export|type|interface)\b/.test(line)) return false
        if (/Razorpay(CheckoutPayload|PaymentSuccess)|prefetchRazorpay|window\.Razorpay/.test(line)) return false
        if (/razorpay_(order|payment|signature)/.test(line)) return false
        if (/checkout\.razorpay\.com|api\.razorpay\.com/.test(line)) return false
        // What remains that looks like prose between tags or in a quoted string.
        return /['"`>][^'"`<]*(Razorpay|Cashfree)/i.test(line)
      })
      expect(offenders, `${file} has visible provider copy:\n${offenders.join('\n')}`).toEqual([])
    }
  })

  it('the replacement wording is actually present, in all three places', () => {
    // A test that only asserts absence would pass if the line were deleted outright, which
    // would quietly remove a trust signal from the payment screen.
    const client = rendered('app/events/[slug]/register/RegisterClient.tsx')
    const panels = rendered('app/events/[slug]/register/CheckoutPanels.tsx')
    // Two in RegisterClient (the closing strip and the line under the CTA).
    expect(client.split('Encrypted, secure payment').length - 1).toBe(2)
    expect(panels).toContain('Encrypted, secure payment')
    expect(panels).toContain('You will be taken to a secure payment page to complete payment')
  })

  it('the free path keeps its own, different reassurance', () => {
    // 'Your details are sent securely' is for a FREE registration, where no payment happens
    // at all. Collapsing the two would promise encryption of a payment that never occurs.
    const client = rendered('app/events/[slug]/register/RegisterClient.tsx')
    expect(client).toContain('Your details are sent securely')
    expect(client).toMatch(/isPaid \? 'Encrypted, secure payment' : 'Your details are sent securely'/)
  })
})

describe('RD-PAYMENT-CHECKOUT-COPY-06.1 · Razorpay-only surfaces are LEFT ALONE', () => {
  // These domains take money through Razorpay and only Razorpay (licensing is Razorpay-only
  // by a frozen decision). Naming it there is accurate, and a well-meaning sweep that
  // neutralised them would delete true information.
  it.each([
    // RD-COMMS-P1 — the communication-balance top-up dialog (CommunicationBalanceCard) was removed with
    // the retired top-up path; that card is now a read-only legacy-balance notice with no payment.
    // RD-PHOTO-01 — BuyCreditsDialog was removed with the retired Media Credits purchase path.
    ['components/wizard/ActivationPaymentPanel.tsx', 'Razorpay'],
  ])('%s still says "%s"', (file, phrase) => {
    expect(read(file)).toContain(phrase)
  })
})

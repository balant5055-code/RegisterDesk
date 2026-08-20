// RD-RECOVER-01 · the orphaned-capture recovery path.
//
// This function is the only door in the system that can settle a payment intent the normal
// flow has already given up on, so the tests that matter most are the REFUSALS. Every one of
// them must abort before a single write, and none of them may refund: an already-captured
// legitimate payment must never be handed back because our own settlement was missed.
//
// The second thing pinned here is that the door is narrow. The caller has to state the order,
// the payment, the amount, the event, the pass and the phone up front, and every one is
// re-verified — the amount and payment against Razorpay, the rest against the stored intent.
// A single mismatch aborts, which is what stops this being a general-purpose "force settle".

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

let rzpPayments: Array<Doc> = []
let rzpThrows   = false
let intent: Doc | null = null
/** Registrations returned by each query shape, keyed by the field queried. */
let regsByField: Record<string, Doc[]> = {}

/** Every settleCapturedRegistration call — the proof that writes were or were not reached. */
const settleCalls: Doc[] = []

vi.mock('@/lib/razorpay/client', () => ({
  razorpay: {
    orders: {
      fetchPayments: async () => {
        if (rzpThrows) throw new Error('network down')
        return { items: rzpPayments }
      },
    },
  },
}))

vi.mock('@/lib/firebase/firestore/paymentIntents', () => ({
  getPaymentIntent: async () => intent,
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: () => {
      let field = ''
      const q: Doc = {
        where: (f: string) => { if (!field || f !== 'eventSlug') field = f; return q },
        limit: () => q,
        get: async () => {
          const hits = regsByField[field] ?? []
          return { empty: hits.length === 0, docs: hits.map((h, i) => ({ id: `reg-${i}`, data: () => h })) }
        },
      }
      return q
    },
  },
}))

vi.mock('@/lib/payments/settleCapturedRegistration', () => ({
  settleCapturedRegistration: async (args: Doc) => {
    settleCalls.push(args)
    return { kind: 'settled', registrationId: 'new-reg-1' }
  },
}))

const { recoverOrphanedCapture } = await import('@/lib/payments/recoverOrphanedCapture')

const TARGET = {
  orderId:             'order_TS6MJY6uL9NgCw',
  paymentId:           'pay_TS6MPmXBJ9hSj',
  expectedAmountPaise: 51840,
  expectedEventSlug:   'noyyal-marathon-2026',
  expectedPassId:      'pass_riwintpf',
  expectedPhone:       '9994349808',
}

const goodIntent = (over: Doc = {}): Doc => ({
  orderId: TARGET.orderId, status: 'registration_failed', amount: 51840,
  eventSlug: 'noyyal-marathon-2026', passId: 'pass_riwintpf',
  attendee: { name: 'S.P. PRITHIVIK', phone: '9994349808', email: 'srini.tex@gmail.com' },
  ...over,
})

beforeEach(() => {
  rzpThrows   = false
  rzpPayments = [{ id: 'pay_TS6MPmXBJ9hSj', status: 'captured', amount: 51840, currency: 'INR' }]
  intent      = goodIntent()
  regsByField = {}
  settleCalls.length = 0
})

const noWrites = () => expect(settleCalls).toEqual([])

// ─── The happy path ───────────────────────────────────────────────────────────

describe('a verified orphaned capture is settled through the normal transaction', () => {
  it('accepts and delegates', async () => {
    const r = await recoverOrphanedCapture(TARGET)
    expect(r.ok).toBe(true)
    expect(settleCalls).toHaveLength(1)
  })

  it('passes the recovery authorization, bound to the SAME paymentId', async () => {
    await recoverOrphanedCapture(TARGET)
    expect(settleCalls[0].recovery).toEqual({ verifiedCapturedPaymentId: 'pay_TS6MPmXBJ9hSj' })
    expect(settleCalls[0].paymentId).toBe('pay_TS6MPmXBJ9hSj')
    expect(settleCalls[0].orderId).toBe('order_TS6MJY6uL9NgCw')
  })

  it('constructs no registration, ticket, counter or wallet write of its own', async () => {
    await recoverOrphanedCapture(TARGET)
    // The ONLY thing it does is call the settlement transaction.
    expect(Object.keys(settleCalls[0]).sort())
      .toEqual(['intent', 'orderId', 'paymentId', 'recovery', 'source'])
  })
})

// ─── Razorpay verification ────────────────────────────────────────────────────

describe('Razorpay is the authority on whether money was taken', () => {
  it('rejects a payment that is not on this order', async () => {
    rzpPayments = [{ id: 'pay_SOMEONE_ELSE', status: 'captured', amount: 51840, currency: 'INR' }]
    const r = await recoverOrphanedCapture(TARGET)
    expect(r).toMatchObject({ ok: false, reason: 'payment_not_on_order' })
    noWrites()
  })

  it.each([['authorized'], ['failed'], ['created'], ['refunded']])(
    'rejects a payment in status %s — only captured counts', async (status) => {
      rzpPayments = [{ id: TARGET.paymentId, status, amount: 51840, currency: 'INR' }]
      const r = await recoverOrphanedCapture(TARGET)
      expect(r).toMatchObject({ ok: false, reason: 'payment_not_captured' })
      noWrites()
    })

  it('rejects an amount mismatch at Razorpay', async () => {
    rzpPayments = [{ id: TARGET.paymentId, status: 'captured', amount: 25920, currency: 'INR' }]
    const r = await recoverOrphanedCapture(TARGET)
    expect(r).toMatchObject({ ok: false, reason: 'razorpay_amount_mismatch' })
    noWrites()
  })

  it('rejects a non-INR capture', async () => {
    rzpPayments = [{ id: TARGET.paymentId, status: 'captured', amount: 51840, currency: 'USD' }]
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'currency_mismatch' })
    noWrites()
  })

  it('an unreachable Razorpay aborts — it never assumes capture', async () => {
    rzpThrows = true
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'razorpay_unreachable' })
    noWrites()
  })

  it('an order with no payments at all is refused', async () => {
    rzpPayments = []
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'payment_not_on_order' })
    noWrites()
  })
})

// ─── Intent verification — the narrowness of the door ────────────────────────

describe('the intent must be the specific orphan named by the caller', () => {
  it('rejects a missing intent', async () => {
    intent = null
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'intent_not_found' })
    noWrites()
  })

  it.each([['created'], ['paid'], ['failed'], ['attempt_failed']])(
    'rejects an intent in status %s — only registration_failed is an orphan', async (status) => {
      intent = goodIntent({ status })
      const r = await recoverOrphanedCapture(TARGET)
      expect(r).toMatchObject({ ok: false, reason: 'intent_not_orphaned' })
      noWrites()
    })

  it('rejects an intent that already carries a registrationId', async () => {
    intent = goodIntent({ registrationId: 'existing-reg' })
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'intent_already_settled' })
    noWrites()
  })

  it('rejects a WRONG EVENT', async () => {
    intent = goodIntent({ eventSlug: 'some-other-event' })
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'event_mismatch' })
    noWrites()
  })

  it('rejects a WRONG PASS', async () => {
    intent = goodIntent({ passId: 'pass_11y5jsvd' })
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'pass_mismatch' })
    noWrites()
  })

  it('rejects an intent amount that disagrees with the expectation', async () => {
    intent = goodIntent({ amount: 25920 })
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'intent_amount_mismatch' })
    noWrites()
  })

  it('rejects a phone mismatch — the attendee must be the one named', async () => {
    intent = goodIntent({ attendee: { name: 'X', phone: '9999999999', email: 'srini.tex@gmail.com' } })
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'phone_mismatch' })
    noWrites()
  })
})

// ─── Idempotency / duplicate protection ──────────────────────────────────────

describe('duplicates are impossible', () => {
  it('refuses when a registration already exists for the order', async () => {
    regsByField.razorpayOrderId = [{ id: 'existing' }]
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'registration_exists' })
    noWrites()
  })

  it('refuses when a registration already exists for the payment', async () => {
    regsByField.paymentId = [{ id: 'existing' }]
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'registration_exists_for_payment' })
    noWrites()
  })

  it('refuses when the PHONE already has a registration on this event', async () => {
    regsByField['attendee.phone'] = [{ id: 'existing' }]
    expect(await recoverOrphanedCapture(TARGET)).toMatchObject({ ok: false, reason: 'registration_exists_for_phone' })
    noWrites()
  })

  it('a second run after settlement is refused by the intent check', async () => {
    expect((await recoverOrphanedCapture(TARGET)).ok).toBe(true)
    // After the first run the intent is paid + linked; the second run sees that.
    intent = goodIntent({ status: 'paid', registrationId: 'new-reg-1' })
    const second = await recoverOrphanedCapture(TARGET)
    expect(second).toMatchObject({ ok: false, reason: 'intent_not_orphaned' })
    expect(settleCalls).toHaveLength(1)   // no second settlement ⇒ no second wallet credit
  })

  it('never refunds and never captures — no such call is reachable from here', async () => {
    const src = (await import('node:fs')).readFileSync('lib/payments/recoverOrphanedCapture.ts', 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/refund/i)
    expect(src).not.toMatch(/\.capture\(/)
  })
})

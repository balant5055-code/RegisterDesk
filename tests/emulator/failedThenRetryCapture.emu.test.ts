// RD-PAY-P0-6 — a payment that FAILS, is RETRIED on the same Razorpay order, and then
// captures, must still produce exactly one registration.
// REAL Firestore (emulator) — the claim is about persisted intent state, so only a real
// datastore can answer it.
//
// THE BUG THIS PINS. Razorpay's checkout retry reuses the SAME order (RegisterClient
// retryPayment → runPayment(rec.order)). The `payment.failed` webhook marked the intent
// `registration_failed` — a status every guard reads as "already refunded / closed":
//
//   verify-payment 4b        → refuses          (client signature is not enough)
//   webhook 6.5              → skips
//   settleCapturedRegistration → deferred:intent_terminal
//   capture sweep            → scanned `created` ONLY, so never looked
//
// The retry's capture therefore landed on an intent nothing would ever settle: money taken,
// no registration, and no refund either — permanent, with no automatic recovery.
//
// The fix separates the two meanings. `attempt_failed` = this ATTEMPT failed, the ORDER is
// still payable. `registration_failed` keeps its original meaning (refunded / closed).
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const gw = vi.hoisted(() => ({
  payments: new Map<string, Array<{ id: string; status: string; amount: number; currency: string }>>(),
  refunds:  [] as Array<{ paymentId: string; amount: number }>,
  failFetch: false,
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub', RAZORPAY_KEY_SECRET: 'stub',
  razorpay: {
    orders: {
      fetchPayments: async (orderId: string) => {
        if (gw.failFetch) throw new Error('razorpay unreachable')
        return { items: gw.payments.get(orderId) ?? [] }
      },
    },
    payments: {
      refund: async (paymentId: string, o: { amount: number }) => {
        gw.refunds.push({ paymentId, amount: o.amount })
        return { id: `rfnd_${gw.refunds.length}`, status: 'processed' }
      },
    },
  },
}))

vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({ sendConfirmationEmail: async () => {} }))
vi.mock('@/lib/firebase/firestore/platformTransactions', () => ({
  recordPlatformTransactionAndCredit: async () => {}, reversePlatformTransactionAndDebit: async () => {},
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {},
  flushMonitoring: async () => {},
}))

let adminDb: import('firebase-admin/firestore').Firestore
let settleCapturedRegistration: typeof import('@/lib/payments/settleCapturedRegistration')['settleCapturedRegistration']
let recoverCapturedPaymentIntents: typeof import('@/lib/payments/registrationReconciliation')['recoverCapturedPaymentIntents']
let markPaymentIntentAttemptFailed: typeof import('@/lib/firebase/firestore/paymentIntents')['markPaymentIntentAttemptFailed']
let markPaymentIntentFailed: typeof import('@/lib/firebase/firestore/paymentIntents')['markPaymentIntentFailed']

const SLUG = 'p06-retry-event'
const PASS = 'pass-a'
let seq = 0

async function seedEvent() {
  await adminDb.collection('events').doc(SLUG).set({
    slug: SLUG, uid: 'org-p06', draftId: 'd-p06',
    lifecycleStatus: 'published', totalCapacity: null, capacityPlan: 'unlimited', planType: 'paid_event',
    eventDetails: {
      info: { name: 'P0-6 Retry Event' },
      schedule: { startDate: '2099-01-01', endDate: '2099-01-02', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Kolkata' },
    },
    pricing: { passes: [{ id: PASS, name: 'Pass A', price: 100, status: 'active', unlimited: true, quantity: null }] },
    registrationForm: { sections: [], conditionalRules: [], registrationRules: {} },
    accessControl: { type: 'public', confirmationMode: 'auto' },
  })
  await adminDb.collection('registrationCounters').doc(SLUG).set({
    eventSlug: SLUG, totalCount: 0, passCounts: {}, revenuePaise: 0, statsVersion: 3,
  })
}

/** An intent whose order is old enough to be past the sweep's 10-minute grace. */
async function seedIntent(ageMinutes = 20) {
  const orderId = `order_P06_${++seq}`
  await adminDb.collection('paymentIntents').doc(orderId).set({
    orderId, eventSlug: SLUG, passId: PASS, passName: 'Pass A', passCapacity: null,
    eventName: 'P0-6 Retry Event', organizerUid: 'org-p06',
    amount: 10000, currency: 'INR',
    attendee: { name: 'Priya', email: `p06_${seq}@example.com`, formResponses: {} },
    status: 'created',
    createdAt: Timestamp.fromMillis(Date.now() - ageMinutes * 60_000),
    updatedAt: Timestamp.now(),
  })
  return orderId
}

const readIntent = async (o: string) => (await adminDb.collection('paymentIntents').doc(o).get()).data()
const capture = (orderId: string, amount = 10000) => {
  const id = `pay_P06_${orderId}`
  gw.payments.set(orderId, [{ id, status: 'captured', amount, currency: 'INR' }])
  return id
}
const regCount = async (slug = SLUG) =>
  (await adminDb.collection('registrations').where('eventSlug', '==', slug).get()).size

describeEmu('RD-PAY-P0-6 · failed attempt → retry on the same order → capture', () => {
  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ settleCapturedRegistration } = await import('@/lib/payments/settleCapturedRegistration'))
    ;({ recoverCapturedPaymentIntents } = await import('@/lib/payments/registrationReconciliation'))
    ;({ markPaymentIntentAttemptFailed, markPaymentIntentFailed } =
      await import('@/lib/firebase/firestore/paymentIntents'))
  })

  beforeEach(async () => {
    gw.payments.clear(); gw.refunds.length = 0; gw.failFetch = false
    for (const c of ['events', 'registrationCounters', 'paymentIntents', 'registrations', 'registrationClaims', 'ticketCodeClaims']) {
      const s = await adminDb.collection(c).limit(300).get()
      await Promise.all(s.docs.map(d => d.ref.delete()))
    }
    await seedEvent()
  })

  // ── 1 ─────────────────────────────────────────────────────────────────────
  it('1 · payment.failed → retry → captured → registration SUCCEEDS via verify', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed:BAD_CARD:declined')
    expect((await readIntent(orderId))?.status).toBe('attempt_failed')

    const paymentId = capture(orderId)
    const out = await settleCapturedRegistration({
      orderId, paymentId, intent: await readIntent(orderId) as never, source: 'verify',
    })

    expect(out.kind).toBe('settled')                     // ← THE REGRESSION (was 'deferred')
    expect(await regCount()).toBe(1)
    expect((await readIntent(orderId))?.status).toBe('paid')
    expect(gw.refunds).toHaveLength(0)
  }, 30_000)

  // ── 2 ─────────────────────────────────────────────────────────────────────
  it('2 · client verification never happens → the WEBHOOK recovers it', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed')
    const paymentId = capture(orderId)

    const out = await settleCapturedRegistration({
      orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook',
    })
    expect(out.kind).toBe('settled')
    expect(await regCount()).toBe(1)
  }, 30_000)

  // ── 3 ─────────────────────────────────────────────────────────────────────
  it('3 · browser closes after the retry capture → the SWEEP recovers it', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed')
    capture(orderId)

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.recovered).toBeGreaterThanOrEqual(1)
    expect(await regCount()).toBe(1)
    expect((await readIntent(orderId))?.status).toBe('paid')
  }, 30_000)

  // ── 4 ─────────────────────────────────────────────────────────────────────
  it('4 · failed attempt with NO retry stays harmless — no registration, no refund', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed')
    gw.payments.set(orderId, [])                          // Razorpay holds nothing

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.recovered).toBe(0)
    expect(res.unpaid).toBeGreaterThanOrEqual(1)
    expect(await regCount()).toBe(0)
    expect(gw.refunds).toHaveLength(0)
  }, 30_000)

  // ── 5 ─────────────────────────────────────────────────────────────────────
  it('5 · pure dismissal (intent stays `created`) → retry → captured → succeeds', async () => {
    const orderId = await seedIntent()                    // no failure marker at all
    const paymentId = capture(orderId)
    const out = await settleCapturedRegistration({
      orderId, paymentId, intent: await readIntent(orderId) as never, source: 'verify',
    })
    expect(out.kind).toBe('settled')
    expect(await regCount()).toBe(1)
  }, 30_000)

  // ── 6 ─────────────────────────────────────────────────────────────────────
  it('6 · duplicate webhook after a successful settlement is a no-op', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed')
    const paymentId = capture(orderId)

    const a = await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source: 'verify' })
    const b = await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook' })

    expect(a.kind).toBe('settled')
    expect(b.kind).toBe('already_settled')
    expect(await regCount()).toBe(1)                      // exactly one
  }, 30_000)

  // ── 7 ─────────────────────────────────────────────────────────────────────
  it('7 · verify + webhook + sweep CONCURRENTLY produce exactly one registration', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed')
    const paymentId = capture(orderId)
    const intent = await readIntent(orderId)

    const [v, w] = await Promise.all([
      settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'verify' }),
      settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'webhook' }),
    ])
    await recoverCapturedPaymentIntents(50)

    expect([v.kind, w.kind].filter(k => k === 'settled')).toHaveLength(1)
    expect(await regCount()).toBe(1)
  }, 30_000)

  // ── 8 ─────────────────────────────────────────────────────────────────────
  it('8 · a genuinely REFUNDED intent is never registered — not even by the sweep', async () => {
    const orderId = await seedIntent()
    await adminDb.collection('paymentIntents').doc(orderId).update({
      status: 'registration_failed', refundId: 'rfnd_prior', refundStatus: 'processed',
    })
    capture(orderId)   // Razorpay would still report the original capture

    const direct = await settleCapturedRegistration({
      orderId, paymentId: 'pay_x', intent: await readIntent(orderId) as never,
      source: 'sweep', capturedByServer: true,          // even the strongest caller
    })
    expect(direct.kind).toBe('deferred')
    expect((direct as { reason: string }).reason).toBe('intent_refunded')

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.recovered).toBe(0)
    expect(await regCount()).toBe(0)
  }, 30_000)

  it('8b · a terminal intent is still refused on the CLIENT paths', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentFailed(orderId, 'gate_blocked')   // genuine terminal, no refund yet
    capture(orderId)

    for (const source of ['verify', 'webhook'] as const) {
      const out = await settleCapturedRegistration({
        orderId, paymentId: 'pay_y', intent: await readIntent(orderId) as never, source,
      })
      expect(out.kind).toBe('deferred')
      expect((out as { reason: string }).reason).toBe('intent_terminal')
    }
    expect(await regCount()).toBe(0)
  }, 30_000)

  // ── 9 ─────────────────────────────────────────────────────────────────────
  it('9 · a payment on a DIFFERENT order never settles this intent', async () => {
    const mine  = await seedIntent()
    const other = await seedIntent()
    await markPaymentIntentAttemptFailed(mine, 'payment_failed')
    capture(other)                     // money exists, but on someone else's order
    gw.payments.set(mine, [])

    const res = await recoverCapturedPaymentIntents(50)
    const settledMine = (await readIntent(mine))?.status
    expect(settledMine).not.toBe('paid')
    expect(res.recovered).toBeLessThanOrEqual(1)          // only `other` could recover
  }, 30_000)

  // ── 10 ────────────────────────────────────────────────────────────────────
  it('10 · an AMOUNT MISMATCH never settles the registration', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed')
    gw.payments.set(orderId, [{ id: 'pay_wrong', status: 'captured', amount: 500, currency: 'INR' }])

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.recovered).toBe(0)
    expect(res.unpaid).toBeGreaterThanOrEqual(1)
    expect(await regCount()).toBe(0)
  }, 30_000)

  it('a Razorpay outage leaves the intent recoverable — fail-closed, never "unpaid"', async () => {
    const orderId = await seedIntent()
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed')
    capture(orderId)
    gw.failFetch = true

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.uncertain).toBeGreaterThanOrEqual(1)
    expect(res.recovered).toBe(0)
    expect((await readIntent(orderId))?.status).toBe('attempt_failed')   // still recoverable
  }, 30_000)

  // ── Legacy repair lane ────────────────────────────────────────────────────
  it('REPAIR · a pre-fix `registration_failed` intent with a real capture is recovered by the sweep', async () => {
    const orderId = await seedIntent()
    // Exactly what the old webhook wrote — terminal status, NO refund markers.
    await adminDb.collection('paymentIntents').doc(orderId).update({ status: 'registration_failed' })
    capture(orderId)

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.recovered).toBe(1)
    expect(await regCount()).toBe(1)
    expect((await readIntent(orderId))?.status).toBe('paid')
  }, 30_000)
})

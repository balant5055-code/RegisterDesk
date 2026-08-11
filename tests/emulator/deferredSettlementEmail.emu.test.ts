// The confirmation email must never sit on the payment-critical path.
// REAL Firestore (emulator) — the claim is "the financial state is committed", and only a
// real datastore can answer that.
//
// THE PROBLEM THIS PINS. `settleCapturedRegistration` awaited `sendConfirmationEmail`
// inline. The send is already non-fatal, so correctness was never at risk — but the WAIT
// was: MAX_SEND_ATTEMPTS(3) × RESEND_TIMEOUT_MS(15s) + backoff ≈ 45s of provider slowness
// lands on the attendee's verify-payment response, long enough for the platform to time the
// function out and show a failure for a payment that actually succeeded.
//
// The fix injects `defer` (next/server's `after` at the request-scoped call sites). These
// tests hold BOTH halves of that contract:
//   • with defer    — settlement is fully committed and the email has NOT run yet
//   • without defer — behaviour is exactly as before, which is what keeps the sweep and
//                     every other direct caller (no request scope ⇒ after() would throw) safe
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const gw = vi.hoisted(() => ({
  emails: [] as { registrationId: string; eventSlug: string }[],
  throwOnEmail: false,
}))

// settleCapturedRegistration pulls in the Razorpay client transitively (via the
// reconciliation module), which validates its env at import time. Stubbed exactly as
// capturedRecovery.emu.test.ts does — no refund path is exercised here.
vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: 'stub_secret',
  razorpay: {
    orders:   { fetchPayments: async () => ({ items: [] }) },
    payments: { refund: async () => ({ id: 'rfnd_stub', status: 'processed' }) },
  },
}))

vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({
  sendConfirmationEmail: async (a: { registrationId: string; eventSlug: string }) => {
    if (gw.throwOnEmail) throw new Error('Resend unreachable')
    gw.emails.push({ registrationId: a.registrationId, eventSlug: a.eventSlug })
  },
}))

vi.mock('@/lib/firebase/firestore/platformTransactions', () => ({
  recordPlatformTransactionAndCredit: async () => {},
  reversePlatformTransactionAndDebit: async () => {},
}))

vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {},
  flushMonitoring: async () => {},
}))

let adminDb: import('firebase-admin/firestore').Firestore
let settleCapturedRegistration: typeof import('@/lib/payments/settleCapturedRegistration')['settleCapturedRegistration']

const SLUG = 'defer-email-event'
const PASS = 'pass-a'
let seq = 0

async function seedEvent() {
  await adminDb.collection('events').doc(SLUG).set({
    slug: SLUG, uid: 'org-uid-1', draftId: 'd-defer',
    lifecycleStatus: 'published', totalCapacity: null, capacityPlan: 'unlimited', planType: 'paid_event',
    emailProvider: 'resend',
    eventDetails: {
      info: { name: 'Deferred Email Event' },
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

async function seedIntent() {
  const orderId = `order_DEFER_${++seq}`
  await adminDb.collection('paymentIntents').doc(orderId).set({
    orderId, eventSlug: SLUG, passId: PASS, passName: 'Pass A', passCapacity: null,
    eventName: 'Deferred Email Event', organizerUid: 'org-uid-1',
    amount: 10000, currency: 'INR',
    attendee: { name: 'Priya', email: `d${seq}@example.com`, formResponses: {} },
    status: 'created',
    createdAt: Timestamp.fromMillis(Date.now() - 20 * 60_000),
    updatedAt: Timestamp.now(),
  })
  return orderId
}

const readIntent = async (orderId: string) =>
  (await adminDb.collection('paymentIntents').doc(orderId).get()).data()

describeEmu('settlement · the confirmation email is deferred off the payment path', () => {
  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ settleCapturedRegistration } = await import('@/lib/payments/settleCapturedRegistration'))
  })

  beforeEach(async () => {
    gw.emails.length = 0
    gw.throwOnEmail = false
    for (const c of ['events', 'registrationCounters', 'paymentIntents', 'registrations', 'registrationClaims']) {
      const s = await adminDb.collection(c).limit(300).get()
      await Promise.all(s.docs.map(d => d.ref.delete()))
    }
    await seedEvent()
  })

  it('with defer: the registration is COMMITTED and the email has not run yet', async () => {
    const orderId = await seedIntent()
    const deferred: (() => void | Promise<void>)[] = []

    const outcome = await settleCapturedRegistration({
      orderId, paymentId: 'pay_1', intent: await readIntent(orderId) as never,
      source: 'verify', defer: t => { deferred.push(t) },
    })

    // Financial state is durable BEFORE the email is even attempted.
    expect(outcome.kind).toBe('settled')
    const registrationId = (outcome as { registrationId: string }).registrationId
    expect((await adminDb.collection('registrations').doc(registrationId).get()).exists).toBe(true)
    expect((await readIntent(orderId))?.status).toBe('paid')

    // …and the caller was never made to wait for it.
    expect(gw.emails).toHaveLength(0)
    expect(deferred).toHaveLength(1)

    // The deferred task still sends exactly one email, carrying the eventSlug that drives
    // provider routing — so deferring changes WHEN it sends, never WHICH transport.
    await deferred[0]()
    expect(gw.emails).toEqual([{ registrationId, eventSlug: SLUG }])
  }, 30_000)

  it('without defer: the email runs inline, exactly as before', async () => {
    const orderId = await seedIntent()
    const outcome = await settleCapturedRegistration({
      orderId, paymentId: 'pay_2', intent: await readIntent(orderId) as never, source: 'sweep',
    })
    expect(outcome.kind).toBe('settled')
    // The sweep and the emulator tests have no request scope; they must keep the old path.
    expect(gw.emails).toHaveLength(1)
    expect(gw.emails[0].eventSlug).toBe(SLUG)
  }, 30_000)

  it('a THROWING email provider leaves the payment settled and the registration intact', async () => {
    gw.throwOnEmail = true
    const orderId = await seedIntent()

    const outcome = await settleCapturedRegistration({
      orderId, paymentId: 'pay_3', intent: await readIntent(orderId) as never, source: 'sweep',
    })

    expect(outcome.kind).toBe('settled')
    const registrationId = (outcome as { registrationId: string }).registrationId
    const reg = await adminDb.collection('registrations').doc(registrationId).get()
    expect(reg.exists).toBe(true)
    expect(reg.data()?.status).toBe('confirmed')
    expect((await readIntent(orderId))?.status).toBe('paid')
  }, 30_000)

  it('a deferred task that rejects still cannot touch the settled state', async () => {
    gw.throwOnEmail = true
    const orderId = await seedIntent()
    const deferred: (() => void | Promise<void>)[] = []

    const outcome = await settleCapturedRegistration({
      orderId, paymentId: 'pay_4', intent: await readIntent(orderId) as never,
      source: 'verify', defer: t => { deferred.push(t) },
    })
    const registrationId = (outcome as { registrationId: string }).registrationId

    // The task swallows the provider error itself — an unhandled rejection inside after()
    // would be logged by the platform, but the contract is that it never surfaces.
    await expect(deferred[0]()).resolves.toBeUndefined()

    expect((await adminDb.collection('registrations').doc(registrationId).get()).data()?.status).toBe('confirmed')
    expect((await readIntent(orderId))?.status).toBe('paid')
  }, 30_000)

  it('a replayed settlement schedules NO second email — no duplicate confirmation', async () => {
    const orderId = await seedIntent()
    const deferred: (() => void | Promise<void>)[] = []
    const defer = (t: () => void | Promise<void>) => { deferred.push(t) }

    const first = await settleCapturedRegistration({
      orderId, paymentId: 'pay_5', intent: await readIntent(orderId) as never, source: 'verify', defer,
    })
    // The webhook arrives for the same order after the browser already settled it.
    const second = await settleCapturedRegistration({
      orderId, paymentId: 'pay_5', intent: await readIntent(orderId) as never, source: 'webhook', defer,
    })

    expect(first.kind).toBe('settled')
    expect(second.kind).toBe('already_settled')
    expect(deferred).toHaveLength(1)

    await Promise.all(deferred.map(t => t()))
    expect(gw.emails).toHaveLength(1)
  }, 30_000)
})

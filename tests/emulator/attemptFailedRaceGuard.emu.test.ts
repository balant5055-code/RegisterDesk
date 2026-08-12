// RD-PAY-P0-7 — `markPaymentIntentAttemptFailed` must never downgrade a settled intent.
// REAL Firestore (emulator): the claim is about a check-and-write race on a persisted
// document, and only a real datastore can answer it.
//
// THE RACE THIS PINS. The `payment.failed` webhook does:
//
//   const intent = await getPaymentIntent(orderId)      // reads 'created'
//   if (intent?.status === 'created')                   // gate passes
//   await markPaymentIntentAttemptFailed(orderId)       // writes
//
// Those are TWO operations. A settlement committing between them used to be overwritten by
// an unconditional update(): `paid` → `attempt_failed`, with `registrationId` left in place.
// Because `attempt_failed` is deliberately settleable on every path (that is the whole point
// of RD-PAY-P0-6), the next webhook delivery or capture sweep would then settle the SAME
// payment again — a second registration, a second ticket, duplicate notifications, and a
// second organizer credit, since the ledger is keyed `ptx_<registrationId>` and a fresh
// registration id mints a fresh ledger doc that the idempotency gate never matches.
//
// Two independent guards are asserted here:
//   1. the transition itself is atomic (transaction, `created` only)
//   2. settlement short-circuits on `registrationId` alone, so even a corrupted status
//      cannot mint a second registration
//
//   npm run emu:start && npx dotenv -e .env.emulator -- npx vitest run tests/emulator/attemptFailedRaceGuard.emu.test.ts

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'
import crypto from 'node:crypto'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

const gw = vi.hoisted(() => ({
  payments: new Map<string, Array<{ id: string; status: string; amount: number; currency: string }>>(),
  refunds:  [] as Array<{ paymentId: string; amount: number }>,
  emailsSent:  [] as string[],
  creditCalls: [] as string[],   // ptx_<registrationId> — one per organizer credit attempt
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub', RAZORPAY_KEY_SECRET: 'stub',
  razorpay: {
    orders: { fetchPayments: async (o: string) => ({ items: gw.payments.get(o) ?? [] }) },
    payments: {
      refund: async (paymentId: string, o: { amount: number }) => {
        gw.refunds.push({ paymentId, amount: o.amount })
        return { id: `rfnd_${gw.refunds.length}`, status: 'processed' }
      },
    },
  },
}))
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({
  sendConfirmationEmail: async (a: { registrationId: string }) => { gw.emailsSent.push(a.registrationId) },
}))
vi.mock('@/lib/firebase/firestore/platformTransactions', () => ({
  recordPlatformTransactionAndCredit: async (l: { id: string }) => { gw.creditCalls.push(l.id) },
  reversePlatformTransactionAndDebit: async () => {},
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {},
  flushMonitoring: async () => {},
}))

let adminDb: import('firebase-admin/firestore').Firestore
let settleCapturedRegistration: typeof import('@/lib/payments/settleCapturedRegistration')['settleCapturedRegistration']
let markPaymentIntentAttemptFailed: typeof import('@/lib/firebase/firestore/paymentIntents')['markPaymentIntentAttemptFailed']
let markPaymentIntentFailed: typeof import('@/lib/firebase/firestore/paymentIntents')['markPaymentIntentFailed']

// Process-unique fixture. Two vitest processes against one emulator would otherwise mint
// identical order ids and wipe each other's documents mid-test — a failure mode that reads
// exactly like a settlement bug and is not one.
const RUN  = crypto.randomUUID().slice(0, 8)
const SLUG = `p07-race-${RUN}`
const PASS = 'pass-a'
let seq = 0

async function seedEvent() {
  await adminDb.collection('events').doc(SLUG).set({
    slug: SLUG, uid: 'org-p07', draftId: 'd-p07',
    lifecycleStatus: 'published', totalCapacity: null, capacityPlan: 'unlimited', planType: 'paid_event',
    eventDetails: {
      info: { name: 'P0-7 Race Event' },
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

async function seedIntent(status = 'created', ageMinutes = 20) {
  const orderId = `order_P07_${RUN}_${++seq}`
  await adminDb.collection('paymentIntents').doc(orderId).set({
    orderId, eventSlug: SLUG, passId: PASS, passName: 'Pass A', passCapacity: null,
    eventName: 'P0-7 Race Event', organizerUid: 'org-p07',
    amount: 10000, currency: 'INR',
    attendee: { name: 'Priya', email: `p07_${RUN}_${seq}@example.com`, formResponses: {} },
    status,
    createdAt: Timestamp.fromMillis(Date.now() - ageMinutes * 60_000),
    updatedAt: Timestamp.now(),
  })
  return orderId
}

const readIntent = async (o: string) =>
  (await adminDb.collection('paymentIntents').doc(o).get()).data() as Record<string, unknown> | undefined
const capture = (orderId: string, amount = 10000) => {
  const id = `pay_P07_${orderId}`
  gw.payments.set(orderId, [{ id, status: 'captured', amount, currency: 'INR' }])
  return id
}
const regsFor = async (o: string) =>
  (await adminDb.collection('registrations').where('razorpayOrderId', '==', o).get()).docs

/** Scoped to THIS run's event only — never a collection-wide delete. */
async function wipeRun() {
  for (const c of ['paymentIntents', 'registrations']) {
    const s = await adminDb.collection(c).where('eventSlug', '==', SLUG).limit(400).get()
    await Promise.all(s.docs.map(d => d.ref.delete()))
  }
}

describeEmu('RD-PAY-P0-7 · attempt_failed can never downgrade a settled intent', () => {
  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ settleCapturedRegistration } = await import('@/lib/payments/settleCapturedRegistration'))
    ;({ markPaymentIntentAttemptFailed, markPaymentIntentFailed } =
      await import('@/lib/firebase/firestore/paymentIntents'))
    await seedEvent()
  })

  beforeEach(async () => {
    gw.payments.clear(); gw.refunds.length = 0
    gw.emailsSent.length = 0; gw.creditCalls.length = 0
    await wipeRun()
    await seedEvent()
  })

  // ── TEST 1 + 2 · THE RACE, in its exact harmful ordering ───────────────────
  it('1+2 · settle THEN a late attempt-failed → status stays paid, one registration, one credit', async () => {
    const orderId = await seedIntent('created')

    // The webhook's read happens here, while the intent is still `created`. Everything
    // below is what runs between that read and its write.
    const staleRead = await readIntent(orderId)
    expect(staleRead?.status).toBe('created')

    const paymentId = capture(orderId)
    const out = await settleCapturedRegistration({
      orderId, paymentId, intent: staleRead as never, source: 'verify',
    })
    expect(out.kind).toBe('settled')
    const settledRegId = (await readIntent(orderId))?.registrationId as string
    expect(settledRegId).toBeTruthy()

    // …and now the webhook resumes and writes, holding its stale `created` observation.
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed:BAD_CARD:declined')

    const after = await readIntent(orderId)
    expect(after?.status).toBe('paid')                    // ← THE REGRESSION
    expect(after?.registrationId).toBe(settledRegId)      // untouched
    expect(await regsFor(orderId)).toHaveLength(1)

    // TEST 2 — exactly one organizer credit, keyed on the one registration id.
    expect(gw.creditCalls).toEqual([`ptx_${settledRegId}`])
    expect(new Set(gw.creditCalls).size).toBe(1)
  }, 30_000)

  // ── TEST 2b · a corrupted status must still not mint a second registration ──
  it('2b · even if status is forced to attempt_failed, re-settlement is a no-op', async () => {
    const orderId   = await seedIntent('created')
    const paymentId = capture(orderId)
    await settleCapturedRegistration({
      orderId, paymentId, intent: await readIntent(orderId) as never, source: 'verify',
    })
    const regId = (await readIntent(orderId))?.registrationId as string

    // Simulate the corruption directly — the state the old unconditional update() produced.
    await adminDb.collection('paymentIntents').doc(orderId).update({ status: 'attempt_failed' })

    const replay = await settleCapturedRegistration({
      orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook',
    })
    expect(replay.kind).toBe('already_settled')
    expect(await regsFor(orderId)).toHaveLength(1)
    expect(new Set(gw.creditCalls).size).toBe(1)
    expect(gw.emailsSent).toHaveLength(1)
    expect(regId).toBeTruthy()
  }, 30_000)

  // ── TEST 3 · true concurrency, repeated ────────────────────────────────────
  it('3 · settlement + attempt-failed CONCURRENTLY, repeated → exactly one of everything', async () => {
    for (let i = 0; i < 8; i++) {
      await wipeRun(); await seedEvent()
      gw.payments.clear(); gw.emailsSent.length = 0; gw.creditCalls.length = 0

      const orderId   = await seedIntent('created')
      const paymentId = capture(orderId)
      const intent    = await readIntent(orderId)

      await Promise.all([
        settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'verify' }),
        markPaymentIntentAttemptFailed(orderId, 'payment_failed'),
      ])

      const regs = await regsFor(orderId)
      const final = await readIntent(orderId)

      // Either ordering is legal; only these outcomes are.
      if (regs.length === 1) {
        expect(final?.status, `iteration ${i}`).toBe('paid')
        expect(final?.registrationId).toBe(regs[0].id)
        expect(new Set(gw.creditCalls).size).toBe(1)
        expect(new Set(regs.map(d => d.data().ticketCode)).size).toBe(1)
      } else {
        // attempt_failed won the race — the order is simply not settled yet. Never a
        // partially-settled or duplicated state.
        expect(regs, `iteration ${i}`).toHaveLength(0)
        expect(final?.status).toBe('attempt_failed')
        expect(final?.registrationId).toBeUndefined()
      }
    }
  }, 120_000)

  // ── TESTS 4–8 · the transition matrix ──────────────────────────────────────
  it('4 · paid → attempt_failed is a NO-OP', async () => {
    const orderId   = await seedIntent('created')
    const paymentId = capture(orderId)
    await settleCapturedRegistration({
      orderId, paymentId, intent: await readIntent(orderId) as never, source: 'verify',
    })
    const before = await readIntent(orderId)
    await markPaymentIntentAttemptFailed(orderId, 'late')
    const after = await readIntent(orderId)
    expect(after?.status).toBe('paid')
    expect(after?.registrationId).toBe(before?.registrationId)
    expect(after?.failureReason).toBeUndefined()
  }, 30_000)

  it('5 · registration_failed → attempt_failed is a NO-OP', async () => {
    const orderId = await seedIntent('created')
    await markPaymentIntentFailed(orderId, 'gate_blocked')
    await markPaymentIntentAttemptFailed(orderId, 'late')
    expect((await readIntent(orderId))?.status).toBe('registration_failed')
    expect((await readIntent(orderId))?.failureReason).toBe('gate_blocked')
  }, 30_000)

  it('6 · failed → attempt_failed is a NO-OP', async () => {
    const orderId = await seedIntent('failed')
    await markPaymentIntentAttemptFailed(orderId, 'late')
    expect((await readIntent(orderId))?.status).toBe('failed')
  }, 30_000)

  it('7 · attempt_failed → attempt_failed is a NO-OP (reason not overwritten)', async () => {
    const orderId = await seedIntent('created')
    await markPaymentIntentAttemptFailed(orderId, 'first_reason')
    await markPaymentIntentAttemptFailed(orderId, 'second_reason')
    const after = await readIntent(orderId)
    expect(after?.status).toBe('attempt_failed')
    expect(after?.failureReason).toBe('first_reason')
  }, 30_000)

  it('8 · created → attempt_failed IS allowed', async () => {
    const orderId = await seedIntent('created')
    await markPaymentIntentAttemptFailed(orderId, 'payment_failed:BAD_CARD')
    const after = await readIntent(orderId)
    expect(after?.status).toBe('attempt_failed')
    expect(after?.failureReason).toBe('payment_failed:BAD_CARD')
  }, 30_000)

  it('8b · a missing intent is a safe no-op, not a throw', async () => {
    await expect(markPaymentIntentAttemptFailed(`order_P07_${RUN}_absent`, 'x')).resolves.toBeUndefined()
  }, 30_000)

  // ── TEST 9 · the original P0-6 scenario still works end to end ─────────────
  it('9 · failed → retry on the SAME order → captured → one registration, one credit', async () => {
    const orderId = await seedIntent('created')

    await markPaymentIntentAttemptFailed(orderId, 'payment_failed:BAD_CARD:declined')
    expect((await readIntent(orderId))?.status).toBe('attempt_failed')

    // The retry reuses this same order; Razorpay captures against it.
    const paymentId = capture(orderId)
    const out = await settleCapturedRegistration({
      orderId, paymentId, intent: await readIntent(orderId) as never, source: 'verify',
    })

    expect(out.kind).toBe('settled')
    const regs = await regsFor(orderId)
    expect(regs).toHaveLength(1)
    expect((await readIntent(orderId))?.status).toBe('paid')
    expect(gw.creditCalls).toEqual([`ptx_${regs[0].id}`])
    expect(gw.emailsSent).toEqual([regs[0].id])
    expect(gw.refunds).toHaveLength(0)
  }, 30_000)
})

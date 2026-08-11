// RD-PAY-P0-3 · Orphaned-capture recovery — REAL Firestore (emulator).
//
// THE SCENARIO THIS EXISTS TO PROVE:
//
//   Razorpay captures the payment
//   → the browser disappears completely (no verify-payment request is ever made)
//   → recovery notices and settles it
//   → EXACTLY ONE registration exists.
//
// It needs a real Firestore because every guarantee here is transactional. The payment
// intent is read INSIDE the settlement transaction, and that read is the only thing making
// concurrent settlements safe — a mocked Firestore would serialise the callers for us and
// prove nothing at all.
//
//   npm run emu:start && npm run test:emu

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import { Timestamp } from 'firebase-admin/firestore'

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST
const describeEmu = EMULATOR ? describe : describe.skip

// ─── Stub gateway + side effects ───────────────────────────────────────────────

const gw = vi.hoisted(() => ({
  /** orderId → payments Razorpay reports for it. */
  payments: new Map<string, Array<{ id: string; status: string; amount: number; currency: string }>>(),
  /** fetchPayments throws → "we could not ask". Must never read as "unpaid". */
  failFetch: false,
  refunds: [] as Array<{ paymentId: string; amount: number; reason: unknown }>,
  emailsSent: [] as string[],
  creditCalls: [] as string[],
}))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: 'stub_secret',
  razorpay: {
    orders: {
      fetchPayments: async (orderId: string) => {
        if (gw.failFetch) throw new Error('razorpay unreachable')
        return { items: gw.payments.get(orderId) ?? [] }
      },
    },
    payments: {
      refund: async (paymentId: string, o: { amount: number; notes: unknown }) => {
        gw.refunds.push({ paymentId, amount: o.amount, reason: o.notes })
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

// Loaded inside beforeAll (repo convention): a top-level import would pull in the Admin
// SDK — and blow up on the missing service-account key — even when this suite is skipped
// because no emulator is running.
let adminDb: import('firebase-admin/firestore').Firestore
let settleCapturedRegistration: typeof import('@/lib/payments/settleCapturedRegistration')['settleCapturedRegistration']
let recoverCapturedPaymentIntents: typeof import('@/lib/payments/registrationReconciliation')['recoverCapturedPaymentIntents']

// ─── Fixture ───────────────────────────────────────────────────────────────────

const SLUG = 'p03-recovery-event'
const PASS = 'pass-a'
let seq = 0

async function seedEvent(o: { passQuantity?: number | null; limitPerEmail?: boolean } = {}) {
  await adminDb.collection('events').doc(SLUG).set({
    slug: SLUG, uid: 'org-uid-1', draftId: 'd1',
    lifecycleStatus: 'published', totalCapacity: null, capacityPlan: 'unlimited', planType: 'paid_event',
    eventDetails: {
      info: { name: 'P0-3 Recovery Event' },
      schedule: { startDate: '2099-01-01', endDate: '2099-01-02', startTime: '09:00', endTime: '18:00', timezone: 'Asia/Kolkata' },
    },
    pricing: {
      passes: [{
        id: PASS, name: 'Pass A', price: 100, status: 'active',
        unlimited: o.passQuantity === undefined, quantity: o.passQuantity ?? null,
      }],
    },
    registrationForm: { sections: [], conditionalRules: [], registrationRules: { limitPerEmail: !!o.limitPerEmail } },
    accessControl: { type: 'public', confirmationMode: 'auto' },
  })
  await adminDb.collection('registrationCounters').doc(SLUG).set({
    eventSlug: SLUG, totalCount: 0, passCounts: {}, revenuePaise: 0, statsVersion: 3,
  })
}

/** A payment intent stuck in `created` — the browser never came back. */
async function seedIntent(o: {
  uid?: string; email?: string; ageMinutes?: number
  coupon?: { docId: string; code: string; discount: number; original: number }
  inviteCode?: string
  financials?: { ticketBasePaise: number }
} = {}) {
  const orderId = `order_P03_${++seq}`
  await adminDb.collection('paymentIntents').doc(orderId).set({
    orderId, eventSlug: SLUG, passId: PASS, passName: 'Pass A', passCapacity: null,
    eventName: 'P0-3 Recovery Event', organizerUid: 'org-uid-1',
    amount: 10000, currency: 'INR',
    attendee: { name: 'Priya', email: o.email ?? `p${seq}@example.com`, formResponses: {} },
    ...(o.uid ? { uid: o.uid } : {}),          // P0-1: guests carry NO uid key at all
    ...(o.inviteCode ? { inviteCode: o.inviteCode } : {}),
    ...(o.coupon ? {
      couponCode: o.coupon.code, couponDocId: o.coupon.docId,
      discountAmount: o.coupon.discount, originalAmount: o.coupon.original,
    } : {}),
    ...(o.financials ? { financials: { ticketBasePaise: o.financials.ticketBasePaise } } : {}),
    status: 'created',
    createdAt: Timestamp.fromMillis(Date.now() - (o.ageMinutes ?? 20) * 60_000),
    updatedAt: Timestamp.now(),
  })
  return orderId
}

/** A coupon on the event, with an optional usage cap. */
async function seedCoupon(docId: string, o: { maxUses?: number; currentUses?: number } = {}) {
  await adminDb.collection('events').doc(SLUG).collection('coupons').doc(docId).set({
    code: 'SAVE10', type: 'percentage', value: 10, active: true,
    applicablePassIds: [], currentUses: o.currentUses ?? 0,
    ...(o.maxUses !== undefined ? { maxUses: o.maxUses } : {}),
  })
  return { docId, code: 'SAVE10', discount: 1000, original: 11000 }
}

const couponUses = async (docId: string) =>
  ((await adminDb.collection('events').doc(SLUG).collection('coupons').doc(docId).get())
    .data() as { currentUses?: number } | undefined)?.currentUses

/** Razorpay reports a captured payment for this order. */
function capture(orderId: string, amount = 10000) {
  const id = `pay_P03_${orderId.slice(-4)}`
  gw.payments.set(orderId, [{ id, status: 'captured', amount, currency: 'INR' }])
  return id
}

const readIntent = async (o: string) =>
  (await adminDb.collection('paymentIntents').doc(o).get()).data() as Record<string, unknown>
const regsFor = async (o: string) =>
  (await adminDb.collection('registrations').where('razorpayOrderId', '==', o).get()).docs
const counter = async () =>
  (await adminDb.collection('registrationCounters').doc(SLUG).get()).data() as { totalCount?: number; passCounts?: Record<string, number> }

async function wipe() {
  for (const c of ['paymentIntents', 'registrations', 'registrationClaims', 'ticketCodeClaims', 'failedRefunds', 'events', 'registrationCounters']) {
    const s = await adminDb.collection(c).limit(500).get()
    await Promise.all(s.docs.map(d => d.ref.delete()))
  }
}

describeEmu('RD-PAY-P0-3 · orphaned capture recovery (real Firestore)', () => {
  beforeAll(async () => {
    ;({ adminDb } = await import('@/lib/firebase/admin'))
    ;({ settleCapturedRegistration } = await import('@/lib/payments/settleCapturedRegistration'))
    ;({ recoverCapturedPaymentIntents } = await import('@/lib/payments/registrationReconciliation'))
    await wipe()
  })
  beforeEach(async () => {
    await wipe()
    gw.payments.clear(); gw.failFetch = false
    gw.refunds.length = 0; gw.emailsSent.length = 0; gw.creditCalls.length = 0
    await seedEvent()
  })

  // ═══ THE CRITICAL PROOF ═════════════════════════════════════════════════════
  it('CRITICAL · captured + browser never returns → sweep creates EXACTLY ONE registration', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)

    // No verify-payment call is made anywhere in this test. The browser is simply gone.
    const res = await recoverCapturedPaymentIntents(50)

    expect(res.recovered).toBe(1)
    const regs = await regsFor(orderId)
    expect(regs).toHaveLength(1)

    const reg = regs[0].data()
    expect(reg.status).toBe('confirmed')
    expect(reg.paymentStatus).toBe('paid')
    expect(reg.paymentId).toBe(paymentId)
    expect(reg.amount).toBe(10000)
    expect(reg.ticketCode).toBeTruthy()
    expect(reg.recoveredBySweep).toBe(true)

    // Every artefact the normal path writes, written exactly once.
    const intent = await readIntent(orderId)
    expect(intent.status).toBe('paid')
    expect(intent.registrationId).toBe(regs[0].id)
    expect((await counter()).totalCount).toBe(1)
    expect((await counter()).passCounts?.[PASS]).toBe(1)
    expect((await adminDb.collection('ticketCodeClaims').doc(reg.ticketCode as string).get()).exists).toBe(true)
    expect(gw.emailsSent).toEqual([regs[0].id])
    expect(gw.creditCalls).toEqual([`ptx_${regs[0].id}`])
    expect(gw.refunds).toHaveLength(0)
  })

  // ═══ 1–2 · normal recovery + duplicate delivery ══════════════════════════════
  it('1–2 · webhook settles, then a duplicate delivery → still exactly one of everything', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)
    const intent    = await readIntent(orderId)

    const a = await settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'webhook' })
    const b = await settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'webhook' })

    expect(a.kind).toBe('settled')
    expect(b.kind).toBe('already_settled')
    expect(await regsFor(orderId)).toHaveLength(1)
    expect((await counter()).totalCount).toBe(1)
    expect(gw.emailsSent).toHaveLength(1)      // no duplicate email
    expect(gw.creditCalls).toHaveLength(1)     // no duplicate wallet credit
  })

  it('2 · a duplicate delivery re-read from Firestore also no-ops', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)
    await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook' })
    // Second delivery reads the NOW-PAID intent, as the real route does.
    const b = await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook' })
    expect(b.kind).toBe('already_settled')
    expect(await regsFor(orderId)).toHaveLength(1)
  })

  // ═══ 3–5 · ordering and simultaneity ════════════════════════════════════════
  it('3 · webhook before the sweep → one registration', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)
    await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook' })
    const sweep = await recoverCapturedPaymentIntents(50)
    expect(sweep.recovered).toBe(0)            // nothing left to recover
    expect(await regsFor(orderId)).toHaveLength(1)
    expect(gw.emailsSent).toHaveLength(1)
  })

  it('4 · sweep before the webhook → one registration', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)
    await recoverCapturedPaymentIntents(50)
    const late = await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook' })
    expect(late.kind).toBe('already_settled')
    expect(await regsFor(orderId)).toHaveLength(1)
    expect(gw.emailsSent).toHaveLength(1)
  })

  it('5 · webhook and sweep fire SIMULTANEOUSLY → still exactly one registration', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)
    const intent    = await readIntent(orderId)

    // Both start from the same pre-settlement snapshot — the real race.
    const [x, y] = await Promise.all([
      settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'webhook' }),
      settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'sweep' }),
    ])

    const kinds = [x.kind, y.kind].sort()
    expect(kinds).toEqual(['already_settled', 'settled'])
    expect(await regsFor(orderId)).toHaveLength(1)
    expect((await counter()).totalCount).toBe(1)
    expect(gw.emailsSent).toHaveLength(1)
    expect(gw.creditCalls).toHaveLength(1)
  }, 30_000)

  it('5b · three concurrent settlements still yield one registration', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)
    const intent    = await readIntent(orderId)
    const results = await Promise.all([
      settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'webhook' }),
      settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'webhook' }),
      settleCapturedRegistration({ orderId, paymentId, intent: intent as never, source: 'sweep' }),
    ])
    expect(results.filter(r => r.kind === 'settled')).toHaveLength(1)
    expect(await regsFor(orderId)).toHaveLength(1)
    expect((await counter()).totalCount).toBe(1)
  }, 30_000)

  // ═══ 7–10 · unpaid, stale, uncertain ════════════════════════════════════════
  it('7 · an UNPAID Razorpay order is left completely alone — created ≠ failed', async () => {
    const orderId = await seedIntent()
    gw.payments.set(orderId, [])                     // Razorpay holds nothing

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.unpaid).toBe(1)
    expect(res.recovered).toBe(0)
    expect(await regsFor(orderId)).toHaveLength(0)
    const intent = await readIntent(orderId)
    expect(intent.status).toBe('created')            // still open, still settleable
    expect(intent.failureReason).toBeUndefined()
    expect(gw.refunds).toHaveLength(0)
  })

  it('8 · a stale created intent inside the window is a candidate; a fresh one is not', async () => {
    await seedIntent({ ageMinutes: 20 })             // older than the 10-min grace
    await seedIntent({ ageMinutes: 1 })              // in-flight checkout — must be skipped
    const res = await recoverCapturedPaymentIntents(50)
    expect(res.candidates).toBe(1)
  })

  it('9 · a stale intent WITH a capture is recovered', async () => {
    const orderId = await seedIntent({ ageMinutes: 90 })
    capture(orderId)
    const res = await recoverCapturedPaymentIntents(50)
    expect(res.recovered).toBe(1)
    expect(await regsFor(orderId)).toHaveLength(1)
  })

  it('10 · an UNCERTAIN Razorpay response never fails or refunds the payment', async () => {
    const orderId = await seedIntent()
    gw.failFetch = true

    const res = await recoverCapturedPaymentIntents(50)
    expect(res.uncertain).toBe(1)
    expect(res.recovered).toBe(0)
    expect((await readIntent(orderId)).status).toBe('created')   // still recoverable
    expect(gw.refunds).toHaveLength(0)

    // …and once Razorpay answers again, the next run recovers it.
    gw.failFetch = false
    capture(orderId)
    const again = await recoverCapturedPaymentIntents(50)
    expect(again.recovered).toBe(1)
    expect(await regsFor(orderId)).toHaveLength(1)
  })

  it('an AUTHORIZED (not yet captured) payment is also recovered — the funds are held', async () => {
    const orderId = await seedIntent()
    gw.payments.set(orderId, [{ id: 'pay_auth', status: 'authorized', amount: 10000, currency: 'INR' }])
    expect((await recoverCapturedPaymentIntents(50)).recovered).toBe(1)
  })

  it('a payment for a DIFFERENT amount never settles this intent', async () => {
    const orderId = await seedIntent()
    gw.payments.set(orderId, [{ id: 'pay_x', status: 'captured', amount: 9999, currency: 'INR' }])
    const res = await recoverCapturedPaymentIntents(50)
    expect(res.unpaid).toBe(1)
    expect(await regsFor(orderId)).toHaveLength(0)
  })

  // ═══ 12–13 · duplicate ids ══════════════════════════════════════════════════
  it('12–13 · the same payment id and order id twice cannot create a second registration', async () => {
    const orderId   = await seedIntent()
    const paymentId = capture(orderId)
    await recoverCapturedPaymentIntents(50)
    await recoverCapturedPaymentIntents(50)
    await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source: 'webhook' })
    expect(await regsFor(orderId)).toHaveLength(1)
    expect((await counter()).totalCount).toBe(1)
  })

  // ═══ 14 · recovery after a server restart ═══════════════════════════════════
  it('14 · recovery works from cold state — nothing in memory is required', async () => {
    const orderId = await seedIntent()
    capture(orderId)
    // A "restart" is exactly this: no client state, no queue, no cache — only Firestore
    // and Razorpay. The sweep reads both from scratch.
    const res = await recoverCapturedPaymentIntents(50)
    expect(res.recovered).toBe(1)
    expect(await regsFor(orderId)).toHaveLength(1)
  })

  // ═══ 15–16 · duplicates and capacity ════════════════════════════════════════
  it('15 · a duplicate-email refusal creates NO registration and refunds in full', async () => {
    await wipe(); await seedEvent({ limitPerEmail: true })
    const first  = await seedIntent({ email: 'dupe@example.com' })
    capture(first)
    await recoverCapturedPaymentIntents(50)
    expect(await regsFor(first)).toHaveLength(1)

    const second = await seedIntent({ email: 'dupe@example.com' })
    const pid2   = capture(second)
    const res    = await recoverCapturedPaymentIntents(50)

    expect(res.refunded).toBe(1)
    expect(await regsFor(second)).toHaveLength(0)
    expect((await readIntent(second)).status).toBe('registration_failed')
    expect(gw.refunds.map(r => r.paymentId)).toEqual([pid2])
    expect((await counter()).totalCount).toBe(1)          // capacity not double-counted
  })

  it('16 · recovery can NEVER exceed pass capacity — the overflow is refunded, not registered', async () => {
    await wipe(); await seedEvent({ passQuantity: 1 })
    const a = await seedIntent(); capture(a)
    const b = await seedIntent(); capture(b)

    const res = await recoverCapturedPaymentIntents(50)

    expect(res.recovered).toBe(1)
    expect(res.refunded).toBe(1)
    expect((await counter()).passCounts?.[PASS]).toBe(1)   // never 2
    const total = (await adminDb.collection('registrations').where('eventSlug', '==', SLUG).get()).size
    expect(total).toBe(1)
    expect(gw.refunds).toHaveLength(1)
  })

  // ═══ 17–18 · guest and authenticated ════════════════════════════════════════
  it('17 · GUEST recovery — no uid on the intent, no uid on the registration (P0-1 held)', async () => {
    const orderId = await seedIntent()                 // seeded WITHOUT uid
    capture(orderId)
    expect(Object.prototype.hasOwnProperty.call(await readIntent(orderId), 'uid')).toBe(false)

    await recoverCapturedPaymentIntents(50)
    const reg = (await regsFor(orderId))[0].data()
    expect(Object.prototype.hasOwnProperty.call(reg, 'uid')).toBe(false)
    expect(reg.status).toBe('confirmed')
  })

  it('18 · AUTHENTICATED recovery — the uid is carried onto the registration', async () => {
    const orderId = await seedIntent({ uid: 'firebase-uid-xyz' })
    capture(orderId)
    await recoverCapturedPaymentIntents(50)
    expect((await regsFor(orderId))[0].data().uid).toBe('firebase-uid-xyz')
  })

  // ═══ RD-PAY-P0-4 · all three paths write the SAME registration ══════════════
  //
  // Before this, the browser path and the two recovery paths disagreed about coupons,
  // invite re-validation and the revenue basis. `source` is now the ONLY input that
  // differs between them, so every assertion below runs for all three.

  const SOURCES = ['verify', 'webhook', 'sweep'] as const

  for (const source of SOURCES) {
    it(`COUPON · ${source} persists the coupon fields and consumes the coupon EXACTLY ONCE`, async () => {
      const c        = await seedCoupon(`cpn_${source}`, { maxUses: 5 })
      const orderId  = await seedIntent({ coupon: c })
      const paymentId = capture(orderId)

      const out = source === 'sweep'
        ? (await recoverCapturedPaymentIntents(50), { kind: 'settled' } as const)
        : await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })

      expect(out.kind).toBe('settled')
      const reg = (await regsFor(orderId))[0].data()
      expect(reg.couponCode).toBe('SAVE10')
      expect(reg.discountAmount).toBe(1000)
      expect(reg.originalAmount).toBe(11000)
      expect(await couponUses(c.docId)).toBe(1)
    })

    it(`COUPON · ${source} — a replay never consumes the coupon a second time`, async () => {
      const c         = await seedCoupon(`cpn2_${source}`, { maxUses: 5 })
      const orderId   = await seedIntent({ coupon: c })
      const paymentId = capture(orderId)

      await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })
      // Replay from the ORIGINAL pre-settlement snapshot — the worst case.
      await settleCapturedRegistration({ orderId, paymentId, intent: { ...(await readIntent(orderId)), status: 'created', registrationId: undefined } as never, source })
      await recoverCapturedPaymentIntents(50)

      expect(await couponUses(c.docId)).toBe(1)
      expect(await regsFor(orderId)).toHaveLength(1)
    })

    it(`NO COUPON · ${source} writes no coupon fields`, async () => {
      const orderId   = await seedIntent()
      const paymentId = capture(orderId)
      await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })
      const reg = (await regsFor(orderId))[0].data()
      for (const k of ['couponCode', 'discountAmount', 'originalAmount']) {
        expect(Object.prototype.hasOwnProperty.call(reg, k)).toBe(false)
      }
    })

    it(`REVENUE BASIS · ${source} counts financials.ticketBasePaise, not the gross charge`, async () => {
      const orderId   = await seedIntent({ financials: { ticketBasePaise: 8500 } })
      const paymentId = capture(orderId)                    // gross charge is 10000
      await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })
      const c = (await adminDb.collection('registrationCounters').doc(SLUG).get()).data() as { revenuePaise?: number }
      expect(c.revenuePaise).toBe(8500)                     // NOT 10000
      // The registration itself still records what the attendee actually paid.
      expect((await regsFor(orderId))[0].data().amount).toBe(10000)
    })
  }

  it('COUPON CAP · an exhausted coupon is refused and refunded on EVERY path, and never over-consumed', async () => {
    const c = await seedCoupon('cpn_full', { maxUses: 1, currentUses: 1 })
    for (const source of SOURCES) {
      const orderId   = await seedIntent({ coupon: c })
      const paymentId = capture(orderId)
      const out = await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })
      expect(out).toEqual({ kind: 'refunded', reason: 'COUPON_EXHAUSTED' })
      expect(await regsFor(orderId)).toHaveLength(0)
      expect((await readIntent(orderId)).status).toBe('registration_failed')
    }
    expect(await couponUses('cpn_full')).toBe(1)            // never incremented past the cap
    expect(gw.refunds).toHaveLength(3)
  })

  it('COUPON RACE · two concurrent settlements for the LAST use → one registration, one consumption', async () => {
    const c  = await seedCoupon('cpn_last', { maxUses: 1 })
    const o1 = await seedIntent({ coupon: c }); const p1 = capture(o1)
    const o2 = await seedIntent({ coupon: c }); const p2 = capture(o2)

    const [a, b] = await Promise.all([
      settleCapturedRegistration({ orderId: o1, paymentId: p1, intent: await readIntent(o1) as never, source: 'verify' }),
      settleCapturedRegistration({ orderId: o2, paymentId: p2, intent: await readIntent(o2) as never, source: 'webhook' }),
    ])

    const kinds = [a.kind, b.kind].sort()
    expect(kinds).toEqual(['refunded', 'settled'])
    expect(await couponUses('cpn_last')).toBe(1)
    expect(gw.refunds).toHaveLength(1)                       // the loser is refunded in full
  }, 30_000)

  it('INVITE · an invite-only event refuses + refunds on every path when the code is absent', async () => {
    await adminDb.collection('events').doc(SLUG).update({
      accessControl: { type: 'invite_code', confirmationMode: 'auto', inviteCode: { code: 'VIP1', caseSensitive: false } },
    })
    for (const source of SOURCES) {
      const orderId   = await seedIntent()                   // intent carries NO inviteCode
      const paymentId = capture(orderId)
      const out = await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })
      expect(out).toEqual({ kind: 'refunded', reason: 'INVITE_CODE_INVALID' })
      expect(await regsFor(orderId)).toHaveLength(0)
    }
  })

  it('INVITE · the trusted code stored on the intent settles on every path', async () => {
    await adminDb.collection('events').doc(SLUG).update({
      accessControl: { type: 'invite_code', confirmationMode: 'auto', inviteCode: { code: 'VIP1', caseSensitive: false } },
    })
    for (const source of SOURCES) {
      const orderId   = await seedIntent({ inviteCode: 'VIP1' })
      const paymentId = capture(orderId)
      const out = await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })
      expect(out.kind).toBe('settled')
      expect(await regsFor(orderId)).toHaveLength(1)
    }
  })

  it('EQUIVALENCE · verify, webhook and sweep produce byte-identical registrations', async () => {
    const shaped = async (source: typeof SOURCES[number]) => {
      const c         = await seedCoupon(`cpn_eq_${source}`, { maxUses: 9 })
      const orderId   = await seedIntent({ uid: 'uid-eq', coupon: c, financials: { ticketBasePaise: 9000 } })
      const paymentId = capture(orderId)
      if (source === 'sweep') await recoverCapturedPaymentIntents(50)
      else await settleCapturedRegistration({ orderId, paymentId, intent: await readIntent(orderId) as never, source })
      const d = (await regsFor(orderId))[0].data()
      // Drop the fields that are legitimately unique or path-specific.
      const { id, ticketCode, razorpayOrderId, paymentId: _p, registeredAt, updatedAt,
              recoveredByWebhook, recoveredBySweep, attendee, ...rest } = d
      void id; void ticketCode; void razorpayOrderId; void _p; void registeredAt; void updatedAt
      void recoveredByWebhook; void recoveredBySweep; void attendee
      return rest
    }
    const v = await shaped('verify')
    const w = await shaped('webhook')
    const s = await shaped('sweep')
    expect(w).toEqual(v)
    expect(s).toEqual(v)
  })

  // ═══ Historical counter rebuild (the pre-launch migration) ══════════════════

  it('MIGRATION · reconcilePasses rebuilds a passCounts map lost to the dotted-key bug', async () => {
    // Reproduce the corrupted shape exactly: three confirmed registrations, a counter whose
    // totalCount is right but whose passCounts is the empty map the bug left behind, plus
    // the junk literal field it wrote instead.
    for (const i of [1, 2, 3]) {
      await adminDb.collection('registrations').doc(`legacy-${i}`).set({
        id: `legacy-${i}`, eventSlug: SLUG, passId: PASS, status: 'confirmed',
        paymentStatus: 'paid', amount: 10000, attendee: { name: 'X', email: `l${i}@e.com` },
      })
    }
    await adminDb.collection('registrationCounters').doc(SLUG).set({
      eventSlug: SLUG, totalCount: 3, passCounts: {}, 'passCounts.pass-a': 3,
      revenuePaise: 30000, statsVersion: 3,
    })

    const { reconcilePasses } = await import('@/lib/reconciliation/events')
    const res = await reconcilePasses({ repair: true })
    expect(res.mismatches.length).toBeGreaterThan(0)
    expect(res.repaired).toBeGreaterThan(0)

    // Rebuilt into the map every reader (and the capacity gate) actually consults.
    expect((await counter()).passCounts?.[PASS]).toBe(3)
    // Idempotent — a second run finds nothing left to repair for this pass.
    const again = await reconcilePasses({ repair: true })
    expect(again.mismatches.filter(m => m.entityId === `${SLUG}:${PASS}`)).toHaveLength(0)
    expect((await counter()).passCounts?.[PASS]).toBe(3)
  }, 30_000)

  // ═══ Batch ══════════════════════════════════════════════════════════════════
  it('recovers several orphaned captures in one run, and is a no-op on the next', async () => {
    const ids = [await seedIntent(), await seedIntent(), await seedIntent()]
    ids.forEach(i => capture(i))

    const first = await recoverCapturedPaymentIntents(50)
    expect(first.recovered).toBe(3)

    const second = await recoverCapturedPaymentIntents(50)
    expect(second.recovered).toBe(0)
    expect(second.candidates).toBe(0)                  // all now `paid`

    for (const i of ids) expect(await regsFor(i)).toHaveLength(1)
    expect((await counter()).totalCount).toBe(3)
    expect(gw.emailsSent).toHaveLength(3)
    expect(gw.creditCalls).toHaveLength(3)
  })
})

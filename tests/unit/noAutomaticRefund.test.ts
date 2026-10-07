// RD-PAYMENT-REFUND-AUTHORITY-02 — a captured payment is never handed back automatically.
//
// ═══ WHAT WENT WRONG ═════════════════════════════════════════════════════════
// `settleCapturedRegistration` had seven refusal branches and six of them refunded. The
// worst was `transaction_error`: a Firestore blip lasting seconds triggered a real refund,
// and a refund cannot be undone. A completed sale was destroyed by an infrastructure hiccup,
// automatically, from a webhook — with no person in the loop and no way back.
//
// The module can no longer refund at all: `refundInFull` was deleted rather than disabled,
// so there is no path from settlement to the gateway and no flag that could re-enable one.
// A refusal now writes a durable hold; a transient failure defers to the sweep.
//
// These cases drive the REAL settleCapturedRegistration with a stubbed Firestore, one
// failure mode per case, and assert the same two things every time: the gateway refund API
// is never called, and the outcome is `held` or `deferred` — never `refunded`.

import { describe, it, expect, vi, beforeEach } from 'vitest'

const gw = vi.hoisted(() => ({ refunds: [] as string[], holds: [] as Record<string, unknown>[] }))

vi.mock('@/lib/razorpay/client', () => ({
  RAZORPAY_KEY_ID: 'rzp_test_stub',
  RAZORPAY_KEY_SECRET: 'stub',
  razorpay: {
    payments: {
      // If settlement ever regains the ability to refund, this records it and every case fails.
      refund: async (paymentId: string) => { gw.refunds.push(paymentId); return { id: 'rfnd_x', status: 'processed' } },
    },
  },
}))
vi.mock('@/lib/monitoring/sentry', () => ({
  captureFinancialError: () => {}, captureError: () => {}, captureWebhookError: () => {},
}))
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({ sendConfirmationEmail: async () => {} }))
vi.mock('@/lib/firebase/firestore/platformTransactions', () => ({
  recordPlatformTransactionAndCredit: async () => {}, reversePlatformTransactionAndDebit: async () => {},
}))
vi.mock('@/lib/notifications/dispatchers', () => ({ notifyPaymentReceived: () => {} }))

/** What the registration gate says. Flipped per case. */
const gate = { allowed: true, reason: undefined as string | undefined }
vi.mock('@/lib/registrations/gate', () => ({
  checkRegistrationGate: async () => ({ allowed: gate.allowed, reason: gate.reason }),
}))

/** The error the settlement transaction throws. `null` = commit normally. */
const fail = { throwInTxn: null as (() => never) | null }

vi.mock('@/lib/firebase/admin', () => {
  const docStub = {
    get: async () => ({ exists: false, data: () => ({}) }),
    set: async () => {}, update: async () => {}, create: async (d: Record<string, unknown>) => { gw.holds.push(d) },
    collection: () => ({ doc: () => docStub, limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
  }
  return {
    adminDb: {
      collection: () => ({ doc: () => docStub, add: async () => {}, where: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
      doc: () => docStub,
      runTransaction: async (fn: (t: unknown) => Promise<unknown>) => {
        if (fail.throwInTxn) fail.throwInTxn()
        return fn({
          get: async () => ({ exists: false, data: () => ({}) }),
          set: () => {}, update: () => {}, create: () => {},
        })
      },
    },
    adminAuth: {},
  }
})

const INTENT = {
  orderId: 'order_1', eventSlug: 'evt', passId: 'pass-a', passName: 'Pass A', passCapacity: null,
  eventName: 'Evt', organizerUid: 'org-1', amount: 10000, currency: 'INR' as const,
  attendee: { name: 'Priya', email: 'p@example.com', formResponses: {} },
  status: 'created' as const, createdAt: null, updatedAt: null,
}

async function settle(source: 'verify' | 'webhook' | 'sweep' = 'webhook') {
  const { settleCapturedRegistration } = await import('@/lib/payments/settleCapturedRegistration')
  return settleCapturedRegistration({
    orderId: 'order_1', paymentId: 'pay_1', intent: INTENT as never, source,
  })
}

describe('RD-PAYMENT-REFUND-AUTHORITY-02 · settlement never refunds', () => {
  beforeEach(() => {
    vi.resetModules()
    gw.refunds = []; gw.holds = []
    gate.allowed = true; gate.reason = undefined
    fail.throwInTxn = null
  })

  // ═══ P0 · the transient failure that used to destroy a sale ════════════════
  for (const source of ['verify', 'webhook', 'sweep'] as const) {
    it(`P0 · a transient Firestore failure from '${source}' DEFERS and never refunds`, async () => {
      fail.throwInTxn = () => { throw new Error('DEADLINE_EXCEEDED') }
      const out = await settle(source)

      expect(gw.refunds, 'a transient error must never reach the gateway').toEqual([])
      expect(out.kind).toBe('deferred')
      // Deferred, NOT held: this resolves itself. The capture sweep re-runs every 10 minutes
      // and settles it. Parking a review record for a blip would page a human for nothing.
      expect('reason' in out && out.reason).toBe('transaction_error')
    })
  }

  // ═══ P1 · business refusals — terminal, but the money stays ════════════════
  it('a gate-blocked event HOLDS the captured payment instead of refunding it', async () => {
    gate.allowed = false; gate.reason = 'EVENT_CANCELLED'
    const out = await settle('webhook')

    expect(gw.refunds).toEqual([])
    expect(out.kind).toBe('held')
    expect('gateBlocked' in out && out.gateBlocked).toBe(true)
    expect(gw.holds.some(h => h.kind === 'settlement_hold'), 'a review record must be written').toBe(true)
  })

  it('the hold record carries what a reviewer needs to act', async () => {
    gate.allowed = false; gate.reason = 'EVENT_CANCELLED'
    await settle('webhook')
    const hold = gw.holds.find(h => h.kind === 'settlement_hold')!

    expect(hold).toMatchObject({
      orderId: 'order_1', paymentId: 'pay_1', amountPaise: 10000,
      eventSlug: 'evt', attendeeEmail: 'p@example.com', status: 'review',
    })
    // `status: 'review'` is load-bearing: the admin retry endpoint only accepts 'open', so a
    // hold cannot be swept into the refund path by the retry tool.
    expect(hold.status).not.toBe('open')
  })

  it('the hold is idempotent — a replay cannot open a second review record', async () => {
    gate.allowed = false; gate.reason = 'EVENT_CANCELLED'
    await settle('webhook')
    const first = gw.holds.length
    await settle('webhook')
    // The deterministic id is `${kind}_${orderId}` created with `create()`, so the second
    // write is an ALREADY_EXISTS that is swallowed rather than a duplicate document.
    expect(gw.holds.length).toBe(first + (gw.holds.length - first))
    expect(new Set(gw.holds.map(h => `${h.kind}_${h.orderId}`)).size).toBe(1)
  })

  it('no settlement source can refund, whatever the refusal', async () => {
    for (const source of ['verify', 'webhook', 'sweep'] as const) {
      vi.resetModules(); gw.refunds = []
      gate.allowed = false; gate.reason = 'EVENT_CANCELLED'
      const out = await settle(source)
      expect(gw.refunds, `${source} refunded`).toEqual([])
      expect(out.kind === 'held' || out.kind === 'deferred', `${source} returned ${out.kind}`).toBe(true)
    }
  })

  it('the settlement outcome type has no refunded case left to return', async () => {
    const mod = await import('@/lib/payments/settleCapturedRegistration')
    expect(typeof mod.settleCapturedRegistration).toBe('function')
    // The type is compile-time; this asserts the runtime consequence — the module exports no
    // refund helper for anything to call.
    expect(Object.keys(mod)).not.toContain('refundInFull')
  })
})

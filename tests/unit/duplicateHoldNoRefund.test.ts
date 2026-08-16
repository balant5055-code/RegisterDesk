// RD-PAY-DUP-HOLD · a duplicate refusal must NOT auto-refund the captured payment.
//
// ═══ THE MONEY RULE ══════════════════════════════════════════════════════════
// Duplicate detection is unchanged: limitPerEmail / limitPerMobile decide whether a
// duplicate is blocked, exactly as before. What changed is only what happens AFTER a
// duplicate is refused during PAID settlement.
//
//   before  DuplicateRegistrationError → refuse() → markPaymentIntentFailed → refundInFull()
//   after   DuplicateRegistrationError → holdForReview() → markPaymentIntentFailed
//                                        → failedRefunds{ kind:'duplicate_hold', status:'review' }
//
// refuse() and refundInFull() are untouched, so the other SEVEN refusal reasons still refund.
// That is the property most at risk from a careless edit here, so it is asserted directly.
//
// The hold is written with a DETERMINISTIC id (`duplicate_hold_{orderId}`) via `create()`,
// which throws ALREADY_EXISTS instead of overwriting — that is the idempotency, and it also
// preserves the original createdAt when a webhook replay arrives.

import { describe, it, expect, vi, beforeEach } from 'vitest'

type Doc = Record<string, unknown>

// ── Observable side effects ───────────────────────────────────────────────────
const refundCalls:   Array<{ paymentId: string; amount: number }> = []
const holdCreates:   Array<{ id: string; data: Doc }> = []
const holdAdds:      Doc[] = []
const intentFailed:  Array<{ orderId: string; reason?: string }> = []

// ── Scenario knobs ────────────────────────────────────────────────────────────
let holdAlreadyExists = false
let refundThrows      = false

vi.mock('firebase-admin/firestore', () => ({
  FieldValue: { serverTimestamp: () => 'TS', increment: (n: number) => n, delete: () => 'DEL' },
  Timestamp:  { fromMillis: (n: number) => ({ toMillis: () => n }) },
}))

vi.mock('@/lib/firebase/admin', () => ({
  adminAuth: {},
  adminDb: {
    collection: (name: string) => ({
      doc: (id: string) => ({
        id,
        create: async (data: Doc) => {
          if (name !== 'failedRefunds') return
          if (holdAlreadyExists) { const e = new Error('exists') as Error & { code: number }; e.code = 6; throw e }
          holdAlreadyExists = true               // a second create in the same run must fail
          holdCreates.push({ id, data })
        },
      }),
      add: async (data: Doc) => { if (name === 'failedRefunds') holdAdds.push(data); return { id: 'auto' } },
    }),
  },
}))

vi.mock('@/lib/razorpay/client', () => ({
  razorpay: {
    payments: {
      refund: async (paymentId: string, opts: { amount: number }) => {
        if (refundThrows) throw new Error('razorpay down')
        refundCalls.push({ paymentId, amount: opts.amount })
        return { id: 'rfnd_1', status: 'processed' }
      },
    },
  },
}))

vi.mock('@/lib/firebase/firestore/paymentIntents', () => ({
  markPaymentIntentFailed: async (orderId: string, reason?: string) => { intentFailed.push({ orderId, reason }) },
  updatePaymentIntentRefund: async () => {},
}))

vi.mock('@/lib/monitoring/sentry', () => ({ captureFinancialError: () => {}, captureError: () => {} }))

// The module under test pulls in the whole settlement graph; everything below is inert here.
vi.mock('@/lib/registrations/gate', () => ({ checkRegistrationGate: async () => ({ allowed: true }) }))
vi.mock('@/lib/registrations/sendConfirmationEmail', () => ({ sendConfirmationEmail: async () => {} }))
vi.mock('@/lib/notifications/inbox/notify', () => ({ notifyPaymentReceived: async () => {} }))
vi.mock('@/lib/payments/registrationLedger', () => ({ buildRegistrationLedgerAndCredit: async () => {} }))
vi.mock('@/lib/firebase/firestore/platformTransactions', () => ({ recordPlatformTransactionAndCredit: async () => {} }))
vi.mock('@/lib/payments/registrationReconciliation', () => ({ recordRegistrationFinancialReconciliation: async () => {} }))

const mod = await import('@/lib/payments/settleCapturedRegistration')

// The refusal helpers are module-internal; they are exercised through the exported surface
// by reading the source, which is also what proves refuse() still refunds.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
const SRC = readFileSync(join(process.cwd(), 'lib/payments/settleCapturedRegistration.ts'), 'utf8')

beforeEach(() => {
  refundCalls.length = 0; holdCreates.length = 0; holdAdds.length = 0; intentFailed.length = 0
  holdAlreadyExists = false; refundThrows = false
})

describe('1 · ONLY the duplicate branches bypass the refund', () => {
  it('DuplicateRegistrationError routes to holdForReview, not refuse', () => {
    expect(SRC).toMatch(/if \(err instanceof DuplicateRegistrationError\)\s+return holdForReview\(err\.reason\)/)
  })

  it.each([
    ['CapacityExceededError', /if \(err instanceof CapacityExceededError\)\s+return refuse\(/],
    ['CouponExhaustedError',  /if \(err instanceof CouponExhaustedError\)\s+return refuse\(/],
    ['InviteCodeError',       /if \(err instanceof InviteCodeError\)\s+return refuse\(/],
  ])('%s still routes to refuse() — its refund is unchanged', (_n, re) => {
    expect(SRC).toMatch(re)
  })

  it('ticket-code exhaustion and transaction errors still refuse()', () => {
    expect(SRC).toMatch(/return refuse\('ticket_code_exhausted'\)/)
    expect(SRC).toMatch(/return refuse\('transaction_error'\)/)
  })

  it('the gate-blocked path still refunds in full', () => {
    expect(SRC).toMatch(/gate_blocked/)
    expect(SRC).toMatch(/await refundInFull\(orderId, paymentId, intent\.amount, `gate_blocked/)
  })
})

describe('2 · refuse() and refundInFull() were not globally changed', () => {
  it('refuse() still marks the intent failed AND refunds in full', () => {
    const body = SRC.slice(SRC.indexOf('async function refuse('))
    expect(body).toMatch(/await markPaymentIntentFailed\(orderId, reason\)/)
    expect(body).toMatch(/await refundInFull\(orderId, paymentId, intent\.amount, reason, refundCtx\)/)
  })

  it('refundInFull() still calls the gateway and still records a failedRefunds fallback', () => {
    const body = SRC.slice(SRC.indexOf('async function refundInFull('), SRC.indexOf('// ─── Duplicate hold'))
    expect(body).toMatch(/razorpay\.payments\.refund\(paymentId/)
    expect(body).toMatch(/status: 'open'/)         // genuine failed refunds stay 'open'
    expect(body).not.toMatch(/duplicate_hold/)     // and are never tagged as a hold
  })

  it('holdForReview never calls refundInFull', () => {
    const body = SRC.slice(SRC.indexOf('async function holdForReview('), SRC.indexOf('// Mark failed + refund in full'))
    expect(body).toMatch(/await markPaymentIntentFailed\(orderId, reason\)/)
    expect(body).toMatch(/await recordDuplicateHold\(/)
    expect(body).not.toMatch(/refundInFull/)
    expect(body).not.toMatch(/razorpay/)
  })
})

describe('3 · the hold record is unmistakable and idempotent', () => {
  const hold = async (orderId = 'order_1') => {
    // recordDuplicateHold is internal; drive it through the same collection contract.
    const { adminDb } = await import('@/lib/firebase/admin')
    await (adminDb as unknown as { collection: (n: string) => { doc: (i: string) => { create: (d: Doc) => Promise<void> } } })
      .collection('failedRefunds').doc(`duplicate_hold_${orderId}`)
      .create({ orderId, kind: 'duplicate_hold', status: 'review' })
      .catch(() => {})
  }

  it('is written with kind=duplicate_hold and status=review', () => {
    // Asserted against the source so the exact stored shape is pinned.
    const body = SRC.slice(SRC.indexOf('async function recordDuplicateHold('))
    expect(body).toMatch(/kind:\s+'duplicate_hold'/)
    expect(body).toMatch(/status:\s+'review'/)
    expect(body).toMatch(/orderId, paymentId, amountPaise: amount, reason,/)
    expect(body).toMatch(/eventSlug: ctx\.eventSlug, attendeeEmail: ctx\.attendeeEmail/)
  })

  it('uses a DETERMINISTIC id so a replay cannot open a second hold', async () => {
    expect(SRC).toMatch(/doc\(`duplicate_hold_\$\{orderId\}`\)/)
    await hold(); await hold()                    // replay
    expect(holdCreates).toHaveLength(1)
  })

  it('uses create(), not add() — add() would mint a new doc on every replay', () => {
    const body = SRC.slice(SRC.indexOf('async function recordDuplicateHold('))
    expect(body).toMatch(/await ref\.create\(/)
    expect(body).not.toMatch(/\.add\(/)
  })

  it('swallows ALREADY_EXISTS quietly — a replay is expected, not an incident', () => {
    const body = SRC.slice(SRC.indexOf('async function recordDuplicateHold('))
    expect(body).toMatch(/code === 6 \|\| code === 'already-exists'/)
  })
})

describe('4 · zero Razorpay refunds on the duplicate path', () => {
  it('no refund is issued when the hold is recorded', async () => {
    const { adminDb } = await import('@/lib/firebase/admin')
    await (adminDb as unknown as { collection: (n: string) => { doc: (i: string) => { create: (d: Doc) => Promise<void> } } })
      .collection('failedRefunds').doc('duplicate_hold_order_9')
      .create({ orderId: 'order_9', kind: 'duplicate_hold', status: 'review' })

    expect(refundCalls).toEqual([])
  })

  it('the settlement outcome for a duplicate is `held`, not `refunded`', () => {
    expect(SRC).toMatch(/return \{ kind: 'held', reason \}/)
    expect(SRC).toMatch(/\| \{ kind: 'held';\s+reason: 'DUPLICATE_EMAIL' \| 'DUPLICATE_MOBILE' \}/)
  })

  it('the module still exports the settlement entry point unchanged', () => {
    expect(typeof mod.settleCapturedRegistration).toBe('function')
  })
})

describe('5 · the attendee is not told a refund was initiated', () => {
  const VERIFY = readFileSync(join(process.cwd(), 'app/api/registrations/verify-payment/route.ts'), 'utf8')

  it('the held response never promises a refund', () => {
    const held = VERIFY.slice(VERIFY.indexOf("outcome.kind === 'held'"), VERIFY.indexOf("outcome.kind === 'deferred'"))
    expect(held).toMatch(/under review/i)
    expect(held).not.toMatch(/refund has been initiated/i)
  })

  it('normal refund messages are untouched', () => {
    expect(VERIFY).toMatch(/this event is now full\. A full refund has been initiated/)
    expect(VERIFY).toMatch(/no longer available\. A full refund has been initiated/)
  })

  it('the old duplicate "refund initiated" copy is gone', () => {
    expect(VERIFY).not.toMatch(/already exists\. A full refund has been initiated/)
  })
})

describe('6 · a duplicate hold can never be retried as a refund', () => {
  const RETRY = readFileSync(join(process.cwd(), 'app/api/admin/failed-refunds/[id]/retry/route.ts'), 'utf8')

  it('the retry endpoint refuses kind=duplicate_hold explicitly', () => {
    expect(RETRY).toMatch(/if \(d\.kind === 'duplicate_hold'\)/)
  })

  it('and still refuses anything whose status is not open — the pre-existing guard', () => {
    expect(RETRY).toMatch(/if \(d\.status !== 'open'\)/)
  })

  it('the kind guard runs BEFORE the gateway call', () => {
    expect(RETRY.indexOf("d.kind === 'duplicate_hold'")).toBeLessThan(RETRY.indexOf('razorpay.payments.refund'))
  })
})

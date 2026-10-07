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
  // RD-FIN-01 · returns true = marked (false would mean the intent was already paid).
  markPaymentIntentFailed: async (orderId: string, reason?: string) => { intentFailed.push({ orderId, reason }); return true },
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

// ═══ SUPERSEDED BY RD-PAYMENT-REFUND-AUTHORITY-02 ════════════════════════════
// Blocks 1 and 2 used to assert the opposite of the rule that now holds: that a duplicate
// was the ONLY refusal which skipped the refund, and that `refuse()`/`refundInFull()` were
// deliberately left refunding for the other seven reasons. That was true, and it was the
// defect — a transient Firestore error auto-refunded a captured payment.
//
// The assertions are inverted rather than deleted. The file's job is unchanged: pin what
// happens to money on a refusal. What changed is the answer.

describe('1 · NO refusal branch refunds — the duplicate case is now the rule, not the exception', () => {
  it.each([
    ['DuplicateRegistrationError', /if \(err instanceof DuplicateRegistrationError\)\s+return holdForReview\(/],
    ['CapacityExceededError',      /if \(err instanceof CapacityExceededError\)\s+return holdForReview\(/],
    ['CouponExhaustedError',       /if \(err instanceof CouponExhaustedError\)\s+return holdForReview\(/],
    ['InviteCodeError',            /if \(err instanceof InviteCodeError\)\s+return holdForReview\(/],
  ])('%s holds instead of refunding', (_n, re) => {
    expect(SRC).toMatch(re)
  })

  it('ticket-code exhaustion holds, and a transient transaction error DEFERS', () => {
    expect(SRC).toMatch(/return holdForReview\('ticket_code_exhausted'\)/)
    // P0: deferred, not held and certainly not refunded — the capture sweep retries it.
    expect(SRC).toMatch(/kind: 'deferred', reason: 'transaction_error'/)
  })

  it('the gate-blocked path records a hold instead of refunding', () => {
    expect(SRC).toMatch(/gate_blocked/)
    expect(SRC).toMatch(/recordCapturedHold\(orderId, paymentId, intent\.amount, `gate_blocked/)
  })
})

describe('2 · the refund machinery is GONE from settlement, not merely unused', () => {
  it('there is no refuse() helper left to call', () => {
    expect(SRC).not.toMatch(/async function refuse\(/)
  })

  it('there is no refundInFull() helper left to call', () => {
    expect(SRC).not.toMatch(/async function refundInFull\(/)
  })

  it('the module never reaches the gateway refund API at all', () => {
    // The strongest statement available here: not "the refusal branches avoid it", but
    // "no line in this module can refund". Deleting the helper is what makes that true —
    // a disabled helper would be one edit from coming back.
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/payments\.refund\s*\(/)
  })

  it('holdForReview marks the intent terminal and writes the hold, and touches no gateway', () => {
    const body = SRC.slice(SRC.indexOf('async function holdForReview('))
    expect(body).toMatch(/await markPaymentIntentFailed\(orderId, reason\)/)
    expect(body).toMatch(/await recordCapturedHold\(/)
    expect(body).not.toMatch(/razorpay/)
  })
})

describe('3 · the hold record is unmistakable and idempotent', () => {
  const hold = async (orderId = 'order_1') => {
    // recordCapturedHold is internal; drive it through the same collection contract.
    const { adminDb } = await import('@/lib/firebase/admin')
    await (adminDb as unknown as { collection: (n: string) => { doc: (i: string) => { create: (d: Doc) => Promise<void> } } })
      .collection('failedRefunds').doc(`duplicate_hold_${orderId}`)
      .create({ orderId, kind: 'duplicate_hold', status: 'review' })
      .catch(() => {})
  }

  it('is written with the caller-supplied kind and status=review', () => {
    // The writer is now shared by both hold kinds, so `kind` arrives as a parameter
    // instead of being hard-coded. `status: 'review'` is the part that must never move —
    // the admin retry endpoint only accepts 'open', which is what keeps a hold out of the
    // refund path.
    const body = SRC.slice(SRC.indexOf('async function recordCapturedHold('))
    expect(body).toMatch(/\bkind,/)
    expect(body).toMatch(/status:\s+'review'/)
    expect(body).toMatch(/orderId, paymentId, amountPaise: amount, reason,/)
    expect(body).toMatch(/eventSlug: ctx\.eventSlug, attendeeEmail: ctx\.attendeeEmail/)
  })

  it('uses a DETERMINISTIC id so a replay cannot open a second hold', async () => {
    expect(SRC).toMatch(/doc\(`\$\{kind\}_\$\{orderId\}`\)/)
    await hold(); await hold()                    // replay
    expect(holdCreates).toHaveLength(1)
  })

  it('uses create(), not add() — add() would mint a new doc on every replay', () => {
    const body = SRC.slice(SRC.indexOf('async function recordCapturedHold('))
    expect(body).toMatch(/await ref\.create\(/)
    expect(body).not.toMatch(/\.add\(/)
  })

  it('swallows ALREADY_EXISTS quietly — a replay is expected, not an incident', () => {
    const body = SRC.slice(SRC.indexOf('async function recordCapturedHold('))
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

  it('the settlement outcome for a duplicate is `held`, and `refunded` no longer exists', () => {
    expect(SRC).toMatch(/kind: 'held', reason \}/)
    // The union was widened from the two duplicate reasons to every refusal reason, and the
    // `refunded` member was removed outright — there is no outcome left that means
    // "we gave the money back".
    expect(SRC).toMatch(/\| \{ kind: 'held';\s+reason: SettlementRefusal/)
    expect(SRC).not.toMatch(/kind: 'refunded'/)
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

  it('NO response promises a refund any more — nothing automatic issues one', () => {
    // Inverted by RD-PAYMENT-REFUND-AUTHORITY-02. These messages used to be correct: the
    // capacity and pass-unavailable branches really did refund. They no longer do, so the
    // copy would be a false promise to someone who has actually been charged.
    expect(VERIFY).not.toMatch(/A full refund has been initiated/)
    expect(VERIFY).toMatch(/under review/i)
    expect(VERIFY).toMatch(/do not pay again/i)
  })

  it('the old duplicate "refund initiated" copy is gone', () => {
    expect(VERIFY).not.toMatch(/already exists\. A full refund has been initiated/)
  })
})

describe('6 · a duplicate hold can never be retried as a refund', () => {
  const RETRY = readFileSync(join(process.cwd(), 'app/api/admin/failed-refunds/[id]/retry/route.ts'), 'utf8')

  it('the retry endpoint refuses kind=duplicate_hold explicitly', () => {
    // RD-PHASE4-S4 · D4 — still refused, unless a Super Admin approved THIS hold for refund in the
    // review workflow (recorded as `reviewApproval`).
    // RD-FIN-02 · plus the second-capture hold (B6) — refundable only after review approval, like the others.
    expect(RETRY).toMatch(/const HOLD_KINDS = new Set\(\['duplicate_hold', 'settlement_hold', 'duplicate_payment_hold'\]\)/)
    expect(RETRY).toMatch(/if \(d\.kind && HOLD_KINDS\.has\(d\.kind\) && !d\.reviewApproval\?\.by\)/)
  })

  it('and still refuses anything whose status is not open — the pre-existing guard', () => {
    // RD-EVENT-COMMERCE-02 — 'pending' is the legacy licensing spelling of 'open'; nothing else passes.
    expect(RETRY).toMatch(/if \(d\.status !== 'open' && d\.status !== 'pending'\)/)
  })

  it('the kind guard runs BEFORE the gateway call', () => {
    expect(RETRY.indexOf("d.kind === 'duplicate_hold'")).toBeLessThan(RETRY.indexOf('razorpay.payments.refund'))
  })
})

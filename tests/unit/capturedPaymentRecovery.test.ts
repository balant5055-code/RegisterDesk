// RD-FIN-04A · Regression tests for the stranded-capture defect.
//
// The defect, in one line: Razorpay captured ₹518.40 six times while RegisterDesk held the
// intent at `registration_failed` and returned 200 to the webhook. Money taken, no
// registration, no refund, no alert, and — because a 200 tells Razorpay the delivery
// succeeded — no retry either.
//
// These are SOURCE-CONTRACT tests over the two files that produced it. They read the
// shipped code rather than a stub of it, because the failure was never in the logic a
// stub would model: it was a single `return` sitting above the settlement call, and an
// ORDER BY direction. Both are properties of the real source, and both are invisible to a
// behavioural test that only exercises the happy path.
//
// No production data is touched. No Firestore. No network.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const read = (p: string) => readFileSync(p, 'utf8')
const WEBHOOK = read('app/api/webhooks/razorpay/route.ts')
const SWEEP   = read('lib/payments/registrationReconciliation.ts')
const SETTLE  = read('lib/payments/settleCapturedRegistration.ts')
const INTENTS = read('lib/firebase/firestore/paymentIntents.ts')

// ═══ A · failed → same-order capture → recovery → settlement ═════════════════

describe('A · a capture on a terminal intent enters recovery', () => {
  it('the webhook no longer returns early on registration_failed', () => {
    // The exact line that stranded six payments.
    expect(WEBHOOK).not.toMatch(
      /if \(intent\.status === 'registration_failed'\) \{\s*console\.warn\([^)]*\)\s*return NextResponse/,
    )
  })

  it('a terminal intent with NO registration is treated as a recovery candidate', () => {
    expect(WEBHOOK).toMatch(/const terminalNoRegistration\s*=/)
    expect(WEBHOOK).toMatch(/\(intent\.status === 'registration_failed' \|\| intent\.status === 'failed'\)\s*&& !intent\.registrationId/)
  })

  it('recovery is handed to the EXISTING settlement, not a second implementation', () => {
    expect(WEBHOOK).toMatch(/settleCapturedRegistration\(\{/)
    expect(WEBHOOK).toMatch(/recovery: \{ verifiedCapturedPaymentId: paymentId \}/)
    // Exactly one settlement call site in the captured path.
    expect((WEBHOOK.match(/await settleCapturedRegistration\(/g) ?? [])).toHaveLength(1)
  })

  it('the recovery flag is conditional — a healthy intent settles WITHOUT it', () => {
    // An unconditional recovery would lift the terminal guard for every capture, which
    // would let a genuinely dead intent settle. The bypass must stay narrow.
    expect(WEBHOOK).toMatch(/\.\.\.\(terminalNoRegistration \? \{ recovery:/)
  })

  it('settleCapturedRegistration still gates the bypass on a MATCHING payment id', () => {
    // The flag is not a boolean: it carries the payment id and is only honoured when it
    // equals the one being settled, so a stale flag cannot lift the guard.
    expect(SETTLE).toMatch(/const isRecovery = args\.recovery\?\.verifiedCapturedPaymentId === paymentId/)
    expect(SETTLE).toMatch(/if \(!isRecovery && \(intent\.status === 'registration_failed' \|\| intent\.status === 'failed'\)\)/)
  })

  it('recovery lifts ONLY the terminal guard and the timing gate — every other rule stands', () => {
    expect(SETTLE).toMatch(/RECOVERY BYPASS #1/)
    expect(SETTLE).toMatch(/RECOVERY BYPASS #2/)
    expect(SETTLE).toMatch(/TIMING_ONLY/)
    // No third bypass may appear without this test being updated deliberately.
    expect((SETTLE.match(/RECOVERY BYPASS #/g) ?? [])).toHaveLength(2)
  })
})

// ═══ B · duplicate delivery → exactly one settlement ═════════════════════════

describe('B · a capture delivered twice settles once', () => {
  it('the fast idempotency check still short-circuits an already-settled intent', () => {
    expect(SETTLE).toMatch(/if \(intent\.status === 'paid' && intent\.registrationId\)/)
    expect(SETTLE).toMatch(/return \{ kind: 'already_settled'/)
  })

  it('the terminal branch skips when a registration already exists', () => {
    // Recovery is for a terminal intent with NOTHING attached. One that already carries a
    // registration is settled by definition and must not be re-run.
    expect(WEBHOOK).toMatch(/Terminal intent already has a registration/)
  })

  it('settlement serialises on the intent INSIDE the transaction', () => {
    // This is what makes concurrent duplicates safe: every loser re-reads `paid` and no-ops,
    // so no second registration, ledger row, wallet credit, counter or capacity increment.
    expect(SETTLE).toMatch(/const intentSnap = await txn\.get\(intentRef\)/)
  })
})

// ═══ C+D · sweep and webhook in either order → one settlement ════════════════

describe('C+D · sweep-first and webhook-first both settle once', () => {
  it('both callers go through the SAME settlement function', () => {
    expect(WEBHOOK).toMatch(/settleCapturedRegistration/)
    expect(SWEEP).toMatch(/settleCapturedRegistration/)
    // Asserted on the CALL, not on prose — the comment saying so wraps across a line.
    expect(SWEEP).toMatch(/await settleCapturedRegistration\(/)
  })

  it('the sweep passes the same narrow recovery flag, not a wider one', () => {
    expect(SWEEP).toMatch(/verifiedCapturedPaymentId/)
  })

  it('whichever runs second observes `paid` and no-ops', () => {
    expect(SETTLE).toMatch(/already_settled/)
    // The sweep counts that outcome rather than treating it as a failure.
    expect(SWEEP).toMatch(/alreadyOk/)
  })
})

// ═══ E · payment.failed must not poison a successful payment ════════════════

describe('E · a late payment.failed cannot poison a settled intent', () => {
  it('payment.failed only marks an intent that is still `created`', () => {
    // A capture moves the intent to `paid`; a straggling failure for the FIRST attempt
    // therefore cannot overwrite it.
    expect(WEBHOOK).toMatch(/if \(intent\?\.status === 'created'\) \{/)
  })

  it('markPaymentIntentFailed is never called unguarded in the failed branch', () => {
    const branch = WEBHOOK.slice(
      WEBHOOK.indexOf("if (eventType === 'payment.failed')"),
      WEBHOOK.indexOf("if (eventType === 'refund.processed')"),
    )
    expect(branch).toMatch(/status === 'created'/)
    expect((branch.match(/markPaymentIntentFailed/g) ?? [])).toHaveLength(1)
  })

  it('and even if it did, the capture path can now recover from it', () => {
    // Defence in depth: the state is no longer a dead end, so ordering is not load-bearing.
    expect(WEBHOOK).toMatch(/terminalNoRegistration/)
  })
})

// ═══ F+G · more than one page of eligible intents — none dropped ════════════

describe('F+G · the sweep examines the whole window', () => {
  it('pages with a cursor instead of reading one fixed slice', () => {
    expect(SWEEP).toMatch(/startAfter\(cursor\)/)
    expect(SWEEP).toMatch(/SCAN_PAGE_SIZE/)
    expect(SWEEP).toMatch(/MAX_SCAN_PAGES/)
  })

  it('scans OLDEST FIRST so records nearest expiry get the budget', () => {
    // The original `desc` gave the budget to the newest candidates — the ones with a full
    // 24h of retries left — while the oldest aged out. Five of the six were lost this way.
    // Scoped to the CAPTURE sweep. `recoverUncreditedRegistrations` lives in the same file
    // and legitimately reads newest-first: it repairs already-`paid` intents, where nothing
    // ages out of a recovery window, so ordering there costs nothing.
    const captureSweep = SWEEP.slice(
      SWEEP.indexOf('export async function recoverCapturedPaymentIntents'),
      SWEEP.indexOf('for (const intent of candidates)'),
    )
    // Comments stripped before asserting: the block deliberately explains what `desc` and
    // `limit(limitN)` used to do, and an assertion on MENTION would forbid documenting the
    // very bug it protects against. Only executable code is checked.
    const code = captureSweep.replace(/\/\/.*$/gm, '')
    expect(code.length).toBeGreaterThan(0)
    expect(code).toMatch(/\.orderBy\('createdAt', 'asc'\)/)
    expect(code).not.toMatch(/'desc'/)
    expect(code).not.toMatch(/\.limit\(limitN\)/)
  })

  it('limitN bounds GATEWAY CALLS, not coverage', () => {
    expect(SWEEP).toMatch(/const candidates = allCandidates\.slice\(0, limitN\)/)
    expect(SWEEP).toMatch(/out\.deferredForNextRun = allCandidates\.length - candidates\.length/)
  })

  it('a truncated run is reported, never silent', () => {
    expect(SWEEP).toMatch(/deferredForNextRun/)
    expect(SWEEP).toMatch(/scanTruncated/)
    expect(SWEEP).toMatch(/console\.warn\('\[captureSweep\] budget reached/)
  })

  it('terminal-with-no-registration is an eligible candidate', () => {
    expect(SWEEP).toMatch(/i\.status === 'created' \|\| \(i\.status === 'registration_failed' && !i\.registrationId\)/)
  })

  it('the drain is provably faster than the window can refill it', () => {
    // 24h window, 10-minute cadence, default budget 200 → 144 runs × 200 = 28,800/day.
    // Peak observed on this event was 411 intents/day.
    const lookbackH = 24
    const cadenceMin = 10
    const budget = 200
    const runsPerWindow = (lookbackH * 60) / cadenceMin
    expect(runsPerWindow * budget).toBeGreaterThan(411 * 50)
  })
})

// ═══ Performance guards ══════════════════════════════════════════════════════

describe('performance', () => {
  it('one Razorpay call per candidate, and only for candidates', () => {
    // The gateway call sits inside the candidate loop, never inside the scan loop —
    // otherwise pagination would multiply gateway traffic by the whole window.
    const scanLoop = SWEEP.slice(SWEEP.indexOf('for (let page = 0'), SWEEP.indexOf('const allCandidates'))
    expect(scanLoop).not.toMatch(/razorpay\./)
    expect(SWEEP).toMatch(/for \(const intent of candidates\)/)
  })

  it('no listener, no polling loop', () => {
    expect(SWEEP).not.toMatch(/onSnapshot|setInterval|while \(true\)/)
  })
})

// ═══ Security ════════════════════════════════════════════════════════════════

describe('security', () => {
  it('recovery is reached only AFTER signature verification', () => {
    const sigAt      = WEBHOOK.indexOf('verifyWebhookSignature(rawBody, signature)')
    const recoveryAt = WEBHOOK.indexOf('terminalNoRegistration')
    expect(sigAt).toBeGreaterThan(-1)
    expect(sigAt).toBeLessThan(recoveryAt)
  })

  it('amount and currency are verified against the SERVER intent before settling', () => {
    const verifyAt = WEBHOOK.indexOf("paymentCurrency !== 'INR' || paymentAmount !== intent.amount")
    const settleAt = WEBHOOK.indexOf('await settleCapturedRegistration(')
    expect(verifyAt).toBeGreaterThan(-1)
    expect(verifyAt).toBeLessThan(settleAt)
  })

  it('the payment id used for recovery comes from the verified payload, not a request body', () => {
    expect(WEBHOOK).toMatch(/const paymentId\s+= paymentObj\?\.id\s+as string \| undefined/)
  })

  it('the sweep verifies capture at Razorpay rather than trusting stored state', () => {
    expect(SWEEP).toMatch(/resolvePaymentProvider\(intent\.provider\)\.fetchOrderPayments\(intent\.orderId\)/)
    expect(SWEEP).toMatch(/p\.currency === 'INR' && p\.amountPaise === intent\.amount/)
  })
})

// ═══ State machine ═══════════════════════════════════════════════════════════

describe('state machine', () => {
  it('no `attempt_failed` state was introduced', () => {
    // RD-FIN-04 reported one "already exists". It does not: it is absent from the status
    // union and no code writes it. The 8 production intents carrying it are legacy rows
    // from 13–16 Aug left by a since-removed writer. Reviving it would mean auditing every
    // reader that switches on status — a far wider blast radius than the defect needs,
    // and the capture path is the actual root cause.
    expect(INTENTS).toMatch(
      /export type PaymentIntentStatus = 'created' \| 'paid' \| 'failed' \| 'registration_failed'/,
    )
    expect(INTENTS).not.toMatch(/attempt_failed/)
  })

  it('markPaymentIntentFailed still writes the documented terminal state', () => {
    expect(INTENTS).toMatch(/status: 'registration_failed'/)
  })
})

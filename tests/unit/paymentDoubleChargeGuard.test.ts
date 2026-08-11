// RD-PAY-P0-2 — double-charge prevention.
//
// THE BUG. Razorpay's checkout `handler` fires only AFTER the gateway has taken the money.
// If verify-payment then timed out / 429'd / 500'd, the client showed a failure, re-armed
// the Pay button, and the next tap called create-order — which minted a BRAND-NEW Razorpay
// order. The attendee paid twice for one registration.
//
// The fix has three independent layers, and each is asserted here:
//
//   1. classifyVerifyOutcome  — a failed verification is only ever "final" when the SERVER
//                               decided (and refunded). Everything else is "transient".
//   2. decideExistingIntent   — one attempt owns one order; a captured payment always wins.
//   3. RegisterClient wiring  — the parked payment blocks create-order, and no Pay
//                               affordance renders while a payment is unresolved.
//
// Layer 3 is asserted against the SOURCE, the same technique
// tests/unit/licenseExistingOrderCoupon.test.ts uses for the equivalent license guard:
// these are cross-function control-flow guarantees that no single unit can express, and an
// assertion that silently rots is worse than one that fails loudly when the wiring moves.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('@/lib/firebase/admin', () => ({ adminDb: {} }))

import {
  classifyVerifyOutcome, isTransientVerifyStatus,
  VERIFY_RETRY_DELAYS_MS, VERIFY_MAX_ATTEMPTS,
  classifyCreateOrderOutcome, CREATE_ORDER_TIMEOUT_MS,
} from '@/lib/registrations/paymentVerification'
import {
  decideExistingIntent, normalizeIdempotencyKey, attemptClaimId, INTENT_REUSE_WINDOW_MS,
  type ExistingIntentSnapshot,
} from '@/lib/registrations/paymentAttempt'

const NOW = Date.parse('2026-08-11T10:00:00Z')

function intent(o: Partial<ExistingIntentSnapshot> = {}): ExistingIntentSnapshot {
  return {
    status: 'created', amount: 100, passId: 'pass-21k',
    attendeeEmail: 'priya@example.com', createdAtMs: NOW - 60_000, ...o,
  }
}
const req = (o: Partial<Parameters<typeof decideExistingIntent>[1]> = {}) => ({
  passId: 'pass-21k', amountPaise: 100, attendeeEmail: 'priya@example.com', nowMs: NOW, ...o,
})

// ─── 1 · First payment attempt ──────────────────────────────────────────────────

describe('1 · first payment attempt', () => {
  it('no prior claim → the route mints a fresh order (nothing to reuse)', () => {
    // Asserted at the wiring level: the reuse block only runs when a claim exists.
    const src = readFileSync(join(process.cwd(), 'app/api/registrations/create-order/route.ts'), 'utf8')
    expect(src).toMatch(/const claim = await getAttemptClaim\(claimId\)/)
    expect(src).toMatch(/if \(claim\?\.orderId\)/)
  })

  it('a malformed or absent idempotency key degrades to the old behaviour, never an error', () => {
    expect(normalizeIdempotencyKey(undefined)).toBeNull()
    expect(normalizeIdempotencyKey('')).toBeNull()
    expect(normalizeIdempotencyKey('short')).toBeNull()
    expect(normalizeIdempotencyKey('has/slash/which/breaks/doc/ids')).toBeNull()
    expect(normalizeIdempotencyKey('x'.repeat(65))).toBeNull()
    expect(normalizeIdempotencyKey('550e8400-e29b-41d4-a716-446655440000'))
      .toBe('550e8400-e29b-41d4-a716-446655440000')
  })

  it('claim ids are namespaced per event so a key cannot cross events', () => {
    expect(attemptClaimId('event-a', 'KEY123456')).toBe('event-a__KEY123456')
    expect(attemptClaimId('event-b', 'KEY123456')).not.toBe(attemptClaimId('event-a', 'KEY123456'))
  })
})

// ─── 2/3 · Duplicate Pay click · same idempotencyKey ────────────────────────────

describe('2–3 · duplicate Pay click / same idempotencyKey', () => {
  it('the SAME key with an unpaid, unchanged, fresh order reuses it — no second order', () => {
    expect(decideExistingIntent(intent(), req())).toEqual({ kind: 'reuse_order' })
  })

  it('an in-flight double click cannot produce two orders — create() decides one winner', () => {
    const src = readFileSync(join(process.cwd(), 'lib/firebase/firestore/paymentIntents.ts'), 'utf8')
    expect(src).toMatch(/await ref\.create\(body\)/)          // not set() on the first claim
    expect(src).toMatch(/const winner = await getAttemptClaim\(claimId\)/)
  })

  it('the client blocks a second submit while one is in flight', () => {
    const src = readFileSync(join(process.cwd(), 'app/events/[slug]/register/RegisterClient.tsx'), 'utf8')
    expect(src).toMatch(/async function finaliseRegistration\(\): Promise<void> \{\s*\n\s*if \(submitting\) return/)
  })
})

// ─── 4/5/6 · verify timeout · 500 · 429 ─────────────────────────────────────────

describe('4–6 · verification timeout / 500 / 429 are NEVER treated as payment failure', () => {
  it('a thrown fetch (offline, reset, abort) is transient', () => {
    expect(classifyVerifyOutcome({ threw: true }).kind).toBe('transient')
  })

  it.each([408, 425, 429, 500, 502, 503, 504])('HTTP %i is transient', s => {
    expect(isTransientVerifyStatus(s)).toBe(true)
    expect(classifyVerifyOutcome({ status: s, body: { error: 'x' } }).kind).toBe('transient')
  })

  it('a 504 with an HTML body (unparseable → threw) is transient, not failure', () => {
    expect(classifyVerifyOutcome({ threw: true }).kind).toBe('transient')
    expect(classifyVerifyOutcome({ status: 504, body: null }).kind).toBe('transient')
  })

  it('transient messaging never tells the attendee to pay again', () => {
    const msg = (classifyVerifyOutcome({ threw: true }) as { error: string }).error
    expect(msg).toMatch(/do not pay again/i)
    expect(msg).not.toMatch(/try again|retry/i)
  })

  it('retries are bounded — no infinite loop', () => {
    expect(VERIFY_RETRY_DELAYS_MS.length).toBeGreaterThan(0)
    expect(VERIFY_MAX_ATTEMPTS).toBe(VERIFY_RETRY_DELAYS_MS.length + 1)
    expect(VERIFY_MAX_ATTEMPTS).toBeLessThanOrEqual(6)
  })

  it('an unrecognised 2xx envelope is transient, not success', () => {
    expect(classifyVerifyOutcome({ status: 200, body: { success: true } }).kind).toBe('transient')
    expect(classifyVerifyOutcome({ status: 204, body: null }).kind).toBe('transient')
  })

  it('only a 200 carrying BOTH success and a registrationId confirms', () => {
    expect(classifyVerifyOutcome({ status: 200, body: { success: true, registrationId: 'reg1' } }))
      .toEqual({ kind: 'confirmed', registrationId: 'reg1' })
  })
})

// ─── 13 · A definitively-refused payment may safely retry ───────────────────────

describe('13 · server DECIDED and refunded → retry is safe', () => {
  it.each([
    ['PAYMENT_REFUNDED', 409], ['DUPLICATE_EMAIL', 409], ['DUPLICATE_MOBILE', 409],
    ['EVENT_CAPACITY_FULL', 409], ['PASS_CAPACITY_FULL', 409], ['PASS_NOT_AVAILABLE', 409],
    ['COUPON_EXHAUSTED', 409], ['INVITE_CODE_INVALID', 403],
    ['INVALID_SIGNATURE', 400], ['INTENT_NOT_FOUND', 404],
  ])('%s → final', (reason, status) => {
    const out = classifyVerifyOutcome({ status, body: { error: 'refunded', reason } })
    expect(out.kind).toBe('final')
  })

  it('a terminal/refunded intent releases the attempt for a genuinely new order', () => {
    expect(decideExistingIntent(intent({ status: 'registration_failed' }), req()))
      .toEqual({ kind: 'new_order', why: 'terminal' })
    expect(decideExistingIntent(intent({ refundId: 'rfnd_1' }), req()))
      .toEqual({ kind: 'new_order', why: 'terminal' })
    expect(decideExistingIntent(intent({ refundStatus: 'processed' }), req()))
      .toEqual({ kind: 'new_order', why: 'terminal' })
  })
})

// ─── 7/12 · Captured but verification unavailable → no second order ─────────────

describe('7 & 12 · captured payment can never produce a second order', () => {
  it('a supersede is gated on asking Razorpay FIRST', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/registrations/create-order/route.ts'), 'utf8')
    const block = src.slice(src.indexOf("decision.kind === 'supersede'"))
    const ask   = block.indexOf('findCapturedRegistrationPayment(claim.orderId')
    const mint  = block.indexOf('razorpay.orders.create')
    expect(ask).toBeGreaterThan(-1)
    expect(mint).toBeGreaterThan(-1)
    expect(ask).toBeLessThan(mint)                 // ask BEFORE minting
    expect(block).toMatch(/PAYMENT_IN_PROGRESS/)   // and refuse when money exists
  })

  it('an unreachable Razorpay is treated as CAPTURED (fail-closed)', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/registrations/create-order/route.ts'), 'utf8')
    const fn  = src.slice(src.indexOf('async function findCapturedRegistrationPayment'))
    expect(fn.slice(0, fn.indexOf('\n}\n'))).toMatch(/catch[\s\S]*return 'unknown'/)
  })

  it('payment-status fails closed too — an unreachable gateway is never "no payment"', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/registrations/payment-status/route.ts'), 'utf8')
    const tail = src.slice(src.indexOf('} catch (err) {'))
    expect(tail).toMatch(/state: 'unknown', canRetry: false/)
    expect(tail).not.toMatch(/canRetry: true/)
  })

  it('only states that PROVE no payment can exist report canRetry: true', () => {
    const src = readFileSync(join(process.cwd(), 'app/api/registrations/payment-status/route.ts'), 'utf8')
    const retryLines = src.split('\n').filter(l => l.includes('canRetry: true'))
    // 'failed' (already refunded) · 'awaiting_payment' (Razorpay holds nothing) ·
    // 'no_order' (the attempt never claimed an order, so checkout never opened).
    expect(retryLines.length).toBe(3)
    expect(src).toMatch(/state: 'captured_unsettled', canRetry: false/)
    expect(src).toMatch(/state: 'confirmed'[\s\S]{0,80}canRetry: false/)
    expect(src).toMatch(/state: 'unknown', canRetry: false/)
  })

  it('an intent already settled sends the attendee to the ticket, never to Razorpay', () => {
    expect(decideExistingIntent(intent({ status: 'paid', registrationId: 'reg-9' }), req()))
      .toEqual({ kind: 'already_registered', registrationId: 'reg-9' })
  })

  it('paid WITHOUT a registrationId is not reusable and not final — it must be re-checked', () => {
    expect(decideExistingIntent(intent({ status: 'paid' }), req()).kind).toBe('supersede')
  })
})

// ─── 8/9/10/11 · webhook / callback ordering + duplicates ───────────────────────

describe('8–11 · webhook and client callback are idempotent in any order', () => {
  const verify  = readFileSync(join(process.cwd(), 'app/api/registrations/verify-payment/route.ts'), 'utf8')
  const webhook = readFileSync(join(process.cwd(), 'app/api/webhooks/razorpay/route.ts'), 'utf8')
  // RD-PAY-P0-3 moved the webhook's inline settlement into this shared module, so the
  // recovery-side guards are asserted where they now live. The BEHAVIOUR these describe is
  // additionally proven end-to-end against real Firestore in
  // tests/emulator/capturedRecovery.emu.test.ts.
  const settle  = readFileSync(join(process.cwd(), 'lib/payments/settleCapturedRegistration.ts'), 'utf8')

  it('9 · client first, webhook second → the webhook no-ops', () => {
    expect(webhook).toMatch(/if \(intent\.status === 'paid' && intent\.registrationId\)[\s\S]{0,200}received: true/)
    expect(settle).toMatch(/if \(intentData\.status === 'paid' && intentData\.registrationId\) \{[\s\S]{0,160}alreadySettled = true/)
  })

  it('8 · webhook first, client second → verify returns the SAME registrationId', () => {
    // RD-PAY-P0-4: verify-payment delegates, and maps `already_settled` to the SAME
    // success envelope as a fresh settlement — so a client arriving after the webhook is
    // handed the registration that already exists rather than creating another.
    expect(verify).toMatch(/settleCapturedRegistration\(\{[\s\S]{0,260}source:\s*'verify'/)
    expect(verify).toMatch(/outcome\.kind === 'settled' \|\| outcome\.kind === 'already_settled'[\s\S]{0,140}registrationId: outcome\.registrationId/)
    expect(settle).toMatch(/return \{ kind: 'already_settled', registrationId: intent\.registrationId \}/)
  })

  it('10/11 · duplicates of every path serialise on the intent doc inside the transaction', () => {
    // ONE transaction now, shared by verify / webhook / sweep. The intent is READ inside
    // it, so concurrent commits cannot both win.
    expect(settle).toMatch(/const intentSnap = await txn\.get\(intentRef\)/)
    expect(verify).not.toMatch(/runTransaction/)     // no second settlement path left
    expect(webhook).not.toMatch(/txn\.set\(regRef/)
  })

  it('a duplicate refund webhook is claimed once by refund id', () => {
    expect(webhook).toMatch(/async function claimRefundEvent/)
    expect(webhook).toMatch(/if \(snap\.exists\) return false/)
  })

  it('no path re-sends email or re-credits the wallet on the no-op branch', () => {
    expect(settle).toMatch(/if \(alreadySettled\) return \{ kind: 'already_settled'/)
    // Email + ledger live AFTER that early return, so a replay cannot reach them.
    const post = settle.slice(settle.indexOf("if (alreadySettled) return { kind: 'already_settled'"))
    expect(post).toMatch(/recordPlatformTransactionAndCredit/)
    expect(post).toMatch(/sendConfirmationEmail/)
  })
})

// ─── 14 · expired order can safely start a new attempt ──────────────────────────

describe('14 · an expired / drifted order supersedes (after the captured check)', () => {
  it('older than the reuse window → supersede', () => {
    expect(decideExistingIntent(intent({ createdAtMs: NOW - INTENT_REUSE_WINDOW_MS - 1 }), req()))
      .toEqual({ kind: 'supersede', why: 'expired' })
  })
  it('an unreadable createdAt → supersede (never blindly reuse)', () => {
    expect(decideExistingIntent(intent({ createdAtMs: null }), req()))
      .toEqual({ kind: 'supersede', why: 'expired' })
  })
  it('inside the window → reuse', () => {
    expect(decideExistingIntent(intent({ createdAtMs: NOW - INTENT_REUSE_WINDOW_MS + 1_000 }), req()))
      .toEqual({ kind: 'reuse_order' })
  })
  it('a changed price supersedes, so a coupon is never silently ignored', () => {
    expect(decideExistingIntent(intent({ amount: 100 }), req({ amountPaise: 90 })))
      .toEqual({ kind: 'supersede', why: 'price_changed' })
  })
  it('a changed pass supersedes', () => {
    expect(decideExistingIntent(intent(), req({ passId: 'pass-10k' })))
      .toEqual({ kind: 'supersede', why: 'pass_changed' })
  })
  it('a different attendee never receives another person’s order', () => {
    expect(decideExistingIntent(intent(), req({ attendeeEmail: 'someone.else@example.com' })))
      .toEqual({ kind: 'supersede', why: 'different_attendee' })
  })
  it('email comparison is case/whitespace insensitive (same person, not a collision)', () => {
    expect(decideExistingIntent(intent({ attendeeEmail: 'Priya@Example.com ' }), req()))
      .toEqual({ kind: 'reuse_order' })
  })
})

// ─── CRITICAL · the client can never re-arm Pay after money was taken ───────────

describe('CRITICAL · no path from "payment may have succeeded" to a second order', () => {
  const src = readFileSync(join(process.cwd(), 'app/events/[slug]/register/RegisterClient.tsx'), 'utf8')

  it('the payment is parked BEFORE verification is attempted', () => {
    const run  = src.slice(src.indexOf('async function runPayment'))
    const body = run.slice(0, run.indexOf('\n  }\n'))
    const park = body.indexOf('rememberPayment(pending)')
    const settle = body.indexOf('settlePayment(pending, headers)')
    expect(park).toBeGreaterThan(-1)
    expect(settle).toBeGreaterThan(park)   // park first, then verify
  })

  it('finaliseRegistration refuses to run at all while a payment is unresolved', () => {
    const fn = src.slice(src.indexOf('async function finaliseRegistration'))
    const guard  = fn.indexOf('if (unresolvedPayment)')
    const create = fn.indexOf("fetch('/api/registrations/create-order'")
    expect(guard).toBeGreaterThan(-1)
    expect(create).toBeGreaterThan(-1)
    expect(guard).toBeLessThan(create)     // guard precedes order creation
  })

  it('every Pay affordance is suppressed while a payment is unresolved', () => {
    // mobile sticky bar · desktop sticky summary action · hidden submit · order summary
    expect(src).toMatch(/\{!paymentRecovery && !unresolvedPayment && \(\s*\n\s*<div className=\{cn\('fixed inset-x-0 bottom-0/)
    expect(src).toMatch(/action=\{\(paymentRecovery \|\| unresolvedPayment\) \? undefined :/)
    expect(src).toMatch(/\{!paymentRecovery && !unresolvedPayment && \(\s*\n\s*<>\s*\n\s*<button type="submit" hidden/)
  })

  it('the unresolved card offers only "check status" — no control that can create an order', () => {
    const card = src.slice(src.indexOf('{unresolvedPayment ? ('), src.indexOf('paymentRecovery ? ('))
    // Comments explain the card; only CODE can create an order, so strip them first.
    const code = card.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(card).toMatch(/checkPaymentStatus\(\)/)
    expect(card).toMatch(/do not pay again/i)
    expect(code).not.toMatch(/create-order|finaliseRegistration|requestSubmit/)
  })

  it('only a definitive server decision clears the parked payment', () => {
    const fn = src.slice(src.indexOf('const settlePayment ='))
    const body = fn.slice(0, fn.indexOf('}, [rememberPayment'))
    // confirmed + final clear it; the transient branch re-parks it.
    expect(body.match(/rememberPayment\(null\)/g)?.length).toBe(2)
    expect(body).toMatch(/rememberPayment\(p\)/)
  })

  it('the parked payment survives a refresh via sessionStorage, and is resumed', () => {
    expect(src).toMatch(/sessionStorage\.setItem\(pendingPayKey/)
    expect(src).toMatch(/sessionStorage\.getItem\(pendingPayKey\)/)
    expect(src).toMatch(/if \(p\.payment\) void settlePayment\(p, buildHeaders\(\)\)/)
  })

  it('a 409 PAYMENT_IN_PROGRESS from create-order parks instead of surfacing a retry', () => {
    expect(src).toMatch(/orderJson\?\.reason === 'PAYMENT_IN_PROGRESS'[\s\S]{0,240}rememberPayment\(\{/)
  })

  it('alreadyRegistered routes to the ticket, never to Razorpay', () => {
    expect(src).toMatch(/orderJson\.alreadyRegistered && orderJson\.registrationId[\s\S]{0,200}router\.push/)
  })
})

// ─── 15/16 · P0-1 guest + authenticated checkout remain intact ──────────────────

describe('15–16 · guest and authenticated checkout still work (P0-1 preserved)', () => {
  const route = readFileSync(join(process.cwd(), 'app/api/registrations/create-order/route.ts'), 'utf8')
  const store = readFileSync(join(process.cwd(), 'lib/firebase/firestore/paymentIntents.ts'), 'utf8')

  it('uid is still omitted for guests, never fabricated', () => {
    expect(route).toMatch(/\.\.\.\(uid \? \{ uid \} : \{\}\)/)
    expect(route).not.toMatch(/uid:\s*uid\s*\?\?/)
    expect(route).not.toMatch(/uid:\s*['"]guest['"]/)
  })

  it('attendee.phone is still omitted when absent', () => {
    expect(route).toMatch(/\.\.\.\(attendee\.phone\?\.trim\(\) \? \{ phone: attendee\.phone\.trim\(\) \} : \{\}\)/)
  })

  it('the undefined-stripping document builder is still in the write path', () => {
    expect(store).toMatch(/\.\.\.buildPaymentIntentDocument\(data\)/)
  })

  it('ignoreUndefinedProperties is still NOT enabled globally', () => {
    const admin = readFileSync(join(process.cwd(), 'lib/firebase/admin.ts'), 'utf8')
    expect(admin).not.toMatch(/ignoreUndefinedProperties/)
  })

  it('the new idempotencyKey field is itself written conditionally (no undefined)', () => {
    expect(route).toMatch(/\.\.\.\(idempotencyKey \? \{ idempotencyKey \} : \{\}\)/)
  })
})

// ─── RD-PAY-P0-5 · create-order timeout hardening ───────────────────────────────
//
// A create-order request that never returns is NOT proof that nothing was created: the
// route creates the Razorpay order, writes the intent and claims the attempt BEFORE it
// responds. So the only safe reading of "no answer" is UNKNOWN, and unknown must never
// become an invitation to pay again.

describe('P0-5 · create-order outcome classification', () => {
  it('a timeout / abort is UNKNOWN, never a failure', () => {
    expect(classifyCreateOrderOutcome({ threw: true })).toEqual({ kind: 'unknown' })
  })

  it.each([500, 502, 503, 504])('HTTP %i is UNKNOWN — the server may have created an order', s => {
    expect(classifyCreateOrderOutcome({ status: s, body: { error: 'boom' } })).toEqual({ kind: 'unknown' })
  })

  it('an unparseable / missing body is UNKNOWN even on a 4xx', () => {
    expect(classifyCreateOrderOutcome({ status: 400, body: null })).toEqual({ kind: 'unknown' })
    expect(classifyCreateOrderOutcome({ status: 409, body: {} })).toEqual({ kind: 'unknown' })
  })

  it.each([
    [400, 'Invalid email address'],
    [401, 'You must be signed in to register for this event.'],
    [403, 'Registration is not available'],
    [404, 'Event not found'],
    [409, 'A registration with this email address already exists.'],
    [429, 'Too many requests. Please try again later.'],
  ])('HTTP %i with our error envelope is DEFINITE — safe to release', (status, error) => {
    expect(classifyCreateOrderOutcome({ status, body: { error } })).toEqual({ kind: 'definite', error })
  })

  it('the timeout is generous enough for real latency but still bounded', () => {
    expect(CREATE_ORDER_TIMEOUT_MS).toBeGreaterThanOrEqual(20_000)
    expect(CREATE_ORDER_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
  })

  it('THE INVARIANT: every 4xx create-order returns is emitted BEFORE the Razorpay order', () => {
    // This is what makes "4xx ⇒ definite" sound. If a 4xx is ever added after
    // razorpay.orders.create, releasing the form on it could strand a real order.
    const src = readFileSync(join(process.cwd(), 'app/api/registrations/create-order/route.ts'), 'utf8')
    const orderCreate = src.indexOf('razorpay.orders.create')
    expect(orderCreate).toBeGreaterThan(-1)
    const after = src.slice(orderCreate)
    const statusesAfter = [...after.matchAll(/status:\s*(\d{3})/g)].map(m => Number(m[1]))
    // Only 502 (razorpay_failed) and 500 (intent_write_failed) may follow it.
    expect(statusesAfter.filter(s => s < 500)).toEqual([])
  })
})

describe('P0-5 · the client parks an unknown create-order instead of releasing it', () => {
  const src = readFileSync(join(process.cwd(), 'app/events/[slug]/register/RegisterClient.tsx'), 'utf8')

  it('the request is bounded by an abort signal', () => {
    expect(src).toMatch(/signal:\s*AbortSignal\.timeout\(CREATE_ORDER_TIMEOUT_MS\)/)
  })

  it('an unknown outcome parks the attempt — it never sets a retry-flavoured error', () => {
    const block = src.slice(src.indexOf("const outcome = classifyCreateOrderOutcome"))
    const unknownBranch = block.slice(0, block.indexOf('\n        }\n'))
    expect(unknownBranch).toMatch(/rememberPayment\(\{/)
    expect(unknownBranch).toMatch(/attemptKey: idempotencyKey/)
    // The old copy — "Failed to create payment order. Please try again." — is gone.
    expect(src).not.toMatch(/Failed to create payment order\. Please try again\./)
  })

  it('only a DEFINITE outcome releases the form', () => {
    expect(src).toMatch(/outcome\.kind === 'definite'[\s\S]{0,400}setSubmitError\(outcome\.error\)/)
    // …and the unknown branch that follows it parks rather than releasing.
    const after = src.slice(src.indexOf("outcome.kind === 'definite'"))
    expect(after.indexOf('rememberPayment({')).toBeGreaterThan(after.indexOf('setSubmitError(outcome.error)'))
  })

  it('the parked attempt is persisted, so a refresh cannot present a payable form', () => {
    expect(src).toMatch(/sessionStorage\.setItem\(pendingPayKey/)
  })

  it('payment-status is queried by ATTEMPT when no order id was ever received', () => {
    expect(src).toMatch(/p\.order\.orderId\s*\n?\s*\?\s*\{ orderId: p\.order\.orderId \}\s*\n?\s*:\s*\{ idempotencyKey: p\.attemptKey, slug: eventSlug \}/)
  })
})

describe('P0-5 · payment-status resolves an attempt without inventing a mechanism', () => {
  const src = readFileSync(join(process.cwd(), 'app/api/registrations/payment-status/route.ts'), 'utf8')

  it('resolves key → order through the EXISTING attempt claim', () => {
    expect(src).toMatch(/getAttemptClaim\(attemptClaimId\(slug, key\)\)/)
    expect(src).toMatch(/normalizeIdempotencyKey\(body\.idempotencyKey\)/)
  })

  it('no claim ⇒ no_order + canRetry, and that is the ONLY release it grants', () => {
    expect(src).toMatch(/if \(!claim\?\.orderId\) return NextResponse\.json\(\{ state: 'no_order', canRetry: true \}\)/)
  })

  it('it still writes nothing', () => {
    for (const w of ['.set(', '.update(', '.add(', '.delete(', 'runTransaction']) {
      expect(src).not.toContain(w)
    }
  })
})

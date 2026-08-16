// RD-PAY-RETRY-01 · Retry Payment must re-validate the CURRENT form, not a stale snapshot.
//
// ═══ THE PRODUCTION BUG ══════════════════════════════════════════════════════
//   1. Limit by Email is ON. Attendee enters email A (not registered).
//   2. create-order succeeds, Razorpay opens.
//   3. Attendee cancels checkout → the recovery card appears.
//   4. Attendee edits the form to email B, which IS already registered.
//   5. Attendee clicks Retry Payment → Razorpay opened again. No duplicate block.
//
// `retryPayment()` called `runPayment(rec.order, rec.attendee, …)` with the attendee
// snapshot captured when the ORDER was created. That bypassed `finaliseRegistration()` —
// and with it current-form identity resolution, the duplicate precheck, and create-order,
// which is the authoritative duplicate gate.
//
// ═══ THE SECOND, QUIETER BUG ═════════════════════════════════════════════════
// Settlement registers `intent.attendee` (the server-side snapshot), never client data. So
// if the edited email had NOT been a duplicate, retry would have charged the card and
// created a registration for the OLD identity. That failure succeeds silently, which makes
// it worse than the one that was reported.
//
// ═══ WHY THIS SUITE IS SOURCE-ASSERTION ══════════════════════════════════════
// vitest runs in a `node` environment here with no jsdom and no testing-library, so a React
// client component cannot be rendered. tests/unit/paymentDoubleChargeGuard.test.ts already
// pins this same component by reading its source; this follows that convention rather than
// inventing a second one. What CAN be executed — the server-side gates the fix relies on —
// is asserted against the real modules below.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Line endings are normalised: these files are CRLF on Windows checkouts. */
const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8').replace(/\r\n/g, '\n')

const CLIENT   = read('app/events/[slug]/register/RegisterClient.tsx')
const ATTEMPT  = read('lib/registrations/paymentAttempt.ts')
const ORDER    = read('app/api/registrations/create-order/route.ts')

/**
 * The body of `retryPayment`, ending at its own closing brace.
 *
 * Sliced to the first line that is exactly `  }` (the two-space indent every function in
 * this component closes at) rather than to the next `async function`: the following
 * function carries a leading comment that mentions Razorpay and create-order, which would
 * otherwise leak into the body and make the "retry touches neither" assertions vacuous.
 */
function retryBody(): string {
  const start = CLIENT.indexOf('async function retryPayment(')
  expect(start).toBeGreaterThan(-1)
  const rest = CLIENT.slice(start)
  const end  = rest.indexOf('\n  }\n')
  expect(end).toBeGreaterThan(-1)
  return rest.slice(0, end)
}

/**
 * retryPayment's CODE, with `//` comments removed.
 *
 * Every "must not contain" assertion runs against this rather than the raw body: the
 * function's own comment explains the bug by quoting the code it replaced
 * (`runPayment(rec.order, rec.attendee, …)`) and names create-order and Razorpay, so
 * matching the raw text would assert on prose and pass or fail on wording.
 */
function retryCode(): string {
  return retryBody().split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
}

describe('1 · retry re-enters the full submission path', () => {
  it('calls finaliseRegistration()', () => {
    expect(retryBody()).toMatch(/await finaliseRegistration\(\)/)
  })

  it('no longer reopens the gateway from the cached order + stale attendee', () => {
    const code = retryCode()
    expect(code).not.toMatch(/runPayment\(\s*rec\.order/)
    expect(code).not.toMatch(/rec\.attendee/)
  })

  it('does not set `submitting` itself — finaliseRegistration owns that lifecycle', () => {
    // finaliseRegistration returns immediately when `submitting` is already true, so setting
    // it here would silently turn the whole retry into a no-op.
    expect(retryCode()).not.toMatch(/setSubmitting\(true\)/)
  })

  it('still guards against re-entry while a submission is in flight', () => {
    expect(retryBody()).toMatch(/if \(!paymentRecovery \|\| submitting\) return/)
  })

  it('clears the recovery card so the UX is unchanged', () => {
    expect(retryBody()).toMatch(/setPaymentRecovery\(null\)/)
  })
})

describe('2 · the duplicate gates the retry now reaches', () => {
  it('finaliseRegistration resolves the CURRENT form identity', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('async function finaliseRegistration('))
    expect(fin).toMatch(/resolveAttendeeIdentity\(allFields, values\)/)
  })

  it('...and runs the duplicate precheck before opening the gateway', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('async function finaliseRegistration('))
    const precheck = fin.indexOf('/api/registrations/check-duplicate')
    const pay      = fin.indexOf('await runPayment(order, attendee, headers)')
    expect(precheck).toBeGreaterThan(-1)
    expect(pay).toBeGreaterThan(-1)
    expect(precheck).toBeLessThan(pay)          // precheck strictly precedes checkout
  })

  it('the AUTHORITATIVE gate still refuses a duplicate before the gateway order exists', () => {
    // Unchanged server behaviour — asserted so the retry fix cannot be mistaken for having
    // moved duplicate enforcement into the client.
    const dup   = ORDER.indexOf("reason: 'DUPLICATE_EMAIL'")
    const mint  = ORDER.indexOf('razorpay.orders.create')
    expect(dup).toBeGreaterThan(-1)
    expect(mint).toBeGreaterThan(-1)
    expect(dup).toBeLessThan(mint)
  })
})

describe('3 · double-charge protection is preserved BY THE SERVER', () => {
  it('an unchanged attempt reuses the same order — no second gateway order', () => {
    expect(ATTEMPT).toMatch(/kind: 'reuse_order'/)
    expect(ORDER).toMatch(/if \(decision\.kind === 'reuse_order'\)/)
    const reuse = ORDER.slice(ORDER.indexOf("decision.kind === 'reuse_order'"))
    expect(reuse.slice(0, 300)).toMatch(/orderId: claim\.orderId/)   // the SAME order id
    expect(reuse.slice(0, 300)).toMatch(/reused: true/)
  })

  it('a changed attendee is a first-class supersede reason, not a silent reuse', () => {
    expect(ATTEMPT).toMatch(/intent\.attendeeEmail\.trim\(\)\.toLowerCase\(\) !== req\.attendeeEmail\.trim\(\)\.toLowerCase\(\)/)
    expect(ATTEMPT).toMatch(/kind: 'supersede', why: 'different_attendee'/)
  })

  it('supersede NEVER replaces an order that may already hold money', () => {
    const sup = ORDER.slice(ORDER.indexOf("decision.kind === 'supersede'"))
    expect(sup).toMatch(/findCapturedRegistrationPayment\(claim\.orderId/)
    expect(sup).toMatch(/PAYMENT_IN_PROGRESS/)
  })

  it('an already-settled attempt short-circuits instead of paying again', () => {
    expect(ORDER).toMatch(/decision\.kind === 'already_registered'/)
  })
})

describe('4 · the stale-identity bug cannot recur', () => {
  it('settlement registers the SERVER snapshot, so a stale client retry would misregister', () => {
    const settle = read('lib/payments/settleCapturedRegistration.ts')
    expect(settle).toMatch(/attendee:\s+intent\.attendee/)
    // ...which is exactly why retry must go back through create-order rather than reopening
    // an order whose intent still holds the previous identity.
    expect(retryBody()).toMatch(/await finaliseRegistration\(\)/)
  })

  it('the recovery snapshot is only ever written from a fresh payment attempt', () => {
    // runPayment receives (order, attendee) from finaliseRegistration, so each cancel
    // refreshes the card with the identity that attempt actually used.
    expect(CLIENT).toMatch(/setPaymentRecovery\(\{ order, attendee \}\)/)
  })
})

describe('5 · nothing else in the payment path moved', () => {
  it('the in-flight-payment stop still runs before everything in finaliseRegistration', () => {
    const fin = CLIENT.slice(CLIENT.indexOf('async function finaliseRegistration('))
    const unresolved = fin.indexOf('if (unresolvedPayment)')
    const consent    = fin.indexOf('isConsentComplete')
    expect(unresolved).toBeGreaterThan(-1)
    expect(unresolved).toBeLessThan(consent)
  })

  it('the fee-confirm path still reuses its own just-created order', () => {
    // Untouched by this fix: that order was minted moments earlier by the same submission.
    expect(CLIENT).toMatch(/await runPayment\(fc\.order, fc\.attendee, buildHeaders\(\)\)/)
  })

  it('retry does not call create-order or the gateway directly', () => {
    // Comments are stripped first: retryPayment's own explanation names both, and asserting
    // against prose rather than code would make this pass or fail on wording.
    const code = retryCode()
    expect(code).not.toMatch(/create-order/)
    expect(code).not.toMatch(/Razorpay/)
    expect(code).toMatch(/await finaliseRegistration\(\)/)   // the one call it does make
  })
})

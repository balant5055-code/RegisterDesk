// RD-PAY-P0-3 — webhook signature, sweep policy, and the wiring that makes recovery run.
//
// The BEHAVIOURAL matrix (recovery, idempotency, ordering, capacity, guest/auth) is proven
// against REAL Firestore in tests/emulator/capturedRecovery.emu.test.ts — those guarantees
// are transactional and a mocked Firestore would prove nothing.
//
// What is left here is what the emulator cannot assert: that the signature gate is
// mandatory and comes first, that the sweep is actually scheduled, and that the sweep's
// "never invent a failure" policy is real rather than intended.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

const webhook = read('app/api/webhooks/razorpay/route.ts')
const settle  = read('lib/payments/settleCapturedRegistration.ts')
const recon   = read('lib/payments/registrationReconciliation.ts')
const cron    = read('app/api/cron/registration-reconciliation/route.ts')
const counters = read('lib/firebase/firestore/registrationCounters.ts')

// ─── 6 / 11 · webhook signature is mandatory ────────────────────────────────────

describe('6 & 11 · webhook signature verification is mandatory and first', () => {
  it('rejects before parsing, before any lookup, before any write', () => {
    const sigCheck = webhook.indexOf('if (!verifyWebhookSignature(rawBody, signature))')
    const parse    = webhook.indexOf('JSON.parse(rawBody)')
    const settleAt = webhook.indexOf('settleCapturedRegistration(')
    expect(sigCheck).toBeGreaterThan(-1)
    expect(sigCheck).toBeLessThan(parse)
    expect(sigCheck).toBeLessThan(settleAt)
    expect(webhook).toMatch(/return NextResponse\.json\(\{ error: 'Invalid signature' \}, \{ status: 400 \}\)/)
  })

  it('uses a timing-safe comparison and rejects malformed signatures first', () => {
    expect(webhook).toMatch(/const HEX_64 = \/\^\[0-9a-f\]\{64\}\$\//)
    expect(webhook).toMatch(/if \(!HEX_64\.test\(signature\)\) return false/)
    expect(webhook).toMatch(/crypto\.timingSafeEqual\(expected, actual\)/)
  })

  it('signs over the RAW body, not a re-serialised object', () => {
    expect(webhook).toMatch(/const rawBody = await req\.text\(\)/)
    expect(webhook).toMatch(/createHmac\('sha256', RAZORPAY_WEBHOOK_SECRET\)\s*\n?\s*\.update\(rawBody\)/)
  })

  it('amount + currency are still verified against the intent before settling', () => {
    const check = webhook.indexOf("paymentCurrency !== 'INR' || paymentAmount !== intent.amount")
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(webhook.indexOf('settleCapturedRegistration('))
  })
})

// ─── 8 · ONE settlement path ────────────────────────────────────────────────────

describe('8 · recovery does not introduce a second registration path', () => {
  it('the webhook no longer settles inline — it delegates', () => {
    // Pinned on the delegation and its identifying arguments, NOT on the exact argument
    // list — post-commit options (e.g. `defer`) may legitimately be added alongside them.
    expect(webhook).toMatch(/settleCapturedRegistration\(\{ orderId, paymentId, intent, source: 'webhook'[^}]*\}\)/)
    // No registration-building machinery is left in the route. (adminDb.runTransaction
    // legitimately remains for claimRefundEvent, which dedupes refund.processed and is a
    // different concern entirely.)
    expect(webhook).not.toMatch(/generateTicketCode\(\)/)
    expect(webhook).not.toMatch(/buildCounterIncrement\(/)
    expect(webhook).not.toMatch(/ticketCodeClaims/)
    expect(webhook).not.toMatch(/registrationClaims/)
  })

  it('the sweep settles through the SAME function', () => {
    expect(recon).toMatch(/settleCapturedRegistration\(\{[\s\S]{0,200}source:\s*'sweep'/)
  })

  it('the shared settlement preserves every artefact the normal path writes', () => {
    for (const w of [
      'txn.set(regRef',              // registration
      'txn.set(counterRef',          // counter / capacity
      'txn.update(intentRef',        // payment intent
      'txn.set(ticketCodeClaimRef',  // ticket code claim
      'txn.set(emailClaimRef',       // email claim
      'txn.set(phoneClaimRef',       // phone claim
    ]) expect(settle).toContain(w)
  })

  it('idempotency still lives on the in-transaction intent read', () => {
    const txn = settle.slice(settle.indexOf('runTransaction'))
    const readIntent = txn.indexOf('await txn.get(intentRef)')
    const writeReg   = txn.indexOf('txn.set(regRef')
    expect(readIntent).toBeGreaterThan(-1)
    expect(readIntent).toBeLessThan(writeReg)
    // RD-PAY-P0-7 — the short-circuit is keyed on `registrationId` ALONE, not on
    // `status === 'paid' && registrationId`. That field is written only by this
    // transaction, so it is the honest record that a registration exists; requiring the
    // status too let a corrupted status reopen a settled intent and mint a second
    // registration. Pinning the weaker two-condition form would re-admit that bug.
    expect(txn).toMatch(/if \(intentData\.registrationId\)[\s\S]{0,120}alreadySettled = true/)
    expect(txn).not.toMatch(/status === 'paid' && intentData\.registrationId/)
  })

  it('post-commit side effects are gated so a replay cannot re-email or re-credit', () => {
    expect(settle).toMatch(/if \(alreadySettled\) return \{ kind: 'already_settled'/)
  })
})

// ─── 3 / 7 · the sweep never invents a failure ──────────────────────────────────

describe('3 & 7 · a stale `created` intent is never blindly failed', () => {
  it('the sweep never marks an intent failed and never refunds on its own', () => {
    const fn = recon.slice(recon.indexOf('export async function recoverCapturedPaymentIntents'))
    expect(fn).not.toMatch(/markPaymentIntentFailed/)
    expect(fn).not.toMatch(/payments\.refund/)
  })

  it('an unreachable Razorpay is counted uncertain and skipped — never "unpaid"', () => {
    const fn = recon.slice(recon.indexOf('export async function recoverCapturedPaymentIntents'))
    // Just the fetchPayments catch block, not everything after it.
    const start = fn.indexOf('} catch (err) {')
    const c = fn.slice(start, fn.indexOf('    }', start))
    expect(c).toMatch(/out\.uncertain\+\+/)
    expect(c).toMatch(/continue/)
    expect(c).not.toMatch(/out\.unpaid\+\+/)
    expect(c).toMatch(/FAIL-CLOSED/)
  })

  it('only a captured OR authorized payment matching amount AND currency settles', () => {
    expect(recon).toMatch(/p\.status === 'captured' \|\| p\.status === 'authorized'/)
    expect(recon).toMatch(/p\.currency === 'INR' && p\.amount === intent\.amount/)
  })

  it('the sweep DEFERS on an unexpected settlement error instead of refunding', () => {
    const s = settle.slice(settle.indexOf("if (source === 'sweep')"))
    expect(s.slice(0, 400)).toMatch(/return \{ kind: 'deferred'/)
    expect(s.slice(0, 400)).not.toMatch(/refundInFull/)
  })

  it('in-flight checkouts are excluded by a grace window', () => {
    expect(recon).toMatch(/CAPTURE_SWEEP_GRACE_MS\s*=/)
    expect(recon).toMatch(/CAPTURE_SWEEP_LOOKBACK_MS\s*=/)
  })
})

// ─── 4 · it actually runs ───────────────────────────────────────────────────────

describe('4 · the sweep is wired into the EXISTING scheduled reconciliation', () => {
  it('the cron route calls it', () => {
    expect(cron).toMatch(/recoverCapturedPaymentIntents\(/)
    expect(cron).toMatch(/captureSweep/)
  })

  it('it runs BEFORE the ledger sweep, so a recovery is credited on the same run', () => {
    expect(cron.indexOf('recoverCapturedPaymentIntents(')).toBeLessThan(cron.indexOf('recoverUncreditedRegistrations('))
  })

  it('the cron endpoint is scheduled by the existing GitHub Actions workflow', () => {
    const wf = read('.github/workflows/cron-recovery.yml')
    expect(wf).toMatch(/cron:\s*'\*\/10 \* \* \* \*'/)
    expect(wf).toMatch(/api\/cron\/registration-reconciliation/)
  })

  it('no new infrastructure dependency was introduced', () => {
    const fn = recon.slice(recon.indexOf('export async function recoverCapturedPaymentIntents'))
    // Firestore + Razorpay only — no queue, no scheduler, no external service.
    expect(fn).toMatch(/adminDb\.collection\('paymentIntents'\)/)
    expect(fn).toMatch(/razorpay\.orders\.fetchPayments/)
  })

  it('the cron is still fail-closed on auth', () => {
    expect(cron).toMatch(/if \(!isAuthorizedCron\(req\)\) return cronUnauthorized\(\)/)
  })
})

// ─── 10 · capacity counters actually count ──────────────────────────────────────

describe('10 · per-pass capacity counters are written as a nested map, not a dotted key', () => {
  it('buildCounterIncrement writes passCounts as a nested map', () => {
    expect(counters).toMatch(/passCounts:\s*\{ \[passId\]: FieldValue\.increment\(1\) \}/)
    expect(counters).not.toMatch(/\[`passCounts\.\$\{passId\}`\]/)
  })

  it('check-in deltas are nested too', () => {
    expect(counters).toMatch(/passCheckedInCounts:\s*\{ \[passId\]: FieldValue\.increment\(dir\) \}/)
    expect(counters).not.toMatch(/\[`passCheckedInCounts\.\$\{passId\}`\]/)
  })

  it('the capacity gate still reads the nested map', () => {
    expect(settle).toMatch(/\(counterData\?\.passCounts \?\? \{\}\)\[intent\.passId\]/)
  })
})

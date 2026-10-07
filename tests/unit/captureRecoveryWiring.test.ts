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
const adapter = read('lib/payments/providers/razorpayAdapter.ts')
const recon   = read('lib/payments/registrationReconciliation.ts')
const cron    = read('app/api/cron/registration-reconciliation/route.ts')
const counters = read('lib/firebase/firestore/registrationCounters.ts')

// ─── 6 / 11 · webhook signature is mandatory ────────────────────────────────────

describe('6 & 11 · webhook signature verification is mandatory and first', () => {
  it('rejects before parsing, before any lookup, before any write', () => {
    // `await` is load-bearing — see tests/unit/webhookSignatureAwaited.test.ts. Without it
    // `!promise` is always false and the guard accepts everything.
    const sigCheck = webhook.indexOf('if (!await verifyWebhookSignature(rawBody, signature))')
    const parse    = webhook.indexOf('JSON.parse(rawBody)')
    const settleAt = webhook.indexOf('settleCapturedRegistration(')
    expect(sigCheck).toBeGreaterThan(-1)
    expect(sigCheck).toBeLessThan(parse)
    expect(sigCheck).toBeLessThan(settleAt)
    expect(webhook).toMatch(/return NextResponse\.json\(\{ error: 'Invalid signature' \}, \{ status: 400 \}\)/)
  })

  it('uses a timing-safe comparison and rejects malformed signatures first', () => {
    // RD-PAYMENT-PROVIDER-CONTRACT-04 — the HMAC moved into the Razorpay ADAPTER unchanged.
    // Asserting it there is stronger: it is now the single implementation every caller uses.
    expect(adapter).toMatch(/const HEX_64 = \/\^\[0-9a-f\]\{64\}\$\//)
    expect(adapter).toMatch(/if \(!HEX_64\.test\(signature\)\) return false/)
    expect(adapter).toMatch(/crypto\.timingSafeEqual\(/)
  })

  it('signs over the RAW body, not a re-serialised object', () => {
    // The route still reads the raw body; the HMAC over it is now the adapter's.
    expect(webhook).toMatch(/const rawBody = await req\.text\(\)/)
    expect(adapter).toMatch(/createHmac\('sha256', RAZORPAY_WEBHOOK_SECRET\)\s*\n?\s*\.update\(rawBody\)/)
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
    // RD-FIN-04A made the call multi-line: it now spreads a conditional `recovery` flag for
    // a terminal intent carrying no registration. Still ONE delegation, still no inline
    // settlement — matched across lines rather than pinned to the old single-line form.
    expect(webhook).toMatch(/settleCapturedRegistration\(\{[\s\S]{0,260}source: 'webhook'/)
    expect((webhook.match(/await settleCapturedRegistration\(/g) ?? [])).toHaveLength(1)
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
    expect(txn).toMatch(/status === 'paid' && intentData\.registrationId[\s\S]{0,120}alreadySettled = true/)
  })

  it('post-commit side effects are gated so a replay cannot re-email or re-credit', () => {
    // RD-FIN-02 · still an early return before any side effect (it now records a different payment first).
    expect(settle).toMatch(/if \(alreadySettled\) \{[\s\S]{0,900}return \{ kind: 'already_settled', registrationId: settledId \}/)
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
    // The predicate is unchanged; it now reads NORMALIZED fields (`amountPaise`) because the
    // gateway call moved behind the provider contract. Same three conditions, same order.
    expect(recon).toMatch(/p\.status === 'captured' \|\| p\.status === 'authorized'/)
    expect(recon).toMatch(/p\.currency === 'INR' && p\.amountPaise === intent\.amount/)
  })

  it('EVERY source defers on an unexpected settlement error instead of refunding', () => {
    // RD-PAYMENT-REFUND-AUTHORITY-02 widened this. The sweep already deferred; 'verify' and
    // 'webhook' refunded, so a transient Firestore error destroyed a captured sale. There is
    // no longer a `source === 'sweep'` special case because all three behave the same way.
    expect(settle).not.toMatch(/if \(source === 'sweep'\)/)
    expect(settle).toMatch(/return \{ kind: 'deferred', reason: 'transaction_error' \}/)
    // Comments stripped: the module documents at length that `refundInFull` was removed and
    // why. That prose is the point, and an assertion that reads it as code fails on the
    // explanation for the very change it is checking.
    const code = settle.replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
    expect(code).not.toMatch(/refundInFull/)
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
    // Firestore + the payment provider only — no queue, no scheduler, no external service.
    // The gateway is now reached through the provider contract rather than the SDK directly,
    // which is a change of route, not of dependency.
    expect(fn).toMatch(/adminDb\.collection\('paymentIntents'\)/)
    expect(fn).toMatch(/resolvePaymentProvider\(intent\.provider\)\.fetchOrderPayments/)
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

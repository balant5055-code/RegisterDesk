// Server-only: shared Razorpay client.
// Validation is handled in lib/env.ts — this module only initialises the
// Razorpay SDK instance and re-exports the validated key constants.

import Razorpay from 'razorpay'
import {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
  required,
} from '@/lib/env'

export { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET }

// RD-ENV-ARCH-03 — Razorpay is a PAYMENT-subsystem dependency, so its env validation
// lives HERE (the payment ownership boundary, imported only by payment/webhook/
// licensing code) rather than in the shared lib/env.ts. A missing or test-mode key
// therefore fails ONLY payment endpoints at init — never OTP / dashboard / certificates.
// Same variables, same messages, same live-key rule. required() skips validation during
// `next build` (NEXT_PHASE) exactly as before.
required('RAZORPAY_KEY_ID',        'Obtain from Razorpay Dashboard → Settings → API Keys. Use rzp_test_* for development.')
required('RAZORPAY_KEY_SECRET',    'Obtain from Razorpay Dashboard → Settings → API Keys. Keep server-side only — never expose to the client.')
required('RAZORPAY_WEBHOOK_SECRET', 'Set a webhook secret in Razorpay Dashboard → Settings → Webhooks, then copy it here.')

// ─── Live-key enforcement in production ──────────────────────────────────────
// By default, production (NODE_ENV=production) REQUIRES a live key (rzp_live_*);
// test keys (rzp_test_*) are rejected at startup. Development (NODE_ENV!=production)
// always accepts BOTH test and live keys — this block simply never runs there.
//
// ⚠️  DEVELOPMENT-ONLY ESCAPE HATCH (RD-PAYMENT-01)
// This flag exists ONLY so RegisterDesk can run Razorpay TEST keys on the
// production domain WHILE STILL UNDER DEVELOPMENT, before public launch. Setting
//     ALLOW_RAZORPAY_TEST_IN_PRODUCTION=true
// permits rzp_test_* in production. It changes ONLY this key-prefix check — no
// payment creation, signature verification, webhook, checkout, wallet, refund, or
// licensing logic is affected in any way.
//
// 🚨  MUST be removed or set to false BEFORE public launch. Once real money flows,
// a test key in production would silently void real transactions. The flag is
// fail-safe: only an explicit truthy value opts in; missing / '' / 'false' / any
// other value keeps the strict live-key requirement — so existing deployments are
// unchanged.
//
// Parse is tolerant of surrounding whitespace and letter-case (RD-PAYMENT-01
// verification): a value entered in a hosting dashboard often arrives as "true\n",
// " true ", or "TRUE". A strict `=== 'true'` match silently dropped those and kept
// rejecting test keys even though the operator had enabled the flag — this is the
// root cause of the reported "still throws with ALLOW_RAZORPAY_TEST_IN_PRODUCTION=true".
const allowTestFlag = (process.env.ALLOW_RAZORPAY_TEST_IN_PRODUCTION ?? '').trim().toLowerCase()
const allowTestInProduction = allowTestFlag === 'true' || allowTestFlag === '1'
console.log('=== RAZORPAY ENV DEBUG ===')
console.log({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PHASE: process.env.NEXT_PHASE,
  ALLOW_RAZORPAY_TEST_IN_PRODUCTION:
    process.env.ALLOW_RAZORPAY_TEST_IN_PRODUCTION,
  allowTestInProduction,
})
if (
  process.env.NEXT_PHASE !== 'phase-production-build' &&
  process.env.NODE_ENV === 'production' &&
  !allowTestInProduction &&
  RAZORPAY_KEY_ID &&
  !RAZORPAY_KEY_ID.startsWith('rzp_live_')
) {
  throw new Error(
    '[env] RAZORPAY_KEY_ID must be a live key (rzp_live_*) in production. ' +
    'Test keys (rzp_test_*) are not allowed in production environments. ' +
    'During pre-launch development only, set ALLOW_RAZORPAY_TEST_IN_PRODUCTION=true ' +
    'to permit test keys — this MUST be removed before public launch.',
  )
}

// During build (isBuildPhase in env.ts) keys may be empty strings — the
// Razorpay instance is a typed placeholder that is never actually called.
// At runtime, env.ts guarantees both keys are non-empty.
export const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : (null as unknown as Razorpay)

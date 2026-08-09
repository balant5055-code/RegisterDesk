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
// Production (NODE_ENV=production) REQUIRES a live key (rzp_live_*); test keys
// (rzp_test_*) are rejected at startup. Development (NODE_ENV!=production) always
// accepts BOTH test and live keys — this block simply never runs there.
//
// RD-LAUNCH-07: the ALLOW_RAZORPAY_TEST_IN_PRODUCTION escape hatch has been REMOVED.
// It existed only so test keys could run on the production domain while the platform
// was pre-launch (RD-PAYMENT-01), and its own note required deletion before launch:
// once real money flows, a test key in production silently voids real transactions —
// attendees see confirmed registrations and receipts for payments that never settled.
//
// There is now no way to opt out. Setting the old variable has no effect; a non-live
// key in production fails loudly at startup, which is the correct failure mode — a
// deployment that refuses to boot is recoverable in minutes, whereas taking test
// payments for real customers is not.
if (
  process.env.NEXT_PHASE !== 'phase-production-build' &&
  process.env.NODE_ENV === 'production' &&
  RAZORPAY_KEY_ID &&
  !RAZORPAY_KEY_ID.startsWith('rzp_live_')
) {
  throw new Error(
    '[env] RAZORPAY_KEY_ID must be a live key (rzp_live_*) in production. ' +
    'Test keys (rzp_test_*) are not allowed in production environments.',
  )
}

// During build (isBuildPhase in env.ts) keys may be empty strings — the
// Razorpay instance is a typed placeholder that is never actually called.
// At runtime, env.ts guarantees both keys are non-empty.
export const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : (null as unknown as Razorpay)

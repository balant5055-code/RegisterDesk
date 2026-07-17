// Server-only: shared Razorpay client.
// Validation is handled in lib/env.ts — this module only initialises the
// Razorpay SDK instance and re-exports the validated key constants.

import Razorpay from 'razorpay'
import {
  RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET,
} from '@/lib/env'

export { RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET }

// During build (isBuildPhase in env.ts) keys may be empty strings — the
// Razorpay instance is a typed placeholder that is never actually called.
// At runtime, env.ts guarantees both keys are non-empty.
export const razorpay = (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET)
  ? new Razorpay({ key_id: RAZORPAY_KEY_ID, key_secret: RAZORPAY_KEY_SECRET })
  : (null as unknown as Razorpay)

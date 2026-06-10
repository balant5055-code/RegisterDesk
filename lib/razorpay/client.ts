// Server-only: shared Razorpay client.
// Throws at module-load time if required keys are absent — the application
// refuses to initialise rather than silently falling back to empty credentials.

import Razorpay from 'razorpay'

const key_id     = process.env.RAZORPAY_KEY_ID
const key_secret = process.env.RAZORPAY_KEY_SECRET

if (!key_id || !key_secret) {
  throw new Error(
    'RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment variables. ' +
    'Add them to .env.local (development) or your deployment secrets (production).',
  )
}

export const RAZORPAY_KEY_ID     = key_id
export const RAZORPAY_KEY_SECRET = key_secret

export const razorpay = new Razorpay({ key_id, key_secret })

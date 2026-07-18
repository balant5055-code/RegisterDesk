// lib/env.ts
// Single source of truth for all environment variables. Server-only.
// Never import this module from client components, pages, or browser bundles.
//
// Validation is skipped during `next build` (NEXT_PHASE === 'phase-production-build')
// so CI/CD pipelines that lack live secrets can still compile the application.
// At actual server runtime, all Category A variables are required — the server
// refuses to start and logs a clear error message for each missing value.
//
// instrumentation.ts imports this module so validation fires once at server
// startup, before any route handler or request is processed.

const isBuildPhase = process.env.NEXT_PHASE === 'phase-production-build'

// ─── Validation helpers ───────────────────────────────────────────────────────

function required(name: string, hint: string): string {
  if (isBuildPhase) return process.env[name] ?? ''
  const value = (process.env[name] ?? '').trim()
  if (!value) {
    throw new Error(
      `[env] Missing required environment variable: ${name}\n` +
      `  Hint: ${hint}\n` +
      `  Add it to .env.local for development or your deployment secrets for production.`,
    )
  }
  return value
}

function optional(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim()
}

// ─── Category A — Firebase Admin SDK ─────────────────────────────────────────
// Required: every API route uses Firestore or Firebase Auth via the Admin SDK.

export const FIREBASE_SERVICE_ACCOUNT_KEY = required(
  'FIREBASE_SERVICE_ACCOUNT_KEY',
  'Generate a service account key: Firebase Console → Project settings → Service accounts → ' +
  'Generate new private key. Base64-encode the JSON: ' +
  'node -e "console.log(Buffer.from(require(\'fs\').readFileSync(\'key.json\')).toString(\'base64\'))"',
)

// Firebase Storage bucket name (same value the client uses). Server-side
// certificate generation uploads the produced file via the Admin SDK and needs
// this to address the bucket. Optional so server startup is unaffected when it's
// absent; the certificate generator throws a clear error at upload time instead.
export const FIREBASE_STORAGE_BUCKET = optional('NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET')

// Optional Unicode (TTF/OTF) fonts for certificate rendering. When set, the
// certificate renderer embeds them so non-Latin participant names render
// correctly; otherwise it falls back to the built-in WinAnsi standard fonts.
// Alternatively, drop NotoSans-Regular.ttf / NotoSans-Bold.ttf into a
// `certificate-fonts/` directory at the project root.
export const CERT_FONT_REGULAR_URL = optional('CERT_FONT_REGULAR_URL')
export const CERT_FONT_BOLD_URL    = optional('CERT_FONT_BOLD_URL')

// Shared secret for scheduled (cron) endpoints. Vercel Cron sends it as
// `Authorization: Bearer <CRON_SECRET>`. When unset, cron endpoints reject all
// requests (fail-closed) so they can never be triggered anonymously.
export const CRON_SECRET = optional('CRON_SECRET')

// CRON_SECRET is MANDATORY in real production (P0-5), but that requirement is now
// enforced in lib/cron/auth.ts — which is imported ONLY by the /api/cron/* routes —
// rather than here (RD-CRON-ARCH-02). A missing CRON_SECRET therefore disables cron
// endpoints (fail-closed) WITHOUT crashing the rest of the app (login, OTP, payments,
// dashboard) that merely imports this shared env module. isAuthorizedCron() still
// rejects every cron request when the secret is unset.
//
// Vercel sets NODE_ENV=production for PREVIEW deployments too, so we key off
// VERCEL_ENV when present to enforce only in TRUE production — preview and
// development keep working without the mandatory secrets. Self-hosted (no VERCEL_ENV)
// falls back to NODE_ENV. (_isRealProduction is used by the Upstash check below.)
const _vercelEnv = (process.env.VERCEL_ENV ?? '').trim()
const _isRealProduction = _vercelEnv
  ? _vercelEnv === 'production'
  : process.env.NODE_ENV === 'production'

// ─── Upstash Redis — distributed rate limiting (P1-2) ────────────────────────
// REST endpoint + token for the serverless Redis used by lib/rateLimit/redis.ts.
// MANDATORY in real production: the per-instance in-memory limiter provides no
// protection across serverless instances, so security-sensitive endpoints
// (payment verification, OTP, API-key auth) require a distributed backend.
// Preview/development fall back to the in-memory limiter when these are unset.
export const UPSTASH_REDIS_REST_URL   = optional('UPSTASH_REDIS_REST_URL').replace(/\/$/, '')
export const UPSTASH_REDIS_REST_TOKEN = optional('UPSTASH_REDIS_REST_TOKEN')

if (!isBuildPhase && _isRealProduction && (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN)) {
  throw new Error(
    '[env] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required in ' +
    'production. Without them, rate limiting falls back to a per-instance in-memory ' +
    'counter that does NOT enforce limits across serverless instances — payment, ' +
    'OTP and API-key abuse protections would be ineffective.\n' +
    '  Hint: create a database at console.upstash.com (Redis) and copy the REST URL + token.',
  )
}

// ─── Category A — HMAC secrets ───────────────────────────────────────────────
// Required: ticket PDF tokens, receipt PDF tokens, and unsubscribe link tokens
// all depend on TICKET_SECRET.  The server cannot sign or verify any token
// without it.

export const TICKET_SECRET = required(
  'TICKET_SECRET',
  'Generate with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
)

// RECEIPT_TOKEN_SECRET is optional — falls back to TICKET_SECRET so projects
// that have only one secret set still work correctly.
export const RECEIPT_TOKEN_SECRET =
  optional('RECEIPT_TOKEN_SECRET') || TICKET_SECRET

// ATTENDEE_SESSION_SECRET signs the attendee_session cookie. Optional — falls
// back to TICKET_SECRET so single-secret deployments still work.
export const ATTENDEE_SESSION_SECRET =
  optional('ATTENDEE_SESSION_SECRET') || TICKET_SECRET

// PAYOUT_PII_SECRET keys the AES-256-GCM encryption of stored payout PII (PAN /
// account number / IFSC). Optional — falls back to TICKET_SECRET so single-secret
// deployments still work. Rotating this secret makes existing ciphertext
// undecryptable, so set a dedicated value before storing real payout data.
export const PAYOUT_PII_SECRET =
  optional('PAYOUT_PII_SECRET') || TICKET_SECRET

// ─── Category A — Razorpay ───────────────────────────────────────────────────
// Required: payment order creation, signature verification, and webhook processing
// all require these values.  Without them no payment flow can complete.

export const RAZORPAY_KEY_ID = required(
  'RAZORPAY_KEY_ID',
  'Obtain from Razorpay Dashboard → Settings → API Keys. Use rzp_test_* for development.',
)

export const RAZORPAY_KEY_SECRET = required(
  'RAZORPAY_KEY_SECRET',
  'Obtain from Razorpay Dashboard → Settings → API Keys. Keep server-side only — never expose to the client.',
)

export const RAZORPAY_WEBHOOK_SECRET = required(
  'RAZORPAY_WEBHOOK_SECRET',
  'Set a webhook secret in Razorpay Dashboard → Settings → Webhooks, then copy it here.',
)

// Enforce live keys in production.
if (
  !isBuildPhase &&
  process.env.NODE_ENV === 'production' &&
  RAZORPAY_KEY_ID &&
  !RAZORPAY_KEY_ID.startsWith('rzp_live_')
) {
  throw new Error(
    '[env] RAZORPAY_KEY_ID must be a live key (rzp_live_*) in production. ' +
    'Test keys (rzp_test_*) are not allowed in production environments.',
  )
}

// ─── Category A — Application URL ────────────────────────────────────────────
// Required: all email links (ticket PDFs, receipt PDFs, waitlist conversion,
// certificate download, unsubscribe) embed absolute URLs built from this value.
// Missing this makes every outgoing email contain broken links.

export const APP_URL = required(
  'NEXT_PUBLIC_APP_URL',
  'Set to the base URL of your deployed application, e.g. https://registerdesk.in (no trailing slash).',
).replace(/\/$/, '')

// ─── Category B — Email provider (Amazon SES) ────────────────────────────────
// SES is the sole email provider. When SES_FROM_EMAIL is blank, email is disabled
// and all sends are silently skipped (registrations still succeed). Region
// defaults to Mumbai (ap-south-1). Credentials are optional — omit them to use an
// attached IAM role via the SDK's default credential chain.

export const AWS_REGION            = optional('AWS_REGION', 'ap-south-1')
export const AWS_ACCESS_KEY_ID     = optional('AWS_ACCESS_KEY_ID')
export const AWS_SECRET_ACCESS_KEY = optional('AWS_SECRET_ACCESS_KEY')
export const SES_FROM_EMAIL        = optional('SES_FROM_EMAIL')
export const SES_FROM_NAME         = optional('SES_FROM_NAME', 'RegisterDesk')

// A sender configured with only one half of a static credential pair is almost
// certainly a misconfiguration — fail fast rather than silently falling back to
// the default credential chain and getting auth errors on the first send.
if (!isBuildPhase && SES_FROM_EMAIL &&
    Boolean(AWS_ACCESS_KEY_ID) !== Boolean(AWS_SECRET_ACCESS_KEY)) {
  throw new Error(
    '[env] AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set together. ' +
    'Provide both for static credentials, or neither to use an attached IAM role.',
  )
}

// Svix-style signing secret for the inbound email delivery webhook.
// Optional: when blank, the webhook route fails closed (rejects all calls).
export const RESEND_WEBHOOK_SECRET = optional('RESEND_WEBHOOK_SECRET')

// ─── Category B — WhatsApp (Meta Cloud API) ──────────────────────────────────
// Foundation only (Phase G3.1): the Notification Engine can DISCOVER Meta as a
// provider, but no notification is routed to WhatsApp yet. When none of these are
// set, WhatsApp is disabled. Setting ANY of them opts in and requires the full
// core set — we fail fast at startup with the specific missing variables rather
// than erroring on first use. META_API_VERSION is optional (sane default).

export const META_APP_ID               = optional('META_APP_ID')
export const META_APP_SECRET           = optional('META_APP_SECRET')
export const META_ACCESS_TOKEN         = optional('META_ACCESS_TOKEN')
export const META_PHONE_NUMBER_ID      = optional('META_PHONE_NUMBER_ID')
export const META_BUSINESS_ACCOUNT_ID  = optional('META_BUSINESS_ACCOUNT_ID')
export const META_WEBHOOK_VERIFY_TOKEN = optional('META_WEBHOOK_VERIFY_TOKEN')
export const META_API_VERSION          = optional('META_API_VERSION', 'v21.0')

const _metaRequired: Record<string, string> = {
  META_APP_ID,
  META_APP_SECRET,
  META_ACCESS_TOKEN,
  META_PHONE_NUMBER_ID,
  META_BUSINESS_ACCOUNT_ID,
  META_WEBHOOK_VERIFY_TOKEN,
}
const _metaOptedIn = Object.values(_metaRequired).some(Boolean)

if (!isBuildPhase && _metaOptedIn) {
  const missing = Object.entries(_metaRequired).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) {
    throw new Error(
      `[env] WhatsApp (Meta Cloud API) is partially configured. Missing: ${missing.join(', ')}.\n` +
      '  Once any META_* variable is set, all of META_APP_ID, META_APP_SECRET, ' +
      'META_ACCESS_TOKEN, META_PHONE_NUMBER_ID, META_BUSINESS_ACCOUNT_ID and ' +
      'META_WEBHOOK_VERIFY_TOKEN are required.\n' +
      '  Hint: Meta App Dashboard → WhatsApp → API Setup. Leave all unset to disable WhatsApp.',
    )
  }
}

// ─── Category C — Optional ────────────────────────────────────────────────────

// Comma-separated Firebase UIDs for admin bootstrap. Falls back to '' — without
// it admin access still works via Firebase custom claims ({ admin: true }).
export const ADMIN_UIDS = optional('ADMIN_UIDS')

// Base URL for Open Graph / SEO meta tags on public pages.
export const BASE_URL = optional('NEXT_PUBLIC_BASE_URL', 'https://registerdesk.in').replace(/\/$/, '')

// Sentry DSN for error monitoring. Optional — when unset, lib/monitoring/sentry.ts
// degrades to console.error only (never throws, never blocks business logic).
export const SENTRY_DSN = optional('SENTRY_DSN')

// GA-7E S1 — out-of-band critical-alert channel (independent of SES). A generic JSON
// webhook: a Slack Incoming Webhook URL works directly (reads the `text` field); any
// generic endpoint / a PagerDuty Events proxy receives the full JSON. Optional — when
// unset, critical alerts deliver via email only (unchanged). No provider SDK, no new
// subsystem — just one more notifier alongside the existing email path.
export const OPS_ALERT_WEBHOOK_URL = optional('OPS_ALERT_WEBHOOK_URL')
// Deployment environment tag for Sentry events (Vercel sets VERCEL_ENV).
export const SENTRY_ENVIRONMENT = optional('VERCEL_ENV') || optional('NODE_ENV') || 'development'

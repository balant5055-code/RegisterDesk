// The SES region rule — pure, no imports, so it is testable without loading the email module.
//
// RD-PREPROD · the application used to fall back to a default region silently when AWS_REGION
// was unset, so a production deployment missing it would send from whatever the default happened
// to be — and a region without the verified SES identity rejects every send, which the email
// layer swallows by design (email must never break registration). Production therefore states
// the region EXPLICITLY, and a missing or malformed value fails loudly at the email boundary.
//
// The region itself is the deployment's choice (production runs ap-south-1). The code does NOT
// pin a region: any well-formed AWS region is accepted, and the SES client uses exactly that value.

/** The region used ONLY outside a production deployment when AWS_REGION is unset (local/test). */
export const SES_REGION = 'us-east-1'

/** Shape of an AWS region id: ap-south-1, us-east-1, eu-central-2, us-gov-west-1, … */
const AWS_REGION_FORMAT = /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d{1,2}$/

/**
 * The reason a production deployment's SES region is unacceptable, or null when it is fine.
 *
 * Applies only to a PRODUCTION deployment (VERCEL_ENV=production) that has email enabled
 * (SES_FROM_EMAIL set). Local, preview and test environments keep the default.
 */
export function sesRegionProblem(env: Record<string, string | undefined>): string | null {
  if (env.VERCEL_ENV !== 'production') return null
  if (!(env.SES_FROM_EMAIL ?? '').trim()) return null
  const region = (env.AWS_REGION ?? '').trim()
  if (!region) return '[env] AWS_REGION must be set explicitly in production (the SES region of the verified sender).'
  if (!AWS_REGION_FORMAT.test(region)) return `[env] AWS_REGION "${region}" is not a valid AWS region id.`
  return null
}

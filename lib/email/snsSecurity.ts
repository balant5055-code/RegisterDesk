// RD-COMMS-P2-C — trust rules for the SES delivery webhook's SNS messages (app/api/webhooks/ses).
// Server-only, dependency-free, so the rules are unit-tested directly.

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com$/

/** An AWS SNS URL the webhook may contact: https, an sns.<region>.amazonaws.com host, no credentials/port. */
export function snsUrl(raw: string): URL | null {
  let u: URL
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:' || !SNS_HOST.test(u.hostname) || u.port || u.username || u.password) return null
  return u
}

/** The signing certificate URL: an SNS URL with exactly the `/SimpleNotificationService-<id>.pem` path. */
export function isValidSigningCertUrl(raw: string): boolean {
  const u = snsUrl(raw)
  return !!u && /^\/SimpleNotificationService-[A-Za-z0-9]+\.pem$/.test(u.pathname) && !u.search && !u.hash
}

/**
 * The SNS topics the webhook trusts — SES_SNS_TOPIC_ARNS (comma-separated TopicArns), read per call.
 * Malformed entries are ignored; an empty set means the webhook is NOT configured and fails closed.
 */
export function allowedSesTopics(raw: string | undefined = process.env.SES_SNS_TOPIC_ARNS): Set<string> {
  return new Set(String(raw ?? '').split(',').map(s => s.trim())
    .filter(s => /^arn:aws:sns:[a-z0-9-]+:\d{12}:[A-Za-z0-9_-]{1,256}$/.test(s)))
}

/** The two AWS SNS signature versions, exactly — anything else (missing, '3', 1) is refused. */
export function snsSignatureAlgorithm(version: unknown): 'RSA-SHA1' | 'RSA-SHA256' | null {
  return version === '1' ? 'RSA-SHA1' : version === '2' ? 'RSA-SHA256' : null
}

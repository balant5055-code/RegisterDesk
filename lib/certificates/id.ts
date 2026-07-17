// Certificate ID generation — server-only (uses Node.js crypto).

import crypto from 'crypto'

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/**
 * Generates a unique, unguessable certificate ID.
 *
 * Format: RDC-{YEAR}-{6 random uppercase alphanumeric chars}
 * Example: "RDC-2026-AB12CD"
 *
 * Collision probability: 1 / (36^6) ≈ 1 in 2.18 billion per year.
 * crypto.randomBytes ensures uniform distribution over CHARS.
 */
export function generateCertificateId(): string {
  const year  = new Date().getFullYear()
  const bytes = crypto.randomBytes(6)
  const chars = Array.from(bytes, b => CHARS[b % CHARS.length]).join('')
  return `RDC-${year}-${chars}`
}

/** Returns true if the string looks like a valid certificate ID. */
export function isValidCertificateId(id: string): boolean {
  return /^RDC-\d{4}-[A-Z0-9]{6}$/.test(id)
}

/**
 * Generates a private, unguessable verification token for a certificate.
 *
 * Distinct from the public certificateId: the token is a secret capability
 * (32 URL-safe chars / 192 bits of entropy) that can gate authenticated
 * downloads and tamper checks without exposing the ID. Stored on the new
 * `certificates` document (Phase 2 data model) and never shown publicly.
 */
export function generateVerificationToken(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/** Returns true if the string looks like a valid verification token. */
export function isValidVerificationToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{32}$/.test(token)
}

/**
 * Generates a unique template document ID.
 *
 * Format: TPL-{20 random uppercase alphanumeric chars}. Long enough that it can
 * never collide with an event/draft ID, so file-based templates and the legacy
 * eventId-keyed design doc can safely share the certificateTemplates collection.
 */
export function generateTemplateId(): string {
  const bytes = crypto.randomBytes(20)
  const chars = Array.from(bytes, b => CHARS[b % CHARS.length]).join('')
  return `TPL-${chars}`
}

/**
 * Generates a unique bulk-job ID. Format: JOB-{20 random uppercase alphanumerics}.
 */
export function generateJobId(): string {
  const bytes = crypto.randomBytes(20)
  const chars = Array.from(bytes, b => CHARS[b % CHARS.length]).join('')
  return `JOB-${chars}`
}

/**
 * Deterministic idempotency-claim ID for a certificate.
 *
 * The same (eventId, registrationId, certificateType) always maps to the same
 * claim document, so a transactional get-or-create on this id guarantees at most
 * one certificate per tuple even under concurrent requests.
 */
export function certificateClaimId(
  eventId: string,
  registrationId: string,
  certificateType: string,
): string {
  return crypto
    .createHash('sha256')
    .update(`${eventId}|${registrationId}|${certificateType}`)
    .digest('hex')
}

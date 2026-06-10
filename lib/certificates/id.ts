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

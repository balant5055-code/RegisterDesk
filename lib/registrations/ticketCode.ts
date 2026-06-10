import { randomBytes } from 'crypto'

// Character set excludes letters visually ambiguous with digits: B≈8, I≈1, O≈0, S≈5
const CHARSET = 'ACDEFGHJKLMNPQRTUVWXYZ2346789'

// Thrown inside a Firestore transaction when the generated ticket code is already
// claimed by another registration.  Callers must retry with a freshly generated code.
export class TicketCodeCollisionError extends Error {
  constructor() {
    super('Ticket code already claimed — caller must retry with a new code')
    this.name = 'TicketCodeCollisionError'
  }
}

/**
 * Generates a cryptographically random, human-readable ticket code.
 * Format:  RD-XXXXXXXX   (8 chars from CHARSET, 29^8 ≈ 500 billion possibilities)
 * Example: RD-K7QMAT3P
 *
 * Uniqueness is enforced by claiming a ticketCodeClaims/{code} document inside
 * the same Firestore transaction that creates the registration.  On collision
 * (probability ~0.000002% at 10,000 registrations), callers retry with a new code.
 */
export function generateTicketCode(): string {
  const bytes = randomBytes(8)
  const code  = Array.from(bytes)
    .map(b => CHARSET[b % CHARSET.length])
    .join('')
  return `RD-${code}`
}

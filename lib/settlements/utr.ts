// lib/settlements/utr.ts
// Pure (no firebase-admin), so the Super Admin Finance Console can validate a UTR with the SAME rule
// the server applies. Re-exported from lib/settlements/confirmedTransfer.ts for server callers.

/**
 * M1.3 — THE canonical form of a transfer reference, shared by every recording path: uppercase; whitespace,
 * hyphens and underscores (formatting separators) removed; letters and digits only (1–64). Two spellings with the
 * same canonical form are the SAME UTR — conservative: a separator never makes two references distinct.
 */
export function canonicalUtr(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toUpperCase().replace(/[\s_-]/g, '')
  return /^[A-Z0-9]{1,64}$/.test(v) ? v : null
}

/** RD-SETTLE-PAY-02 — the length a real bank transfer reference has (IMPS/UPI 12, NEFT 16, RTGS 22; 6–40 as the exception path). */
export const RECORDABLE_UTR_MIN = 6
export const RECORDABLE_UTR_MAX = 40

/**
 * RD-SETTLE-PAY-02 — a UTR that may RECORD a payout: the canonical form, and long enough to be a genuine bank
 * reference (a stray "1" or "TEST" is refused). Returns the canonical form (the one-UTR-one-payout key) or null.
 */
export function recordableUtr(raw: unknown): string | null {
  const v = canonicalUtr(raw)
  return v && v.length >= RECORDABLE_UTR_MIN && v.length <= RECORDABLE_UTR_MAX ? v : null
}

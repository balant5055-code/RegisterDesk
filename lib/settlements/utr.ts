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

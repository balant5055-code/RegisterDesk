// lib/admin/financialReason.ts
// RD-PHASE4-S4 · D3 — the reason rule for financial mutations, PURE (no next/server, no firebase-admin) so a
// client form can apply the exact rule the server enforces. Re-exported from lib/admin/financialGuard.ts.

export const REASON_MIN = 3
export const REASON_MAX = 500

export type ReasonErrorCode = 'REASON_REQUIRED' | 'REASON_TOO_SHORT' | 'REASON_TOO_LONG'

export type ReasonResult =
  | { ok: true;  reason: string }
  | { ok: false; code: ReasonErrorCode; error: string }

/** Pure. Accepts the first string candidate that is non-blank (e.g. `body.reason ?? body.adminNote`). */
export function parseFinancialReason(...candidates: unknown[]): ReasonResult {
  const raw = candidates.find(c => typeof c === 'string' && c.trim() !== '')
  const reason = typeof raw === 'string' ? raw.trim() : ''
  if (!reason)                   return { ok: false, code: 'REASON_REQUIRED',  error: 'A reason is required for this action.' }
  if (reason.length < REASON_MIN) return { ok: false, code: 'REASON_TOO_SHORT', error: `The reason must be at least ${REASON_MIN} characters.` }
  if (reason.length > REASON_MAX) return { ok: false, code: 'REASON_TOO_LONG',  error: `The reason must be at most ${REASON_MAX} characters.` }
  return { ok: true, reason }
}

// lib/admin/financialGuard.ts
// RD-PHASE4-S4 — the ONE authorization + reason policy for financial mutations (D1, D3).
//
//   requireSuperAdmin(req)  — D1: ADMIN_UIDS only (resolveSuperAdminUid). A caller holding only
//                             the legacy `admin: true` claim is a plain admin and is REFUSED with
//                             a stable 403 SUPER_ADMIN_REQUIRED; a non-admin gets 403 Forbidden.
//   parseFinancialReason(v) — D3: a trimmed reason of 3–500 characters, with stable error codes.
//
// Server-only (pulls in firebase-admin through lib/admin/auth).

import { NextResponse } from 'next/server'
import { legacyAdminClaimOnly, resolveSuperAdminUid } from '@/lib/admin/auth'
import type { ReasonResult } from '@/lib/admin/financialReason'

// D3's rule lives in a pure module so the Finance Console can apply it client-side unchanged.
export { REASON_MIN, REASON_MAX, parseFinancialReason } from '@/lib/admin/financialReason'
export type { ReasonErrorCode, ReasonResult } from '@/lib/admin/financialReason'

export function reasonErrorResponse(r: Extract<ReasonResult, { ok: false }>): NextResponse {
  return NextResponse.json({ error: r.error, code: r.code }, { status: 400 })
}

/** How many Super Admins the deployment configures (ADMIN_UIDS) — for actionable maker-checker errors. */
export function configuredSuperAdminCount(): number {
  return new Set((process.env.ADMIN_UIDS ?? '').split(',').map(u => u.trim()).filter(Boolean)).size
}

export const SUPER_ADMIN_REQUIRED_MESSAGE = 'Only a Super Admin can perform this financial action.'

/** D1 — returns the Super Admin uid, or the refusal response to return as-is. */
export async function requireSuperAdmin(
  req: Request,
): Promise<{ uid: string; response?: undefined } | { uid?: undefined; response: NextResponse }> {
  const header = req.headers.get('authorization')
  const superUid = await resolveSuperAdminUid(header)
  if (superUid) return { uid: superUid }
  // RD-SEC-01 · the legacy claim grants nothing; it only selects the clearer refusal message.
  const legacyClaim = await legacyAdminClaimOnly(header)
  return {
    response: legacyClaim
      ? NextResponse.json({ error: SUPER_ADMIN_REQUIRED_MESSAGE, code: 'SUPER_ADMIN_REQUIRED' }, { status: 403 })
      : NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
  }
}

// ═══ RD-CLOSE · mixed admin views (moderation + money) ═══════════════════════════════════════════
// Some admin reads serve BOTH moderation (any admin) and money (Super Admin only): the Event /
// Organizer 360 overviews and detail routes, platform stats, lookup. Refusing them outright would
// lock a claim-only admin out of moderation; returning them whole would hand that admin financial
// data. So the SAME response is returned with every money-valued field withheld (null) unless the
// caller is a Super Admin (ADMIN_UIDS). The money keys are recognised by name — amounts in this
// codebase are consistently named *Paise / amount* / revenue* / balance* / gross* / net* / fee* /
// cost* / price* / refund* / payout* / settle*.

/** True only for a Super Admin (ADMIN_UIDS) — never for the legacy admin claim alone. */
export async function isSuperAdminRequest(req: Request): Promise<boolean> {
  return !!(await resolveSuperAdminUid(req.headers.get('authorization')))
}

const MONEY_KEY = /(paise|rupees|amount|revenue|balance|gross|^net|netpaise|fee|cost|price|refund|payout|settle|gmv|earning|discount|wallet|charge)/i

/** Pure. A deep copy with every money-valued leaf replaced by null (non-money fields untouched). */
export function redactFinancialFields<T>(value: T): T {
  const walk = (v: unknown, key: string | null): unknown => {
    if (key && MONEY_KEY.test(key) && (typeof v === 'number' || typeof v === 'string' || (v && typeof v === 'object'))) {
      return typeof v === 'object' ? (Array.isArray(v) ? [] : null) : null
    }
    if (Array.isArray(v)) return v.map(x => walk(x, null))
    if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]))
    }
    return v
  }
  return walk(value, null) as T
}

/** Mixed admin read: the payload as-is for a Super Admin, money withheld (and flagged) otherwise. */
export async function financialViewFor<T>(req: Request, payload: T): Promise<T & { financialRedacted?: true }> {
  if (await isSuperAdminRequest(req)) return payload as T & { financialRedacted?: true }
  return { ...(redactFinancialFields(payload) as object), financialRedacted: true } as T & { financialRedacted: true }
}

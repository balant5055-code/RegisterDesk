// Organizer visibility (admin) — PURE display rules shared by the organizer list / detail popup and
// the Organizer 360 console. Client-safe: no server imports.
//
// Every rule keeps three outcomes apart that a bare `?? '—'` would merge:
//   • NOT RECORDED  — the profile holds nothing about it (legacy / never captured);
//   • UNVERIFIED / MISSING — recorded, and not done;
//   • WITHHELD      — the server redacted it (money fields for a non-Super-Admin caller).
// A missing field is never shown as success, and a redacted field is never shown as zero.

import type { AccountStatus, EmailVerificationState } from '@/lib/admin/organizerTypes'

/** A date for display, or '—' when absent or not a valid date (never "Invalid Date"). */
export function fmtSafeDate(iso: unknown, withTime = false): string {
  if (typeof iso !== 'string' || !iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return withTime
    ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export const PENDING_VERIFICATION_LABEL = 'Pending verification'

/** The status column text: the effective status, marked when the document records none. */
export function statusText(status: AccountStatus, statusRecorded: boolean | undefined): string {
  return statusRecorded === false ? `${status} (no status recorded)` : status
}

export function emailVerificationLabel(state: EmailVerificationState | null | undefined): string {
  if (state === 'verified')   return 'Verified'
  if (state === 'unverified') return 'Unverified'
  return 'Not recorded'
}

export function mobileLabel(phone: string | null | undefined, verification: 'verified' | 'unverified' | 'missing' | null | undefined): string {
  if (!phone || verification === 'missing') return 'Not provided'
  if (verification === 'verified') return `${phone} · verified`
  // phone OTP is not offered on the platform: "unverified" here means "not verified", not "failed"
  return `${phone} · not verified`
}

export function trustLabel(trust: { level: string | null; score: number | null } | null | undefined): string {
  if (!trust || (!trust.level && trust.score === null)) return 'Not recorded'
  const level = trust.level ? trust.level.replace(/_/g, ' ') : 'unknown level'
  return trust.score === null ? level : `${level} · score ${trust.score}`
}

/** Rupees from paise; a non-number (absent or redacted) is '—', never ₹0. */
export function rupees(paise: unknown): string {
  return typeof paise === 'number' && Number.isFinite(paise)
    ? `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
    : '—'
}

export const WITHHELD = 'Withheld'

/** One wallet amount in the detail popup: withheld (redacted), no wallet, or the amount. */
type WalletAmountField = 'availablePaise' | 'pendingPaise' | 'settledPaise' | 'inTransitPaise'

export function walletAmountLabel(
  wallet: ({ exists?: unknown } & Partial<Record<WalletAmountField, unknown>>) | null | undefined,
  field: WalletAmountField,
  redacted: boolean,
): string {
  if (redacted || wallet === null) return WITHHELD
  if (!wallet || wallet.exists !== true) return '—'
  return rupees(wallet[field])
}

/** Payout setup: withheld (redacted), none, verified or unverified. */
export function payoutLabel(
  payout: { exists?: unknown; isVerified?: unknown } | 'verified' | 'unverified' | 'missing' | null | undefined,
  redacted: boolean,
): string {
  if (redacted || payout === null) return WITHHELD
  if (payout === 'verified') return 'Verified'
  if (payout === 'unverified') return 'Not verified'
  if (payout === 'missing' || !payout || payout.exists !== true) return 'Not set up'
  return payout.isVerified === true ? 'Verified' : 'Not verified'
}

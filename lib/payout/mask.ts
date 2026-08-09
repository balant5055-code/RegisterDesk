// RD-FINANCE-CLOSURE-02 · Masking payout identifiers for the audit history.
//
// PURE. No SDK, no I/O, no crypto — so every rule below is unit-tested directly.
//
// ═══ WHY MASKED VALUES AND NOT ENCRYPTED ONES ════════════════════════════════
// The payout profile itself stores PAN / account number / IFSC encrypted at rest
// (lib/payout/encryption.ts), and that stays exactly as it is. The history must NOT be a
// second copy of those credentials in any form — not plaintext, and not ciphertext either,
// because a second encrypted copy is a second thing to leak and a second thing to rotate.
//
// What an audit trail actually needs is enough to answer "did the destination change, and
// to what?" — not enough to send money anywhere. A last-4 and a bank name answer the
// question; they cannot be used to receive a payout.
//
// Every function here is total: it never throws, and it never returns more characters than
// the rule allows, including for short or malformed input.

import type { PayoutMethod } from '@/lib/payout/types'

const DOT = '•'   // •

/** Bullets of a fixed visual length — never the true length, which would leak it. */
const BULLETS = DOT.repeat(4)

/**
 * Last four characters, everything else replaced.
 *
 * A value of four characters or fewer is masked ENTIRELY: revealing "the last 4" of a
 * 4-character secret reveals the secret.
 */
function keepLast4(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (v === '') return null
  if (v.length <= 4) return BULLETS
  return BULLETS + v.slice(-4)
}

/** Account number → `••••9012`. */
export function maskAccountNumber(value: string | null | undefined): string | null {
  return keepLast4(value)
}

/** PAN → `••••234F`. A tax identifier, so it is masked like an account number. */
export function maskPan(value: string | null | undefined): string | null {
  return keepLast4(value)
}

/**
 * IFSC → the BANK code only, e.g. `HDFC0001234` → `HDFC${DOT}${DOT}${DOT}${DOT}`.
 *
 * An IFSC is public branch data, but combined with an account tail it narrows a real
 * account, so only the first four characters — which identify the bank, and are the part an
 * auditor actually reads — are kept. The branch digits are dropped.
 */
export function maskIfsc(value: string | null | undefined): string | null {
  const v = (value ?? '').trim().toUpperCase()
  if (v === '') return null
  if (v.length <= 4) return BULLETS
  return v.slice(0, 4) + BULLETS
}

/**
 * UPI → `ba${DOT}${DOT}${DOT}${DOT}@okhdfc`.
 *
 * The handle after `@` is the provider and is not a secret; the local part identifies the
 * person and is masked to its first two characters. A local part of two characters or
 * fewer is masked entirely.
 */
export function maskUpi(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (v === '') return null
  const at = v.lastIndexOf('@')
  if (at <= 0) return BULLETS                     // no handle — reveal nothing
  const local  = v.slice(0, at)
  const handle = v.slice(at)                      // includes '@'
  if (local.length <= 2) return BULLETS + handle
  return local.slice(0, 2) + BULLETS + handle
}

/**
 * The masked payout destination — what the history stores instead of the real one.
 *
 * `label` is the single human-readable line a change log shows. The structured fields are
 * kept alongside it so a future reader can compare destinations programmatically without
 * parsing prose.
 */
export interface MaskedDestination {
  method:       PayoutMethod
  label:        string
  bankName:     string | null
  accountMasked: string | null
  ifscBank:     string | null
  upiMasked:    string | null
}

/**
 * Builds the masked destination from PLAINTEXT values.
 *
 * The caller is responsible for decrypting first — see `decryptPii`. Passing ciphertext in
 * would produce a masked tail of the base64, which is meaningless rather than dangerous,
 * but it would also make the history useless, so the call sites decrypt explicitly.
 */
export function maskDestination(input: {
  payoutMethod:  PayoutMethod
  bankName:      string | null | undefined
  accountNumber: string | null | undefined
  ifscCode:      string | null | undefined
  upiId:         string | null | undefined
}): MaskedDestination {
  if (input.payoutMethod === 'upi') {
    const upiMasked = maskUpi(input.upiId)
    return {
      method: 'upi',
      label:  upiMasked ?? 'UPI (not set)',
      bankName: null,
      accountMasked: null,
      ifscBank: null,
      upiMasked,
    }
  }

  const accountMasked = maskAccountNumber(input.accountNumber)
  const ifscBank      = maskIfsc(input.ifscCode)
  const bankName      = (input.bankName ?? '').trim() || null

  // "HDFC Bank ••••9012" — the two things an auditor checks, and nothing more.
  const label = [bankName, accountMasked].filter(Boolean).join(' ') || 'Bank account (not set)'

  return { method: 'bank', label, bankName, accountMasked, ifscBank, upiMasked: null }
}

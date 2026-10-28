// lib/settlements/markPaidForm.ts
// RD-SETTLE-PAY-01 — the Super Admin "Mark as Paid" / "Record completed transfer" form, PURE (client-safe).
//
// The form has exactly TWO required inputs, checked with the SAME rules the server applies
// (app/api/admin/settlements/[id]/route.ts): the UTR (canonicalUtr) and the reason (parseFinancialReason,
// 3–500 characters). Bank Reference, Paid By and Payment Notes are optional and deliberately NOT inputs
// here, so they can never take part in the Confirm button's state or a field error.
//
// Maker-checker (D2) is decided by the server inside the paid transaction and has no bypass; the console
// only warns up front, from the approver uid the list API returns, so nobody fills in a form that the
// server is certain to refuse.

import { canonicalUtr } from './utr'
import { parseFinancialReason, REASON_MIN, REASON_MAX } from '@/lib/admin/financialReason'

export interface MarkPaidRequiredInput {
  utrNumber: string
  reason:    string
}

export interface MarkPaidFormCheck {
  ok:          boolean
  /** null when the UTR is acceptable */
  utrError:    string | null
  /** null when the reason is acceptable */
  reasonError: string | null
}

export const UTR_REQUIRED_MESSAGE = 'Enter the UTR number.'
export const UTR_FORMAT_MESSAGE   = 'The UTR must contain letters and digits only (spaces, hyphens and underscores are ignored), up to 64 characters.'

export function checkMarkPaidForm({ utrNumber, reason }: MarkPaidRequiredInput): MarkPaidFormCheck {
  const utrError = !utrNumber.trim() ? UTR_REQUIRED_MESSAGE
    : canonicalUtr(utrNumber) ? null
    : UTR_FORMAT_MESSAGE
  const r = parseFinancialReason(reason)
  const reasonError = r.ok ? null
    : r.code === 'REASON_REQUIRED'  ? `Enter a reason (${REASON_MIN}–${REASON_MAX} characters).`
    : r.code === 'REASON_TOO_SHORT' ? `The reason must be at least ${REASON_MIN} characters (${reason.trim().length}/${REASON_MIN}).`
    : `The reason must be at most ${REASON_MAX} characters (${reason.trim().length}/${REASON_MAX}).`
  return { ok: !utrError && !reasonError, utrError, reasonError }
}

/** D2 — true when the signed-in Super Admin is the one who approved (the server will refuse them). */
export function approvedByViewer(approvedBy: string | null | undefined, viewerUid: string | null | undefined): boolean {
  return !!approvedBy && !!viewerUid && approvedBy === viewerUid
}

export const MAKER_CHECKER_NOTICE =
  'You approved this settlement, so a different Super Admin must record the payout. This control cannot be bypassed.'

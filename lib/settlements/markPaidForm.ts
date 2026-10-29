// lib/settlements/markPaidForm.ts
// RD-SETTLE-PAY-01 — the Super Admin "Mark as Paid" / "Record completed transfer" form, PURE (client-safe).
//
// The form has exactly THREE required inputs, checked with the SAME rules the server applies
// (app/api/admin/settlements/[id]/route.ts): the UTR (recordableUtr — a genuine bank reference, 6–40 letters
// and digits), the reason (parseFinancialReason, 3–500 characters) and the explicit confirmation that the bank
// transfer has completed (confirmTransferCompleted). Bank Reference, Paid By and Payment Notes are optional and
// deliberately NOT inputs here, so they can never take part in the Confirm button's state or a field error.
//
// RD-SETTLE-PAY-02 — RegisterDesk runs with ONE Super Admin: the admin who approved a settlement may record its
// payment (the audit row records that it was the same admin).

import { recordableUtr, RECORDABLE_UTR_MIN, RECORDABLE_UTR_MAX } from './utr'
import { parseFinancialReason, REASON_MIN, REASON_MAX } from '@/lib/admin/financialReason'

export interface MarkPaidRequiredInput {
  utrNumber: string
  reason:    string
  /** the admin ticked "I confirm this bank transfer has been completed" */
  confirmed: boolean
}

export interface MarkPaidFormCheck {
  ok:          boolean
  /** null when the UTR is acceptable */
  utrError:    string | null
  /** null when the reason is acceptable */
  reasonError: string | null
  /** null once the transfer is confirmed */
  confirmError: string | null
}

export const UTR_REQUIRED_MESSAGE = 'Enter the UTR number.'
export const UTR_FORMAT_MESSAGE   = `Enter the bank's transfer reference: ${RECORDABLE_UTR_MIN}–${RECORDABLE_UTR_MAX} letters and digits (spaces, hyphens and underscores are ignored).`
export const CONFIRM_REQUIRED_MESSAGE = 'Confirm that this bank transfer has been completed.'

export function checkMarkPaidForm({ utrNumber, reason, confirmed }: MarkPaidRequiredInput): MarkPaidFormCheck {
  const utrError = !utrNumber.trim() ? UTR_REQUIRED_MESSAGE
    : recordableUtr(utrNumber) ? null
    : UTR_FORMAT_MESSAGE
  const r = parseFinancialReason(reason)
  const reasonError = r.ok ? null
    : r.code === 'REASON_REQUIRED'  ? `Enter a reason (${REASON_MIN}–${REASON_MAX} characters).`
    : r.code === 'REASON_TOO_SHORT' ? `The reason must be at least ${REASON_MIN} characters (${reason.trim().length}/${REASON_MIN}).`
    : `The reason must be at most ${REASON_MAX} characters (${reason.trim().length}/${REASON_MAX}).`
  const confirmError = confirmed ? null : CONFIRM_REQUIRED_MESSAGE
  return { ok: !utrError && !reasonError && !confirmError, utrError, reasonError, confirmError }
}

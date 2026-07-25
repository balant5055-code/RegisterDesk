// RD-PAYMENT-05 B1 — server reader for the canonical persisted fee breakdown of a paid
// registration. Reads the write-time financials off the platform-ledger entry
// (ptx_<registrationId>); NEVER recomputes. Used by the attendee post-payment surfaces
// (success page, receipt) to itemize the charge from the exact stored values.

import { getPlatformTransaction } from '@/lib/firebase/firestore/platformTransactions'
import type { FeeBreakdownRecord } from './types'

/**
 * Returns the stored FeeBreakdownRecord for a registration when the attendee bore fees
 * (attendee_pays), else null (organizer_absorbs / free / legacy → nothing to itemize).
 * Fail-safe: any read error resolves to null so a display surface never breaks.
 */
export async function getStoredAttendeeFinancials(
  registrationId: string,
): Promise<FeeBreakdownRecord | null> {
  const txn = await getPlatformTransaction(`ptx_${registrationId}`).catch(() => null)
  const f = txn?.financials
  if (!f || f.attendeeFeeTotalPaise <= 0) return null
  return f
}

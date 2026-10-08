// RD-COMMS-P2-E — the per-recipient delivery ledger for reminders. Server-only.
//
// One document per (logical reminder, recipient email), created with `create()` BEFORE the email
// is handed to the provider. A second attempt to create it fails, so the same attendee can never
// receive the same reminder twice — whatever the cause: a duplicate job, a resumed or concurrent
// worker, a re-run scheduler, a page re-read after an interruption, or a legacy job beside its
// re-keyed successor (both resolve to the same logical key).
//
// The ledger is written FIRST, so a crash between the write and the send leaves a 'pending' record
// and that recipient is never retried: an unknown outcome is not resent (RD-COMMS-P2-D).
// No email address is stored — the id is a hash.

import { createHash } from 'node:crypto'
import { FieldValue } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'

export const REMINDER_DELIVERIES = 'reminderDeliveries'

export type DeliveryStatus = 'pending' | 'sent' | 'failed' | 'unknown'

export function reminderDeliveryId(logicalKey: string, email: string): string {
  return createHash('sha256').update(`${logicalKey}\n${email.trim().toLowerCase()}`).digest('hex')
}

/** Reserve this recipient for this logical reminder. 'exists' = already attempted (never resend). */
export async function claimReminderDelivery(
  id: string, meta: { reminderId: string; logicalKey: string; eventId: string | null; organizerUid: string },
): Promise<'claimed' | 'exists'> {
  try {
    await adminDb.collection(REMINDER_DELIVERIES).doc(id).create({
      ...meta, status: 'pending' satisfies DeliveryStatus,
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    })
    return 'claimed'
  } catch (err) {
    const code = (err as { code?: unknown }).code
    if (code === 6 || code === 'already-exists' || /already exists/i.test(String((err as Error)?.message))) return 'exists'
    throw err
  }
}

/** Record the outcome. Best-effort: the claim alone already prevents a resend. */
export async function settleReminderDelivery(id: string, status: Exclude<DeliveryStatus, 'pending'>): Promise<void> {
  await adminDb.collection(REMINDER_DELIVERIES).doc(id)
    .update({ status, updatedAt: FieldValue.serverTimestamp() })
    .catch(() => {})
}

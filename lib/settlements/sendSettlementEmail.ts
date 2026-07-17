// Settlement notification email senders — fire-and-forget callers.
// Never throw. All failures are logged and swallowed so the settlement
// workflow is never interrupted by an email failure.

import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import type {
  SettlementApprovedEmailParams,
  SettlementRejectedEmailParams,
  SettlementPaidEmailParams,
} from '@/lib/email/provider'

export async function sendSettlementApprovedEmail(
  params: SettlementApprovedEmailParams,
): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return
  try {
    const result = await notificationEngine.send(NotificationType.SETTLEMENT_APPROVED, params)
    if (!result.success) {
      console.error('[settlement-email] Approved email failed:', result.error)
    }
  } catch (err) {
    console.error('[settlement-email] Unexpected error sending approved email:', err)
  }
}

export async function sendSettlementRejectedEmail(
  params: SettlementRejectedEmailParams,
): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return
  try {
    const result = await notificationEngine.send(NotificationType.SETTLEMENT_REJECTED, params)
    if (!result.success) {
      console.error('[settlement-email] Rejected email failed:', result.error)
    }
  } catch (err) {
    console.error('[settlement-email] Unexpected error sending rejected email:', err)
  }
}

export async function sendSettlementPaidEmail(
  params: SettlementPaidEmailParams,
): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return
  try {
    const result = await notificationEngine.send(NotificationType.SETTLEMENT_PAID, params)
    if (!result.success) {
      console.error('[settlement-email] Paid email failed:', result.error)
    }
  } catch (err) {
    console.error('[settlement-email] Unexpected error sending paid email:', err)
  }
}

// MC-11 · Telling people a refund moved — SERVER ONLY.
//
// ═══ FIRE AND FORGET, ALWAYS ══════════════════════════════════════════════════
// Every function here swallows its own failures. A refund that was approved and paid must
// never be rolled back because an SMTP call timed out, and an admin pressing Approve must
// never see an error that makes them press it again. The money is the record; the email is
// a courtesy.
//
// ═══ REUSES THE PLATFORM ENGINE ═══════════════════════════════════════════════
// `notificationEngine.send(CUSTOM_EMAIL, …)` — the same path every other transactional email
// in the product takes, which means SES, the email shell, the provider resolver and the
// `emailLogs` audit all apply without this module knowing about any of them.
//
// Recipients come from `resolveOrganizerRecipients`, the canonical resolver (RD-AUTH-02):
// the organizer's PRIVATE account email, never the public support address.

import { notificationEngine } from '@/lib/notifications/engine'
import { NotificationType } from '@/lib/notifications/catalog'
import { resolveOrganizerRecipients } from '@/lib/organizer/recipients'

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const num = (n: number) => n.toLocaleString('en-IN')

/** Minimal, readable, and consistent with the platform's transactional shell. */
function body(heading: string, lines: readonly string[]): string {
  const items = lines.map(l => `<p style="margin:0 0 10px">${l}</p>`).join('')
  return `<h2 style="margin:0 0 14px;font-size:18px">${heading}</h2>${items}`
}

async function email(to: string, subject: string, html: string): Promise<void> {
  if (!to) return
  try {
    await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to, subject, html })
  } catch (err) {
    // Logged, never rethrown — see the header. The caller has already moved money.
    console.error('[media-credits/refund-notify] send failed:', err)
  }
}

export interface RefundNotice {
  organizerUid:      string
  credits:           number
  refundAmountPaise: number
  purchaseId:        string
}

/** The request landed in the queue. Nothing has moved yet, and the copy says so. */
export async function notifyRefundRequested(n: RefundNotice): Promise<void> {
  const { email: to } = await resolveOrganizerRecipients(n.organizerUid)
  await email(to, 'Your Media Credits refund request', body(
    'Refund request received',
    [
      `We have received your request to refund <strong>${num(n.credits)} Media Credits</strong>.`,
      `If it is approved you will receive <strong>${rupees(n.refundAmountPaise)}</strong> back to your original payment method.`,
      'Your credits remain available until the request is approved. Using them will make the refund ineligible.',
      'We will email you once it has been reviewed.',
    ],
  ))
}

/** Approved: the credits are gone from the wallet, the money is on its way. */
export async function notifyRefundApproved(n: RefundNotice): Promise<void> {
  const { email: to } = await resolveOrganizerRecipients(n.organizerUid)
  await email(to, 'Your Media Credits refund was approved', body(
    'Refund approved',
    [
      `Your refund of <strong>${rupees(n.refundAmountPaise)}</strong> has been approved.`,
      `<strong>${num(n.credits)} credits</strong> have been removed from your balance.`,
      'The money is being returned to your original payment method and usually appears within 5–7 working days.',
    ],
  ))
}

/** Rejected: nothing moved. The credits are still theirs, and the copy leads with that. */
export async function notifyRefundRejected(
  n: RefundNotice & { note?: string | null },
): Promise<void> {
  const { email: to } = await resolveOrganizerRecipients(n.organizerUid)
  await email(to, 'Your Media Credits refund request', body(
    'Refund request declined',
    [
      'We were not able to approve this refund request.',
      `Your <strong>${num(n.credits)} credits</strong> remain in your balance and are still available to use.`,
      ...(n.note ? [`<strong>Reason:</strong> ${n.note}`] : []),
      'Reply to this email if you would like us to take another look.',
    ],
  ))
}

/** Settled: the gateway confirmed the payout. */
export async function notifyRefundPaid(
  n: RefundNotice & { gatewayRefundId?: string | null },
): Promise<void> {
  const { email: to } = await resolveOrganizerRecipients(n.organizerUid)
  await email(to, 'Your Media Credits refund has been paid', body(
    'Refund paid',
    [
      `<strong>${rupees(n.refundAmountPaise)}</strong> has been returned to your original payment method.`,
      ...(n.gatewayRefundId
        ? [`Reference: <code>${n.gatewayRefundId}</code> — this appears on your card statement.`]
        : []),
      'It usually takes 5–7 working days to show on your statement.',
    ],
  ))
}

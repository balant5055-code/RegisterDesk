// Organizer notifications for the event review workflow.
//
// Recipient resolution (organizer uid → email) lives here; the subject/body
// template now lives in the Notification Engine (NotificationType.EVENT_*), so
// this module no longer knows any email content. Never throws: failures are
// logged and must never interrupt the review action.

import { adminDb }             from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { sendOrganizerWhatsApp } from '@/lib/notifications/organizerWhatsApp'
import { writeEmailLog }         from '@/lib/email-logs/write'
import { notifyEventReviewed }   from '@/lib/notifications/inbox/notify'

export type ReviewNotificationKind =
  | 'submitted'          // event submitted → under review
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'resubmitted'        // organizer resubmitted → under review again

interface ReviewNotificationArgs {
  organizerUid: string
  eventName:    string
  kind:         ReviewNotificationKind
  reason?:      string   // rejection reason
  comment?:     string   // changes-requested comment
  eventId?:     string | null   // draftId — used to deep-link the inbox notification (H.4.3)
}

const KIND_TO_TYPE: Record<ReviewNotificationKind, NotificationType> = {
  submitted:         NotificationType.EVENT_SUBMITTED,
  approved:          NotificationType.EVENT_APPROVED,
  rejected:          NotificationType.EVENT_REJECTED,
  changes_requested: NotificationType.EVENT_CHANGES_REQUESTED,
  resubmitted:       NotificationType.EVENT_RESUBMITTED,
}

// Sends the organizer review notification on BOTH channels (Phase G3.5): email
// (SES, via the engine) and WhatsApp (Meta, via the registry). Both are FREE and
// best-effort — a failure on either channel never interrupts the review action.
// Named *Email for backward compatibility with existing call sites.
//
// LS1 fix: both channels are AWAITED (concurrently) so the whole notification
// completes as a single promise. Callers schedule this via `after(...)` so the
// serverless function stays alive until delivery finishes — previously the
// WhatsApp send was a dangling `void` promise that got cut off when the route
// returned, so the organizer WhatsApp never went out.
export async function sendEventReviewEmail(args: ReviewNotificationArgs): Promise<void> {
  const _traceType = KIND_TO_TYPE[args.kind]
  console.info(`[wa-trace][${_traceType}] STEP 2b sendEventReviewEmail running · kind=${args.kind} → dispatching email + WhatsApp concurrently`)

  // H.4.3: record the review event in the organizer's Notification Center inbox.
  // Single choke point for all five review transitions; best-effort (never throws).
  void notifyEventReviewed({
    workspaceUid: args.organizerUid,
    eventName:    args.eventName,
    eventId:      args.eventId ?? null,
    kind:         args.kind,
    reason:       args.reason,
    comment:      args.comment,
  })

  const emailTask = (async () => {
    try {
      if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return
      const snap  = await adminDb.doc(`users/${args.organizerUid}`).get()
      const email = (snap.data() as { email?: unknown } | undefined)?.email
      if (typeof email !== 'string' || !email) return
      const type   = KIND_TO_TYPE[args.kind]
      const result = await notificationEngine.send(type, {
        to:        email,
        eventName: args.eventName,
        reason:    args.reason,
        comment:   args.comment,
      })
      // PART 9: record the organizer email in the unified communication log
      // (channel='email') so it appears in the Communication Center alongside WhatsApp.
      void writeEmailLog({
        organizerUid:      args.organizerUid,
        eventId:           '',
        eventSlug:         '',
        eventName:         args.eventName,
        templateKey:       type,
        recipientEmail:    email,
        recipientName:     '',
        subject:           `Event review: ${args.kind}`,
        status:            result.success ? 'sent' : 'failed',
        provider:          'ses',
        channel:           'email',
        providerMessageId: result.messageId,
        error:             result.success ? undefined : result.error,
      })
    } catch (err) {
      console.error('[reviewNotifications] failed to send review email:', err)
    }
  })()

  const whatsappTask = sendOrganizerWhatsApp({
    type:         KIND_TO_TYPE[args.kind],
    organizerUid: args.organizerUid,
    variables:    { eventName: args.eventName },
    eventName:    args.eventName,
  })

  // Both tasks never throw; allSettled guarantees we await completion of each.
  await Promise.allSettled([emailTask, whatsappTask])
  console.info(`[wa-trace][${_traceType}] STEP 2c both channels settled (email + WhatsApp complete)`)
}

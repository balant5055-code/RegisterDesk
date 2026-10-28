// Organizer notifications for the event review workflow.
//
// Recipient resolution (organizer uid → email) lives here; the subject/body
// template now lives in the Notification Engine (NotificationType.EVENT_*), so
// this module no longer knows any email content. Never throws: failures are
// logged and must never interrupt the review action.

import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { resolvePlatformEmailProvider } from '@/lib/email/platformProvider'
import { sendOrganizerWhatsApp } from '@/lib/notifications/organizerWhatsApp'
import { writeEmailLog }         from '@/lib/email-logs/write'
import { resolveOrganizerEmailIdentity } from '@/lib/organizer/emailIdentity'
import { notifyEventReviewed }   from '@/lib/notifications/inbox/notify'
import { emailUrl }              from '@/lib/email/appUrl'
import { eventEditorPath }       from '@/lib/events/editorPath'

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
  /** RD-REVIEW-01 — the reviewHistory entry id of this transition (dedupes the inbox item). */
  occurrenceId?: string
}

/**
 * Where the organizer acts on a review decision: requested changes open the event EDITOR (the request,
 * its deadline and Submit for review — RD-REVIEW-03); a rejection opens the Setup tab; anything else
 * the event itself.
 */
export function reviewEventPath(kind: ReviewNotificationKind, eventId?: string | null): string | null {
  if (!eventId) return null
  if (kind === 'changes_requested') return eventEditorPath(eventId)
  const base = `/dashboard/events/${encodeURIComponent(eventId)}`
  return kind === 'rejected' ? `${base}?tab=setup` : base
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
    occurrenceId: args.occurrenceId,
  })

  const emailTask = (async () => {
    const type = KIND_TO_TYPE[args.kind]
    // Base communication-log row shared by every outcome (sent / failed / skipped) so
    // NO path exits silently — every attempt is traceable in the Communication Center.
    const logBase = {
      organizerUid: args.organizerUid,
      eventId:      '',
      eventSlug:    '',
      eventName:    args.eventName,
      templateKey:  type,
      subject:      `Event review: ${args.kind}`,
      // RD-EMAIL-PROVIDER-04 — the provider the engine will actually use (platform choice).
      provider:     await resolvePlatformEmailProvider(),
      channel:      'email' as const,
    }
    try {
      // Canonical recipient resolution: Firestore profile first, Firebase Auth as the
      // authoritative email-identity fallback when the profile is a phantom ancestor.
      const identity = await resolveOrganizerEmailIdentity(args.organizerUid)

      if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
        void writeEmailLog({ ...logBase, recipientEmail: identity.email, recipientName: identity.name, status: 'skipped', error: 'Email provider not configured' })
        return
      }
      if (!identity.email) {
        void writeEmailLog({ ...logBase, recipientEmail: '', recipientName: identity.name, status: 'skipped', error: `No email on file for organizer ${args.organizerUid} (Firestore profile + Auth record both empty)` })
        return
      }

      // The link is an addition: a misconfigured app URL (emailUrl throws in production) drops the
      // button, never the review email itself.
      const path = reviewEventPath(args.kind, args.eventId)
      let eventUrl: string | undefined
      try { eventUrl = path ? emailUrl(path) : undefined } catch { eventUrl = undefined }
      const result = await notificationEngine.send(type, {
        to:        identity.email,
        eventName: args.eventName,
        reason:    args.reason,
        comment:   args.comment,
        eventUrl,
      })
      // PART 9: record the organizer email in the unified communication log
      // (channel='email') so it appears in the Communication Center alongside WhatsApp.
      void writeEmailLog({
        ...logBase,
        recipientEmail:    identity.email,
        recipientName:     identity.name,
        status:            result.success ? 'sent' : 'failed',
        providerMessageId: result.messageId,
        error:             result.success ? undefined : result.error,
      })
    } catch (err) {
      console.error('[reviewNotifications] failed to send review email:', err)
      void writeEmailLog({ ...logBase, recipientEmail: '', recipientName: '', status: 'failed', error: err instanceof Error ? err.message : 'unknown error' })
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

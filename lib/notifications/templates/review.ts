// Template resolution for the event-review notification family.
//
// This is the ONE place the review email copy lives. It was moved verbatim from
// lib/events/reviewNotifications.ts (buildContent) so business code no longer
// knows the subject/body — it only passes ReviewNotificationParams. Output is
// byte-identical to the previous implementation (same emailShell wrapper).

import { emailShell, escHtml } from '@/lib/email/templates/base'
import type { CustomEmailParams } from '@/lib/email/provider'
import type { ReviewNotificationParams } from '../catalog'

export type ReviewKind =
  | 'submitted'
  | 'approved'
  | 'rejected'
  | 'changes_requested'
  | 'resubmitted'

function buildContent(
  kind: ReviewKind,
  args: ReviewNotificationParams,
): { subject: string; body: string } {
  const name = escHtml(args.eventName || 'Your event')
  switch (kind) {
    case 'submitted':
    case 'resubmitted':
      return {
        subject: `“${args.eventName}” has been submitted for review`,
        body: `<p>Thanks — <strong>${name}</strong> has been submitted and is now <strong>under review</strong>. We’ll email you as soon as it’s approved and goes live.</p>`,
      }
    case 'approved':
      return {
        subject: `“${args.eventName}” is approved and live`,
        body: `<p>Good news — <strong>${name}</strong> has been <strong>approved</strong> and is now live and accepting registrations.</p>`,
      }
    case 'rejected':
      return {
        subject: `“${args.eventName}” was not approved`,
        body:
          `<p><strong>${name}</strong> was <strong>not approved</strong> and has been returned to your drafts.</p>` +
          (args.reason ? `<p><strong>Reason:</strong> ${escHtml(args.reason)}</p>` : '') +
          `<p>Please make the necessary changes and resubmit for review.</p>`,
      }
    case 'changes_requested':
      return {
        subject: `Changes requested for “${args.eventName}”`,
        body:
          `<p>An admin has requested changes to <strong>${name}</strong> before it can go live.</p>` +
          (args.comment ? `<p><strong>Requested changes:</strong> ${escHtml(args.comment)}</p>` : '') +
          `<p>Please update your event and resubmit for review.</p>`,
      }
  }
}

/** Render a review notification into the custom-email payload the provider sends. */
export function renderReviewEmail(
  kind: ReviewKind,
  params: ReviewNotificationParams,
): CustomEmailParams {
  const { subject, body } = buildContent(kind, params)
  return { to: params.to, subject, html: emailShell(subject, body) }
}

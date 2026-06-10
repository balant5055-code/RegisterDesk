import { emailShell, metaRow } from './base'
import type { EventCancelledEmailParams } from '../provider'

export function eventCancelledTemplate(p: EventCancelledEmailParams): { subject: string; html: string } {
  const subject = `Cancelled: ${p.eventName}`

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Event cancelled
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escName(p.attendeeName)}</strong>, we&rsquo;re sorry to inform you that
      <strong style="color:#111827;">${escName(p.eventName)}</strong> has been cancelled.
    </p>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Event',    p.eventName)}
        ${metaRow('Date',     p.eventDate)}
        ${metaRow('Attendee', p.attendeeName)}
        ${p.cancelReason ? metaRow('Reason', p.cancelReason) : ''}
      </table>
    </div>

    <p style="margin:0;font-size:13.5px;color:#6b7280;line-height:1.7;">
      If you made a payment, please allow 5&ndash;10 business days for the refund to appear.
      Contact the event organiser directly if you have any questions.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

function escName(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

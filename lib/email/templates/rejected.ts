import { emailShell, metaRow } from './base'
import type { RegistrationRejectedEmailParams } from '../provider'

export function registrationRejectedTemplate(
  p: RegistrationRejectedEmailParams,
): { subject: string; html: string } {
  const subject = `Registration update for ${p.eventName}`

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Registration not confirmed
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${esc(p.attendeeName)}</strong>, unfortunately we were unable
      to confirm your registration for <strong style="color:#111827;">${esc(p.eventName)}</strong>.
    </p>

    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Event',    p.eventName)}
        ${metaRow('Attendee', p.attendeeName)}
        ${metaRow('Ticket',   p.ticketCode)}
        ${p.reason ? metaRow('Reason', p.reason) : ''}
      </table>
    </div>

    <p style="margin:0 0 18px;font-size:13.5px;color:#6b7280;line-height:1.7;">
      If you believe this is an error or would like more information, please contact the event
      organiser directly.
    </p>

    <p style="margin:0;font-size:12px;color:#9ca3af;line-height:1.6;">
      Your reference ticket code is
      <strong style="color:#374151;font-family:monospace;">${esc(p.ticketCode)}</strong>.
      Please quote this when contacting the organiser.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

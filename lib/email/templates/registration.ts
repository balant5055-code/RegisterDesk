import { emailShell, btn, metaRow } from './base'
import type { RegistrationEmailParams } from '../provider'

export function registrationTemplate(p: RegistrationEmailParams): { subject: string; html: string } {
  const subject = `You're registered: ${p.eventName}`

  const dateLine   = p.eventTime ? `${p.eventDate} · ${p.eventTime}` : p.eventDate
  const venueLine  = [p.venueName, p.venueCity].filter(Boolean).join(', ')

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      You&rsquo;re registered!
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escName(p.attendeeName)}</strong>, your spot at
      <strong style="color:#111827;">${escName(p.eventName)}</strong> is confirmed.
    </p>

    <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:0 0 22px;border:1px solid #f3f4f6;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Event',    p.eventName)}
        ${metaRow('Date',     dateLine)}
        ${venueLine ? metaRow('Venue', venueLine) : ''}
        ${metaRow('Pass',     p.passName)}
        ${metaRow('Attendee', p.attendeeName)}
        ${metaRow('Ticket',   p.ticketCode)}
      </table>
    </div>

    <div style="margin:0 0 6px;">
      ${btn('View Ticket', p.ticketPageUrl)}
      ${btn('Download PDF', p.pdfDownloadUrl, false)}
      ${p.receiptDownloadUrl ? btn('Download Receipt', p.receiptDownloadUrl, false) : ''}
    </div>

    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
      Save this email &mdash; your ticket code is
      <strong style="color:#374151;font-family:monospace;">${p.ticketCode}</strong>.
      You&rsquo;ll need it to check in at the event.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

// Minimal XSS protection for interpolated values in the template body
function escName(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

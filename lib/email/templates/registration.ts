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

    ${feeBreakdownBlock(p)}

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

  return { subject, html: emailShell(subject, body, undefined, p.branding) }
}

/**
 * RD-FEE-RESTORE-01 — what the attendee actually paid, itemised.
 *
 * Rendered ONLY when `feeBreakdown` is present, which `buildAttendeeFeeBreakdown` does only for
 * an attendee_pays registration that bore fees. Organizer-absorbs and free registrations get
 * nothing here and the email is byte-identical to before, so this cannot change any mail that
 * is sent today.
 *
 * Every figure comes from the stored canonical record — the same paise the engine produced at
 * checkout and the receipt renders. Nothing is recomputed in an email template.
 */
function feeBreakdownBlock(p: RegistrationEmailParams): string {
  const bd = p.feeBreakdown
  if (!bd || bd.lines.length === 0) return ''

  const rows = bd.lines.map(l => `
        <tr>
          <td style="padding:4px 0;font-size:13px;color:#6b7280;">${escName(l.label)}</td>
          <td style="padding:4px 0;font-size:13px;color:#374151;text-align:right;">${rupees(l.paise)}</td>
        </tr>`).join('')

  return `
    <div style="background:#f9fafb;border-radius:10px;padding:16px 20px;margin:0 0 22px;border:1px solid #f3f4f6;">
      <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#111827;">Payment summary</p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${rows}
        <tr>
          <td style="padding:10px 0 0;border-top:1px solid #e5e7eb;font-size:14px;font-weight:700;color:#111827;">Total paid</td>
          <td style="padding:10px 0 0;border-top:1px solid #e5e7eb;font-size:14px;font-weight:700;color:#111827;text-align:right;">${rupees(bd.totalPaise)}</td>
        </tr>
      </table>
    </div>
  `
}

/** Integer paise → "₹1,234.50". Fixed 2dp so a fee line never renders as a bare rupee value. */
function rupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Minimal XSS protection for interpolated values in the template body
function escName(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

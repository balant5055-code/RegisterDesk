import type { TicketEmailParams } from '../provider'

export function ticketTemplate(p: TicketEmailParams): { subject: string; html: string } {
  const subject  = `Your ticket: ${p.eventName}`
  const venue    = [p.venueName, p.venueCity].filter(Boolean).join(', ')
  const dateLine = [p.eventDate, p.eventTime].filter(Boolean).join(' · ')

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f4f4f5;padding:32px 16px;">
  <tr><td align="center">
    <table width="520" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e4e4e7;">

      <!-- Header -->
      <tr><td style="background:#e5277e;padding:24px 28px;">
        <p style="margin:0;font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:rgba(255,255,255,0.8);">RegisterDesk</p>
        <h1 style="margin:10px 0 0;font-size:22px;font-weight:800;color:#ffffff;line-height:1.25;">${esc(p.eventName)}</h1>
        ${dateLine ? `<p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.85);">${esc(dateLine)}${venue ? ` &nbsp;&middot;&nbsp; ${esc(venue)}` : ''}</p>` : ''}
      </td></tr>

      <!-- Greeting -->
      <tr><td style="padding:24px 28px 0;">
        <p style="margin:0;font-size:15px;color:#18181b;">Hi <strong>${esc(p.attendeeName)}</strong>,</p>
        <p style="margin:8px 0 0;font-size:14px;color:#52525b;line-height:1.6;">Here is your ticket for <strong>${esc(p.eventName)}</strong>.</p>
      </td></tr>

      <!-- Ticket code block -->
      <tr><td style="padding:20px 28px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f9f9fb;border:1px solid #e4e4e7;border-radius:12px;padding:20px;text-align:center;">
          <tr><td>
            <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#71717a;">Ticket Code</p>
            <p style="margin:10px 0;font-size:28px;font-weight:800;letter-spacing:0.15em;color:#18181b;font-family:'Courier New',Courier,monospace;">${esc(p.ticketCode)}</p>
            <p style="margin:0;font-size:11px;color:#71717a;">Present this code or QR at the entry gate</p>
          </td></tr>
        </table>
      </td></tr>

      <!-- Details -->
      <tr><td style="padding:0 28px 20px;">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td style="width:50%;padding:7px 0;vertical-align:top;">
              <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;">Pass</p>
              <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#18181b;">${esc(p.passName)}</p>
            </td>
            <td style="width:50%;padding:7px 0;vertical-align:top;">
              <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;">Attendee</p>
              <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#18181b;">${esc(p.attendeeName)}</p>
            </td>
          </tr>
          ${dateLine ? `<tr>
            <td colspan="2" style="padding:7px 0;vertical-align:top;">
              <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;">Date &amp; Time</p>
              <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#18181b;">${esc(dateLine)}</p>
            </td>
          </tr>` : ''}
          ${venue ? `<tr>
            <td colspan="2" style="padding:7px 0;vertical-align:top;">
              <p style="margin:0;font-size:10px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#71717a;">Venue</p>
              <p style="margin:4px 0 0;font-size:13px;font-weight:600;color:#18181b;">${esc(venue)}</p>
            </td>
          </tr>` : ''}
        </table>
      </td></tr>

      <!-- CTAs -->
      <tr><td style="padding:0 28px 28px;">
        <table cellpadding="0" cellspacing="0" role="presentation">
          <tr>
            <td style="padding-right:12px;">
              <a href="${esc(p.ticketPageUrl)}" style="display:inline-block;background:#e5277e;color:#ffffff;font-size:13px;font-weight:700;padding:10px 20px;border-radius:10px;text-decoration:none;">View Ticket</a>
            </td>
            <td>
              <a href="${esc(p.pdfDownloadUrl)}" style="display:inline-block;background:#f4f4f5;color:#18181b;font-size:13px;font-weight:700;padding:10px 20px;border-radius:10px;text-decoration:none;border:1px solid #e4e4e7;">Download PDF</a>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- Footer -->
      <tr><td style="background:#f4f4f5;border-top:1px solid #e4e4e7;padding:16px 28px;text-align:center;">
        <p style="margin:0;font-size:11px;color:#a1a1aa;">
          Ticket generated by <a href="https://registerdesk.in" style="color:#e5277e;text-decoration:none;font-weight:600;">RegisterDesk</a>.
          Questions? Contact the event organiser directly.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body>
</html>`

  return { subject, html }
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

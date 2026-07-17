import { escHtml, escAttr } from './base'
import type { ApplicationReceivedEmailParams, ApplicationStatusEmailParams } from '../provider'

const BRAND_COLOR = '#6366f1'

function shell(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:'Segoe UI',Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 0">
  <tr><td align="center">
    <table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;max-width:600px;width:100%">
      <tr>
        <td style="background:${BRAND_COLOR};padding:20px 32px">
          <span style="font-size:18px;font-weight:700;color:#fff;letter-spacing:-0.3px">RegisterDesk</span>
        </td>
      </tr>
      <tr><td style="padding:32px">${body}</td></tr>
      <tr>
        <td style="background:#f9fafb;padding:16px 32px;font-size:12px;color:#9ca3af;border-top:1px solid #e5e7eb">
          This email was sent by RegisterDesk. If you did not submit an application, you can ignore this message.
        </td>
      </tr>
    </table>
  </td></tr>
</table>
</body>
</html>`
}

const TYPE_LABEL: Record<string, string> = {
  speaker: 'Speaker',
  sponsor: 'Sponsor',
}

export function applicationReceivedTemplate(p: ApplicationReceivedEmailParams): { subject: string; html: string } {
  const typeLabel = TYPE_LABEL[p.applicationType] ?? 'Application'
  const subject   = `Your ${typeLabel} Application — ${p.eventName}`

  const appName = escHtml(p.applicantName)
  const evName  = escHtml(p.eventName)
  const evUrl   = escAttr(p.eventUrl)

  const body = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111827">Application Received</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280">Hi ${appName},</p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151">
      Thank you for applying to speak at <strong>${evName}</strong>. We have received your ${typeLabel.toLowerCase()} application and our team will review it shortly.
    </p>
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151">
      You will receive an email once your application has been reviewed. In the meantime, feel free to explore the event page.
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:24px 0">
      <tr>
        <td style="background:${BRAND_COLOR};border-radius:8px;padding:12px 24px">
          <a href="${evUrl}" style="color:#fff;font-size:14px;font-weight:600;text-decoration:none">View Event →</a>
        </td>
      </tr>
    </table>
    <p style="margin:24px 0 0;font-size:14px;color:#9ca3af">Regards,<br/>The RegisterDesk Team</p>
  `
  return { subject, html: shell(subject, body) }
}

export function applicationStatusTemplate(p: ApplicationStatusEmailParams): { subject: string; html: string } {
  const typeLabel   = TYPE_LABEL[p.applicationType] ?? 'Application'
  const isApproved  = p.status === 'approved'
  const statusLabel = isApproved ? 'Approved' : 'Not Selected'
  const subject     = `${typeLabel} Application ${statusLabel} — ${p.eventName}`

  const accentColor = isApproved ? '#16a34a' : '#dc2626'
  const accentBg    = isApproved ? '#f0fdf4' : '#fef2f2'

  const appName = escHtml(p.applicantName)
  const evName  = escHtml(p.eventName)
  const evUrl   = escAttr(p.eventUrl)
  const note    = p.note ? escHtml(p.note) : ''

  const body = `
    <p style="margin:0 0 8px;font-size:20px;font-weight:700;color:#111827">Application ${statusLabel}</p>
    <p style="margin:0 0 24px;font-size:14px;color:#6b7280">Hi ${appName},</p>
    <div style="background:${accentBg};border-left:4px solid ${accentColor};border-radius:4px;padding:14px 18px;margin:0 0 20px">
      <p style="margin:0;font-size:14px;font-weight:600;color:${accentColor}">
        ${isApproved
          ? `Congratulations! Your ${typeLabel.toLowerCase()} application for <strong>${evName}</strong> has been approved.`
          : `Thank you for applying. After careful review, we are unable to move forward with your ${typeLabel.toLowerCase()} application for <strong>${evName}</strong> at this time.`
        }
      </p>
    </div>
    ${note ? `
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151">
      <strong>Note from the organiser:</strong><br/>${note}
    </p>` : ''}
    <p style="margin:0 0 20px;font-size:15px;line-height:1.6;color:#374151">
      ${isApproved
        ? 'The organiser will reach out to you with further details. You can also visit the event page for updates.'
        : 'We encourage you to explore future events on RegisterDesk and apply again.'
      }
    </p>
    <table cellpadding="0" cellspacing="0" style="margin:24px 0">
      <tr>
        <td style="background:${BRAND_COLOR};border-radius:8px;padding:12px 24px">
          <a href="${evUrl}" style="color:#fff;font-size:14px;font-weight:600;text-decoration:none">View Event →</a>
        </td>
      </tr>
    </table>
    <p style="margin:24px 0 0;font-size:14px;color:#9ca3af">Regards,<br/>The RegisterDesk Team</p>
  `
  return { subject, html: shell(subject, body) }
}

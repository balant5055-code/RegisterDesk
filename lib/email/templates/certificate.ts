// Certificate-ready email template.

import { emailShell } from './base'
import type { CertificateEmailParams } from '../provider'

// Minimal HTML escape for organizer-supplied custom message text.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function certificateTemplate(p: CertificateEmailParams): { subject: string; html: string } {
  const subject = p.subject?.trim() || `Your Certificate - ${p.eventName}`

  // Organizer custom message (placeholder-resolved upstream) takes precedence;
  // otherwise fall back to the default copy. Newlines become paragraph breaks.
  const intro = p.message?.trim()
    ? `<p style="font-size:14px;color:#333;margin:0 0 4px 0;white-space:pre-line;">${esc(p.message.trim())}</p>`
    : `
      <p style="font-size:16px;font-weight:700;color:#1a1a1a;margin:0 0 4px 0;">
        Your certificate is ready, ${esc(p.attendeeName)}!
      </p>
      <p style="font-size:14px;color:#555;margin:0;">
        Your certificate for <strong>${esc(p.eventName)}</strong> has been generated and is available to download.
      </p>`

  const body = `
    <div style="margin-bottom:24px;">
      ${intro}
    </div>

    <div style="background:#fafafa;border:1px solid #eee;border-radius:12px;padding:20px 24px;margin-bottom:24px;">
      <p style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 4px 0;">Certificate ID</p>
      <p style="font-size:18px;font-weight:700;color:#1a1a1a;font-family:monospace;letter-spacing:0.06em;margin:0;">${p.certificateId}</p>
    </div>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="${p.downloadUrl}"
         style="display:inline-block;background:linear-gradient(135deg,#fb5a6a,#e5277e);color:#fff;font-size:14px;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;">
        Download Certificate
      </a>
    </div>

    <p style="font-size:13px;color:#777;text-align:center;margin:0 0 8px 0;">
      You can verify the authenticity of your certificate at any time:
    </p>
    <p style="text-align:center;margin:0;">
      <a href="${p.verifyUrl}" style="font-size:12px;color:#e5277e;">${p.verifyUrl}</a>
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

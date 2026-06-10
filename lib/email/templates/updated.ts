import { emailShell, btn } from './base'
import type { EventUpdatedEmailParams } from '../provider'

export function eventUpdatedTemplate(p: EventUpdatedEmailParams): { subject: string; html: string } {
  const subject = `Update: ${p.eventName}`

  const changeItems = p.changes
    .map(c => `<li style="margin:0 0 7px;font-size:13.5px;color:#374151;line-height:1.6;">${escName(c)}</li>`)
    .join('')

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Event updated
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${escName(p.attendeeName)}</strong>, there have been updates to
      <strong style="color:#111827;">${escName(p.eventName)}</strong>.
    </p>

    <div style="background:#fefce8;border:1px solid #fde68a;border-radius:10px;padding:16px 20px;margin:0 0 22px;">
      <p style="margin:0 0 10px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#92400e;">What changed</p>
      <ul style="margin:0;padding-left:16px;">
        ${changeItems}
      </ul>
    </div>

    <div style="margin:0 0 6px;">
      ${btn('View Event', p.eventPageUrl)}
    </div>

    <p style="margin:18px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
      Your registration remains confirmed. If you have any questions, please contact the event organiser.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

function escName(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

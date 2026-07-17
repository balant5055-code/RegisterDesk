import { emailShell, btn, metaRow } from './base'
import type { SpotAvailableEmailParams } from '../provider'

export function spotAvailableTemplate(p: SpotAvailableEmailParams): { subject: string; html: string } {
  const subject = `A spot is available for ${p.eventName}`

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      Great news &mdash; a spot opened up!
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${esc(p.attendeeName)}</strong>, a spot has become
      available at <strong style="color:#111827;">${esc(p.eventName)}</strong>. Complete
      your registration now before it&rsquo;s taken.
    </p>

    <div style="background:#f0fdf4;border-radius:10px;padding:16px 20px;margin:0 0 22px;border:1px solid #bbf7d0;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Event', p.eventName)}
        ${metaRow('Pass',  p.passName)}
        ${metaRow('Status', 'Spot available — register now to confirm your place')}
      </table>
    </div>

    <div style="margin:0 0 6px;">
      ${btn('Register Now', p.registerUrl)}
    </div>

    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
      Spots are first come, first served. Register soon to secure your place.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

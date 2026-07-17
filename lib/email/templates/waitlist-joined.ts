import { emailShell, metaRow } from './base'
import type { WaitlistJoinedEmailParams } from '../provider'

export function waitlistJoinedTemplate(p: WaitlistJoinedEmailParams): { subject: string; html: string } {
  const subject = `You're on the waitlist for ${p.eventName}`

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const body = `
    <h1 style="margin:0 0 6px;font-size:22px;font-weight:700;color:#111827;line-height:1.3;">
      You&rsquo;re on the waitlist!
    </h1>
    <p style="margin:0 0 22px;font-size:14px;color:#6b7280;line-height:1.6;">
      Hi <strong style="color:#111827;">${esc(p.attendeeName)}</strong>, you&rsquo;ve been added to the
      waitlist for <strong style="color:#111827;">${esc(p.eventName)}</strong>.
      We&rsquo;ll notify you by email if a spot opens up.
    </p>

    <div style="background:#fef3c7;border-radius:10px;padding:16px 20px;margin:0 0 22px;border:1px solid #fde68a;">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${metaRow('Event', p.eventName)}
        ${metaRow('Pass',  p.passName)}
        ${metaRow('Status', 'Waitlisted — we will email you if a spot opens')}
      </table>
    </div>

    <p style="margin:0 0 6px;">
      <a href="${esc(p.eventPageUrl)}" style="display:inline-block;background:#f3f4f6;color:#374151;text-decoration:none;font-size:13.5px;font-weight:600;padding:11px 22px;border-radius:8px;border:1px solid #d1d5db;margin:0 8px 8px 0;line-height:1.4;">
        View Event
      </a>
    </p>

    <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;line-height:1.6;">
      No action needed — we&rsquo;ll reach out if a spot becomes available.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

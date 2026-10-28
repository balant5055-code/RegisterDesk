// RD-MEETING-ACCESS-01 — the "How to join" block of the confirmation / approval / ticket emails.
//
// Rendered ONLY when the sender attached `meetingAccess`, which lib/registrations/meetingAccess
// does only for a confirmed registration of an online / hybrid event. Every other email is
// byte-identical to before. All values are escaped; the link is already a validated http(s) URL.

import type { MeetingAccessEmail } from '../provider'
import { escHtml, escAttr } from './base'

export function meetingAccessBlock(m: MeetingAccessEmail | undefined): string {
  if (!m) return ''
  const row = (label: string, value: string, mono = false) => `
        <tr>
          <td style="padding:6px 16px 6px 0;font-size:12px;color:#6b7280;vertical-align:top;white-space:nowrap;">${escHtml(label)}</td>
          <td style="padding:6px 0;font-size:13px;color:#111827;font-weight:600;${mono ? "font-family:'Courier New',Courier,monospace;" : ''}word-break:break-all;">${escHtml(value)}</td>
        </tr>`

  return `
    <div style="background:#eef2ff;border-radius:10px;padding:16px 20px;margin:0 0 22px;border:1px solid #c7d2fe;">
      <p style="margin:0 0 4px;font-size:13px;font-weight:700;color:#111827;">How to join online</p>
      <p style="margin:0 0 10px;font-size:12px;color:#4b5563;line-height:1.5;">Joining details for ${escHtml(m.platform)}. Please don&rsquo;t share them &mdash; they are for registered attendees.</p>
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%">
        ${m.joinUrl ? `
        <tr>
          <td style="padding:6px 16px 6px 0;font-size:12px;color:#6b7280;vertical-align:top;white-space:nowrap;">Link</td>
          <td style="padding:6px 0;font-size:13px;word-break:break-all;"><a href="${escAttr(m.joinUrl)}" style="color:#4F46E5;font-weight:600;">${escHtml(m.joinUrl)}</a></td>
        </tr>` : ''}
        ${m.meetingId ? row('Meeting ID', m.meetingId, true) : ''}
        ${m.passcode ? row('Passcode', m.passcode, true) : ''}
      </table>
      ${m.instructions ? `<p style="margin:10px 0 0;font-size:12px;color:#4b5563;line-height:1.6;white-space:pre-line;">${escHtml(m.instructions)}</p>` : ''}
    </div>
  `
}

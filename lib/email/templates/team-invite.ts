// Team invitation email — sent when an owner invites a member to their workspace.

import { emailShell } from './base'

export interface TeamInviteEmailParams {
  organizationName: string
  inviterEmail:     string
  roleLabel:        string   // human-readable role, e.g. "Manager"
  acceptUrl:        string
}

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function teamInviteTemplate(p: TeamInviteEmailParams): { subject: string; html: string } {
  const org     = esc(p.organizationName)
  const subject = `You've been invited to join ${org} on RegisterDesk`

  const body = `
    <div style="margin-bottom:24px;">
      <p style="font-size:16px;font-weight:700;color:#1a1a1a;margin:0 0 6px 0;">
        You've been invited to join ${org}
      </p>
      <p style="font-size:14px;color:#555;margin:0;">
        <strong>${esc(p.inviterEmail)}</strong> has invited you to collaborate as
        <strong>${esc(p.roleLabel)}</strong> on RegisterDesk.
      </p>
    </div>

    <div style="text-align:center;margin-bottom:24px;">
      <a href="${p.acceptUrl}"
         style="display:inline-block;background:linear-gradient(135deg,#fb5a6a,#e5277e);color:#fff;font-size:14px;font-weight:700;padding:14px 32px;border-radius:12px;text-decoration:none;">
        Accept invitation
      </a>
    </div>

    <p style="font-size:13px;color:#777;text-align:center;margin:0 0 4px 0;">
      If the button doesn't work, paste this link into your browser:
    </p>
    <p style="text-align:center;margin:0 0 16px 0;">
      <a href="${p.acceptUrl}" style="font-size:12px;color:#e5277e;word-break:break-all;">${p.acceptUrl}</a>
    </p>

    <p style="font-size:12px;color:#999;text-align:center;margin:0;">
      This invitation expires in 7 days. If you weren't expecting it, you can safely ignore this email.
    </p>
  `

  return { subject, html: emailShell(subject, body) }
}

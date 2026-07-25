// RD-PRODUCT-01C — organizer email white-label branding.
//   GET   → the organizer's saved branding.
//   PATCH → validate + save branding.
//   POST  → send a branded TEST email to the organizer (body: { to?: string }).
//
// Workspace-gated. Reuses the existing emailShell + notification engine — no new
// email infrastructure.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import {
  loadOrganizerEmailBranding, saveOrganizerEmailBranding, validateOrganizerEmailBranding,
  resolveEmailBranding, type OrganizerEmailBranding,
} from '@/lib/email/branding'
import { emailShell, btn, metaRow } from '@/lib/email/templates/base'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'

const ALLOWED = new Set<keyof OrganizerEmailBranding>([
  'enabled', 'companyName', 'primaryColor', 'secondaryColor', 'logoUrl', 'website',
  'supportEmail', 'supportPhone', 'footerText', 'copyright', 'hideRegisterDeskBranding',
])

function parse(body: Record<string, unknown>): OrganizerEmailBranding {
  const out: OrganizerEmailBranding = {}
  for (const key of ALLOWED) {
    if (!(key in body)) continue
    const v = body[key]
    if (key === 'enabled' || key === 'hideRegisterDeskBranding') { if (typeof v === 'boolean') out[key] = v }
    else if (typeof v === 'string') (out[key] as string) = v.trim()
  }
  return out
}

/** A representative registration-confirmation body, so the preview/test reflect a real email. */
export function sampleEmailBody(): string {
  const body = `
    <p style="font-size:15px;color:#111827;margin:0 0 6px;">Hi Priya,</p>
    <p style="font-size:14px;color:#374151;line-height:1.6;margin:0 0 18px;">
      Your registration for <strong>Annual Tech Summit 2026</strong> is confirmed. Your ticket is below.
    </p>
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:0 0 18px;">
      ${metaRow('Ticket', 'RD-8F3K2M9Q')}
      ${metaRow('Pass', 'Full Conference')}
      ${metaRow('Date', 'Saturday, 14 March 2026')}
      ${metaRow('Venue', 'Bengaluru International Centre')}
    </table>
    ${btn('Download Ticket', 'https://registerdesk.in')}
    ${btn('View Details', 'https://registerdesk.in', false)}
  `
  return body
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const branding = await loadOrganizerEmailBranding(authz.workspaceUid)
  return NextResponse.json({ branding: branding ?? {} })
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const patch = parse(body)
  const errs = validateOrganizerEmailBranding(patch)
  if (errs.length) return NextResponse.json({ error: 'Invalid branding', details: errs }, { status: 400 })
  await saveOrganizerEmailBranding(authz.workspaceUid, patch)
  return NextResponse.json({ ok: true, branding: patch })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
    return NextResponse.json({ error: 'Email is not configured' }, { status: 503 })
  }
  let body: Record<string, unknown> = {}
  try { body = await req.json() as Record<string, unknown> } catch { /* optional body */ }
  const to = typeof body.to === 'string' && body.to.includes('@') ? body.to : ''
  if (!to) return NextResponse.json({ error: 'A recipient email is required' }, { status: 400 })

  const stored = await loadOrganizerEmailBranding(authz.workspaceUid)
  const branding = resolveEmailBranding(stored)
  const subject = '[Test] Your branded RegisterDesk email'
  const html = emailShell(subject, sampleEmailBody(), undefined, branding)

  const result = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, { to, subject, html })
  if (!result.success) return NextResponse.json({ error: result.error ?? 'Send failed' }, { status: 502 })
  return NextResponse.json({ ok: true, sentTo: to })
}

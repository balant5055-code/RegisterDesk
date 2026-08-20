// POST /api/organizer/broadcasts/test
//
// Sends a single test email to the authenticated organizer's own email address.
// The body is rendered with SAMPLE_VARS substitution so the organizer sees
// what the final email will look like. No campaign document is created.
//
// Body: { subject: string; html: string }

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import { emailShell }                from '@/lib/email/templates/base'
import { substituteVariables, SAMPLE_VARS } from '@/lib/email-templates/types'
import { renderBroadcastBody }      from '@/lib/broadcasts/renderBody'

interface TestResponse {
  success: boolean
  error?:  string
}

export async function POST(req: NextRequest): Promise<NextResponse<TestResponse>> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid       = authz.workspaceUid
  const callerUid = authz.callerUid

  // Per-operator rate limit (workspace+operator) so one staff member can't
  // exhaust the workspace's test-send budget: 10 test emails / 5 min each.
  // Fail-open: a Redis outage shouldn't block this low-risk authenticated action.
  const rl = await checkDistributedRateLimit({ key: `broadcast-test:${uid}:${callerUid}`, limit: 10, windowSeconds: 5 * 60, failOpen: true })
  if (!rl.allowed) {
    return NextResponse.json({ success: false, error: 'Too many test emails. Please wait a moment and try again.' }, { status: 429 })
  }

  let body: unknown
  try { body = await req.json() }
  catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }) }

  const { subject, html } = body as Record<string, unknown>
  if (typeof subject !== 'string' || !subject.trim()) {
    return NextResponse.json({ success: false, error: 'subject is required' }, { status: 400 })
  }
  if (typeof html !== 'string' || !html.trim()) {
    return NextResponse.json({ success: false, error: 'html is required' }, { status: 400 })
  }

  // Get organizer's own email from profile
  const profileSnap = await adminDb.collection('users').doc(uid).get()
  const profile     = profileSnap.data() ?? {}
  const orgEmail    = typeof profile.email === 'string' ? profile.email.trim() : ''
  if (!orgEmail) {
    return NextResponse.json(
      { success: false, error: 'Organizer email not found in profile. Please update your account email.' },
      { status: 422 },
    )
  }

  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
    return NextResponse.json(
      { success: false, error: 'Email provider not configured on this server.' },
      { status: 503 },
    )
  }

  const renderedSubject = substituteVariables(subject, SAMPLE_VARS)
  // RD-BCAST-FMT-01 — the SAME body renderer the real send uses, so a test email is a
  // faithful rehearsal rather than a third variant.
  const renderedBody    = renderBroadcastBody(html, SAMPLE_VARS)
  // Footer matches a real broadcast: entity line off, platform mark on.
  //
  // The unsubscribe link is deliberately NOT passed here. This message goes to the
  // organizer's own address, and a live link would let them suppress themselves from
  // their own campaigns with one curious click — a real, hard-to-diagnose outcome from a
  // button labelled "Send Test". Recipients still get the link; see emailJob.
  const fullHtml        = emailShell(renderedSubject, renderedBody, undefined, undefined, { hideOwnershipLine: true })

  try {
    const result = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, {
      to:      orgEmail,
      subject: `[TEST] ${renderedSubject}`,
      html:    fullHtml,
    })
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error ?? 'Send failed' }, { status: 502 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unexpected error'
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

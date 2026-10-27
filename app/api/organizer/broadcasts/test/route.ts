// POST /api/organizer/broadcasts/test
//
// Sends ONE test email to the signed-in operator's OWN account address — never to an attendee and
// never to the audience. No campaign document is created.
//
// Body: { subject: string; html: string; eventSlug?: string }
//
// RD-BCAST-TEST — a faithful rehearsal of the real send:
//   • the SAME body renderer (renderBroadcastBody) and email shell as the job;
//   • the SAME transport: with an event, the event's resolved provider (per-event override, else the
//     platform provider), exactly what the broadcast job will use — it used to always be the
//     zero-argument default, so a Resend event was rehearsed through SES;
//   • the event's real date / venue / organizer name; attendee fields use sample values;
//   • unknown {{variables}} are refused here exactly as at send.
// The response reports PROVIDER ACCEPTANCE, not delivery: the provider took the message.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb, adminAuth }        from '@/lib/firebase/admin'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { checkDistributedRateLimit } from '@/lib/rateLimit/redis'
import { emailShell }                from '@/lib/email/templates/base'
import { substituteVariables, SAMPLE_VARS } from '@/lib/email-templates/types'
import { renderBroadcastBody }      from '@/lib/broadcasts/renderBody'
import { broadcastEventVars, unknownBroadcastVariables, unknownVariablesMessage } from '@/lib/broadcasts/eventVars'
import { resolveEventEmailProvider } from '@/lib/email/resolveEventProvider'
import { resolvePlatformEmailProvider } from '@/lib/email/platformProvider'
import { EMAIL_PROVIDER_LABEL }      from '@/lib/email/providerSelection'
import { resolvePublicBranding }     from '@/lib/branding/service'
import { authoritativeEventName }    from '@/lib/broadcasts/eventName'

interface TestResponse {
  success: boolean
  error?:  string
  /** RD-BCAST-TEST — accepted by this provider (not "delivered"). */
  provider?: string
  /** The operator's own address, masked. */
  to?: string
}

const mask = (email: string) => email.replace(/^(.)[^@]*(@.*)$/, (_, a: string, d: string) => `${a}***${d}`)

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

  const { subject, html, eventSlug } = body as Record<string, unknown>
  if (typeof subject !== 'string' || !subject.trim()) {
    return NextResponse.json({ success: false, error: 'subject is required' }, { status: 400 })
  }
  if (typeof html !== 'string' || !html.trim()) {
    return NextResponse.json({ success: false, error: 'html is required' }, { status: 400 })
  }
  const unknown = unknownBroadcastVariables(subject, html)
  if (unknown.length > 0) return NextResponse.json({ success: false, error: unknownVariablesMessage(unknown) }, { status: 400 })

  // The event (optional — the composer always sends it): must be THIS workspace's live event.
  let eventDoc: Record<string, unknown> | null = null
  const slug = typeof eventSlug === 'string' ? eventSlug.trim() : ''
  if (slug) {
    const snap = await adminDb.collection('events').doc(slug).get().catch(() => null)
    const data = snap?.exists ? snap.data() as Record<string, unknown> : null
    if (!data || data.uid !== uid) return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
    eventDoc = data
  }

  // The OPERATOR's own address (the person who clicked), never an attendee's.
  const callerProfile = (await adminDb.collection('users').doc(callerUid).get().catch(() => null))?.data() ?? {}
  let toEmail = typeof callerProfile.email === 'string' ? callerProfile.email.trim() : ''
  if (!toEmail) toEmail = (await adminAuth.getUser(callerUid).then(u => u.email ?? '').catch(() => '')).trim()
  if (!toEmail) {
    return NextResponse.json(
      { success: false, error: 'Your account has no email address. Add one to your profile to receive test emails.' },
      { status: 422 },
    )
  }

  const providerName = slug ? await resolveEventEmailProvider(slug) : await resolvePlatformEmailProvider()
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL, providerName)) {
    return NextResponse.json(
      { success: false, error: `${EMAIL_PROVIDER_LABEL[providerName]} — the email provider for this event — is not configured.` },
      { status: 503 },
    )
  }

  let vars: Record<string, string> = SAMPLE_VARS
  if (eventDoc) {
    const org = (await adminDb.collection('users').doc(uid).get().catch(() => null))?.data() ?? {}
    const branding = await resolvePublicBranding(uid).catch(() => null)
    const organizerName = branding?.companyName || (typeof org.organizationName === 'string' ? org.organizationName : '')
    const ev = broadcastEventVars(eventDoc, organizerName)
    const eventName = authoritativeEventName(eventDoc, slug)
    vars = { ...SAMPLE_VARS, eventName, ...ev }
  }

  const renderedSubject = substituteVariables(subject, vars)
  // RD-BCAST-FMT-01 — the SAME body renderer the real send uses.
  const renderedBody    = renderBroadcastBody(html, vars)
  // Footer matches a real broadcast: entity line off, platform mark on.
  //
  // The unsubscribe link is deliberately NOT passed here. This message goes to the
  // operator's own address, and a live link would let them suppress themselves from
  // their own campaigns with one curious click. Recipients still get the link; see emailJob.
  const fullHtml        = emailShell(renderedSubject, renderedBody, undefined, undefined, { hideOwnershipLine: true })

  try {
    const result = await notificationEngine.send(NotificationType.CUSTOM_EMAIL, {
      to:      toEmail,
      subject: `[TEST] ${renderedSubject}`,
      html:    fullHtml,
    }, providerName)
    if (!result.success) {
      return NextResponse.json({
        success: false,
        error: result.deliveryUnknown
          ? 'The email provider did not confirm the test email. It may still arrive — check your inbox before sending another.'
          : (result.error ?? 'Send failed'),
      }, { status: 502 })
    }
    return NextResponse.json({ success: true, provider: EMAIL_PROVIDER_LABEL[providerName], to: mask(toEmail) })
  } catch {
    return NextResponse.json({ success: false, error: 'The test email could not be sent.' }, { status: 500 })
  }
}

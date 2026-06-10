// POST /api/organizer/registrations/[registrationId]/resend-email
//
// Resends the ticket email for a specific registration.
// Organizer-only: the authenticated user must own the event
// (verified via reg.organizerUid === uid).

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb, adminAuth }          from '@/lib/firebase/admin'
import { getEventBySlug }              from '@/lib/firebase/firestore/events'
import { signTicketToken }             from '@/lib/tickets/generate'
import { getEmailProvider, fmtEmailDate } from '@/lib/email'
import { writeAuditEntry }              from '@/lib/firebase/firestore/registrations'
import type { RegistrationDocument }   from '@/lib/registrations/types'

export interface ResendEmailResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<ResendEmailResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired token' }, { status: 401 })
  }

  const { registrationId } = await context.params

  // ── 2. Load registration ────────────────────────────────────────────────────
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const reg = regSnap.data() as RegistrationDocument

  // ── 3. Ownership check ──────────────────────────────────────────────────────
  if (reg.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // ── 4. Guard: cancelled registrations should not receive tickets ───────────
  if (reg.status === 'cancelled') {
    return NextResponse.json(
      { success: false, error: 'Cannot resend email for a cancelled registration.' },
      { status: 422 },
    )
  }

  // ── 5. Ensure email provider is configured ─────────────────────────────────
  const provider = getEmailProvider()
  if (!provider) {
    return NextResponse.json(
      { success: false, error: 'Email provider is not configured. Set EMAIL_PROVIDER and related environment variables.' },
      { status: 503 },
    )
  }

  // ── 6. Load event for date/venue details ────────────────────────────────────
  const event    = await getEventBySlug(reg.eventSlug)
  const rawDet   = (event?.eventDetails as Record<string, unknown> | null) ?? {}
  const schedule = rawDet.schedule as Record<string, unknown> | null
  const startDate = typeof schedule?.startDate === 'string' ? schedule.startDate : ''
  const startTime = typeof schedule?.startTime === 'string' ? schedule.startTime : ''

  const venueRaw  = rawDet.venue as Record<string, unknown> | null
  const venueType = typeof venueRaw?.type === 'string' ? venueRaw.type : ''
  const physical  = venueRaw?.physical as Record<string, unknown> | null
  const online    = venueRaw?.online   as Record<string, unknown> | null
  const venueName = venueType === 'online'
    ? (typeof online?.platform === 'string' ? online.platform : 'Online')
    : (typeof physical?.name === 'string' ? physical.name : '')
  const venueCity = venueType !== 'online'
    ? (typeof physical?.city === 'string' ? physical.city : '')
    : ''

  // ── 7. Build URLs ────────────────────────────────────────────────────────────
  const baseUrl  = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const pdfToken = signTicketToken(registrationId)
  const pdfUrl   = `${baseUrl}/api/tickets/${registrationId}/pdf${pdfToken ? `?token=${encodeURIComponent(pdfToken)}` : ''}`

  // ── 8. Send ticket email ─────────────────────────────────────────────────────
  let emailStatus: 'sent' | 'failed' = 'failed'
  let emailFailureReason: string | undefined

  try {
    const result = await provider.sendTicketEmail({
      to:             reg.attendee.email,
      attendeeName:   reg.attendee.name,
      eventName:      reg.eventName,
      eventDate:      fmtEmailDate(startDate) || startDate,
      eventTime:      startTime  || undefined,
      venueName:      venueName  || undefined,
      venueCity:      venueCity  || undefined,
      ticketCode:     reg.ticketCode,
      passName:       reg.passName,
      registrationId,
      ticketPageUrl:  `${baseUrl}/tickets/${registrationId}`,
      pdfDownloadUrl: pdfUrl,
    })

    emailStatus = result.success ? 'sent' : 'failed'
    if (!result.success) emailFailureReason = result.error
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[email] resend-email error for ${registrationId}:`, err)
  }

  // ── 9. Persist email status ──────────────────────────────────────────────────
  adminDb.collection('registrations').doc(registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent'
      ? { emailSentAt: FieldValue.serverTimestamp() }
      : { emailFailureReason }),
  }).catch(err =>
    console.error(`[email] Failed to persist emailStatus for ${registrationId}:`, err),
  )

  if (emailStatus === 'sent') {
    writeAuditEntry(registrationId, 'email_resent', uid, 'organizer').catch(err =>
      console.error(`[email] Failed to write audit entry for ${registrationId}:`, err),
    )
    return NextResponse.json({ success: true })
  }

  return NextResponse.json(
    { success: false, error: emailFailureReason ?? 'Email delivery failed.' },
    { status: 502 },
  )
}

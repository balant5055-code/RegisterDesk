// POST /api/organizer/email-logs/[logId]/retry
//
// Re-sends the email for a failed log entry and updates the log status.
// Supports: registration_submitted (ticket email) and registration_approved (ticket email).
// Other template keys return 422 (not yet retryable).

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb }                      from '@/lib/firebase/admin'
import { fmtEmailDate } from '@/lib/email'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { authorizeWorkspace }            from '@/lib/team/workspace'
import { signTicketToken }             from '@/lib/tickets/generate'
import { updateEmailLog }              from '@/lib/email-logs/write'
import { getEventBySlug }              from '@/lib/firebase/firestore/events'
import type { EmailLog }               from '@/lib/email-logs/types'
import type { RegistrationDocument }   from '@/lib/registrations/types'

export interface RetryEmailLogResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ logId: string }> },
): Promise<NextResponse<RetryEmailLogResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { logId } = await params
  const logRef = adminDb.collection('emailLogs').doc(logId)

  // ── 2. Ensure email provider is configured (before claiming the log) ────────
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
    return NextResponse.json(
      { success: false, error: 'Email provider not configured' },
      { status: 503 },
    )
  }

  const retryableKeys = new Set(['registration_submitted', 'registration_approved'])

  // ── 3. Atomically CLAIM the log: ownership + failed-status + retryable, then
  //       flip 'failed' → 'queued' so a concurrent retry can't double-send. ────
  const claim = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(logRef)
    if (!snap.exists) return { ok: false as const, status: 404, error: 'Log entry not found' }
    const l = { id: snap.id, ...snap.data() } as EmailLog
    if (l.organizerUid !== uid) return { ok: false as const, status: 403, error: 'Forbidden' }
    if (l.status !== 'failed') {
      return { ok: false as const, status: 409, error: 'This email is not in a retryable state (already retried or in progress).' }
    }
    if (!retryableKeys.has(l.templateKey)) {
      return { ok: false as const, status: 422, error: `Retry not supported for template "${l.templateKey}"` }
    }
    tx.update(logRef, { status: 'queued', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true as const, log: l }
  })

  if (!claim.ok) {
    return NextResponse.json({ success: false, error: claim.error }, { status: claim.status })
  }
  const log = claim.log

  // ── 6. Load registration + event ───────────────────────────────────────────
  const regSnap = await adminDb.collection('registrations').doc(log.registrationId).get()
  if (!regSnap.exists) {
    // Release the claim so the entry stays retryable rather than stuck 'queued'.
    await updateEmailLog(logId, 'failed', { error: 'Registration not found' })
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const reg = regSnap.data() as RegistrationDocument

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
    : (typeof physical?.name   === 'string' ? physical.name   : '')
  const venueCity = venueType !== 'online'
    ? (typeof physical?.city   === 'string' ? physical.city   : '')
    : ''

  const baseUrl  = process.env.NEXT_PUBLIC_APP_URL ?? ''
  const pdfToken = signTicketToken(log.registrationId)
  const pdfUrl   = `${baseUrl}/api/tickets/${log.registrationId}/pdf${pdfToken ? `?token=${encodeURIComponent(pdfToken)}` : ''}`

  // ── 7. Re-send (templateKey already validated during the claim) ────────────
  let emailStatus: 'sent' | 'failed' = 'failed'
  let errorMsg: string | undefined
  let providerMessageId: string | undefined

  try {
    const result = await notificationEngine.send(NotificationType.REGISTRATION_CONFIRMATION, {
      to:             reg.attendee.email,
      attendeeName:   reg.attendee.name,
      eventName:      reg.eventName,
      eventDate:      fmtEmailDate(startDate) || startDate,
      eventTime:      startTime  || undefined,
      venueName:      venueName  || undefined,
      venueCity:      venueCity  || undefined,
      ticketCode:     reg.ticketCode,
      passName:       reg.passName,
      registrationId: log.registrationId,
      ticketPageUrl:  `${baseUrl}/tickets/${log.registrationId}`,
      pdfDownloadUrl: pdfUrl,
    })
    emailStatus         = result.success ? 'sent' : 'failed'
    providerMessageId   = result.messageId
    if (!result.success) errorMsg = result.error
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : 'Unknown error'
    console.error('[email-logs/retry] send error:', err)
  }

  // ── 8. Update log entry ────────────────────────────────────────────────────
  await updateEmailLog(logId, emailStatus === 'sent' ? 'sent' : 'failed', {
    providerMessageId,
    error: errorMsg,
  })

  // ── 9. Update registration emailStatus ────────────────────────────────────
  adminDb.collection('registrations').doc(log.registrationId).update({
    emailStatus,
    ...(emailStatus === 'sent' ? { emailSentAt: FieldValue.serverTimestamp() } : {}),
  }).catch(e => console.error('[email-logs/retry] Failed to persist emailStatus:', e))

  if (emailStatus === 'sent') {
    return NextResponse.json({ success: true })
  }
  return NextResponse.json(
    { success: false, error: errorMsg ?? 'Email delivery failed' },
    { status: 502 },
  )
}

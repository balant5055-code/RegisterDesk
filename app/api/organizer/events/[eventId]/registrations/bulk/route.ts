// POST /api/organizer/events/[eventId]/registrations/bulk
//
// Bulk operations on up to 200 registrations at once.
// Body: { action: BulkAction, registrationIds: string[] }
//
// check_in    — marks registrations as checked in; updates checkedInCount
// cancel      — cancels registrations; decrements totalCount for confirmed ones
// restore     — restores cancelled registrations to confirmed; increments totalCount
// resend_email — resends ticket email to each attendee

import { NextRequest, NextResponse }      from 'next/server'
import { FieldValue }                      from 'firebase-admin/firestore'
import { adminDb, adminAuth }              from '@/lib/firebase/admin'
import { signTicketToken }                 from '@/lib/tickets/generate'
import { getEmailProvider, fmtEmailDate }  from '@/lib/email'
import type { RegistrationDocument, AuditAction } from '@/lib/registrations/types'

// ─── Response types ───────────────────────────────────────────────────────────

export interface BulkActionResult {
  id:      string
  success: boolean
  reason?: string
}

export interface BulkActionResponse {
  success:   boolean
  processed: number
  succeeded: number
  failed:    number
  error?:    string
  results:   BulkActionResult[]
}

type BulkAction = 'check_in' | 'cancel' | 'restore' | 'resend_email'

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<BulkActionResponse>> {
  const empty = (error: string, status: number): NextResponse<BulkActionResponse> =>
    NextResponse.json({ success: false, processed: 0, succeeded: 0, failed: 0, error, results: [] }, { status })

  // ── 1. Auth ──────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return empty('Unauthorized', 401)

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return empty('Invalid or expired token', 401)
  }

  // ── 2. Parse body ────────────────────────────────────────────────────────
  let action: BulkAction
  let registrationIds: string[]
  try {
    const body       = await req.json() as { action?: unknown; registrationIds?: unknown }
    const validActs: BulkAction[] = ['check_in', 'cancel', 'restore', 'resend_email']
    if (!validActs.includes(body.action as BulkAction)) return empty('Invalid action', 400)
    action = body.action as BulkAction
    if (!Array.isArray(body.registrationIds) || body.registrationIds.length === 0) {
      return empty('registrationIds must be a non-empty array', 400)
    }
    registrationIds = (body.registrationIds as unknown[])
      .slice(0, 200)
      .filter((id): id is string => typeof id === 'string')
  } catch {
    return empty('Invalid request body', 400)
  }

  // ── 3. Verify event ownership ────────────────────────────────────────────
  const { eventId } = await context.params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return empty('Event not found', 404)

  // ── 4. Load all registrations ─────────────────────────────────────────────
  const regSnaps = await Promise.all(
    registrationIds.map(id => adminDb.collection('registrations').doc(id).get()),
  )

  // ── 5. Filter by ownership + eligibility ─────────────────────────────────
  const eligible: Array<{ id: string; data: RegistrationDocument }> = []
  const results:  BulkActionResult[] = []

  for (let i = 0; i < registrationIds.length; i++) {
    const id   = registrationIds[i]
    const snap = regSnaps[i]
    if (!snap.exists) { results.push({ id, success: false, reason: 'Not found' }); continue }
    const reg = snap.data() as RegistrationDocument
    if (reg.organizerUid !== uid) { results.push({ id, success: false, reason: 'Forbidden' }); continue }
    if (action === 'check_in' && reg.checkedIn)              { results.push({ id, success: false, reason: 'Already checked in' }); continue }
    if (action === 'check_in' && reg.status === 'cancelled') { results.push({ id, success: false, reason: 'Registration is cancelled' }); continue }
    if (action === 'cancel'   && reg.status === 'cancelled') { results.push({ id, success: false, reason: 'Already cancelled' }); continue }
    if (action === 'restore'  && reg.status !== 'cancelled') { results.push({ id, success: false, reason: 'Not cancelled' }); continue }
    if (action === 'resend_email' && reg.status === 'cancelled') { results.push({ id, success: false, reason: 'Registration is cancelled' }); continue }
    eligible.push({ id, data: reg })
  }

  if (eligible.length === 0) {
    const failed = results.filter(r => !r.success).length
    return NextResponse.json({ success: true, processed: registrationIds.length, succeeded: 0, failed, results })
  }

  // ── 6. Execute ────────────────────────────────────────────────────────────

  // ── Resend email (async per-item) ─────────────────────────────────────────
  if (action === 'resend_email') {
    const provider = getEmailProvider()
    if (!provider) {
      const errResults = registrationIds.map(id => ({ id, success: false, reason: 'Email provider not configured' }))
      return NextResponse.json({ success: false, processed: registrationIds.length, succeeded: 0, failed: registrationIds.length, error: 'Email provider not configured', results: errResults }, { status: 503 })
    }

    const draft   = draftSnap.data() as Record<string, unknown>
    const rawDet  = draft.eventDetails as Record<string, unknown> | null
    const rawSeo  = rawDet?.seo      as Record<string, unknown> | null
    const sched   = rawDet?.schedule as Record<string, unknown> | null
    const startDate = typeof sched?.startDate === 'string' ? sched.startDate : ''
    const startTime = typeof sched?.startTime === 'string' ? sched.startTime : ''
    const venueRaw  = rawDet?.venue  as Record<string, unknown> | null
    const venueType = typeof venueRaw?.type === 'string' ? venueRaw.type : ''
    const physical  = venueRaw?.physical as Record<string, unknown> | null
    const online    = venueRaw?.online   as Record<string, unknown> | null
    const venueName = venueType === 'online'
      ? (typeof online?.platform === 'string' ? online.platform : 'Online')
      : (typeof physical?.name   === 'string' ? physical.name   : '')
    const venueCity = venueType !== 'online'
      ? (typeof physical?.city   === 'string' ? physical.city   : '')
      : ''
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
    void rawSeo  // slug not needed for email sending

    const emailResults = await Promise.allSettled(
      eligible.map(async ({ id, data: reg }) => {
        const pdfToken = signTicketToken(id)
        const pdfUrl   = `${baseUrl}/api/tickets/${id}/pdf${pdfToken ? `?token=${encodeURIComponent(pdfToken)}` : ''}`
        const result   = await provider.sendTicketEmail({
          to:             reg.attendee.email,
          attendeeName:   reg.attendee.name,
          eventName:      reg.eventName,
          eventDate:      fmtEmailDate(startDate) || startDate,
          eventTime:      startTime  || undefined,
          venueName:      venueName  || undefined,
          venueCity:      venueCity  || undefined,
          ticketCode:     reg.ticketCode,
          passName:       reg.passName,
          registrationId: id,
          ticketPageUrl:  `${baseUrl}/tickets/${id}`,
          pdfDownloadUrl: pdfUrl,
        })
        if (!result.success) throw new Error(result.error ?? 'Email delivery failed')
        adminDb.collection('registrations').doc(id).update({
          emailStatus: 'sent', emailSentAt: FieldValue.serverTimestamp(),
        }).catch(err => console.error(`[bulk] emailStatus update error for ${id}:`, err))
      }),
    )

    let succeeded = 0
    emailResults.forEach((r, i) => {
      const { id } = eligible[i]
      if (r.status === 'fulfilled') { results.push({ id, success: true }); succeeded++ }
      else results.push({ id, success: false, reason: r.reason instanceof Error ? r.reason.message : 'Failed' })
    })

    const succeededEmailIds = eligible.filter((_, i) => emailResults[i].status === 'fulfilled').map(e => e.id)
    if (succeededEmailIds.length > 0) void writeBulkAudit(succeededEmailIds, 'email_resent', uid)

    const failed = results.filter(r => !r.success).length
    return NextResponse.json({ success: true, processed: registrationIds.length, succeeded, failed, results })
  }

  // ── Batch write actions ───────────────────────────────────────────────────
  const batch = adminDb.batch()
  const now   = FieldValue.serverTimestamp()
  let confirmedToCancelledCount = 0

  for (const { id, data: reg } of eligible) {
    const ref = adminDb.collection('registrations').doc(id)
    if (action === 'check_in') {
      batch.update(ref, {
        checkedIn: true, checkedInAt: now, checkedInBy: uid,
        checkedInSource: 'bulk', updatedAt: now,
      })
    } else if (action === 'cancel') {
      batch.update(ref, { status: 'cancelled', updatedAt: now })
      if (reg.status === 'confirmed') confirmedToCancelledCount++
    } else if (action === 'restore') {
      batch.update(ref, { status: 'confirmed', updatedAt: now })
    }
  }

  try {
    await batch.commit()
  } catch (err) {
    console.error('[bulk] batch commit error:', err)
    return NextResponse.json({ success: false, processed: registrationIds.length, succeeded: 0, failed: registrationIds.length, error: 'Database error. Please try again.', results: [] }, { status: 500 })
  }

  // ── Counter updates (atomic increments outside batch) ──────────────────
  const eventSlug = eligible[0].data.eventSlug
  if (action === 'check_in') {
    adminDb.collection('registrationCounters').doc(eventSlug)
      .set({ checkedInCount: FieldValue.increment(eligible.length) }, { merge: true })
      .catch(err => console.error('[bulk] checkedInCount update error:', err))
  } else if (action === 'cancel' && confirmedToCancelledCount > 0) {
    adminDb.collection('registrationCounters').doc(eventSlug)
      .update({ totalCount: FieldValue.increment(-confirmedToCancelledCount) })
      .catch(err => console.error('[bulk] totalCount decrement error:', err))
  } else if (action === 'restore') {
    adminDb.collection('registrationCounters').doc(eventSlug)
      .update({ totalCount: FieldValue.increment(eligible.length) })
      .catch(err => console.error('[bulk] totalCount increment error:', err))
  }

  // ── Audit (fire-and-forget) ───────────────────────────────────────────────
  const auditAction: AuditAction = action === 'check_in' ? 'checked_in' : action === 'cancel' ? 'cancelled' : 'restored'
  void writeBulkAudit(eligible.map(e => e.id), auditAction, uid)

  for (const { id } of eligible) results.push({ id, success: true })
  const failed = results.filter(r => !r.success).length
  return NextResponse.json({
    success: true, processed: registrationIds.length,
    succeeded: eligible.length, failed, results,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function writeBulkAudit(ids: string[], action: AuditAction, uid: string): Promise<void> {
  try {
    const auditBatch = adminDb.batch()
    const ts = FieldValue.serverTimestamp()
    for (const id of ids) {
      const ref = adminDb.collection('registrations').doc(id).collection('auditLog').doc()
      auditBatch.set(ref, { id: ref.id, action, actor: uid, actorType: 'organizer', timestamp: ts })
    }
    await auditBatch.commit()
  } catch (err) {
    console.error('[bulk] audit batch error:', err)
  }
}

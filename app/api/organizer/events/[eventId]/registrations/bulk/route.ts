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
import { releaseRegistrationSessions, restoreRegistrationSessions } from '@/lib/sessions/allocation'
import { captureError }                    from '@/lib/monitoring/sentry'
import { FieldValue }                      from 'firebase-admin/firestore'
import { adminDb }              from '@/lib/firebase/admin'
import { authorizeWorkspace }              from '@/lib/team/workspace'
import { signTicketToken }                 from '@/lib/tickets/generate'
import { fmtEmailDate }                     from '@/lib/email'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
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
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return empty(authz.error ?? 'Unauthorized', authz.status)
  const uid       = authz.workspaceUid    // authorization / ownership scope
  const callerUid = authz.callerUid       // attribution: the actual operator

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
    if (action === 'check_in' && reg.checkedIn)                        { results.push({ id, success: false, reason: 'Already checked in' }); continue }
    if (action === 'check_in' && reg.status === 'cancelled')           { results.push({ id, success: false, reason: 'Registration is cancelled' }); continue }
    if (action === 'check_in' && reg.status === 'pending')             { results.push({ id, success: false, reason: 'Registration is pending approval' }); continue }
    if (action === 'check_in' && reg.paymentStatus === 'refunded')     { results.push({ id, success: false, reason: 'Registration has been refunded' }); continue }
    if (action === 'cancel'   && reg.status === 'cancelled')           { results.push({ id, success: false, reason: 'Already cancelled' }); continue }
    if (action === 'restore'  && reg.status !== 'cancelled')           { results.push({ id, success: false, reason: 'Not cancelled' }); continue }
    if (action === 'resend_email' && reg.status === 'cancelled')       { results.push({ id, success: false, reason: 'Registration is cancelled' }); continue }
    if (action === 'resend_email' && reg.status === 'rejected')        { results.push({ id, success: false, reason: 'Registration has been rejected' }); continue }
    if (action === 'resend_email' && reg.paymentStatus === 'refunded') { results.push({ id, success: false, reason: 'Registration has been refunded' }); continue }
    eligible.push({ id, data: reg })
  }

  if (eligible.length === 0) {
    const failed = results.filter(r => !r.success).length
    return NextResponse.json({ success: true, processed: registrationIds.length, succeeded: 0, failed, results })
  }

  // ── 5b. P1-C: Best-effort capacity pre-check for bulk restore ─────────────
  // Loads live event + counter docs, then walks eligible items in order,
  // accumulating in-batch additions to detect per-event and per-pass overflow
  // before the batch write.  Not transactionally safe (small TOCTOU window)
  // but closes the same gap that individual restoreRegistration() closes.
  let toProcess = eligible
  if (action === 'restore') {
    const uniqueSlugs = [...new Set(eligible.map(e => e.data.eventSlug))]
    const evtSnaps = await Promise.all(uniqueSlugs.map(s => adminDb.collection('events').doc(s).get()))
    const ctrSnaps = await Promise.all(uniqueSlugs.map(s => adminDb.collection('registrationCounters').doc(s).get()))
    const evtMap = new Map<string, Record<string, unknown>>()
    const ctrMap = new Map<string, { totalCount?: number; passCounts?: Record<string, number> }>()
    for (let ci = 0; ci < uniqueSlugs.length; ci++) {
      const slug = uniqueSlugs[ci]!
      const evtSnap = evtSnaps[ci]!
      const ctrSnap = ctrSnaps[ci]!
      if (evtSnap.exists) evtMap.set(slug, evtSnap.data() as Record<string, unknown>)
      if (ctrSnap.exists) ctrMap.set(slug, ctrSnap.data() as { totalCount?: number; passCounts?: Record<string, number> })
    }
    const batchTotals = new Map<string, number>()
    const batchPasses = new Map<string, number>()
    const capacityPassed: typeof eligible = []
    for (const item of eligible) {
      const { id, data: reg } = item
      const evt = evtMap.get(reg.eventSlug)
      const ctr = ctrMap.get(reg.eventSlug)
      const eventCapacity = (evt?.totalCapacity as number | null | undefined) ?? null
      const currentTotal  = (ctr?.totalCount ?? 0) + (batchTotals.get(reg.eventSlug) ?? 0)
      if (eventCapacity !== null && currentTotal >= eventCapacity) {
        results.push({ id, success: false, reason: 'Event is at capacity' })
        continue
      }
      const rawPricing = evt?.pricing as Record<string, unknown> | undefined
      const rawPasses  = Array.isArray(rawPricing?.passes) ? (rawPricing!.passes as Record<string, unknown>[]) : []
      const livePass   = rawPasses.find(p => p.id === reg.passId)
      const passCapacity = livePass?.unlimited === true ? null
        : typeof livePass?.quantity === 'number' ? livePass.quantity : null
      const passKey    = `${reg.eventSlug}:${reg.passId}`
      const currentPass = ((ctr?.passCounts ?? {})[reg.passId] ?? 0) + (batchPasses.get(passKey) ?? 0)
      if (passCapacity !== null && currentPass >= passCapacity) {
        results.push({ id, success: false, reason: 'Pass is at capacity' })
        continue
      }
      capacityPassed.push(item)
      batchTotals.set(reg.eventSlug, (batchTotals.get(reg.eventSlug) ?? 0) + 1)
      batchPasses.set(passKey, (batchPasses.get(passKey) ?? 0) + 1)
    }
    toProcess = capacityPassed
    if (toProcess.length === 0) {
      const failed = results.filter(r => !r.success).length
      return NextResponse.json({ success: true, processed: registrationIds.length, succeeded: 0, failed, results })
    }
  }

  // ── 6. Execute ────────────────────────────────────────────────────────────

  // ── Resend email (async per-item) ─────────────────────────────────────────
  if (action === 'resend_email') {
    if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
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
        const result   = await notificationEngine.send(NotificationType.TICKET_RESENT, {
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
  const confirmedCancels: { eventSlug: string; passId: string }[] = []

  for (const { id, data: reg } of toProcess) {
    const ref = adminDb.collection('registrations').doc(id)
    if (action === 'check_in') {
      batch.update(ref, {
        checkedIn: true, checkedInAt: now, checkedInBy: callerUid,
        checkedInWorkspaceUid: uid, checkedInSource: 'bulk', updatedAt: now,
      })
    } else if (action === 'cancel') {
      batch.update(ref, { status: 'cancelled', updatedAt: now })
      if (reg.status === 'confirmed') confirmedCancels.push({ eventSlug: reg.eventSlug, passId: reg.passId })
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
  // All three counter cases group by eventSlug so multi-event batches are
  // handled correctly and passCounts stays in sync with totalCount.
  if (action === 'check_in') {
    const byEvent = new Map<string, number>()
    for (const { data: reg } of toProcess) byEvent.set(reg.eventSlug, (byEvent.get(reg.eventSlug) ?? 0) + 1)
    for (const [slug, count] of byEvent) {
      adminDb.collection('registrationCounters').doc(slug)
        .set({ checkedInCount: FieldValue.increment(count) }, { merge: true })
        .catch(err => console.error('[bulk] checkedInCount update error:', err))
    }
  } else if (action === 'cancel' && confirmedCancels.length > 0) {
    const byEvent = new Map<string, { total: number; passes: Record<string, number> }>()
    for (const { eventSlug: slug, passId } of confirmedCancels) {
      const entry = byEvent.get(slug) ?? { total: 0, passes: {} }
      entry.total++
      entry.passes[passId] = (entry.passes[passId] ?? 0) + 1
      byEvent.set(slug, entry)
    }
    for (const [slug, { total, passes }] of byEvent) {
      const update: Record<string, unknown> = {
        totalCount: FieldValue.increment(-total),
        updatedAt:  FieldValue.serverTimestamp(),
      }
      for (const [passId, count] of Object.entries(passes)) {
        update[`passCounts.${passId}`] = FieldValue.increment(-count)
      }
      adminDb.collection('registrationCounters').doc(slug)
        .update(update)
        .catch(err => console.error('[bulk] counter decrement error:', err))
    }
  } else if (action === 'restore') {
    const byEvent = new Map<string, { total: number; passes: Record<string, number> }>()
    for (const { data: reg } of toProcess) {
      const entry = byEvent.get(reg.eventSlug) ?? { total: 0, passes: {} }
      entry.total++
      entry.passes[reg.passId] = (entry.passes[reg.passId] ?? 0) + 1
      byEvent.set(reg.eventSlug, entry)
    }
    for (const [slug, { total, passes }] of byEvent) {
      const update: Record<string, unknown> = {
        totalCount: FieldValue.increment(total),
        updatedAt:  FieldValue.serverTimestamp(),
      }
      for (const [passId, count] of Object.entries(passes)) {
        update[`passCounts.${passId}`] = FieldValue.increment(count)
      }
      adminDb.collection('registrationCounters').doc(slug)
        .set(update, { merge: true })
        .catch(err => console.error('[bulk] counter increment error:', err))
    }
  }

  // ── P1-1: session-allocation sync (post-commit, idempotent; reconciliation
  //    cron is the backstop for any that fail) ────────────────────────────────
  if (action === 'cancel') {
    for (const { id } of toProcess) {
      void releaseRegistrationSessions(id).catch(err => captureError(err, { scope: 'session_reconciliation', detail: 'bulk cancel release failed', registrationId: id }))
    }
  } else if (action === 'restore') {
    for (const { id } of toProcess) {
      void restoreRegistrationSessions(id).catch(err => captureError(err, { scope: 'session_reconciliation', detail: 'bulk restore failed (may be SESSION_FULL)', registrationId: id }))
    }
  }

  // ── Audit (fire-and-forget) ───────────────────────────────────────────────
  const auditAction: AuditAction = action === 'check_in' ? 'checked_in' : action === 'cancel' ? 'cancelled' : 'restored'
  void writeBulkAudit(toProcess.map(e => e.id), auditAction, uid)

  for (const { id } of toProcess) results.push({ id, success: true })
  const failed = results.filter(r => !r.success).length
  return NextResponse.json({
    success: true, processed: registrationIds.length,
    succeeded: toProcess.length, failed, results,
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

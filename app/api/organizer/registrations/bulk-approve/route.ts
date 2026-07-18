// POST /api/organizer/registrations/bulk-approve
//
// Bulk-approves up to 200 pending registrations in one request.
// Body: { registrationIds: string[] }
//
// Only registrations with status === 'pending' belonging to the authenticated
// organizer are processed. Non-pending or foreign registrations are skipped
// with a per-item reason, never causing the whole batch to fail.
//
// Side-effects (all fire-and-forget — never block the response):
//   - registrationCounters.totalCount incremented by succeeded count
//   - Confirmation email sent to each approved attendee
//   - Audit entry written for each approved registration

import { NextRequest, NextResponse }     from 'next/server'
import { FieldValue }                     from 'firebase-admin/firestore'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace }             from '@/lib/team/workspace'
import { signTicketToken }                from '@/lib/tickets/generate'
import { fmtEmailDate } from '@/lib/email'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { writeEmailLog }                  from '@/lib/email-logs/write'
import {
  approveRegistration,
  RegistrationNotFoundError, UnauthorizedCancellationError,
  NotPendingError, CapacityBlocksApprovalError,
} from '@/lib/firebase/firestore/registrations'
import type { RegistrationDocument, AuditAction } from '@/lib/registrations/types'

// Sequential per-id approval keeps counter contention off a single event's
// counter doc; ≤200 admin-triggered approvals fit comfortably in the budget.
export const maxDuration = 60

// ─── Response type ────────────────────────────────────────────────────────────

export interface BulkApproveResponse {
  success:   boolean
  processed: number
  succeeded: number
  failed:    number
  error?:    string
  results:   { id: string; success: boolean; reason?: string }[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<BulkApproveResponse>> {
  const empty = (error: string, status: number): NextResponse<BulkApproveResponse> =>
    NextResponse.json({ success: false, processed: 0, succeeded: 0, failed: 0, error, results: [] }, { status })

  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return empty(authz.error ?? 'Unauthorized', authz.status)
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

  // ── 2. Parse body ──────────────────────────────────────────────────────────
  let registrationIds: string[]
  try {
    const body = await req.json() as { registrationIds?: unknown }
    if (!Array.isArray(body.registrationIds) || body.registrationIds.length === 0) {
      return empty('registrationIds must be a non-empty array', 400)
    }
    // De-dup BEFORE the cap so a duplicated id can't be processed twice.
    registrationIds = [...new Set(
      (body.registrationIds as unknown[]).filter((id): id is string => typeof id === 'string'),
    )].slice(0, 200)
  } catch {
    return empty('Invalid request body', 400)
  }

  // ── 3. Load registrations (for the confirmation-email payload) ─────────────
  const regSnaps = await Promise.all(
    registrationIds.map(id => adminDb.collection('registrations').doc(id).get()),
  )
  const regById = new Map<string, RegistrationDocument>()
  regSnaps.forEach((snap, i) => {
    if (snap.exists) regById.set(registrationIds[i], snap.data() as RegistrationDocument)
  })

  // ── 4. Approve each via the canonical transactional service ────────────────
  // approveRegistration enforces ownership + status==='pending' + EVENT/PASS
  // CAPACITY (manual-approval doesn't reserve at creation) and maintains the
  // counter (totalCount/passCounts up, pendingCount down) atomically + exactly
  // once. Reusing it keeps bulk-approve identical to single-approve — the prior
  // hand-rolled batch skipped the capacity guard and pendingCount, and could
  // double-count. Sequential to avoid contending one event's counter doc.
  const eligible: Array<{ id: string; data: RegistrationDocument }> = []
  const results:  { id: string; success: boolean; reason?: string }[] = []

  for (const id of registrationIds) {
    try {
      await approveRegistration(id, uid)
      const data = regById.get(id)
      if (data) eligible.push({ id, data })
      results.push({ id, success: true })
    } catch (err) {
      let reason = 'Approval failed'
      if      (err instanceof RegistrationNotFoundError)     reason = 'Not found'
      else if (err instanceof UnauthorizedCancellationError) reason = 'Forbidden'
      else if (err instanceof NotPendingError)               reason = 'Not pending'
      else if (err instanceof CapacityBlocksApprovalError)   reason = err.reason === 'PASS_CAPACITY_FULL' ? 'Pass full' : 'Event full'
      else console.error('[bulk-approve] approve error:', { id, err })
      results.push({ id, success: false, reason })
    }
  }

  if (eligible.length === 0) {
    const failed = results.filter(r => !r.success).length
    return NextResponse.json({ success: true, processed: registrationIds.length, succeeded: 0, failed, results })
  }

  // ── 5. Confirmation emails (fire-and-forget) ───────────────────────────────
  void sendBulkApprovalEmails(eligible)

  // ── 6. Audit (fire-and-forget) ─────────────────────────────────────────────
  void writeBulkAudit(eligible.map(e => e.id), 'approved', callerUid, uid)

  // (per-item results were already recorded in the approval loop above)
  const failed = results.filter(r => !r.success).length
  return NextResponse.json({
    success:   true,
    processed: registrationIds.length,
    succeeded: eligible.length,
    failed,
    results,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function sendBulkApprovalEmails(
  eligible: Array<{ id: string; data: RegistrationDocument }>,
): Promise<void> {
  if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) return

  // Fetch distinct event docs in one round-trip
  const slugs = [...new Set(eligible.map(e => e.data.eventSlug))]
  const eventSnaps = await Promise.all(
    slugs.map(slug => adminDb.collection('events').doc(slug).get()),
  )
  const eventMap = new Map<string, Record<string, unknown>>()
  for (const snap of eventSnaps) {
    if (snap.exists) eventMap.set(snap.id, snap.data() as Record<string, unknown>)
  }

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''

  await Promise.allSettled(eligible.map(async ({ id, data: reg }) => {
    const event = eventMap.get(reg.eventSlug)
    if (!event) return

    const rawDetails  = event.eventDetails as Record<string, unknown> | null
    const rawSchedule = rawDetails?.schedule as Record<string, unknown> | null
    const rawVenue    = rawDetails?.venue    as Record<string, unknown> | null

    const startDate = typeof rawSchedule?.startDate === 'string' ? rawSchedule.startDate : ''
    const startTime = typeof rawSchedule?.startTime === 'string' ? rawSchedule.startTime : ''
    const venueType = typeof rawVenue?.type === 'string' ? rawVenue.type : ''
    const physical  = rawVenue?.physical as Record<string, unknown> | null
    const online    = rawVenue?.online   as Record<string, unknown> | null
    const venueName = venueType === 'online'
      ? (typeof online?.platform === 'string' ? online.platform : 'Online')
      : (typeof physical?.name   === 'string' ? physical.name   : '')
    const venueCity = venueType !== 'online'
      ? (typeof physical?.city   === 'string' ? physical.city   : '')
      : ''

    const pdfToken = signTicketToken(id)
    const pdfUrl   = `${baseUrl}/api/tickets/${id}/pdf${pdfToken ? `?token=${encodeURIComponent(pdfToken)}` : ''}`

    let emailStatus: 'sent' | 'failed' = 'failed'
    try {
      const result = await notificationEngine.send(NotificationType.REGISTRATION_APPROVED, {
        to:             reg.attendee.email,
        attendeeName:   reg.attendee.name,
        eventName:      reg.eventName,
        eventDate:      fmtEmailDate(startDate) || startDate,
        eventTime:      startTime   || undefined,
        venueName:      venueName   || undefined,
        venueCity:      venueCity   || undefined,
        ticketCode:     reg.ticketCode,
        passName:       reg.passName,
        registrationId: id,
        ticketPageUrl:  `${baseUrl}/tickets/${id}`,
        pdfDownloadUrl: pdfUrl,
      })
      emailStatus = result.success ? 'sent' : 'failed'
      if (!result.success) {
        console.error(`[bulk-approve-email] Failed for ${id}:`, result.error)
      }
    } catch (err) {
      console.error(`[bulk-approve-email] Unexpected error for ${id}:`, err)
    }

    adminDb.collection('registrations').doc(id).update({
      emailStatus,
      ...(emailStatus === 'sent' ? { emailSentAt: FieldValue.serverTimestamp() } : {}),
    }).catch(e => console.error('[bulk-approve-email] Failed to persist emailStatus:', e))

    void writeEmailLog({
      organizerUid:   reg.organizerUid,
      eventId:        reg.eventSlug,
      eventSlug:      reg.eventSlug,
      eventName:      reg.eventName,
      templateKey:    'registration_approved',
      recipientEmail: reg.attendee.email,
      recipientName:  reg.attendee.name,
      subject:        `Your registration for ${reg.eventName} has been approved`,
      status:         emailStatus === 'sent' ? 'sent' : 'failed',
      provider:       'ses',
      registrationId: id,
    })
  }))
}

async function writeBulkAudit(ids: string[], action: AuditAction, callerUid: string, uid: string): Promise<void> {
  try {
    const auditBatch = adminDb.batch()
    const ts = FieldValue.serverTimestamp()
    for (const id of ids) {
      const ref = adminDb.collection('registrations').doc(id).collection('auditLog').doc()
      auditBatch.set(ref, { id: ref.id, action, actor: callerUid, actorType: 'organizer', workspaceUid: uid, timestamp: ts })
    }
    await auditBatch.commit()
  } catch (err) {
    console.error('[bulk-approve] audit batch error:', err)
  }
}

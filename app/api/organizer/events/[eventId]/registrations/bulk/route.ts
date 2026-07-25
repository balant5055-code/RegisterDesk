// POST /api/organizer/events/[eventId]/registrations/bulk
//
// Bulk operations on up to 200 registrations at once.
// Body: { action: BulkAction, registrationIds: string[] }
//
// check_in     — checks registrations in (attendance shard + passCheckedInCounts)
// cancel       — cancels registrations (counters, revenue, claims, sessions)
// restore      — restores cancelled registrations (capacity-checked)
// resend_email — resends the ticket email to each attendee
//
// RD-REGISTRATIONS-01 Phase 1 (H1): every mutating action is ORCHESTRATION ONLY —
// it delegates to the certified canonical transactional helper (checkInRegistration /
// cancelRegistration / restoreRegistration), exactly as bulk-approve / bulk-reject do.
// The route no longer hand-rolls registration writes or counter math, so the helpers'
// ownership, lifecycle validation, idempotency, capacity checks, attendance shards,
// passCheckedInCounts, revenuePaise, pending/cancelled counters, registrationClaims
// cleanup and session release all apply — atomically and exactly once per item. This
// closes H1 and M1–M4 by construction. (resend_email keeps its own path — Phase 2.)

import { NextRequest, NextResponse }      from 'next/server'
import { FieldValue }                      from 'firebase-admin/firestore'
import { adminDb }                         from '@/lib/firebase/admin'
import { authorizeWorkspace }              from '@/lib/team/workspace'
import { notificationEngine, NotificationChannel } from '@/lib/notifications'
import { resendRegistrationTicketEmail }   from '@/lib/registrations/resendTicketEmail'
import {
  cancelRegistration, restoreRegistration, checkInRegistration,
  RegistrationNotFoundError, UnauthorizedCancellationError,
  AlreadyCancelledError, NotCancelledError, CapacityBlocksRestoreError, CheckInNotAllowedError,
} from '@/lib/firebase/firestore/registrations'
import type { RegistrationDocument, AuditAction } from '@/lib/registrations/types'

// Sequential per-id delegation keeps counter contention off a single event's counter
// doc; ≤200 admin-triggered operations fit comfortably in the budget (matches bulk-approve).
export const maxDuration = 60

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
    // De-duplicate BEFORE slicing so a duplicated id is processed once (the canonical
    // helpers are idempotent, but de-dup also makes the 200 cap count real ids).
    registrationIds = [...new Set(
      (body.registrationIds as unknown[]).filter((id): id is string => typeof id === 'string'),
    )].slice(0, 200)
  } catch {
    return empty('Invalid request body', 400)
  }

  // ── 3. Verify event ownership (path event must belong to the caller) ──────
  const { eventId } = await context.params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return empty('Event not found', 404)

  // ── 4. resend_email — orchestration ONLY (RD-REGISTRATIONS-01 Phase 4 / M5). Each send
  //      delegates to the shared resendRegistrationTicketEmail service (the ONE resend path,
  //      also used by the single-item + admin routes), which applies the eligibility guards,
  //      fetches EACH registration's OWN event details (fixing the former cross-event mixup),
  //      sends via the notification engine and persists emailStatus. The route only resolves
  //      ownership and aggregates results. ──
  if (action === 'resend_email') {
    if (!notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
      const errResults = registrationIds.map(id => ({ id, success: false, reason: 'Email provider not configured' }))
      return NextResponse.json({ success: false, processed: registrationIds.length, succeeded: 0, failed: registrationIds.length, error: 'Email provider not configured', results: errResults }, { status: 503 })
    }

    // Ownership filter (the shared helper handles eligibility + send + persistence).
    const regSnaps = await Promise.all(
      registrationIds.map(id => adminDb.collection('registrations').doc(id).get()),
    )
    const results: BulkActionResult[] = []
    const owned:   string[] = []
    for (let i = 0; i < registrationIds.length; i++) {
      const id   = registrationIds[i]
      const snap = regSnaps[i]
      if (!snap.exists) { results.push({ id, success: false, reason: 'Not found' }); continue }
      const reg = snap.data() as RegistrationDocument
      if (reg.organizerUid !== uid) { results.push({ id, success: false, reason: 'Forbidden' }); continue }
      owned.push(id)
    }

    const sendResults = await Promise.all(owned.map(id => resendRegistrationTicketEmail(id)))
    const succeededIds: string[] = []
    owned.forEach((id, i) => {
      const r = sendResults[i]
      if (r.ok) { results.push({ id, success: true }); succeededIds.push(id) }
      else       results.push({ id, success: false, reason: r.error })
    })

    if (succeededIds.length > 0) void writeBulkAudit(succeededIds, 'email_resent', uid)

    const failed = results.filter(r => !r.success).length
    return NextResponse.json({ success: true, processed: registrationIds.length, succeeded: succeededIds.length, failed, results })
  }

  // ── 5. check_in / cancel / restore — orchestration ONLY (RD-REGISTRATIONS-01
  //      Phase 1 / H1). Delegate each id to the canonical transactional helper and
  //      capture per-item success/failure, exactly like bulk-approve / bulk-reject.
  //      Each helper enforces ownership + lifecycle + capacity + idempotency and
  //      maintains every counter / shard / claim / session atomically. Sequential
  //      to avoid contending one event's counter doc. ──
  const results: BulkActionResult[] = []
  const succeededIds: string[] = []

  for (const id of registrationIds) {
    try {
      if (action === 'check_in') {
        const outcome = await checkInRegistration(id, uid, { byUid: callerUid, workspaceUid: uid, source: 'bulk' })
        if (outcome.status === 'already_checked_in') {
          results.push({ id, success: false, reason: 'Already checked in' })
          continue
        }
      } else if (action === 'cancel') {
        await cancelRegistration(id, uid)
      } else { // restore
        await restoreRegistration(id, uid)
      }
      results.push({ id, success: true })
      succeededIds.push(id)
    } catch (err) {
      results.push({ id, success: false, reason: mapActionError(action, err) })
    }
  }

  // ── Audit (fire-and-forget) — only the ids that actually transitioned. ──────
  if (succeededIds.length > 0) {
    const auditAction: AuditAction = action === 'check_in' ? 'checked_in' : action === 'cancel' ? 'cancelled' : 'restored'
    void writeBulkAudit(succeededIds, auditAction, uid)
  }

  const failed = results.filter(r => !r.success).length
  return NextResponse.json({
    success:   true,
    processed: registrationIds.length,
    succeeded: succeededIds.length,
    failed,
    results,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Maps a canonical-helper error to the same per-item reason string the route
// returned before, so the client-facing result shape is unchanged.
function mapActionError(action: Exclude<BulkAction, 'resend_email'>, err: unknown): string {
  if (err instanceof RegistrationNotFoundError)     return 'Not found'
  if (err instanceof UnauthorizedCancellationError) return 'Forbidden'
  if (action === 'cancel') {
    if (err instanceof AlreadyCancelledError) return 'Already cancelled'
  } else if (action === 'restore') {
    if (err instanceof NotCancelledError)          return 'Not cancelled'
    if (err instanceof CapacityBlocksRestoreError) return err.reason === 'PASS_CAPACITY_FULL' ? 'Pass is at capacity' : 'Event is at capacity'
  } else { // check_in
    if (err instanceof CheckInNotAllowedError) {
      switch (err.reason) {
        case 'CANCELLED': return 'Registration is cancelled'
        case 'PENDING':   return 'Registration is pending approval'
        case 'REJECTED':  return 'Registration has been rejected'
        case 'REFUNDED':  return 'Registration has been refunded'
      }
    }
  }
  console.error('[bulk] action error:', { action, err })
  return action === 'check_in' ? 'Check-in failed' : action === 'cancel' ? 'Cancellation failed' : 'Restore failed'
}

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

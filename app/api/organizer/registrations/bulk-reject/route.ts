// POST /api/organizer/registrations/bulk-reject
//
// Bulk-rejects up to 200 pending registrations in one request.
// Body: { registrationIds: string[] }
//
// Only registrations with status === 'pending' belonging to the authenticated
// organizer are processed. Non-pending or foreign registrations are skipped.
//
// No counter change: pending registrations are not counted in totalCount,
// so rejecting them has no counter impact.
// No automatic email: rejection notifications are sent separately if needed.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminDb }         from '@/lib/firebase/admin'
import { authorizeWorkspace }         from '@/lib/team/workspace'
import { sendRejectionEmail }         from '@/lib/registrations/sendRejectionEmail'
import {
  rejectRegistration,
  RegistrationNotFoundError, UnauthorizedCancellationError,
  NotPendingError, AlreadyRejectedError,
} from '@/lib/firebase/firestore/registrations'
import type { AuditAction } from '@/lib/registrations/types'

// Sequential per-id rejection keeps counter contention off one event's counter
// doc; ≤200 admin-triggered rejections fit comfortably in the budget.
export const maxDuration = 60

// ─── Response type ────────────────────────────────────────────────────────────

export interface BulkRejectResponse {
  success:   boolean
  processed: number
  succeeded: number
  failed:    number
  error?:    string
  results:   { id: string; success: boolean; reason?: string }[]
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse<BulkRejectResponse>> {
  const empty = (error: string, status: number): NextResponse<BulkRejectResponse> =>
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
    // De-dup BEFORE the cap so a duplicated id can't send two rejection emails.
    registrationIds = [...new Set(
      (body.registrationIds as unknown[]).filter((id): id is string => typeof id === 'string'),
    )].slice(0, 200)
  } catch {
    return empty('Invalid request body', 400)
  }

  // ── 3. Reject each via the canonical transactional service ─────────────────
  // rejectRegistration enforces ownership + status==='pending', decrements
  // pendingCount + increments rejectedCount, and RELEASES any held session seats
  // — atomically + exactly once. Reusing it fixes the prior hand-rolled batch,
  // which left the counter untouched (pending/rejected drift) and leaked held
  // session seats. Sequential to avoid contending one event's counter doc.
  const rejectedIds: string[] = []
  const results:  { id: string; success: boolean; reason?: string }[] = []

  for (const id of registrationIds) {
    try {
      await rejectRegistration(id, uid)
      rejectedIds.push(id)
      results.push({ id, success: true })
    } catch (err) {
      let reason = 'Rejection failed'
      if      (err instanceof RegistrationNotFoundError)     reason = 'Not found'
      else if (err instanceof UnauthorizedCancellationError) reason = 'Forbidden'
      else if (err instanceof AlreadyRejectedError)          reason = 'Already rejected'
      else if (err instanceof NotPendingError)               reason = 'Not pending'
      else console.error('[bulk-reject] reject error:', { id, err })
      results.push({ id, success: false, reason })
    }
  }

  if (rejectedIds.length === 0) {
    const failed = results.filter(r => !r.success).length
    return NextResponse.json({ success: true, processed: registrationIds.length, succeeded: 0, failed, results })
  }

  // ── 4. Audit (fire-and-forget) ─────────────────────────────────────────────
  void writeBulkAudit(rejectedIds, 'rejected', callerUid, uid)

  // ── 5. Rejection emails (fire-and-forget, one per registrant) ──────────────
  for (const id of rejectedIds) {
    sendRejectionEmail(id).catch(err =>
      console.error(`[bulk-reject] Failed to send rejection email for ${id}:`, err),
    )
  }

  // (per-item results were already recorded in the rejection loop above)
  const failed = results.filter(r => !r.success).length
  return NextResponse.json({
    success:   true,
    processed: registrationIds.length,
    succeeded: rejectedIds.length,
    failed,
    results,
  })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
    console.error('[bulk-reject] audit batch error:', err)
  }
}

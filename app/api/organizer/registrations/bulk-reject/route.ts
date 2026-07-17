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
import type { RegistrationDocument, AuditAction } from '@/lib/registrations/types'

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
    registrationIds = (body.registrationIds as unknown[])
      .slice(0, 200)
      .filter((id): id is string => typeof id === 'string')
  } catch {
    return empty('Invalid request body', 400)
  }

  // ── 3. Load registrations ──────────────────────────────────────────────────
  const regSnaps = await Promise.all(
    registrationIds.map(id => adminDb.collection('registrations').doc(id).get()),
  )

  // ── 4. Filter: ownership + must be pending ─────────────────────────────────
  const eligible: Array<{ id: string; data: RegistrationDocument }> = []
  const results:  { id: string; success: boolean; reason?: string }[] = []

  for (let i = 0; i < registrationIds.length; i++) {
    const id   = registrationIds[i]
    const snap = regSnaps[i]
    if (!snap.exists) {
      results.push({ id, success: false, reason: 'Not found' }); continue
    }
    const reg = snap.data() as RegistrationDocument
    if (reg.organizerUid !== uid) {
      results.push({ id, success: false, reason: 'Forbidden' }); continue
    }
    if (reg.status !== 'pending') {
      results.push({ id, success: false, reason: 'Not pending' }); continue
    }
    eligible.push({ id, data: reg })
  }

  if (eligible.length === 0) {
    const failed = results.filter(r => !r.success).length
    return NextResponse.json({ success: true, processed: registrationIds.length, succeeded: 0, failed, results })
  }

  // ── 5. Batch update: status → rejected ─────────────────────────────────────
  const batch = adminDb.batch()
  const now   = FieldValue.serverTimestamp()
  for (const { id } of eligible) {
    batch.update(adminDb.collection('registrations').doc(id), {
      status: 'rejected', updatedAt: now,
    })
  }
  try {
    await batch.commit()
  } catch (err) {
    console.error('[bulk-reject] batch commit error:', err)
    return NextResponse.json({
      success:   false,
      processed: registrationIds.length,
      succeeded: 0,
      failed:    registrationIds.length,
      error:     'Database error. Please try again.',
      results:   [],
    }, { status: 500 })
  }

  // ── 6. Audit (fire-and-forget) ─────────────────────────────────────────────
  void writeBulkAudit(eligible.map(e => e.id), 'rejected', callerUid, uid)

  // ── 7. Rejection emails (fire-and-forget, one per registrant) ──────────────
  for (const { id } of eligible) {
    sendRejectionEmail(id).catch(err =>
      console.error(`[bulk-reject] Failed to send rejection email for ${id}:`, err),
    )
  }

  for (const { id } of eligible) results.push({ id, success: true })
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

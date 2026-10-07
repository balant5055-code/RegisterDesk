// PATCH /api/admin/failed-refunds/[id]
//
// Marks an open failed refund as resolved or ignored.
//
// Body: { action: 'resolved' | 'ignored', reason: string }
//
// resolved — admin manually confirmed the customer was refunded outside Razorpay
// ignored  — admin determined no refund is required (e.g. duplicate, fraud)
//
// Only 'open' records can be acted on; 409 for any other status.
//
// RD-PHASE4-S1 · C3 — closing a hold decides what happens to money RegisterDesk holds, and some of
// these records (licence manual-refund holds) may only be PAID by a Super Admin. So: Super Admin
// only; a non-blank reason is required; and the decision is a TRANSACTION that re-reads the record
// and closes it only while it is still open — it can never overwrite a retry in flight
// ('retrying') or a completed one ('retried').

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminDb }                    from '@/lib/firebase/admin'
import { stageAdminAudit }            from '@/lib/admin/audit'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'

// ─── Response type ────────────────────────────────────────────────────────────

export interface FailedRefundActionResponse {
  id:     string
  status: string
}

// ─── Route context ────────────────────────────────────────────────────────────

interface RouteContext {
  params: Promise<{ id: string }>
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

interface PatchBody {
  action?: unknown
  reason?: unknown
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  const { id } = await ctx.params

  let body: PatchBody
  try { body = await req.json() as PatchBody }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const action = typeof body.action === 'string' ? body.action : ''
  if (action !== 'resolved' && action !== 'ignored') {
    return NextResponse.json(
      { error: "action must be 'resolved' or 'ignored'" },
      { status: 400 },
    )
  }

  // RD-PHASE4-S4 · D3 — the shared 3–500 character policy (same bounds as before, stable codes).
  const reasonCheck = parseFinancialReason(body.reason)
  if (!reasonCheck.ok) return reasonErrorResponse(reasonCheck)
  const reason = reasonCheck.reason

  const docRef = adminDb.collection('failedRefunds').doc(id)
  // Re-read + close in ONE transaction: a concurrent retry claim (open → retrying) or a completed
  // retry makes this refuse instead of overwriting it.
  const outcome = await adminDb.runTransaction<
    { ok: true; fromStatus: string } | { ok: false; status: number; error: string }
  >(async txn => {
    const snap = await txn.get(docRef)
    if (!snap.exists) return { ok: false, status: 404, error: 'Failed refund not found' }
    const data = snap.data() as { status?: string; orderId?: string; paymentId?: string; amountPaise?: number; kind?: string }
    // RD-PHASE4-S4 · D4 — a captured-payment HOLD (even one approved for refund) is never closed
    // here: that would keep captured money with no verified outcome. The review workflow
    // (POST …/review) closes a hold only on evidence; an approved hold is refunded via retry.
    if (data.kind === 'duplicate_hold' || data.kind === 'settlement_hold' || data.kind === 'duplicate_payment_hold') {
      return { ok: false, status: 409, error: 'This is a captured-payment hold. Use the Review workflow (approve for refund, or resolve with a verified outcome).' }
    }
    // 'pending' is the legacy licensing spelling of 'open' (see the list route).
    if (data.status !== 'open' && data.status !== 'pending') {
      return { ok: false, status: 409, error: `Cannot ${action} a refund in status '${data.status ?? 'unknown'}'` }
    }
    const now = FieldValue.serverTimestamp()
    txn.update(docRef, {
      status:    action,
      updatedAt: now,
      ...(action === 'resolved'
        ? { resolvedAt: now, resolvedBy: adminUid, resolvedReason: reason }
        : { ignoredAt:  now, ignoredBy:  adminUid, ignoredReason:  reason }),
    })
    // RD-PHASE4-S4 · D6 — audit row committed WITH the decision (it used to be written after,
    // and a failed write was only reported).
    stageAdminAudit(txn, {
      adminUid,
      actorRole:  'super_admin',
      action:     action === 'resolved' ? 'failed_refund.resolved' : 'failed_refund.ignored',
      entityType: 'failed_refund',
      entityId:   id,
      reason,
      changedFields: ['status'],
      before: { status: data.status },
      after:  { status: action },
      metadata:   { reason, fromStatus: data.status, superAdmin: true, amountPaise: data.amountPaise ?? null },
      correlation: { failedRefundId: id, orderId: data.orderId ?? null, paymentId: data.paymentId ?? null },
    })
    return { ok: true, fromStatus: data.status }
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  return NextResponse.json({ id, status: action } satisfies FailedRefundActionResponse)
}

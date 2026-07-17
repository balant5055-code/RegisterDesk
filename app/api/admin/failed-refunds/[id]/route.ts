// PATCH /api/admin/failed-refunds/[id]
//
// Marks an open failed refund as resolved or ignored.
//
// Body: { action: 'resolved' | 'ignored' }
//
// resolved — admin manually confirmed the customer was refunded outside Razorpay
// ignored  — admin determined no refund is required (e.g. duplicate, fraud)
//
// Only 'open' records can be acted on; 409 for any other status.

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                 from 'firebase-admin/firestore'
import { adminDb }                    from '@/lib/firebase/admin'
import { resolveAdminUid }            from '@/lib/admin/auth'
import { logAdminAction }             from '@/lib/admin/audit'

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
}

export async function PATCH(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

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

  const docRef = adminDb.collection('failedRefunds').doc(id)
  const snap   = await docRef.get()
  if (!snap.exists) {
    return NextResponse.json({ error: 'Failed refund not found' }, { status: 404 })
  }

  const data = snap.data() as { status?: string }
  if (data.status !== 'open') {
    return NextResponse.json(
      { error: `Cannot ${action} a refund in status '${data.status ?? 'unknown'}'` },
      { status: 409 },
    )
  }

  const now = FieldValue.serverTimestamp()

  await docRef.update({
    status:    action,
    updatedAt: now,
    ...(action === 'resolved'
      ? { resolvedAt: now, resolvedBy: adminUid }
      : { ignoredAt:  now, ignoredBy:  adminUid }),
  })

  // Fire-and-forget audit log
  void logAdminAction({
    adminUid,
    action:     action === 'resolved' ? 'failed_refund.resolved' : 'failed_refund.ignored',
    entityType: 'failed_refund',
    entityId:   id,
  }).catch((err: unknown) => console.error('[audit] failed_refund action log failed:', err))

  return NextResponse.json({ id, status: action } satisfies FailedRefundActionResponse)
}

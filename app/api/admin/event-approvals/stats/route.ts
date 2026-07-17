// GET /api/admin/event-approvals/stats — approval dashboard metrics (admin only).
//
// pendingReviews  — events currently awaiting approval
// approvedToday   — events approved since 00:00 UTC today
// rejectedToday   — events rejected since 00:00 UTC today
// avgReviewMinutes— mean review turnaround for today's approvals (null if none)

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp }       from 'firebase-admin/firestore'
import { adminDb }         from '@/lib/firebase/admin'
import { resolveAdminUid } from '@/lib/admin/auth'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const now        = new Date()
  const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const startTs    = Timestamp.fromDate(startOfDay)

  const [pendingSnap, approvedSnap, rejectedSnap] = await Promise.all([
    adminDb.collection('events').where('lifecycleStatus', '==', 'pending_review').get(),
    adminDb.collection('events').where('approvedAt', '>=', startTs).get(),
    adminDb.collection('events').where('rejectedAt', '>=', startTs).get(),
  ])

  const durations = approvedSnap.docs
    .map(d => (d.data() as { reviewDurationMs?: unknown }).reviewDurationMs)
    .filter((n): n is number => typeof n === 'number' && n >= 0)

  const avgReviewMinutes = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000)
    : null

  return NextResponse.json({
    pendingReviews:   pendingSnap.size,
    approvedToday:    approvedSnap.size,
    rejectedToday:    rejectedSnap.size,
    avgReviewMinutes,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

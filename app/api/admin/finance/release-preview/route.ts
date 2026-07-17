// GET /api/admin/finance/release-preview
//
// Returns the count and total paise of platform transactions eligible for the
// T+2 release engine, and the timestamp of the most recent release run.
// No writes are performed — read-only preview.
//
// Eligibility criteria (identical to POST /api/admin/finance/release-funds):
//   status == 'completed'
//   releaseStatus == 'pending'
//   paidAt <= now − 48h
//
// Composite index required:
//   platformTransactions (status ASC, releaseStatus ASC, paidAt ASC)
//   (same index as release-funds — no additional index needed)

import { NextRequest, NextResponse }  from 'next/server'
import { Timestamp }                   from 'firebase-admin/firestore'
import { adminDb }                     from '@/lib/firebase/admin'
import { resolveAdminUid }             from '@/lib/admin/auth'
import { getSettlementConfig }         from '@/lib/settlements/resolveSettlementConfig'
import type { PlatformTransactionDocument, ReleaseStatus } from '@/lib/fees/types'

export interface ReleasePreviewResponse {
  eligibleTransactions: number
  eligibleAmountPaise:  number
  latestReleaseAt:      string | null   // ISO 8601 or null if never run
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  // Same hold time the release engine uses (Business Configuration) — never drift.
  const settlements = await getSettlementConfig()
  const cutoff = Timestamp.fromMillis(Date.now() - settlements.holdHours * 60 * 60 * 1000)

  // Run both queries in parallel
  const [eligibleSnap, auditSnap] = await Promise.all([
    adminDb
      .collection('platformTransactions')
      .where('status',        '==', 'completed')
      .where('releaseStatus', '==', 'pending' satisfies ReleaseStatus)
      .where('paidAt',        '<=', cutoff)
      .get(),
    // Query all finance.release_funds audit entries (single-field index — no composite needed)
    adminDb
      .collection('adminAuditLogs')
      .where('action', '==', 'finance.release_funds')
      .get(),
  ])

  // Sum eligible net settlement amounts
  let eligiblePaise = 0
  for (const doc of eligibleSnap.docs) {
    const tx = doc.data() as PlatformTransactionDocument
    eligiblePaise += tx.netSettlementPaise
  }

  // Find the most recent release audit entry by comparing ISO strings
  let latestReleaseAt: string | null = null
  for (const doc of auditSnap.docs) {
    const ts = doc.data().createdAt as Timestamp | undefined
    if (ts && typeof ts.toDate === 'function') {
      const iso = ts.toDate().toISOString()
      if (!latestReleaseAt || iso > latestReleaseAt) latestReleaseAt = iso
    }
  }

  return NextResponse.json({
    eligibleTransactions: eligibleSnap.size,
    eligibleAmountPaise:  eligiblePaise,
    latestReleaseAt,
  } satisfies ReleasePreviewResponse)
}

// GET /api/organizer/events/[eventId]/certificates/stats
//
// Returns certificate generation stats + recent certificate records for the
// organizer's event dashboard.

import { NextRequest, NextResponse }       from 'next/server'
import { adminDb }                         from '@/lib/firebase/admin'
import { authorizeWorkspace }              from '@/lib/team/workspace'
import type { SerializedCertificateRecord, CertificateRecord } from '@/lib/certificates/types'
import { LEGACY_CERTIFICATE_RECORDS } from '@/lib/certificates/constants'

type Params = { params: Promise<{ eventId: string }> }

export interface CertificateStatsResponse {
  generated:  number
  downloaded: number
  emailed:    number
  pending:    number   // eligible registrations without a certificate
  recent:     SerializedCertificateRecord[]
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params

  // Verify ownership
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const draft    = draftSnap.data() as Record<string, unknown>
  const details  = (draft.eventDetails  as Record<string, unknown>) ?? {}
  const seo      = (details.seo         as Record<string, unknown>) ?? {}
  const slug     = typeof seo.urlSlug === 'string' ? seo.urlSlug : null

  // RD-CERT-SCALE P2-3 — BOUNDED.
  //
  // This used to load EVERY certificateRecord for the event with an unbounded .get(), then
  // compute three numbers with .filter().length and discard the rest. At 10k that is 10,000
  // document reads to render four counters and twenty rows.
  //
  // Now: three count() aggregates (which transfer ZERO documents) plus one limit(20) query.
  // Cost is flat in the number of certificates. Same numbers, same rows, same order.
  const base = adminDb.collection(LEGACY_CERTIFICATE_RECORDS)
    .where('organizerUid', '==', uid)
    .where('eventId',      '==', eventId)

  const [generatedAgg, downloadedAgg, emailedAgg, recentSnap] = await Promise.all([
    base.count().get(),
    // `> 0` is a RANGE filter, so downloadCount must be the last field in its index.
    base.where('downloadCount', '>', 0).count().get(),
    base.where('emailStatus', '==', 'sent').count().get(),
    // Newest first — the sort key is issuedAt (CertificateRecord has no createdAt).
    base.orderBy('issuedAt', 'desc').limit(20).get(),
  ])

  const generated  = generatedAgg.data().count
  const downloaded = downloadedAgg.data().count
  const emailed    = emailedAgg.data().count

  // Compute pending: eligible registrations without certificates.
  // GA-7C P1-3: derive from a COUNT aggregation (no document reads) instead of the
  // former O(attendees) full scan of confirmed registrations — pending = confirmed −
  // generated, the standard scalable form for this KPI.
  let pending = 0
  if (slug) {
    const confirmedSnap = await adminDb
      .collection('registrations')
      .where('organizerUid', '==', uid)
      .where('eventSlug',    '==', slug)
      .where('status',       '==', 'confirmed')
      .count().get()
    pending = Math.max(0, confirmedSnap.data().count - generated)
  }

  // Ordered by Firestore, not in memory — these 20 are the only documents read.
  const recent: SerializedCertificateRecord[] = recentSnap.docs.map(d => {
    const r = d.data() as CertificateRecord
    return {
      ...r,
      issuedAt:  toISO(r.issuedAt)  ?? new Date().toISOString(),
      emailedAt: toISO(r.emailedAt) ?? null,
    }
  })

  return NextResponse.json({
    generated, downloaded, emailed, pending, recent,
  } satisfies CertificateStatsResponse)
}

// GET /api/organizer/events/[eventId]/certificates/stats
//
// Returns certificate generation stats + recent certificate records for the
// organizer's event dashboard.

import { NextRequest, NextResponse }       from 'next/server'
import { adminDb, adminAuth }              from '@/lib/firebase/admin'
import { getCertificatesByEventId }        from '@/lib/certificates/firestore'
import type { SerializedCertificateRecord } from '@/lib/certificates/types'

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
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

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

  // Load all cert records for this event
  const records = await getCertificatesByEventId(eventId, uid)

  // Compute stats
  const generated  = records.length
  const downloaded = records.filter(r => r.downloadCount > 0).length
  const emailed    = records.filter(r => r.emailStatus === 'sent').length

  // Compute pending: eligible registrations without certificates
  let pending = 0
  if (slug) {
    // Quick count — load confirmed regs and compare
    const regsSnap = await adminDb
      .collection('registrations')
      .where('organizerUid', '==', uid)
      .where('eventSlug',    '==', slug)
      .where('status',       '==', 'confirmed')
      .get()
    const confirmedIds = new Set(regsSnap.docs.map(d => d.id))
    const certRegIds   = new Set(records.map(r => r.registrationId))
    pending = [...confirmedIds].filter(id => !certRegIds.has(id)).length
  }

  // Serialize recent 20 records, newest first
  const recent: SerializedCertificateRecord[] = records
    .sort((a, b) => {
      const at = toISO(a.issuedAt) ?? ''
      const bt = toISO(b.issuedAt) ?? ''
      return bt.localeCompare(at)
    })
    .slice(0, 20)
    .map(r => ({
      ...r,
      issuedAt:  toISO(r.issuedAt)  ?? new Date().toISOString(),
      emailedAt: toISO(r.emailedAt) ?? null,
    }))

  return NextResponse.json({
    generated, downloaded, emailed, pending, recent,
  } satisfies CertificateStatsResponse)
}

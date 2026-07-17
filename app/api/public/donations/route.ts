// GET /api/public/donations?limit=&cursor=&campaignSlug=
//
// Public API — organizer API key (donations.read). Scoped to the key's organizer.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authenticateApiKey }        from '@/lib/integrations/apiKeys'
import type { DonationDocument }     from '@/lib/donations/types'

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await authenticateApiKey(req, 'donations.read')
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status, headers: auth.headers })

  const sp     = req.nextUrl.searchParams
  const limit  = Math.min(Math.max(parseInt(sp.get('limit') ?? '', 10) || 50, 1), 100)
  const cursor = sp.get('cursor')?.trim()
  const campaignSlug = sp.get('campaignSlug')?.trim()

  let q = adminDb.collection('donations')
    .where('organizerUid', '==', auth.organizerUid) as FirebaseFirestore.Query
  if (campaignSlug) q = q.where('campaignSlug', '==', campaignSlug)
  q = q.orderBy('createdAt', 'desc').limit(limit + 1)

  if (cursor) {
    const curSnap = await adminDb.collection('donations').doc(cursor).get()
    if (curSnap.exists && (curSnap.data() as DonationDocument).organizerUid === auth.organizerUid) {
      q = q.startAfter(curSnap) as FirebaseFirestore.Query
    }
  }

  const snap     = await q.get()
  const hasMore  = snap.docs.length > limit
  const pageDocs = hasMore ? snap.docs.slice(0, limit) : snap.docs

  const data = pageDocs.map(doc => {
    const d = doc.data() as DonationDocument
    return {
      id:            doc.id,
      campaignSlug:  d.campaignSlug,
      campaignTitle: d.campaignTitle,
      amountPaise:   d.amountPaise,
      status:        d.status,
      donorName:     d.isAnonymous ? 'Anonymous' : d.donorName,
      donorEmail:    d.donorEmail,
      receiptNumber: d.receiptNumber ?? null,
      createdAt:     tsToISO(d.createdAt),
    }
  })

  return NextResponse.json(
    { data, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

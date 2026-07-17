// GET /api/organizer/campaigns
//
// Lists all donation campaigns owned by the authenticated organizer.
// Authorization: Bearer Firebase ID token.
// Query: donationCampaigns where uid == organizerUid (uses default single-field index).

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                    from '@/lib/firebase/admin'
import { verifyCaller }               from '@/lib/team/access'
import { getDonationCounter }         from '@/lib/firebase/firestore/donations'
import type { PublishedCampaign }     from '@/lib/firebase/firestore/campaigns'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const uid = caller.uid

  const snap = await adminDb
    .collection('donationCampaigns')
    .where('uid', '==', uid)
    .get()

  if (snap.empty) return NextResponse.json([])

  // Load counters in parallel for all campaigns
  const campaigns = snap.docs.map(d => d.data() as PublishedCampaign)

  const counters = await Promise.all(
    campaigns.map(c => getDonationCounter(c.slug)),
  )

  const result = campaigns.map((c, i) => ({
    slug:              c.slug,
    title:             c.campaignDetails.basics.title,
    status:            c.status,
    totalRaisedRupees: (counters[i]?.totalRaisedPaise ?? 0) / 100,
    donorCount:        counters[i]?.donorCount ?? 0,
  }))

  // Sort active campaigns first, then by totalRaisedRupees descending
  result.sort((a, b) => {
    if (a.status === 'active' && b.status !== 'active') return -1
    if (a.status !== 'active' && b.status === 'active') return 1
    return b.totalRaisedRupees - a.totalRaisedRupees
  })

  return NextResponse.json(result)
}

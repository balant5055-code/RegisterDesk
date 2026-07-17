// GET /api/admin/stats
// Platform-wide KPIs for the admin dashboard.
// Uses Firestore server-side aggregation (count + sum) to avoid loading
// full collections into memory.

import { NextRequest, NextResponse } from 'next/server'
import { AggregateField }            from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'

export interface AdminStats {
  organizerCount:        number
  eventCount:            number
  campaignCount:         number
  pendingSettlements:    number
  pendingSettlementPaise: number
  lifetimeGrossPaise:    number
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const pendingQ = adminDb.collection('settlementRequests').where('status', '==', 'pending')

  const [
    orgSnap,
    eventSnap,
    campaignSnap,
    pendingCountSnap,
    pendingPaiseSnap,
    revenueSnap,
  ] = await Promise.all([
    // Organizers = user accounts with role 'organizer' (set at signup). Excludes
    // admins / any other role. Admin identity lives in custom claims / ADMIN_UIDS,
    // never as role 'organizer', so a role filter is the correct account signal.
    adminDb.collection('users').where('role', '==', 'organizer').count().get(),
    // "Published Events" counts only currently-published events — matching the
    // established convention in getAdminAnalytics (lifecycleStatus === 'published').
    adminDb.collection('events').where('lifecycleStatus', '==', 'published').count().get(),
    adminDb.collection('donationCampaigns').count().get(),
    pendingQ.count().get(),
    pendingQ.aggregate({ paise: AggregateField.sum('amountPaise') }).get(),
    adminDb.collection('organizerRevenueWallets')
      .aggregate({ gross: AggregateField.sum('lifetimeGrossPaise') })
      .get(),
  ])

  const stats: AdminStats = {
    organizerCount:         orgSnap.data().count,
    eventCount:             eventSnap.data().count,
    campaignCount:          campaignSnap.data().count,
    pendingSettlements:     pendingCountSnap.data().count,
    pendingSettlementPaise: pendingPaiseSnap.data().paise  ?? 0,
    lifetimeGrossPaise:     revenueSnap.data().gross       ?? 0,
  }

  return NextResponse.json(stats satisfies AdminStats)
}

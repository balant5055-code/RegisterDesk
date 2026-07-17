// GET /api/organizer/campaigns/[slug]
//
// Returns the full donation dashboard dataset for one campaign.
// Authorization: organizer must own the campaign (campaign.uid === decoded.uid).
//
// Queries:
//   donationCampaigns/{slug}          — campaign meta + ownership check
//   donationCounters/{slug}           — totalRaisedPaise, donorCount, donationCount
//   donations (where campaignSlug + status=successful, orderBy paidAt desc, limit 100)
//     Index: (campaignSlug ASC, status ASC, paidAt DESC) — already in firestore.indexes.json

import { NextRequest, NextResponse }  from 'next/server'
import { verifyCaller }                from '@/lib/team/access'
import { getCampaignBySlug }           from '@/lib/firebase/firestore/campaigns'
import {
  getDonationCounter,
  getCampaignDonations,
}                                      from '@/lib/firebase/firestore/donations'
import type { DonationDocument }       from '@/lib/donations/types'

// ─── Response types ───────────────────────────────────────────────────────────

export interface CampaignDashboardDonation {
  donationId:    string
  donorName:     string
  donorEmail:    string
  donorPhone:    string | null
  amountRupees:  number
  amountPaise:   number
  isAnonymous:   boolean
  paidAt:        string | null
  receiptNumber: string | null
}

export interface DailyDonationTotal {
  date:        string   // YYYY-MM-DD
  amountPaise: number
  count:       number
}

export interface CampaignDashboardData {
  // Campaign meta
  slug:          string
  title:         string
  status:        string
  visibility:    string
  is80G:         boolean
  goalRupees:    number | null
  endDate:       string
  organizerName: string

  // Counter KPIs
  totalRaisedPaise:  number
  totalRaisedRupees: number
  donorCount:        number
  donationCount:     number
  lastDonationAt:    string | null

  // Computed KPIs
  remainingRupees:   number | null
  goalPct:           number | null   // 0-100, null when no goal
  avgDonationRupees: number

  // Progress chart (last 30 days) — aggregated server-side from fetched donations
  dailyTotals: DailyDonationTotal[]

  // Tables (capped in API to avoid bloating response)
  recentDonations: CampaignDashboardDonation[]  // 20 most recent
  topDonations:    CampaignDashboardDonation[]  // 5 largest
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tsToIso(val: unknown): string | null {
  if (!val || typeof val !== 'object') return null
  if ('toDate' in (val as object)) {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function buildDailyTotals(donations: DonationDocument[]): DailyDonationTotal[] {
  const now     = new Date()
  const buckets = new Map<string, { amountPaise: number; count: number }>()

  // Initialise all 30 buckets to zero
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    buckets.set(d.toISOString().slice(0, 10), { amountPaise: 0, count: 0 })
  }

  // Accumulate
  for (const don of donations) {
    const iso = tsToIso(don.paidAt)
    if (!iso) continue
    const key    = iso.slice(0, 10)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.amountPaise += don.amountPaise
      bucket.count++
    }
  }

  return Array.from(buckets.entries()).map(([date, v]) => ({ date, ...v }))
}

function toDashboardDonation(d: DonationDocument): CampaignDashboardDonation {
  return {
    donationId:    d.id,
    donorName:     d.donorName,
    donorEmail:    d.donorEmail,
    donorPhone:    d.donorPhone,
    amountRupees:  d.amountRupees,
    amountPaise:   d.amountPaise,
    isAnonymous:   d.isAnonymous,
    paidAt:        tsToIso(d.paidAt),
    receiptNumber: d.receiptNumber ?? null,
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params

  // Auth — canonical caller verification (email-verification gate enforced).
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const uid = caller.uid

  // Load campaign and verify ownership
  const campaign = await getCampaignBySlug(slug)
  if (!campaign)             return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  if (campaign.uid !== uid)  return NextResponse.json({ error: 'Forbidden' },          { status: 403 })

  const cd = campaign.campaignDetails

  // Load counter + donations in parallel
  const [counter, donations] = await Promise.all([
    getDonationCounter(slug),
    getCampaignDonations(slug, 100),
  ])

  // KPI derivations
  const totalRaisedPaise  = counter?.totalRaisedPaise ?? 0
  const totalRaisedRupees = totalRaisedPaise / 100
  const donorCount        = counter?.donorCount    ?? 0
  const donationCount     = counter?.donationCount ?? 0
  const lastDonationAt    = tsToIso(counter?.lastDonationAt)

  const goalRupees       = cd.goal.targetAmountRupees ?? null
  const remainingRupees  = goalRupees !== null ? Math.max(0, goalRupees - totalRaisedRupees) : null
  const goalPct          = goalRupees !== null && goalRupees > 0
    ? Math.min(100, Math.round((totalRaisedRupees / goalRupees) * 100))
    : null
  const avgDonationRupees = donationCount > 0
    ? Math.round(totalRaisedRupees / donationCount)
    : 0

  // Daily totals for chart
  const dailyTotals = buildDailyTotals(donations)

  // Recent (20 newest — already sorted desc)
  const recentDonations = donations.slice(0, 20).map(toDashboardDonation)

  // Top 5 by amount
  const topDonations = [...donations]
    .sort((a, b) => b.amountPaise - a.amountPaise)
    .slice(0, 5)
    .map(toDashboardDonation)

  const data: CampaignDashboardData = {
    slug,
    title:         cd.basics.title,
    status:        campaign.status,
    visibility:    campaign.visibility,
    is80G:         cd.taxConfig.enabled,
    goalRupees,
    endDate:       cd.goal.endDate,
    organizerName: cd.organizer.name,

    totalRaisedPaise,
    totalRaisedRupees,
    donorCount,
    donationCount,
    lastDonationAt,

    remainingRupees,
    goalPct,
    avgDonationRupees,

    dailyTotals,
    recentDonations,
    topDonations,
  }

  return NextResponse.json(data)
}

// GET /api/organizer/campaigns/[slug]/export
//
// Downloads all successful donations for a campaign as a CSV file.
// Authorization: organizer must own the campaign.
// Anonymous donors: real name + email included (organizer's internal record).

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }               from '@/lib/team/access'
import { getCampaignBySlug }          from '@/lib/firebase/firestore/campaigns'
import { getCampaignDonations }       from '@/lib/firebase/firestore/donations'
import { csvCell as escapeCsv }        from '@/lib/utils/csv'

function fmtDate(val: unknown): string {
  if (!val || typeof val !== 'object') return ''
  if ('toDate' in (val as object)) {
    const d = (val as { toDate: () => Date }).toDate()
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
  }
  return ''
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await context.params

  // Auth — canonical caller verification (email-verification gate enforced).
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const uid = caller.uid

  // Ownership check
  const campaign = await getCampaignBySlug(slug)
  if (!campaign)            return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  if (campaign.uid !== uid) return NextResponse.json({ error: 'Forbidden' },          { status: 403 })

  const donations = await getCampaignDonations(slug, 1000)

  const HEADER = 'Receipt Number,Date,Donor Name,Email,Phone,Amount (INR),Anonymous,Message\r\n'

  const rows = donations.map(d =>
    [
      escapeCsv(d.receiptNumber),
      escapeCsv(fmtDate(d.paidAt)),
      escapeCsv(d.donorName),
      escapeCsv(d.donorEmail),
      escapeCsv(d.donorPhone),
      String(d.amountRupees),
      d.isAnonymous ? 'Yes' : 'No',
      escapeCsv(d.message),
    ].join(','),
  )

  const csv  = HEADER + rows.join('\r\n')
  const safe = slug.replace(/[^a-z0-9-]/gi, '-').toLowerCase()

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safe}-donations.csv"`,
      'Cache-Control':       'no-store',
    },
  })
}

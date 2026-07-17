// GET /api/organizer/events/[eventId]/exhibition
// Returns KPI counts for exhibition events: visitors, exhibitors, sponsors, media, vip, total.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'

export interface ExhibitionKpiResponse {
  total:     number
  visitors:  number
  exhibitors: number
  sponsors:  number
  media:     number
  vip:       number
  topCompanies: { companyName: string; passType: string }[]
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<ExhibitionKpiResponse | { error: string }>> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await context.params

  // Resolve slug from draft
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const d    = draftSnap.data() as Record<string, unknown>
  const seo  = ((d.eventDetails as Record<string, unknown>)?.seo as Record<string, unknown>) ?? {}
  const slug = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
  if (!slug) return NextResponse.json({ error: 'Event not published' }, { status: 400 })

  const snap = await adminDb
    .collection('registrations')
    .where('organizerUid', '==', uid)
    .where('eventSlug',    '==', slug)
    .where('status',       '==', 'confirmed')
    .limit(5000)
    .get()

  let visitors = 0, exhibitors = 0, sponsors = 0, media = 0, vip = 0
  const companies: { companyName: string; passType: string }[] = []

  for (const doc of snap.docs) {
    const r        = doc.data() as Record<string, unknown>
    const passName = (r.passName as string | undefined ?? '').toLowerCase()
    if (passName.includes('exhibitor'))    exhibitors++
    else if (passName.includes('sponsor')) sponsors++
    else if (passName.includes('media'))   media++
    else if (passName.includes('vip'))     vip++
    else                                   visitors++

    const cn = r.companyName as string | null | undefined
    if (cn?.trim()) companies.push({ companyName: cn.trim(), passType: r.passName as string ?? '' })
  }

  return NextResponse.json({
    total:     snap.size,
    visitors,
    exhibitors,
    sponsors,
    media,
    vip,
    topCompanies: companies.slice(0, 50),
  })
}

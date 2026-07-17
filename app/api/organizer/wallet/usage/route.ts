// GET /api/organizer/wallet/usage
// Returns communication usage history for the organizer.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import type { CommunicationUsage, CommChannel } from '@/lib/wallet/types'

function tsToIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

function docToUsage(id: string, d: Record<string, unknown>): CommunicationUsage {
  return {
    id,
    organizerUid: typeof d.organizerUid === 'string' ? d.organizerUid : '',
    eventId:      typeof d.eventId      === 'string' ? d.eventId      : '',
    eventSlug:    typeof d.eventSlug    === 'string' ? d.eventSlug    : '',
    eventName:    typeof d.eventName    === 'string' ? d.eventName    : '',
    channel:      (d.channel as CommChannel) ?? 'email',
    quantity:     typeof d.quantity     === 'number' ? d.quantity     : 0,
    costPaise:    typeof d.costPaise    === 'number' ? d.costPaise    : 0,
    campaignId:   typeof d.campaignId   === 'string' ? d.campaignId   : '',
    templateKey:  typeof d.templateKey  === 'string' ? d.templateKey  : '',
    createdAt:    tsToIso(d.createdAt),
  }
}

export type GetCommUsageResponse =
  | { success: true;  usage: CommunicationUsage[] }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<GetCommUsageResponse>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = new URL(req.url)
  const limitParam = parseInt(searchParams.get('limit') ?? '100', 10)
  const limit      = Math.min(Math.max(limitParam, 1), 500)

  const snap = await adminDb.collection('communicationUsage')
    .where('organizerUid', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(limit)
    .get()

  const usage = snap.docs.map(doc => docToUsage(doc.id, doc.data() as Record<string, unknown>))
  return NextResponse.json({ success: true, usage })
}

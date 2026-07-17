// GET /api/organizer/broadcasts/[campaignId]/job — broadcast send progress
//
// WA-3 / OE-2 — exposes the generic runner job driving a WhatsApp OR Email campaign
// so the UI can show live progress and resume it. Security: auth + campaign ownership.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }            from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob }             from '@/lib/jobs/kernel'
import { serializeJob, type SerializedJob } from '@/lib/jobs/serialize'
import type { Job }           from '@/lib/jobs/types'
import { campaignJobPointer } from '@/lib/broadcasts/broadcastJobs'

export type SerializedBroadcastJob = SerializedJob<Job>
export type GetBroadcastJobResponse =
  | { success: true;  job: SerializedBroadcastJob | null }
  | { success: false; error: string }

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse<GetBroadcastJobResponse>> {
  const { campaignId } = await params
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const snap = await adminDb.collection('broadcastCampaigns').doc(campaignId).get()
  const d = snap.data() as { organizerUid?: string; channel?: string; whatsappJobId?: string; emailJobId?: string } | undefined
  if (!snap.exists || d?.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  const ptr = campaignJobPointer(d)
  if (!ptr.jobId) return NextResponse.json({ success: true, job: null })

  const job = await getJob<Job>(ptr.collection, ptr.jobId)
  return NextResponse.json({ success: true, job: job ? serializeJob(job) : null }, { headers: { 'Cache-Control': 'no-store' } })
}

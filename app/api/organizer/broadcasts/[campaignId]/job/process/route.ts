// POST /api/organizer/broadcasts/[campaignId]/job/process
//
// WA-3 / OE-2 — Drives ONE chunk of a campaign's send job (WhatsApp or Email;
// client poller — the per-channel cron also advances it). Resumes from the
// persisted cursor. Security: auth + campaign ownership.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }            from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getJob }             from '@/lib/jobs/kernel'
import { serializeJob }       from '@/lib/jobs/serialize'
import type { Job }           from '@/lib/jobs/types'
import type { ProcessResult } from '@/lib/jobs/runner'
import { campaignJobPointer, processCampaignJobChunk } from '@/lib/broadcasts/broadcastJobs'
import type { SerializedBroadcastJob } from '../route'

export type ProcessBroadcastJobResponse =
  | { success: true;  result: ProcessResult; job: SerializedBroadcastJob | null }
  | { success: false; error: string }

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ campaignId: string }> },
): Promise<NextResponse<ProcessBroadcastJobResponse>> {
  const { campaignId } = await params
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const snap = await adminDb.collection('broadcastCampaigns').doc(campaignId).get()
  const d = snap.data() as { organizerUid?: string; channel?: string; whatsappJobId?: string; emailJobId?: string } | undefined
  if (!snap.exists || d?.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Campaign not found' }, { status: 404 })
  }

  const ptr = campaignJobPointer(d)
  if (!ptr.jobId || !ptr.channel) {
    return NextResponse.json({ success: false, error: 'This campaign has no send job.' }, { status: 400 })
  }

  const result = await processCampaignJobChunk(ptr.channel, ptr.jobId)
  const after  = await getJob<Job>(ptr.collection, ptr.jobId)
  return NextResponse.json({ success: true, result, job: after ? serializeJob(after) : null })
}

// GET /api/organizer/print-ops/generation-jobs
//
// PA-7 — READ-ONLY list of the workspace's print generation jobs for the
// Operations Center. Reuses the existing PA-4 view serializer; the generation-job
// module is NOT modified. Queries by the single-field `organizerUid` index and
// sorts newest-first in memory (no composite index / no schema change).
//
// Query (optional): event, status, limit.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import {
  PRINT_GENERATION_JOBS, toPrintJobView,
  type PrintGenerationJob, type PrintGenerationJobView,
} from '@/lib/printAssets/generationJob'

export type ListGenerationJobsResponse =
  | { success: true;  jobs: PrintGenerationJobView[] }
  | { success: false; error: string }

const toMs = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0)

export async function GET(req: NextRequest): Promise<NextResponse<ListGenerationJobsResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const sp     = req.nextUrl.searchParams
  const event  = sp.get('event')  ?? ''
  const status = sp.get('status') ?? ''
  const limit  = Math.min(Math.max(parseInt(sp.get('limit') ?? '200', 10) || 200, 1), 500)

  const snap = await adminDb.collection(PRINT_GENERATION_JOBS)
    .where('organizerUid', '==', authz.workspaceUid)
    .limit(500)
    .get()

  const jobs = snap.docs
    .map(d => d.data() as PrintGenerationJob)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
    .filter(j => (!event || j.eventId === event) && (!status || j.status === status))
    .slice(0, limit)
    .map(toPrintJobView)

  return NextResponse.json({ success: true, jobs }, { headers: { 'Cache-Control': 'no-store' } })
}

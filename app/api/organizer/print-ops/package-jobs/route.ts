// GET /api/organizer/print-ops/package-jobs
//
// PA-7 — READ-ONLY list of the workspace's print PACKAGE jobs for the Operations
// Center. Reuses the existing PA-6 view serializer; the package-job module is NOT
// modified. Single-field `organizerUid` query, newest-first in memory.
//
// Query (optional): status, limit.

import { NextRequest, NextResponse } from 'next/server'
import { Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import {
  PRINT_PACKAGE_JOBS, toPackageJobView,
  type PrintPackageJob, type PrintPackageJobView,
} from '@/lib/printAssets/packageJob'

export type ListPackageJobsResponse =
  | { success: true;  jobs: PrintPackageJobView[] }
  | { success: false; error: string }

const toMs = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0)

export async function GET(req: NextRequest): Promise<NextResponse<ListPackageJobsResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const sp     = req.nextUrl.searchParams
  const status = sp.get('status') ?? ''
  const limit  = Math.min(Math.max(parseInt(sp.get('limit') ?? '200', 10) || 200, 1), 500)

  const snap = await adminDb.collection(PRINT_PACKAGE_JOBS)
    .where('organizerUid', '==', authz.workspaceUid)
    .limit(500)
    .get()

  const jobs = snap.docs
    .map(d => d.data() as PrintPackageJob)
    .sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt))
    .filter(j => (!status || j.status === status))
    .slice(0, limit)
    .map(toPackageJobView)

  return NextResponse.json({ success: true, jobs }, { headers: { 'Cache-Control': 'no-store' } })
}

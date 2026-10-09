// GET /api/organizer/print-packages/[jobId]/download
//
// PA-6 — Secure, expiring download for a completed package ZIP. Gates the stored
// file behind auth + ownership + expiry, then redirects to the Storage object. The
// storage token URL is never exposed except through this authorized redirect.
// Accepts the token via header OR ?token= (for <a download> links). One ZIP only.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getPrintPackageJob }  from '@/lib/printAssets/packageJob'

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params

  const qToken = req.nextUrl.searchParams.get('token')
  const authReq = qToken
    ? new Request(req.url, { headers: { Authorization: `Bearer ${qToken}` } })
    : req
  // RD-STAFF-SEC-02 — same gate as every sibling print route (authorizeAnyWorkspace): a
  // gate-only staff credential is refused. This route resolved the workspace by hand and
  // skipped that, so check-in staff could download any printed credential in the workspace.
  const ctx = await authorizeAnyWorkspace(authReq)
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  const job = await getPrintPackageJob(jobId)
  if (!job || job.organizerUid !== ctx.workspaceUid) {
    return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  }
  if (!job.output) {
    return NextResponse.json({ error: 'Package is not ready yet' }, { status: 409 })
  }

  const expiresMs = job.output.expiresAt instanceof Object && typeof (job.output.expiresAt as { toMillis?: unknown }).toMillis === 'function'
    ? (job.output.expiresAt as { toMillis(): number }).toMillis()
    : 0
  if (expiresMs > 0 && expiresMs < Date.now()) {
    return NextResponse.json({ error: 'This download link has expired. Package the assets again.' }, { status: 410 })
  }

  return NextResponse.redirect(job.output.url)
}

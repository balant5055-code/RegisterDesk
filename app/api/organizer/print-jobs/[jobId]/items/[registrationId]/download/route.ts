// GET /api/organizer/print-jobs/[jobId]/items/[registrationId]/download
//
// PA-4 — Secure, expiring download for ONE generated print asset. Gates the stored
// file behind auth + ownership + expiry, then redirects to the Storage object. The
// storage token URL is never exposed except through this authorized redirect.
// Accepts the token via header OR ?token= (for <a download> links). Individual PDFs
// only — no ZIP, no combined package.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { getPrintGenerationJob, getPrintJobItem } from '@/lib/printAssets/generationJob'

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string; registrationId: string }> },
): Promise<NextResponse> {
  const { jobId, registrationId } = await params

  const qToken = req.nextUrl.searchParams.get('token')
  const authReq = qToken
    ? new Request(req.url, { headers: { Authorization: `Bearer ${qToken}` } })
    : req
  // RD-STAFF-SEC-02 — same gate as every sibling print route (authorizeAnyWorkspace): a
  // gate-only staff credential is refused. This route resolved the workspace by hand and
  // skipped that, so check-in staff could download any printed credential in the workspace.
  const ctx = await authorizeAnyWorkspace(authReq)
  if (!ctx.ok) return NextResponse.json({ error: ctx.error }, { status: ctx.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== ctx.workspaceUid) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const item = await getPrintJobItem(jobId, registrationId)
  if (!item || !item.output) {
    return NextResponse.json({ error: 'Asset is not ready yet' }, { status: 409 })
  }

  const expiresMs = item.output.expiresAt instanceof Object && typeof (item.output.expiresAt as { toMillis?: unknown }).toMillis === 'function'
    ? (item.output.expiresAt as { toMillis(): number }).toMillis()
    : 0
  if (expiresMs > 0 && expiresMs < Date.now()) {
    return NextResponse.json({ error: 'This download link has expired. Generate the assets again.' }, { status: 410 })
  }

  return NextResponse.redirect(item.output.url)
}

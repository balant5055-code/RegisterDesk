// GET /api/organizer/print-jobs/[jobId]/items/[registrationId]/download
//
// PA-4 — Secure, expiring download for ONE generated print asset. Gates the stored
// file behind auth + ownership + expiry, then redirects to the Storage object. The
// storage token URL is never exposed except through this authorized redirect.
// Accepts the token via header OR ?token= (for <a download> links). Individual PDFs
// only — no ZIP, no combined package.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { getPrintGenerationJob, getPrintJobItem } from '@/lib/printAssets/generationJob'

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string; registrationId: string }> },
): Promise<NextResponse> {
  const { jobId, registrationId } = await params

  const qToken = req.nextUrl.searchParams.get('token')
  const authReq = qToken
    ? new Request(req.url, { headers: { Authorization: `Bearer ${qToken}` } })
    : req
  const caller = await verifyCaller(authReq)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)

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

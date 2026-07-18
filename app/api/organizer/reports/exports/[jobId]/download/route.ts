// GET /api/organizer/reports/exports/[jobId]/download
//
// OE-3 — Secure, expiring download for a completed report export. Gates the stored
// file behind auth + ownership + expiry, then redirects to the Storage object. The
// token URL is never exposed except through this authorized redirect.
// Accepts the token via header OR ?token= (for <a download> links).

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { getReportExportJob }  from '@/lib/reports/exportJob'

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params

  // Allow the token via query for direct-download links (no custom headers).
  const qToken = req.nextUrl.searchParams.get('token')
  const authReq = qToken
    ? new Request(req.url, { headers: { Authorization: `Bearer ${qToken}` } })
    : req
  const caller = await verifyCaller(authReq)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)

  const job = await getReportExportJob(jobId)
  if (!job || job.organizerUid !== ctx.workspaceUid) {
    return NextResponse.json({ error: 'Export not found' }, { status: 404 })
  }
  // A cancelled job may still carry an `output` (cancelJob does not clear it), so
  // gate on status too — a cancelled export must not remain downloadable.
  if (job.status === 'cancelled') {
    return NextResponse.json({ error: 'This export was cancelled.' }, { status: 410 })
  }
  if (!job.output) {
    return NextResponse.json({ error: 'Export is not ready yet' }, { status: 409 })
  }

  const expiresMs = job.output.expiresAt instanceof Object && typeof (job.output.expiresAt as { toMillis?: unknown }).toMillis === 'function'
    ? (job.output.expiresAt as { toMillis(): number }).toMillis()
    : 0
  if (expiresMs > 0 && expiresMs < Date.now()) {
    return NextResponse.json({ error: 'This download link has expired. Generate the report again.' }, { status: 410 })
  }

  return NextResponse.redirect(job.output.url)
}

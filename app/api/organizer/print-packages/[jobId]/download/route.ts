// GET /api/organizer/print-packages/[jobId]/download
//
// PA-6 — Secure, expiring download for a completed package ZIP. Gates the stored
// file behind auth + ownership + expiry, then redirects to the Storage object. The
// storage token URL is never exposed except through this authorized redirect.
// Accepts the token via header OR ?token= (for <a download> links). One ZIP only.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { getPrintPackageJob }  from '@/lib/printAssets/packageJob'

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params

  const qToken = req.nextUrl.searchParams.get('token')
  const authReq = qToken
    ? new Request(req.url, { headers: { Authorization: `Bearer ${qToken}` } })
    : req
  const caller = await verifyCaller(authReq)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)

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

// GET /api/organizer/print-packages/[jobId]/download
//
// PA-6 — Download a package as ONE ZIP of print cards.
//
// RD-PRINT-P0 — the ZIP is BUILT ON DEMAND, in memory, from the source job's template
// and the LIVE registrations, and returned in this response. Nothing is read from or
// written to Storage. This route used to redirect to a stored ZIP's permanent,
// unauthenticated token URL; it no longer reads that URL, even for legacy packages.
// Capped (PRINT_PACKAGE_MAX_CARDS / PRINT_PACKAGE_MAX_BYTES): above the cap it REFUSES
// with 413 and a message — a package is never silently truncated.
//
// Security: `certificates` permission + package ownership; the login token is accepted
// ONLY in the Authorization header — a `?token=` query parameter is ignored.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintPackageJob, buildPrintPackageZip } from '@/lib/printAssets/packageJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  const { jobId } = await params

  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getPrintPackageJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Package not found' }, { status: 404 })
  }
  if (job.status !== 'completed') {
    return NextResponse.json({ error: 'Package is not ready yet' }, { status: 409 })
  }

  const built = await buildPrintPackageZip(job)
  if (!built.ok) return NextResponse.json({ error: built.error }, { status: built.status })

  return new NextResponse(Buffer.from(built.zip) as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':           'application/zip',
      'Content-Disposition':    `attachment; filename="${built.filename}"`,
      'Cache-Control':          'no-store, private',
      'X-Content-Type-Options': 'nosniff',
      'X-Print-Card-Count':     String(built.fileCount),
      'X-Print-Cards-Skipped':  String(built.skipped),
    },
  })
}

// GET /api/organizer/print-jobs/[jobId]/items/[registrationId]/download
//
// PA-4 — Download ONE print card as a PDF.
//
// RD-PRINT-P0 — the card is RENDERED ON DEMAND, in memory, from the job's template and
// the LIVE registration, and returned in this response. Nothing is read from or written
// to Storage. This route used to redirect to a stored file's permanent, unauthenticated
// token URL; it no longer reads that URL, even for legacy items that still carry one.
//
// Security:
//   • `certificates` permission (the permission that creates print jobs) + job ownership;
//   • the registration must be an item of THIS job, and must still exist, belong to the
//     job's workspace and event, and be eligible for a credential;
//   • the login token is accepted ONLY in the Authorization header — a `?token=` query
//     parameter is ignored (it leaked the session token into URLs and browser history).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintGenerationJob, renderPrintCard } from '@/lib/printAssets/generationJob'

export const dynamic     = 'force-dynamic'
export const maxDuration = 60

export async function GET(
  req: NextRequest, { params }: { params: Promise<{ jobId: string; registrationId: string }> },
): Promise<NextResponse> {
  const { jobId, registrationId } = await params

  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const job = await getPrintGenerationJob(jobId)
  if (!job || job.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }

  const card = await renderPrintCard(job, registrationId)
  if (!card.ok) return NextResponse.json({ error: card.error }, { status: card.status })

  return new NextResponse(Buffer.from(card.bytes) as unknown as BodyInit, {
    status: 200,
    headers: {
      'Content-Type':           'application/pdf',
      'Content-Disposition':    `attachment; filename="${card.filename}"`,
      'Cache-Control':          'no-store, private',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}

// POST /api/organizer/print-packages
//
// PA-6 — Creates a background packaging job that ZIPs the PDFs a PA-4 generation
// job already produced. Returns a jobId immediately; packaging runs off the request
// thread (first chunk inline + the print-packaging cron). NOTHING is rendered or
// regenerated. Security: workspace auth + source-job ownership.
//
// Body:  { sourceJobId, filters?: { pass?, category?, registrationIds?[] } }
// Reply: { success, jobId, job }

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintGenerationJob, type PrintGenerationFilters } from '@/lib/printAssets/generationJob'
import {
  createPrintPackageJob, processPrintPackageChunk, getPrintPackageJob,
  toPackageJobView, type PrintPackageJobView,
} from '@/lib/printAssets/packageJob'

export type CreatePrintPackageResponse =
  | { success: true;  jobId: string; job: PrintPackageJobView }
  | { success: false; error: string }

function parseFilters(raw: unknown): PrintGenerationFilters {
  const b = (raw ?? {}) as Record<string, unknown>
  const f: PrintGenerationFilters = {}
  if (typeof b.pass === 'string' && b.pass) f.pass = b.pass
  if (typeof b.category === 'string' && b.category) f.category = b.category
  if (Array.isArray(b.registrationIds)) {
    const ids = b.registrationIds.filter((x): x is string => typeof x === 'string' && !!x)
    if (ids.length) f.registrationIds = ids.slice(0, 20000)
  }
  return f
}

export async function POST(req: NextRequest): Promise<NextResponse<CreatePrintPackageResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  let body: { sourceJobId?: unknown; filters?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const sourceJobId = typeof body.sourceJobId === 'string' ? body.sourceJobId : ''
  if (!sourceJobId) return NextResponse.json({ success: false, error: 'sourceJobId is required' }, { status: 400 })

  const source = await getPrintGenerationJob(sourceJobId)
  if (!source || source.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Source generation job not found' }, { status: 404 })
  }

  const job = await createPrintPackageJob({
    sourceJobId, eventId: source.eventId, eventSlug: source.eventSlug, assetType: source.assetType,
    filters: parseFilters(body.filters), organizerUid: authz.workspaceUid, createdBy: authz.callerUid,
  })

  await processPrintPackageChunk(job.jobId)   // build the ZIP inline (first chunk)
  const after = await getPrintPackageJob(job.jobId)

  return NextResponse.json(
    { success: true, jobId: job.jobId, job: toPackageJobView(after ?? job) },
    { status: 201 },
  )
}

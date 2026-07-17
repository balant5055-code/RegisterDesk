// POST /api/organizer/print-jobs
//
// PA-4 — Creates a background print-generation job (reuses the ROE generic runner +
// the PA-3 renderer + Storage) and drives the first chunk. Returns a jobId
// immediately; generation runs off the request thread (first chunk inline + the
// print-generation cron). Security: workspace auth + template ownership.
//
// Body:  { templateId, filters?: { pass?, category?, registrationIds?[] } }
// Reply: { success, jobId, job }

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate }   from '@/lib/printAssets/firestore'
import {
  createPrintGenerationJob, processPrintGenerationChunk, getPrintGenerationJob,
  toPrintJobView, type PrintGenerationFilters, type PrintGenerationJobView,
} from '@/lib/printAssets/generationJob'

export type CreatePrintJobResponse =
  | { success: true;  jobId: string; job: PrintGenerationJobView }
  | { success: false; error: string }

function parseFilters(raw: unknown): PrintGenerationFilters {
  const b = (raw ?? {}) as Record<string, unknown>
  const f: PrintGenerationFilters = {}
  if (typeof b.pass === 'string' && b.pass) f.pass = b.pass
  if (typeof b.category === 'string' && b.category) f.category = b.category
  if (Array.isArray(b.registrationIds)) {
    const ids = b.registrationIds.filter((x): x is string => typeof x === 'string' && !!x)
    if (ids.length) f.registrationIds = ids.slice(0, 5000)
  }
  return f
}

export async function POST(req: NextRequest): Promise<NextResponse<CreatePrintJobResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  let body: { templateId?: unknown; filters?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const templateId = typeof body.templateId === 'string' ? body.templateId : ''
  if (!templateId) return NextResponse.json({ success: false, error: 'templateId is required' }, { status: 400 })

  const template = await getPrintTemplate(templateId)
  if (!template || template.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }

  // The template stores the event DRAFT id; registrations are keyed by the published
  // slug (eventDetails.seo.urlSlug). Resolve it before querying registrations.
  const draftSnap = await adminDb.doc(`users/${authz.workspaceUid}/eventDrafts/${template.eventId}`).get()
  const seo = ((draftSnap.data()?.eventDetails as Record<string, unknown> | undefined)?.seo) as Record<string, unknown> | undefined
  const eventSlug = typeof seo?.urlSlug === 'string' ? seo.urlSlug : ''
  if (!eventSlug) {
    return NextResponse.json({ success: false, error: 'Event is not published yet — no registrations to generate.' }, { status: 409 })
  }

  const job = await createPrintGenerationJob({
    templateId, eventId: template.eventId, eventSlug, assetType: template.assetType,
    filters: parseFilters(body.filters), organizerUid: authz.workspaceUid, createdBy: authz.callerUid,
  })

  await processPrintGenerationChunk(job.jobId)   // drive the first chunk inline
  const after = await getPrintGenerationJob(job.jobId)

  return NextResponse.json(
    { success: true, jobId: job.jobId, job: toPrintJobView(after ?? job) },
    { status: 201 },
  )
}

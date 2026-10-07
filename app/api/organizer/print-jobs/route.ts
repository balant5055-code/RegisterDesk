// POST /api/organizer/print-jobs
//
// PA-4 — Creates a background print-generation job (reuses the ROE generic runner +
// the PA-3 renderer + Storage). Returns a jobId immediately; generation runs entirely
// off the request thread (first chunk handed to after(), then the print-generation
// cron). Security: workspace auth + template ownership.
//
// RD-PRINT-SCALE-IMPLEMENTATION-01 — this request no longer scales with event size.
// Seeding is a bounded keyset walk (lib/printAssets/generationJob) and the first
// render chunk is no longer awaited inline, so a 20,000-registration event and a
// 50-registration one differ in how long the job runs, not in what the POST holds.
//
// Body:  { templateId, filters?: { pass?, category?, registrationIds?[] } }
// Reply: { success, jobId, job } · 413 { requested, maxSelection } if over the cap

import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate }   from '@/lib/printAssets/firestore'
import {
  createPrintGenerationJob, processPrintGenerationChunk, MAX_EXPLICIT_SELECTION,
  toPrintJobView, type PrintGenerationFilters, type PrintGenerationJobView,
} from '@/lib/printAssets/generationJob'

export type CreatePrintJobResponse =
  | { success: true;  jobId: string; job: PrintGenerationJobView }
  | { success: false; error: string; requested?: number; maxSelection?: number }

type ParsedFilters =
  | { ok: true;  filters: PrintGenerationFilters }
  | { ok: false; requested: number }

/**
 * RD-PRINT-SCALE-IMPLEMENTATION-01 — this used to end in `ids.slice(0, 5000)`.
 *
 * A selection of 20,000 was silently cut to 5,000 and still answered 201 success, so the
 * organizer only found out which 15,000 badges were missing at the print shop. Over the
 * cap is now a rejection that names the number asked for.
 *
 * Duplicate ids are collapsed: the same registration selected twice is one badge, and
 * counting it twice would push a legitimate selection over the cap.
 */
function parseFilters(raw: unknown): ParsedFilters {
  const b = (raw ?? {}) as Record<string, unknown>
  const f: PrintGenerationFilters = {}
  if (typeof b.pass === 'string' && b.pass) f.pass = b.pass
  if (typeof b.category === 'string' && b.category) f.category = b.category
  if (Array.isArray(b.registrationIds)) {
    const ids = [...new Set(b.registrationIds.filter((x): x is string => typeof x === 'string' && !!x))]
    if (ids.length > MAX_EXPLICIT_SELECTION) return { ok: false, requested: ids.length }
    if (ids.length) f.registrationIds = ids
  }
  return { ok: true, filters: f }
}

export async function POST(req: NextRequest): Promise<NextResponse<CreatePrintJobResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  let body: { templateId?: unknown; filters?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const templateId = typeof body.templateId === 'string' ? body.templateId : ''
  if (!templateId) return NextResponse.json({ success: false, error: 'templateId is required' }, { status: 400 })

  const parsed = parseFilters(body.filters)
  if (!parsed.ok) {
    return NextResponse.json(
      {
        success: false,
        error: `Select at most ${MAX_EXPLICIT_SELECTION.toLocaleString('en-IN')} registrations per print job — you selected ${parsed.requested.toLocaleString('en-IN')}. Generate them in smaller batches.`,
        requested:    parsed.requested,
        maxSelection: MAX_EXPLICIT_SELECTION,
      },
      { status: 413 },
    )
  }

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
    filters: parsed.filters, organizerUid: authz.workspaceUid, createdBy: authz.callerUid,
  })

  // The first chunk used to run INSIDE this request, so the response waited on a render
  // pass on top of the whole seed. It now runs in after(), once the response is already
  // sent — the same handoff lib/jobs/continuation.ts uses. Generation still starts
  // immediately; the request simply stops being the thing that blocks on it. Both callers
  // already poll for readiness, and the print-generation cron remains the backstop.
  after(() => processPrintGenerationChunk(job.jobId).catch(() => {}))

  return NextResponse.json(
    { success: true, jobId: job.jobId, job: toPrintJobView(job) },
    { status: 201 },
  )
}

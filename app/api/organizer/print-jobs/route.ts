// POST /api/organizer/print-jobs
//
// PA-4 — Creates a background print-generation job (reuses the ROE generic runner +
// the PA-3 renderer). Returns a jobId immediately; generation runs entirely off the
// request thread (first chunk handed to after(), then the print-generation cron). The
// job stores metadata only — no output file, no attendee copy (RD-PRINT-P0); cards
// render on demand at download. Security: `certificates` + template ownership.
//
// RD-PRINT-SCALE-IMPLEMENTATION-01 — this request no longer scales with event size.
// Seeding is a bounded keyset walk (lib/printAssets/generationJob) and the first
// render chunk is no longer awaited inline, so a 20,000-registration event and a
// 50-registration one differ in how long the job runs, not in what the POST holds.
//
// Body:  { templateId, filters?: { pass?, category?, registrationIds?[] }, requestId?, quote? }
// Reply: { success, jobId, job } · 413 { requested, maxSelection } if over the cap
//
// RD-PRINT-BILL-P5 — an ID card / badge job on an event with PAID (or complimentary) badge
// generation is created by createBilledPrintGenerationJob: paid needs `requestId` (D5), the owner
// when any attendee is billed (D3), and the `quote` from POST /api/organizer/print-jobs/quote (D4);
// too few units ⇒ 402. Every FREE job — all of them while PAID_BADGE_GENERATION_RELEASED is false —
// takes the original createPrintGenerationJob path below, unchanged.

import { NextRequest, NextResponse } from 'next/server'
import { after } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate }   from '@/lib/printAssets/firestore'
import { ensureCurrentVersion } from '@/lib/printAssets/versions'
import { isPrintableTemplateStatus } from '@/lib/printAssets/types'
import {
  createPrintGenerationJob, createBilledPrintGenerationJob, processPrintGenerationChunk, MAX_EXPLICIT_SELECTION,
  toPrintJobView, type PrintGenerationJobView, type PrintBadgeQuote,
} from '@/lib/printAssets/generationJob'
import { parsePrintJobFilters, overSelectionError, printEventSlugForDraft, parseRequestId } from '@/lib/printAssets/printJobRequest'
import { resolvePrintJobBillingMode } from '@/lib/printAssets/badgeBilling/store'

// RD-PRINT-P8 (W2) — explicit route budget: this route runs a seed walk or a 50 s render chunk,
// so its limit is declared rather than left to the platform default.
export const maxDuration = 60

export type CreatePrintJobResponse =
  | { success: true;  jobId: string; job: PrintGenerationJobView }
  | { success: false; error: string; requested?: number; maxSelection?: number; code?: string; quote?: PrintBadgeQuote }

export async function POST(req: NextRequest): Promise<NextResponse<CreatePrintJobResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  let body: { templateId?: unknown; filters?: unknown; requestId?: unknown; quote?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const templateId = typeof body.templateId === 'string' ? body.templateId : ''
  if (!templateId) return NextResponse.json({ success: false, error: 'templateId is required' }, { status: 400 })

  const parsed = parsePrintJobFilters(body.filters)
  if (!parsed.ok) {
    return NextResponse.json(
      {
        success: false,
        error: overSelectionError(parsed.requested),
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
  // RD-PRINT-P1 — an archived template cannot start a NEW print job. Jobs already pinned
  // to one of its versions keep working (retry, regenerate, download and packaging never
  // consult the template's status). Drafts remain printable, as they always were.
  if (!isPrintableTemplateStatus(template.status)) {
    return NextResponse.json(
      { success: false, error: 'This template is archived. Restore it to Draft or Published to print with it.', code: 'TEMPLATE_ARCHIVED' },
      { status: 409 },
    )
  }

  // The template stores the event DRAFT id; registrations are keyed by the published
  // slug (eventDetails.seo.urlSlug). Resolve it before querying registrations.
  const eventSlug = await printEventSlugForDraft(authz.workspaceUid, template.eventId)
  if (!eventSlug) {
    return NextResponse.json({ success: false, error: 'Event is not published yet — no registrations to generate.' }, { status: 409 })
  }

  // RD-PRINT-P1 — pin the template's CURRENT immutable version (a template never saved
  // since versioning gets its present layout snapshotted as v1). The job renders that
  // version for its whole life, whatever later happens to the template.
  const pin = await ensureCurrentVersion(template.id, authz.workspaceUid, authz.callerUid)

  // RD-PRINT-BILL-P5 — free unless this is a chargeable asset type on an event whose effective
  // badge terms are paid or complimentary (never, while the code gate is closed).
  const billingMode = await resolvePrintJobBillingMode(template.assetType, eventSlug, { organizerUid: authz.workspaceUid, draftId: template.eventId }, { freshPilot: true })   // RD-PRINT-P8.2 — a NEW job: pilot read fresh
  if (!billingMode.ok) {
    return billingMode.reason === 'ownership'
      ? NextResponse.json({ success: false, error: 'This event could not be verified as the published event of this draft.', code: 'EVENT_OWNERSHIP_UNVERIFIED' }, { status: 409 })
      : NextResponse.json({ success: false, error: 'ID badge billing is temporarily unavailable. Try again shortly.', code: 'BILLING_UNAVAILABLE' }, { status: 503 })
  }

  let job
  let existing = false
  if (billingMode.mode === 'free') {
    job = await createPrintGenerationJob({
      templateId, eventId: template.eventId, eventSlug, assetType: template.assetType,
      filters: parsed.filters, organizerUid: authz.workspaceUid, createdBy: authz.callerUid,
      templateVersion: pin.version, templateVersionHash: pin.hash,
    })
  } else {
    const billed = await createBilledPrintGenerationJob({
      templateId, eventId: template.eventId, eventSlug, assetType: template.assetType,
      filters: parsed.filters, organizerUid: authz.workspaceUid, createdBy: authz.callerUid,
      templateVersion: pin.version, templateVersionHash: pin.hash,
      mode: billingMode.mode, terms: billingMode.terms,
      requestId: parseRequestId(body.requestId), quote: body.quote, isOwner: authz.isOwner,
    })
    if (!billed.ok) {
      return NextResponse.json(
        { success: false, error: billed.error, code: billed.code, ...(billed.quote ? { quote: billed.quote } : {}) },
        { status: billed.status },
      )
    }
    job = billed.job
    existing = billed.existing
  }

  // The first chunk used to run INSIDE this request, so the response waited on a render
  // pass on top of the whole seed. It now runs in after(), once the response is already
  // sent — the same handoff lib/jobs/continuation.ts uses. Generation still starts
  // immediately; the request simply stops being the thing that blocks on it. Both callers
  // already poll for readiness, and the print-generation cron remains the backstop.
  const jobId = job.jobId
  after(() => processPrintGenerationChunk(jobId).catch(() => {}))

  return NextResponse.json(
    { success: true, jobId, job: toPrintJobView(job) },
    { status: existing ? 200 : 201 },
  )
}

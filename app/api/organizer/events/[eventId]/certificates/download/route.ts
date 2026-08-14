// POST /api/organizer/events/[eventId]/certificates/download
//
// Bulk certificate ZIP — ENQUEUE ONLY. Returns 202 with a zip-job id; the archive is
// produced asynchronously in shards by lib/certificates/zipJobs and collected from
// /api/organizer/events/[eventId]/certificates/zip-jobs/[jobId].
//
// ═══ WHY THIS NO LONGER STREAMS ══════════════════════════════════════════════
// It used to build the whole archive inside this request. Two defects made that
// unfixable in place:
//
//   1. SILENT TRUNCATION. The eligibility guard counted only certificates carrying a
//      stored `fileUrl`. Once issuance stopped writing that field the count was always
//      zero, so the "too many certificates" rejection could never fire — and a selection
//      above the ceiling was quietly sliced to 5,000, with the loss reported only in an
//      `X-Certificate-Skipped` header no browser download ever surfaces.
//   2. IT COULD NOT FINISH. Every entry re-rendered its PDF, so the advertised 5,000-file
//      ceiling needed roughly 10 minutes against a 300 s budget. A timeout mid-stream is
//      indistinguishable from success, because `200 OK` and the headers are already sent.
//
// Both are structural, not tunable. The job path replaces them with shards that are
// individually atomic and a manifest that states exactly what is and is not included.
//
// Body: { scope: 'selected' | 'all' | 'job', certificateIds?: string[], jobId?: string }

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { countEventCertificates, countJobCertificates } from '@/lib/certificates/firestore'
import { loadEventContext }          from '@/lib/certificates/jobs'
import { createZipJob }              from '@/lib/certificates/zipJobsStore'
import { MAX_EXPLICIT_IDS }          from '@/lib/certificates/validation'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'

type Params = { params: Promise<{ eventId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const rl = checkPolicy(uid, RATE_POLICY.pdfDownload)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many download requests. Please try again shortly.' },
      { status: 429, headers: { 'Retry-After': String(rl.retryAfter) } },
    )
  }

  const { eventId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: { scope?: string; certificateIds?: unknown; jobId?: unknown }
  try { body = await req.json() as typeof body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const scope = body.scope === 'selected' || body.scope === 'job' ? body.scope : 'all'

  // The event slug scopes the shard objects; it is also the ownership check.
  const ctx = await loadEventContext(uid, eventId)
  if (!ctx.ok) {
    return ctx.code === 'not_found'
      ? NextResponse.json({ error: 'Event not found' }, { status: 404 })
      : NextResponse.json({ error: 'Event not published' }, { status: 422 })
  }

  let certificateIds: string[] | null = null
  let sourceJobId:    string | null   = null
  let total = 0

  if (scope === 'selected') {
    const ids = Array.isArray(body.certificateIds)
      ? body.certificateIds.filter((v): v is string => typeof v === 'string')
      : []
    if (ids.length === 0) {
      return NextResponse.json({ error: 'certificateIds required for scope "selected"' }, { status: 422 })
    }
    // Bounded so the id array stays inside a Firestore document. Unlike the old ceiling
    // this is a hard REJECTION, never a silent slice.
    if (ids.length > MAX_EXPLICIT_IDS) {
      return NextResponse.json(
        { error: `Too many certificates in one request (${ids.length} > ${MAX_EXPLICIT_IDS}). Split the selection.` },
        { status: 413 },
      )
    }
    certificateIds = ids
    total = ids.length
  } else if (scope === 'job') {
    if (typeof body.jobId !== 'string' || !body.jobId) {
      return NextResponse.json({ error: 'jobId required for scope "job"' }, { status: 422 })
    }
    sourceJobId = body.jobId
    // Counted with a Firestore AGGREGATE, not by resolving the selection: `requested` must
    // be truthful from the first poll, and loading every certificate here would be an
    // unbounded read on the request path. Leaving it 0 made the poll response report
    // `requested: 0, included: N`, breaking the completeness contract this API advertises.
    total = await countJobCertificates(eventId, uid, sourceJobId)
    if (total === 0) return NextResponse.json({ error: 'No certificates match the selection' }, { status: 404 })
  } else {
    total = await countEventCertificates(eventId, uid)
    if (total === 0) return NextResponse.json({ error: 'No certificates match the selection' }, { status: 404 })
  }

  const job = await createZipJob({
    organizerUid: uid,
    createdBy:    authz.callerUid || uid,
    eventId,
    eventSlug:    ctx.ctx.eventSlug,
    scope,
    sourceJobId,
    certificateIds,
  }, total)

  return NextResponse.json(
    { jobId: job.jobId, status: job.status, scope, total },
    { status: 202 },
  )
}

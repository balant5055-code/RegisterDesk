// POST /api/organizer/events/[eventId]/registrations/bulk-jobs
//
// OE-1 — Creates a background BULK CHECK-IN or BULK RESTORE job over selected
// registrations and drives the first chunk. The rest run via the registration-bulk
// cron (resumable/cancellable). Replaces the synchronous 200-row path for these two
// actions. Security: auth + event ownership.
//
// Body:  { kind: 'check_in' | 'restore', registrationIds: string[] }
// Reply: { success, jobId, job }

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace }  from '@/lib/team/workspace'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import { serializeJob, type SerializedJob } from '@/lib/jobs/serialize'
import {
  createRegistrationBulkJob, processRegistrationBulkChunk,
  BULK_JOB_MAX_ITEMS, type BulkJobKind, type RegistrationBulkJob,
} from '@/lib/registrations/bulkJob'

export type SerializedBulkJob = SerializedJob<RegistrationBulkJob>
export type CreateBulkJobResponse =
  | { success: true;  jobId: string; job: SerializedBulkJob }
  | { success: false; error: string }

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<CreateBulkJobResponse>> {
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ success: false, error: blocked.message }, { status: 403 })

  const { eventId } = await context.params

  let body: { kind?: unknown; registrationIds?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }
  const kind = body.kind === 'check_in' || body.kind === 'restore' ? (body.kind as BulkJobKind) : null
  if (!kind) return NextResponse.json({ success: false, error: 'kind must be check_in or restore' }, { status: 400 })

  const ids = Array.isArray(body.registrationIds)
    ? (body.registrationIds as unknown[]).filter((v): v is string => typeof v === 'string' && v.length > 0)
    : []
  if (ids.length === 0) return NextResponse.json({ success: false, error: 'registrationIds must be a non-empty array' }, { status: 400 })
  if (ids.length > BULK_JOB_MAX_ITEMS) {
    return NextResponse.json({ success: false, error: `Too many registrations (max ${BULK_JOB_MAX_ITEMS}).` }, { status: 400 })
  }

  // Event ownership + slug.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })
  const seo  = ((draftSnap.data() as Record<string, unknown>).eventDetails as Record<string, unknown> | undefined)?.seo as Record<string, unknown> | undefined
  const eventSlug = typeof seo?.urlSlug === 'string' && seo.urlSlug ? seo.urlSlug : eventId

  const job = await createRegistrationBulkJob(
    kind,
    { eventId, eventSlug, organizerUid: uid, createdBy: authz.callerUid },
    ids,
  )

  // Drive the first chunk now; the cron completes the rest.
  await processRegistrationBulkChunk(job.jobId)
  const after = await adminDb.collection('registrationBulkJobs').doc(job.jobId).get()

  return NextResponse.json(
    { success: true, jobId: job.jobId, job: serializeJob((after.data() as RegistrationBulkJob) ?? job) },
    { status: 201 },
  )
}

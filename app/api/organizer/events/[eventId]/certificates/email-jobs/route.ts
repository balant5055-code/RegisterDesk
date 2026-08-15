// POST /api/organizer/events/[eventId]/certificates/email-jobs   — enqueue bulk delivery
// GET  /api/organizer/events/[eventId]/certificates/email-jobs   — delivery history
//
// RD-CERT-EMAIL-BULK. Creating a job only ENQUEUES it (status `pending`); processing is
// driven by /api/cron/certificate-email-jobs. The browser never drives delivery, so a
// 10,000-certificate run survives a closed tab, a refresh and a deployment.
//
// Body: { scopeType: 'unsent' | 'failed' | 'selected', certificateIds?: string[] }
//
// "Select all matching" sends scopeType ONLY — zero ids — so the request stays
// constant-sized no matter how many certificates match. Explicit ids are bounded and are
// re-validated against this event on every chunk, never trusted from here.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { countEventCertificates }    from '@/lib/certificates/firestore'
import { createEmailJob, listEmailJobs } from '@/lib/certificates/emailJobsStore'
import { MAX_EXPLICIT_IDS }          from '@/lib/certificates/validation'
import { serializeCertificateEmailJob } from '@/lib/certificates/types'
import type { SerializedCertificateEmailJob, CertificateDeliveryScope } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

export interface EmailJobsListResponse { jobs: SerializedCertificateEmailJob[] }
export interface EmailJobCreateResponse { job: SerializedCertificateEmailJob }

function isScope(v: unknown): v is CertificateDeliveryScope {
  return v === 'unsent' || v === 'failed' || v === 'selected'
}

type Authorized = { error: NextResponse } | { error?: undefined; uid: string; callerUid: string }

async function authorize(req: NextRequest, eventId: string): Promise<Authorized> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ error: authz.error }, { status: authz.status }) }
  const uid = authz.workspaceUid
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return { error: NextResponse.json({ error: 'Event not found' }, { status: 404 }) }
  }
  return { uid, callerUid: authz.callerUid || uid }
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await authorize(req, eventId)
  if (auth.error) return auth.error

  const jobs = await listEmailJobs(eventId, auth.uid)
  return NextResponse.json({ jobs: jobs.map(serializeCertificateEmailJob) } satisfies EmailJobsListResponse)
}

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { eventId } = await params
  const auth = await authorize(req, eventId)
  if (auth.error) return auth.error

  let body: Record<string, unknown>
  try { body = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  if (!isScope(body.scopeType)) {
    return NextResponse.json({ error: 'scopeType must be unsent, failed, or selected' }, { status: 400 })
  }
  const scopeType = body.scopeType

  let certificateIds: string[] | null = null
  if (scopeType === 'selected') {
    const ids = Array.isArray(body.certificateIds)
      ? body.certificateIds.filter((v): v is string => typeof v === 'string')
      : []
    if (ids.length === 0) {
      return NextResponse.json({ error: 'certificateIds required for scope "selected"' }, { status: 422 })
    }
    // Bounded so the id array stays inside a Firestore document. A selection larger than
    // this is what "select all matching" exists for — it carries no ids at all.
    if (ids.length > MAX_EXPLICIT_IDS) {
      return NextResponse.json(
        { error: `Too many certificates in one request (${ids.length} > ${MAX_EXPLICIT_IDS}). Use "select all matching" instead.` },
        { status: 413 },
      )
    }
    certificateIds = ids
  }

  // `total` is the progress DENOMINATOR only. For a query scope it is the event's
  // certificate count: the exact matching set is resolved per page at execution, and the
  // claim decides each certificate, so an approximate denominator can never cause a
  // wrong send — it only affects the percentage shown while the job runs.
  const total = scopeType === 'selected'
    ? (certificateIds?.length ?? 0)
    : await countEventCertificates(eventId, auth.uid)

  if (total === 0) {
    return NextResponse.json({ error: 'No certificates match this selection' }, { status: 404 })
  }

  const job = await createEmailJob({
    eventId,
    organizerUid: auth.uid,
    createdBy:    auth.callerUid,
    scopeType,
    certificateIds,
  }, total)

  return NextResponse.json(
    { job: serializeCertificateEmailJob(job) } satisfies EmailJobCreateResponse,
    { status: 202 },
  )
}

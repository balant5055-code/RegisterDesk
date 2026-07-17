// POST /api/organizer/events/[eventId]/certificates/download
//
// Bulk certificate ZIP download (GA-4 S2). Reuses the shared ZIP engine
// (lib/certificates/zip → buildStoredZip) over already-generated certificate PDFs.
// Never re-renders. Security: auth + event ownership.
//
// Body: { scope: 'selected' | 'all' | 'job', certificateIds?: string[], jobId?: string }
//   • 'selected' → only the given certificateIds
//   • 'all'      → every generated certificate for the event
//   • 'job'      → certificates produced by a specific generation job

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { listEventCertificates, listJobCertificates, getCertificatesByIds, countEventCertificates } from '@/lib/certificates/firestore'
import { selectZipCertificates, streamCertificatesZip, CERTIFICATE_ZIP_MAX_FILES } from '@/lib/certificates/zip'
import { RATE_POLICY, checkPolicy }  from '@/lib/rateLimit/policies'
import type { Certificate }          from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

// GA-7C S2/P7: the ZIP streams up to CERTIFICATE_ZIP_MAX_FILES PDF fetches — give it
// the same generous budget as the other bulk certificate paths (streaming keeps
// memory flat; this bounds wall-clock).
export const maxDuration = 300

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Bulk ZIP assembly is expensive — throttle per workspace (same PDF policy).
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

  // GA-7C P1-3: resolve the selection with a TARGETED query per scope instead of
  // loading the whole event's certificate collection and filtering in memory. The
  // 'all' scope is count-gated first so a huge event is rejected without loading it.
  let selected: Certificate[]
  if (scope === 'selected') {
    const idList = Array.isArray(body.certificateIds) ? body.certificateIds.filter((v): v is string => typeof v === 'string') : []
    if (idList.length === 0) return NextResponse.json({ error: 'certificateIds required for scope "selected"' }, { status: 422 })
    if (idList.length > CERTIFICATE_ZIP_MAX_FILES) {
      return NextResponse.json({ error: `Too many certificates for a single ZIP (${idList.length} > ${CERTIFICATE_ZIP_MAX_FILES}). Download in batches.` }, { status: 413 })
    }
    selected = await getCertificatesByIds(eventId, uid, idList)
  } else if (scope === 'job') {
    const jobId = typeof body.jobId === 'string' ? body.jobId : ''
    if (!jobId) return NextResponse.json({ error: 'jobId required for scope "job"' }, { status: 422 })
    selected = await listJobCertificates(eventId, uid, jobId)
  } else {
    const total = await countEventCertificates(eventId, uid)
    if (total > CERTIFICATE_ZIP_MAX_FILES) {
      return NextResponse.json(
        { error: `Too many certificates for a single ZIP (${total} > ${CERTIFICATE_ZIP_MAX_FILES}). Narrow the selection (by job or selected certificates) and download in batches.` },
        { status: 413 },
      )
    }
    selected = await listEventCertificates(eventId, uid)
  }

  if (selected.length === 0) return NextResponse.json({ error: 'No certificates match the selection' }, { status: 404 })

  // GA-5 S2: never silently truncate. A selection above the synchronous-ZIP ceiling
  // is rejected with guidance to narrow the scope (by job / selected IDs).
  const downloadable = selected.filter(c => c.status !== 'revoked' && typeof c.fileUrl === 'string' && c.fileUrl).length
  if (downloadable > CERTIFICATE_ZIP_MAX_FILES) {
    return NextResponse.json(
      { error: `Too many certificates for a single ZIP (${downloadable} > ${CERTIFICATE_ZIP_MAX_FILES}). Narrow the selection (by job or selected certificates) and download in batches.` },
      { status: 413 },
    )
  }

  // GA-7C P1-2: STREAM the archive instead of buffering every PDF + a full concat
  // copy in memory (which peaked at multi-GB near the 5000-file cap). PDFs are
  // fetched in bounded-concurrency batches and piped into the streaming STORED-zip
  // writer, so only a handful of PDFs are resident at once. Selection is computed
  // upfront (no fetches) so the response headers are known before the body streams.
  const { usable, skipped } = selectZipCertificates(selected)
  if (usable.length === 0) {
    return NextResponse.json({ error: 'No downloadable certificate files (all revoked or legacy).' }, { status: 409 })
  }

  const filename = `certificates-${eventId}-${scope}-${usable.length}.zip`
  return new NextResponse(streamCertificatesZip(usable), {
    status: 200,
    headers: {
      'Content-Type':        'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control':       'no-store',
      'X-Certificate-Count': String(usable.length),
      'X-Certificate-Skipped': String(skipped),
    },
  })
}

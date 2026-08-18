// POST /api/organizer/events/[eventId]/certificates/delete
//
// Permanently deletes certificates and every asset they own — the record, its legacy twin,
// its reservation claim, its photo grants, and the R2 objects behind all of them.
//
// ONE ENDPOINT FOR ONE AND FOR MANY. Individual delete is a batch of one, so the browser
// never fires N independent deletion requests and there is no second authorization path to
// keep in sync. Body: { certificateIds: string[] }.
//
// Security: workspace auth + event ownership, then EVERY id is re-resolved server-side and
// re-checked against the caller and this event inside the service. A client-supplied id is
// only ever a lookup key — never authority — and no R2 key is ever accepted from the client.
//
// Answers 200 with per-item outcomes even when items failed: a mixed batch is the normal
// case, and collapsing it into one status code is what makes a partial failure read as
// success. Callers must derive their outcome from `results[].ok`.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace }  from '@/lib/team/workspace'
import { deleteCertificates, MAX_DELETE_BATCH } from '@/lib/certificates/deletion'

type Params = { params: Promise<{ eventId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: { certificateIds?: unknown }
  try { body = await req.json() as typeof body } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const ids = Array.isArray(body.certificateIds)
    ? body.certificateIds.filter((v): v is string => typeof v === 'string')
    : []
  if (ids.length === 0) return NextResponse.json({ error: 'certificateIds required' }, { status: 422 })
  // Rejected rather than truncated: silently dropping the tail of a delete request would
  // report success for certificates nobody attempted to delete.
  if (ids.length > MAX_DELETE_BATCH) {
    return NextResponse.json(
      { error: `At most ${MAX_DELETE_BATCH} certificates can be deleted per request` },
      { status: 422 },
    )
  }

  const result = await deleteCertificates(eventId, ids, uid)
  return NextResponse.json(result)
}

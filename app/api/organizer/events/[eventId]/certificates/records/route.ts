// GET /api/organizer/events/[eventId]/certificates/records
//
// Lists generated certificates for an event from the NEW `certificates`
// collection (read-only), for the Certificate Hub's Overview + Recipients tabs.
// Newest first. Security: auth + event ownership.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { listEventCertificatesPage } from '@/lib/certificates/firestore'
import { serializeCertificate }      from '@/lib/certificates/types'
import type { SerializedCertificate } from '@/lib/certificates/types'

type Params = { params: Promise<{ eventId: string }> }

export interface CertificateRecordsResponse {
  certificates: SerializedCertificate[]
  hasMore:      boolean
  nextCursor:   string | null
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  // GA-7C P1-3: cursor pagination (newest first) replaces the former unbounded load
  // of the whole certificates collection into one JSON array. Same cursor pattern as
  // the registrations list; response stays `{ certificates }` plus additive
  // hasMore/nextCursor (backward compatible — existing clients read the first page).
  const params_ = req.nextUrl.searchParams
  const rawLimit = Number(params_.get('limit') ?? '200')
  const pageSize = [50, 100, 200, 500].includes(rawLimit) ? rawLimit : 200
  const cursor   = params_.get('cursor') ?? null

  const page = await listEventCertificatesPage(eventId, uid, { pageSize, cursor })

  return NextResponse.json({
    certificates: page.certificates.map(serializeCertificate),
    hasMore:      page.hasMore,
    nextCursor:   page.nextCursor,
  } satisfies CertificateRecordsResponse)
}

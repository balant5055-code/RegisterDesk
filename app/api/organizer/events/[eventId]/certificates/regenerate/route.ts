// POST /api/organizer/events/[eventId]/certificates/regenerate
//
// Regenerates existing certificates in place (GA-4 S2) against the event's current
// active template — same certificateId/token, no duplicate records. Security: auth +
// event ownership; each certificate is re-checked to belong to this event/workspace.
//
// Body: { certificateIds: string[] }   (bounded per request)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getCertificate }            from '@/lib/certificates/firestore'
import { regenerateCertificate, prefetchRegenAssets } from '@/lib/certificates/generate'
import { captureError }              from '@/lib/monitoring/sentry'

// GA-7C S2/P7: batch regenerate renders up to MAX_PER_REQUEST PDFs — give it the same
// generous function budget as the other bulk certificate paths.
export const maxDuration = 300

type Params = { params: Promise<{ eventId: string }> }

const MAX_PER_REQUEST = 100
const REGEN_CONCURRENCY = 6   // bounded render/upload parallelism (mirrors bulk jobs)

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const actorUid = authz.callerUid ?? uid

  const { eventId } = await params
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })

  let body: { certificateIds?: unknown }
  try { body = await req.json() as typeof body } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const ids = Array.isArray(body.certificateIds)
    ? body.certificateIds.filter((v): v is string => typeof v === 'string').slice(0, MAX_PER_REQUEST)
    : []
  if (ids.length === 0) return NextResponse.json({ error: 'certificateIds required' }, { status: 422 })

  // GA-7C S2: prefetch the event's active template + render assets ONCE and reuse
  // them for every certificate in the batch (was re-fetched per cert). undefined on
  // failure → each regenerate falls back to its own per-cert fetch (unchanged).
  const prefetched = (await prefetchRegenAssets(eventId, uid).catch(() => null)) ?? undefined

  // Bounded worker pool — render/upload are I/O-bound; distinct certificates never
  // contend (idempotent, same-path overwrite), so parallelism is safe. Order of the
  // results array is preserved by writing into a fixed index.
  const results: Array<{ certificateId: string; ok: boolean; error?: string }> = new Array(ids.length)
  let next = 0
  const worker = async () => {
    while (next < ids.length) {
      const i = next++
      const certificateId = ids[i]
      const cert = await getCertificate(certificateId)
      if (!cert || cert.organizerUid !== uid || cert.eventId !== eventId) {
        results[i] = { certificateId, ok: false, error: 'not_found' }
        continue
      }
      const r = await regenerateCertificate(certificateId, { actorUid, prefetched }).catch((e: unknown) => {
        captureError(e, { scope: 'certificate_regeneration', area: 'certificate', certificateId, eventId })
        return { ok: false as const, error: e instanceof Error ? e.message : 'regeneration failed' }
      })
      results[i] = r.ok ? { certificateId, ok: true } : { certificateId, ok: false, error: r.error }
    }
  }
  await Promise.all(Array.from({ length: Math.min(REGEN_CONCURRENCY, ids.length) }, worker))

  const succeeded = results.filter(r => r.ok).length
  return NextResponse.json({ succeeded, failed: results.length - succeeded, results })
}

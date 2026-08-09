// POST /api/organizer/media-studio/uploads/duplicates
//
// Checksum-based duplicate scan for a batch, BEFORE anything is uploaded. Read-only.
//
// The client hashes each source file locally (sha256 of the ORIGINAL bytes) and sends only
// the digests — never the bytes — so a 5,000-photo folder costs one small request.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeMedia, resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import { findByChecksums } from '@/features/media-studio/repositories/assetRepo'
import { scanForDuplicates, type DuplicateCandidate, type DuplicateScan } from '@/features/media-studio/utils/duplicates'
import { checkBatch, resolveMediaConfig } from '@/lib/config/resolveMediaConfig'

export type DuplicateScanResponse = DuplicateScan

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeMedia(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: { eventId?: unknown; candidates?: unknown }
  try { raw = await req.json() as typeof raw }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId = typeof raw.eventId === 'string' ? raw.eventId.trim() : ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  if (!Array.isArray(raw.candidates)) {
    return NextResponse.json({ error: 'candidates[] is required' }, { status: 400 })
  }
  const candidates: DuplicateCandidate[] = []
  for (const entry of raw.candidates) {
    if (typeof entry !== 'object' || entry === null) {
      return NextResponse.json({ error: 'Malformed candidate.' }, { status: 400 })
    }
    const c = entry as Record<string, unknown>
    const itemId   = typeof c.itemId === 'string' ? c.itemId : ''
    const checksum = typeof c.checksum === 'string' ? c.checksum.toLowerCase() : ''
    // A sha256 hex digest is exactly 64 hex chars — reject anything else rather than
    // querying Firestore with junk.
    if (!itemId || !/^[0-9a-f]{64}$/.test(checksum)) {
      return NextResponse.json({ error: 'Malformed candidate.' }, { status: 400 })
    }
    candidates.push({ itemId, checksum })
  }

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  // RD-MEDIA-08 — the batch ceiling is configuration, not a constant. Checked after the
  // event resolves because the limit can be overridden per event and per licence tier.
  const limits = await resolveMediaConfig({
    organizerUid: authz.workspaceUid, eventId, eventSlug: event.event.eventSlug,
  })
  const verdict = checkBatch(candidates.length, limits.maxUploadBatchSize)
  if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: verdict.status })

  const existing = await findByChecksums(
    authz.workspaceUid, eventId, candidates.map(c => c.checksum),
  )

  const body: DuplicateScanResponse = scanForDuplicates(candidates, existing)
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

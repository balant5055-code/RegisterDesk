// GET  /api/organizer/race-operations/badges?eventId=…   — generation status per race
// POST /api/organizer/race-operations/badges             — generate / regenerate a chunk
//
// RD-BADGE-01. Organizer-only, behind the EXISTING Race Operations gate (`requireAdmin` —
// owner or admin). No new permission.
//
// POST is CHUNKED and resumable, driven by repeated calls until `done`, matching the ranking
// and snapshot loops already in this module. Rendering is CPU-bound, so a bounded chunk keeps
// one request short instead of timing out on a 20,000-finisher race.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { resolveOwnedEvent } from '@/features/media-studio/services/authorize'
import { listLiveRacesForEvent, fetchLeaderboardPage } from '@/features/race-operations/repositories/snapshotRepo'
import { countForRace, generatedBibKeys } from '@/features/finisher-badges/repositories/badgeRepo'
import { ensureBadge } from '@/features/finisher-badges/services/badgeService'
import { bibKey } from '@/features/race-operations/utils/publicKeys'
import type { BadgeRaceStatusView } from '@/features/finisher-badges/types'

export interface BadgeStatusResponse {
  races: BadgeRaceStatusView[]
}

export interface BadgeGenerateResponse {
  generated:  number
  failed:     number
  skipped:    number
  done:       boolean
  nextCursor: number | null
}

/** Badges rendered per POST. Rendering is CPU-bound (Satori + resvg), so this is small on
 *  purpose — a bigger chunk risks a request timeout rather than finishing sooner. */
const CHUNK = 20

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = new URL(req.url).searchParams.get('eventId')?.trim() ?? ''
  if (!eventId) return NextResponse.json({ error: 'eventId is required' }, { status: 400 })

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const snapshots = await listLiveRacesForEvent(event.event.eventSlug)

  const races: BadgeRaceStatusView[] = await Promise.all(
    snapshots
      // Defence in depth: listLiveRacesForEvent is already tenant-blind (it is the public
      // reader), so ownership is re-checked here before anything organizer-facing is built.
      .filter(s => s.organizerUid === authz.workspaceUid)
      .map(async s => {
        const counts = await countForRace(authz.workspaceUid, s.eventSlug, s.passId)
        // `pending` is DERIVED, never stored per participant — writing 20,000 "nothing has
        // happened yet" records at publish time would be pure waste.
        const pending = Math.max(0, s.finisherCount - counts.generated - counts.failed)
        return {
          eventSlug: s.eventSlug,
          passSlug:  s.passSlug,
          raceName:  s.passName,
          eligible:  s.finisherCount,
          generated: counts.generated,
          failed:    counts.failed,
          pending,
          snapshotVersion: s.version,
        }
      }),
  )

  const body: BadgeStatusResponse = { races }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId  = typeof raw.eventId  === 'string' ? raw.eventId.trim()  : ''
  const passSlug = typeof raw.passSlug === 'string' ? raw.passSlug.trim() : ''
  const force    = raw.force === true
  const after    = typeof raw.cursor === 'number' && Number.isFinite(raw.cursor)
    ? raw.cursor : null

  if (!eventId || !passSlug) {
    return NextResponse.json({ error: 'eventId and passSlug are required' }, { status: 400 })
  }

  const event = await resolveOwnedEvent(authz.workspaceUid, eventId)
  if (!event.ok) return NextResponse.json({ error: event.error }, { status: event.status })

  const snapshots = await listLiveRacesForEvent(event.event.eventSlug)
  const snapshot  = snapshots.find(
    s => s.passSlug === passSlug && s.organizerUid === authz.workspaceUid,
  )
  if (!snapshot) {
    return NextResponse.json(
      { error: 'No published results for this race. Publish results before generating badges.' },
      { status: 409 },
    )
  }

  // Walk the leaderboard in rank order — the same cursor the public leaderboard uses, so the
  // pass is resumable and cannot skip or repeat a finisher.
  const page = await fetchLeaderboardPage(snapshot.snapshotId, snapshot.version, CHUNK, after)

  // A regenerate re-renders everything; a first run skips what already exists, so an
  // interrupted bulk run resumes cheaply instead of re-rendering from the start.
  const alreadyDone = force
    ? new Set<string>()
    : await generatedBibKeys(authz.workspaceUid, snapshot.eventSlug, snapshot.passId)

  let generated = 0, failed = 0, skipped = 0

  for (const row of page.rows) {
    if (!force && alreadyDone.has(bibKey(row.bibNumber))) { skipped++; continue }

    const outcome = await ensureBadge({
      eventSlug: snapshot.eventSlug, passSlug: snapshot.passSlug,
      bib: row.bibNumber, force,
    })
    if (outcome.ok) generated++
    else            failed++
  }

  const body: BadgeGenerateResponse = {
    generated, failed, skipped,
    done:       page.nextCursor === null,
    nextCursor: page.nextCursor,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

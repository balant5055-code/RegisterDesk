// GET  /api/organizer/race-operations/races?eventId=&passId=   — published version history
// POST /api/organizer/race-operations/races                    — roll back to a version
//
// RD-RESULTS-FIX-01 · The race-level surface. Sessions own an IMPORT; this owns the
// PUBLISHED race, which outlives any one import and is what history and rollback act on.
//
// Rollback writes no entries and rebuilds nothing: every published version's rows still
// exist (see `entryKey`), so restoring one is a single field change that every public query
// picks up on its next read.
//
// Same authorization as every other race-operations route — `authorizeRaceOps`, workspace
// owner or an `admin` team member. No new permission model.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import {
  listSnapshotVersions, rollbackSnapshot,
} from '@/features/race-operations/repositories/snapshotRepo'
import type { SnapshotVersionRecord } from '@/features/race-operations/types/snapshot'

export interface RaceVersionsResponse { versions: SnapshotVersionRecord[] }
export interface RaceRollbackResponse { version: number; previousVersion: number }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  const passId  = req.nextUrl.searchParams.get('passId')?.trim() ?? ''
  if (!eventId || !passId) {
    return NextResponse.json({ error: 'eventId and passId are required' }, { status: 400 })
  }

  // Resolved rather than trusted: the caller sends an eventId, and the snapshot is keyed by
  // slug. Going through the same resolver the publish path uses also re-checks ownership.
  const resolved = await resolveRace(authz.workspaceUid, eventId, passId)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  const versions = await listSnapshotVersions(
    resolved.race.eventSlug, passId, authz.workspaceUid,
  )
  const body: RaceVersionsResponse = { versions }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let raw: Record<string, unknown>
  try { raw = await req.json() as Record<string, unknown> }
  catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const eventId   = typeof raw.eventId === 'string' ? raw.eventId.trim() : ''
  const passId    = typeof raw.passId  === 'string' ? raw.passId.trim()  : ''
  const toVersion = typeof raw.toVersion === 'number' ? Math.trunc(raw.toVersion) : 0

  if (!eventId || !passId || toVersion < 1) {
    return NextResponse.json(
      { error: 'eventId, passId and a positive toVersion are required' }, { status: 400 },
    )
  }

  const resolved = await resolveRace(authz.workspaceUid, eventId, passId)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  const outcome = await rollbackSnapshot({
    eventSlug:    resolved.race.eventSlug,
    passId,
    organizerUid: authz.workspaceUid,
    toVersion,
    actorUid:     authz.callerUid,
  })
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status })

  const body: RaceRollbackResponse = {
    version: outcome.version, previousVersion: outcome.previousVersion,
  }
  return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } })
}

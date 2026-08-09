// GET /api/organizer/race-operations/races/export?eventId=&passId=&status=&format=csv
//
// RD-RESULTS-FIX-01 · Exports the PUBLISHED results of one race.
//
// ═══ WHY THE SNAPSHOT AND NOT THE SESSION ════════════════════════════════════
// An organizer asking for "the results" means what the public can see, which is the live
// snapshot version — not whichever draft import happens to exist. Exporting the session
// would hand out rows that were never published, and after a rollback it would disagree with
// the leaderboard.
//
// Streamed as one response rather than a job: the row cap is 50,000 and each row is a
// handful of short fields, so the whole file is a few megabytes at worst — well inside a
// response, and far simpler than a queue for something an organizer waits on.
//
// Reuses `csvCell` from lib/utils/csv, which carries the formula-injection defence every
// other export in this codebase uses. No local escaping.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeRaceOps } from '@/features/race-operations/services/authorize'
import { resolveRace } from '@/features/race-operations/repositories/eventReadRepo'
import {
  fetchLeaderboardPage, getLiveSnapshotByPass,
} from '@/features/race-operations/repositories/snapshotRepo'
import { csvCell } from '@/lib/utils/csv'
import { formatRaceTime } from '@/features/race-operations/import/validation/time'
import type { RaceResultStatus } from '@/features/race-operations/types/results'

/** Rows per read. The leaderboard index is cursor-paged, so this never scans. */
const PAGE = 500

/** Hard ceiling, matching the import cap. A race cannot contain more than this. */
const MAX_ROWS = 50_000

const COLUMNS = ['Rank', 'Bib', 'Name', 'Chip Time', 'Gun Time', 'Status'] as const

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeRaceOps(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const p       = req.nextUrl.searchParams
  const eventId = p.get('eventId')?.trim() ?? ''
  const passId  = p.get('passId')?.trim()  ?? ''
  // An unrecognised status is IGNORED rather than rejected — this is a view refinement
  // arriving from a URL a person may have edited, and a 400 would break the download
  // instead of returning everything.
  const raw     = p.get('status')?.trim().toLowerCase() ?? ''
  const status  = (['finished', 'dnf', 'dns', 'dq'] as const)
    .find(s => s === raw) as RaceResultStatus | undefined

  if (!eventId || !passId) {
    return NextResponse.json({ error: 'eventId and passId are required' }, { status: 400 })
  }

  // Ownership is established by resolving the race through the organizer's own workspace,
  // exactly as the publish and rollback paths do.
  const resolved = await resolveRace(authz.workspaceUid, eventId, passId)
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: resolved.status })

  const snapshot = await getLiveSnapshotByPass(resolved.race.eventSlug, passId)
  if (!snapshot) {
    return NextResponse.json(
      { error: 'These results have not been published yet.' }, { status: 404 },
    )
  }

  // ── Walk the live version ────────────────────────────────────────────────
  const lines: string[] = [COLUMNS.map(csvCell).join(',')]
  let after: number | null = null
  let rows = 0

  for (;;) {
    const page = await fetchLeaderboardPage(snapshot.snapshotId, snapshot.version, PAGE, after)
    for (const r of page.rows) {
      // Filtered AFTER the read because the leaderboard index orders by rank; adding a
      // status equality would need a second index for a report that is not on a hot path.
      if (status && r.status !== status) continue
      lines.push([
        r.overallRank === null ? '' : String(r.overallRank),
        r.bibNumber,
        r.name ?? '',
        r.chipTimeMs === null ? '' : formatRaceTime(r.chipTimeMs),
        r.gunTimeMs  === null ? '' : formatRaceTime(r.gunTimeMs),
        r.status.toUpperCase(),
      ].map(csvCell).join(','))
      rows++
    }
    if (page.nextCursor === null || rows >= MAX_ROWS) break
    after = page.nextCursor
  }

  // The filename carries the race and the VERSION, so two exports taken either side of a
  // republish are distinguishable on disk rather than silently overwriting each other.
  const name = `${resolved.race.eventSlug}-${snapshot.passSlug}-v${snapshot.version}`
    + (status ? `-${status}` : '') + '.csv'

  return new NextResponse(lines.join('\r\n'), {
    headers: {
      'Content-Type':        'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
      'Cache-Control':       'no-store',
    },
  })
}

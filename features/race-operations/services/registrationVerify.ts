// RD-RESULTS-FIX-01 · Verifying a draft import against the start list — SERVER ONLY.
//
// ═══ WHERE THIS SITS ═════════════════════════════════════════════════════════
// The import pipeline's existing validation is self-contained by design: it checks the file
// against itself and against the canonical model, and is forbidden from touching Firestore
// so a future vendor parser needs no change to it.
//
// This is the pass that DOES need the database. It reads the confirmed start list once and
// runs the pure matcher over the stored rows, then records the counts on the session so
// publish can refuse. Same shape as the ranking pass — a repository read, a pure engine, and
// a bounded walk — rather than a new subsystem.
//
// The whole file is loaded in one walk rather than chunked across requests: `MISSING_RESULT`
// is only answerable on the COMPLETE set (an entrant absent from page 1 may be on page 3),
// and the caps below keep that bounded.

import { fetchEventRoster } from '@/features/race-operations/repositories/eventReadRepo'
import { fetchStoredRowPage } from '@/features/race-operations/repositories/resultRepo'
import { getOwnedSession, saveRegistrationCheck } from '@/features/race-operations/repositories/sessionRepo'
import { bibKey } from '@/features/race-operations/utils/publicKeys'
import {
  hasBlockingRegistrationIssues, matchAgainstRoster,
  type RegistrationIssue,
} from '@/features/race-operations/import/validation/registrationMatch'
import type { ServiceOutcome } from './importService'

/** Rows read per page while walking the session. Same order of magnitude as the other passes. */
const PAGE = 500

/** How many issues are kept for display. The COUNTS are exact; only the list is capped. */
export const REGISTRATION_ISSUE_PREVIEW_LIMIT = 200

export interface RegistrationCheckResult {
  matched:       number
  unknownRunner: number
  wrongRace:     number
  missingResult: number
  /** True when publishing must be refused. */
  blocking:      boolean
  /** Capped for display; `unknownRunner + wrongRace + missingResult` is the real total. */
  issues:        RegistrationIssue[]
  /**
   * True when the event has more confirmed entrants than the roster cap.
   *
   * Reported rather than swallowed: with a truncated roster an `UNKNOWN_RUNNER` may be an
   * artefact of the cap, and an organizer must be told that before acting on it.
   */
  rosterTruncated: boolean
}

/**
 * Runs the check and records it on the session.
 *
 * Recorded rather than returned-only because publish happens in a later request, and
 * re-deriving the verdict there would mean loading the roster and every row a second time.
 */
export async function verifySessionRegistrations(params: {
  sessionId:    string
  workspaceUid: string
}): Promise<ServiceOutcome<RegistrationCheckResult>> {
  const session = await getOwnedSession(params.sessionId, params.workspaceUid)
  if (!session) return { ok: false, status: 404, error: 'Import session not found' }
  if (session.status !== 'draft') {
    return { ok: false, status: 409, error: `Cannot verify a ${session.status} import.` }
  }

  const { roster, truncated } = await fetchEventRoster({
    organizerUid: params.workspaceUid,
    eventSlug:    session.eventSlug,
  })

  // ── Walk every stored row ────────────────────────────────────────────────
  const rows: { rowNumber: number; bibNumber: string | null; bibKey: string }[] = []
  let cursor: number | null = null
  for (;;) {
    const page = await fetchStoredRowPage(params.sessionId, PAGE, cursor)
    for (const r of page.rows) {
      rows.push({
        rowNumber: r.rowNumber,
        bibNumber: r.bibNumber ?? null,
        bibKey:    r.bibNumber ? bibKey(r.bibNumber) : '',
      })
    }
    if (page.nextCursor === null) break
    cursor = page.nextCursor
  }

  const result = matchAgainstRoster({
    passId: session.passId,
    rows,
    roster,
    // Only meaningful against a complete roster. With a truncated one, "missing" would
    // mostly mean "beyond the cap", which is noise an organizer would have to ignore.
    detectMissing: !truncated,
  })

  const blocking = hasBlockingRegistrationIssues(result)

  await saveRegistrationCheck(params.sessionId, {
    matched:       result.matched,
    unknownRunner: result.unknownRunner,
    wrongRace:     result.wrongRace,
    missingResult: result.missingResult,
  })

  return {
    ok: true,
    value: {
      matched:       result.matched,
      unknownRunner: result.unknownRunner,
      wrongRace:     result.wrongRace,
      missingResult: result.missingResult,
      blocking,
      issues:        result.issues.slice(0, REGISTRATION_ISSUE_PREVIEW_LIMIT),
      rosterTruncated: truncated,
    },
  }
}

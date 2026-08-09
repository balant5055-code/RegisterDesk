// RD-RACEOPS-01 Sprint 4 · Certificate result lookup — SERVER ONLY.
//
// ─── This is the approved decision D3 ────────────────────────────────────────
// `lib/certificates/generate.ts` has always accepted `distance`, `finishTime` and
// `position`, and the placeholder registry has always exposed {{distance}},
// {{finishTime}} and {{position}}. Both issue paths passed `''` for all three, so every
// certificate ever produced rendered those tokens blank. This module supplies the values.
//
// ─── Contract with the certificate module ────────────────────────────────────
// READ-ONLY, and FAIL-SOFT. It reads the Official Snapshot and returns empty strings when
// there is nothing to say. A caller that finds no results gets exactly the `''` values it
// used before, so certificate behaviour for a non-race event — or a race with no published
// results — is byte-identical to Sprint 3.
//
// It never throws: a certificate must never fail to issue because a results lookup had a
// bad day.

import {
  getLiveSnapshotByPass, fetchByBib,
} from '@/features/race-operations/repositories/snapshotRepo'
import { formatRaceTime } from '@/features/race-operations/import/validation/time'
import { ordinal } from '@/features/race-operations/utils/ordinal'

/** Exactly the three fields the certificate input needs. */
export interface CertificateRaceResult {
  distance:   string
  finishTime: string
  position:   string
}

const EMPTY: CertificateRaceResult = { distance: '', finishTime: '', position: '' }

/**
 * Resolves a registration's published race result.
 *
 * Direction matters: this goes registration → bib → snapshot, which is the EASY direction
 * and needs no new index. (The reverse — bib → registration — is what a public certificate
 * download would need, and is deliberately not built; see the Sprint 4 report.)
 *
 * `finishTime` is the CHIP time. That is the participant's own net elapsed time and is what
 * a finisher expects on a certificate; gun time is not used. Recorded as a decision in
 * docs/RD-RACEOPS-PUBLIC-RESULTS.md.
 *
 * `position` is the overall rank within the race, rendered as an ordinal.
 */
export async function resolveCertificateRaceResult(params: {
  eventSlug: string
  passId:    string
  bibNumber: string | null | undefined
}): Promise<CertificateRaceResult> {
  const { eventSlug, passId, bibNumber } = params
  if (!bibNumber || !eventSlug || !passId) return EMPTY

  try {
    const snapshot = await getLiveSnapshotByPass(eventSlug, passId)
    if (!snapshot) return EMPTY

    const row = await fetchByBib(snapshot.snapshotId, snapshot.version, bibNumber)
    if (!row) return EMPTY

    return {
      distance:   snapshot.passName,
      finishTime: row.chipTimeMs !== null ? formatRaceTime(row.chipTimeMs) : '',
      position:   row.overallRank !== null ? ordinal(row.overallRank) : '',
    }
  } catch {
    // Fail soft — never block certificate issuance on a results read.
    return EMPTY
  }
}

// RD-BIB-01 · Matching — the decision.
//
// PURE. No SDK, no I/O. Candidates are resolved by the service and handed in already
// resolved, so the rule that decides whether a photo is linked to a runner can be proven by
// test rather than inferred from a Firestore trace.
//
// ─── The rules ───────────────────────────────────────────────────────────────
//   exactly one published runner  → matched, linked
//   none                          → unmatched, kept as evidence
//   more than one                 → ambiguous, EVERY candidate stored, nothing guessed
//
// The third rule is not in the brief, and it is not optional. See the header of
// `services/matchService.ts` and § "Bibs are unique per RACE" in docs/RD-BIB-DETECTION.md.

import type {
  BibDetection, BibMatchCandidate, BibMatchStatus,
} from '@/features/bib-detection/types'

export interface DetectionWithCandidates {
  detection:  BibDetection
  /** Every live race in this event whose published results contain this bib. */
  candidates: readonly BibMatchCandidate[]
}

export interface MatchDecision {
  detection:   BibDetection
  matchStatus: BibMatchStatus
  candidates:  BibMatchCandidate[]
  /**
   * The version this decision was made against — only meaningful when exactly one race
   * matched. An ambiguous link has no single snapshot to be stale against.
   */
  snapshotVersion: number | null
}

/** Same race twice is one candidate. Defensive: a caller bug must not read as ambiguity. */
function dedupeByPass(candidates: readonly BibMatchCandidate[]): BibMatchCandidate[] {
  const byPass = new Map<string, BibMatchCandidate>()
  for (const c of candidates) if (!byPass.has(c.passId)) byPass.set(c.passId, c)
  // Deterministic order, so a stored document does not churn between identical runs.
  return [...byPass.values()].sort((a, b) => a.passId.localeCompare(b.passId))
}

export function decideMatch(input: DetectionWithCandidates): MatchDecision {
  const candidates = dedupeByPass(input.candidates)

  if (candidates.length === 0) {
    // Kept, not discarded. An unmatched bib means either the results are incomplete or the
    // read was wrong, and both are things an organizer needs to be able to see.
    return { detection: input.detection, matchStatus: 'unmatched', candidates: [], snapshotVersion: null }
  }

  if (candidates.length === 1) {
    return {
      detection:       input.detection,
      matchStatus:     'matched',
      candidates,
      snapshotVersion: candidates[0].snapshotVersion,
    }
  }

  // Two races in one event can both have a bib 101 — bibs are unique WITHIN a race. Picking
  // one would attach a stranger's photograph to a runner, so nothing is picked.
  return { detection: input.detection, matchStatus: 'ambiguous', candidates, snapshotVersion: null }
}

export function decideMatches(inputs: readonly DetectionWithCandidates[]): MatchDecision[] {
  return inputs.map(decideMatch)
}

// ─── Confidence ───────────────────────────────────────────────────────────────

/**
 * Confidence is STORED and never acted on.
 *
 * No threshold rejects a detection, and none silently hides one. A model that is 61% sure
 * has still read something, and the decision about what that is worth belongs to the
 * organizer reviewing it — which is exactly why `reviewStatus` exists and starts `pending`.
 *
 * These bands are for DISPLAY only. Nothing in the pipeline branches on them.
 */
export type ConfidenceBand = 'high' | 'medium' | 'low'

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.9) return 'high'
  if (confidence >= 0.7) return 'medium'
  return 'low'
}

/** `95%` — the form the brief's examples use. */
export function formatConfidence(confidence: number): string {
  const pct = Math.round(Math.min(1, Math.max(0, confidence)) * 100)
  return `${pct}%`
}

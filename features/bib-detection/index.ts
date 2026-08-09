// RD-BIB-01 · Bib detection — the module's PUBLIC surface.
//
// Routes import from HERE and nothing deeper.
//
// ─── Contract ────────────────────────────────────────────────────────────────
//   • Bib NUMBERS only. No faces, no people, no other text. `parseDetectionPayload`
//     constructs its output field by field and drops everything else, so a provider that
//     returned a face has nowhere to put it.
//   • Matching reads the OFFICIAL SNAPSHOT and nothing else. Draft imports are unreachable
//     from this module — not by policy, by import graph.
//   • Exact bib match only. No fuzzy matching: a bib is an identifier.
//   • More than one candidate → stored as ambiguous, linked to none. Bibs are unique per
//     RACE, not per event.
//   • Confidence is stored and never acted on. Nothing is auto-rejected.
//   • Every link starts `reviewStatus: 'pending'`.
//   • Links are ORGANIZER-ONLY. No public route reads them.
//   • Permissions reuse the EXISTING `events` permission. No new RBAC.
//
// Architecture: docs/RD-BIB-DETECTION.md

// ── The capability ──────────────────────────────────────────────────────────
export {
  consumeBibDetectionResult, getDetectionJob, rematchAsset, startBibDetection, summarise,
} from './services/detectionService'
export type { DetectionOutcome } from './services/detectionService'

// ── Matching (server) ───────────────────────────────────────────────────────
export { loadLiveRaces, matchDetections, resolveCandidates } from './services/matchService'
export type { LiveRace } from './services/matchService'

// ── Pure engines (no SDK, no DOM, no I/O — unit-tested) ─────────────────────
export {
  MAX_DETECTIONS_PER_PHOTO, parseBoundingBox, parseDetectionPayload, readStoredPayload,
} from './utils/payload'
export type { ParsedPayload } from './utils/payload'

export { confidenceBand, decideMatch, decideMatches, formatConfidence } from './matching/matcher'
export type { ConfidenceBand, DetectionWithCandidates, MatchDecision } from './matching/matcher'

export { buildLink, buildLinks, linkId, serializeLink, toBibSummary } from './utils/linkDoc'
export type { BuildLinkInput, PhotoBibLinkSeed } from './utils/linkDoc'

// ── Domain types ────────────────────────────────────────────────────────────
export {
  BIB_DETECT_KIND, BIB_REVIEW_STATUSES, BIB_SCHEMA_VERSION, EMPTY_BIB_SUMMARY,
  PHOTO_BIB_LINKS, isBibReviewStatus,
} from './types'
export type {
  BibDetection, BibDetectionPayload, BibDetectionSummary, BibMatchCandidate, BibMatchStatus,
  BibReviewStatus, BoundingBox, PhotoBibLinkDoc, PhotoBibLinkView,
} from './types'

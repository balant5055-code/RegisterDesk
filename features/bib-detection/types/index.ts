// RD-BIB-01 · Bib detection — domain types.
//
// SDK-FREE by contract: no firebase-admin, no provider SDK, no next/*, no React.
//
// ═══ WHAT THIS FEATURE IS, AND IS NOT ═════════════════════════════════════════
// It reads NUMBERS printed on a race bib and links a photo to a published result row.
//
// It does NOT detect faces, identify people, compare people, or read any other text. There
// is no field here for a face, a landmark, a person, or arbitrary text — a provider that
// returned one would have nowhere to put it, and `parseDetectionPayload` drops every key it
// does not recognise. The restriction is structural, not a policy note.
// ══════════════════════════════════════════════════════════════════════════════

export const PHOTO_BIB_LINKS = 'photoBibLinks'

/** Bump when a stored shape changes; readers refuse an unknown version. */
export const BIB_SCHEMA_VERSION = 1

/** The AI job kind this capability serves. */
export const BIB_DETECT_KIND = 'bib-detect'

// ─── What a provider returns ──────────────────────────────────────────────────

/**
 * Where the bib sits in the frame, as FRACTIONS of the image (0–1).
 *
 * Normalised rather than pixels so a box stays valid across renditions: detection runs on
 * the medium rendition, and a future crop or thumbnail must be able to use the same box
 * without knowing which size produced it.
 */
export interface BoundingBox {
  x:      number   // left edge, 0–1
  y:      number   // top edge, 0–1
  width:  number   // 0–1
  height: number   // 0–1
}

/**
 * ONE bib a provider claims to see.
 *
 * This is the provider's ENTIRE vocabulary. It reports what it read and how sure it is —
 * nothing else. Whether that bib means anything is decided by the matcher, from the
 * published snapshot, in code no vendor can influence.
 */
export interface BibDetection {
  /** The bib exactly as read. */
  bibNumber:  string
  /** Normalised for lookup — the SAME normaliser the snapshot used to key its entries. */
  bibKey:     string
  /** 0–1. Stored, never used to reject: see `docs/RD-BIB-DETECTION.md`. */
  confidence: number
  boundingBox: BoundingBox | null
}

/** The payload shape stored in `aiResults.payload` for a `bib-detect` job. */
export interface BibDetectionPayload {
  detections: BibDetection[]
}

// ─── Matching ─────────────────────────────────────────────────────────────────

/**
 * `matched`    — exactly one published runner carries this bib in this event.
 * `unmatched`  — no published result carries it. Kept, not discarded: it is evidence the
 *                results are incomplete, or that the read was wrong.
 * `ambiguous`  — more than one race in the event has a runner with this bib. Bibs are
 *                unique WITHIN a race, not within an event, so this is normal and NOT an
 *                error. Every candidate is stored and nothing is guessed.
 */
export type BibMatchStatus = 'matched' | 'unmatched' | 'ambiguous'

/** Organizer review of a link. Every link starts `pending`. No UI is built in this sprint. */
export type BibReviewStatus = 'pending' | 'verified' | 'rejected'

export const BIB_REVIEW_STATUSES: readonly BibReviewStatus[] = ['pending', 'verified', 'rejected']

export function isBibReviewStatus(v: unknown): v is BibReviewStatus {
  return typeof v === 'string' && (BIB_REVIEW_STATUSES as readonly string[]).includes(v)
}

/**
 * One published runner a detected bib could be.
 *
 * A POINTER, deliberately. It carries no name, no time and no rank — those live in the
 * snapshot, are read from there when needed, and are therefore never a stale second copy.
 * It also means this collection holds no personal data about a participant beyond the bib
 * that was printed on their chest in a photograph that is already published.
 */
export interface BibMatchCandidate {
  passId:   string
  passSlug: string
  passName: string
  /** The snapshot version this candidate was found in. */
  snapshotVersion: number
}

// ─── The stored link ──────────────────────────────────────────────────────────

/**
 * photoBibLinks/{assetId}__{bibKey}
 *
 * ONE document per (photo, bib). A photo showing three bibs produces three links; the same
 * bib detected twice in one frame produces one, keeping the higher confidence.
 */
export interface PhotoBibLinkDoc {
  linkId:        string
  schemaVersion: number

  // ── Tenancy + subject ──
  organizerUid: string
  eventId:      string
  eventSlug:    string
  /** The Media Studio asset. `photoId` in the brief's vocabulary. */
  assetId:      string
  galleryId:    string
  albumId:      string | null

  // ── What was detected ──
  bibNumber:   string
  bibKey:      string
  confidence:  number
  boundingBox: BoundingBox | null

  // ── Provenance ──
  provider:        string
  modelVersion:    string | null
  pipelineVersion: number
  jobId:           string
  resultId:        string

  // ── What it matched ──
  matchStatus: BibMatchStatus
  /** Empty when unmatched; one entry when matched; several when ambiguous. */
  candidates:  BibMatchCandidate[]
  /**
   * The snapshot version this link was decided against, or null when unmatched.
   * A re-publish bumps the version, which is how a stale link is identified later.
   */
  snapshotVersion: number | null

  reviewStatus: BibReviewStatus
  /** Set when a human moved it off `pending`. */
  reviewedBy:   string | null
  reviewedAt:   unknown | null

  detectedAt: unknown
  createdAt:  unknown
  updatedAt:  unknown
}

// ─── Serialised views ─────────────────────────────────────────────────────────

export interface PhotoBibLinkView {
  linkId:      string
  assetId:     string
  galleryId:   string
  bibNumber:   string
  confidence:  number
  boundingBox: BoundingBox | null
  provider:      string
  modelVersion:  string | null
  matchStatus:   BibMatchStatus
  candidates:    BibMatchCandidate[]
  snapshotVersion: number | null
  reviewStatus:  BibReviewStatus
  detectedAt:    string | null
}

/** Per-event tallies. */
export interface BibDetectionSummary {
  matched:   number
  unmatched: number
  ambiguous: number
  pending:   number
  verified:  number
  rejected:  number
  total:     number
}

export const EMPTY_BIB_SUMMARY: BibDetectionSummary = {
  matched: 0, unmatched: 0, ambiguous: 0,
  pending: 0, verified: 0, rejected: 0, total: 0,
}

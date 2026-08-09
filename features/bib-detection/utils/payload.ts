// RD-BIB-01 · The provider payload contract.
//
// PURE. No SDK, no I/O.
//
// ═══ THE PRIVACY BOUNDARY ═════════════════════════════════════════════════════
// Everything a provider says passes through here, and this function CONSTRUCTS its output
// field by field — it never spreads the input. A provider that returned faces, landmarks,
// names, ages, genders or free text would have all of it dropped at this line, before
// anything reached Firestore.
//
// That is why "no face recognition" is a property of the code rather than a promise: there
// is no path from a provider's response to storage that preserves a field this parser does
// not name.
// ══════════════════════════════════════════════════════════════════════════════

import { bibKey, isPlausibleBib } from '@/features/race-operations/utils/publicKeys'
import type { BibDetection, BibDetectionPayload, BoundingBox } from '@/features/bib-detection/types'

/**
 * Most detections we keep from one photo.
 *
 * A start-line frame can legitimately contain dozens of bibs, and each becomes a document.
 * The cap bounds that write amplification; `parseDetectionPayload` reports how many were
 * dropped so a truncation is never silent.
 */
export const MAX_DETECTIONS_PER_PHOTO = 50

const isFiniteNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v)

/** Clamps into 0–1. A provider adapter is responsible for scaling; this is the backstop. */
function clampUnit(v: unknown): number {
  if (!isFiniteNumber(v)) return 0
  return Math.min(1, Math.max(0, v))
}

/**
 * A bounding box, or null.
 *
 * Never a reason to discard a detection: a bib that was read correctly is useful even if the
 * box is nonsense, and dropping the read would lose the only thing that matters.
 */
export function parseBoundingBox(raw: unknown): BoundingBox | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>

  const x = r.x, y = r.y
  const width  = r.width  ?? r.w
  const height = r.height ?? r.h

  if (![x, y, width, height].every(isFiniteNumber)) return null

  const box: BoundingBox = {
    x:      clampUnit(x),
    y:      clampUnit(y),
    width:  clampUnit(width),
    height: clampUnit(height),
  }

  // A zero-area box says nothing about where the bib is.
  if (box.width <= 0 || box.height <= 0) return null
  // A box that runs off the frame means the coordinates were not normalised as promised.
  if (box.x + box.width > 1.0001 || box.y + box.height > 1.0001) return null

  return box
}

export interface ParsedPayload {
  payload: BibDetectionPayload
  /** Entries the provider sent that were not usable — malformed, or not a plausible bib. */
  discarded: number
  /** Detections beyond `MAX_DETECTIONS_PER_PHOTO`, dropped after sorting by confidence. */
  truncated: number
  /** Repeat reads of the same bib in one frame, folded into one. */
  deduplicated: number
}

/**
 * Normalises whatever a provider returned into the stored shape.
 *
 * Total: it never throws. A malformed payload yields zero detections, which the pipeline
 * records as a photo with no bibs — indistinguishable from an honest empty result, and
 * correctly so, because both mean "nothing to link".
 */
export function parseDetectionPayload(raw: unknown): ParsedPayload {
  const empty: ParsedPayload = {
    payload: { detections: [] }, discarded: 0, truncated: 0, deduplicated: 0,
  }

  if (typeof raw !== 'object' || raw === null) return empty
  const list = (raw as Record<string, unknown>).detections
  if (!Array.isArray(list)) return empty

  let discarded = 0
  const parsed: BibDetection[] = []

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) { discarded++; continue }
    const e = entry as Record<string, unknown>

    const bibNumber = typeof e.bibNumber === 'string' ? e.bibNumber.trim()
      : typeof e.bib === 'string' ? e.bib.trim()
      : ''

    // The same guard the public results pages use. A "bib" that could never appear in a
    // results file cannot have been read off a bib.
    if (!bibNumber || !isPlausibleBib(bibNumber)) { discarded++; continue }

    const key = bibKey(bibNumber)

    // A bib carries a NUMBER. A purely alphabetic read — "FINISH", "SPONSOR", "NIKE" — is
    // text from somewhere else in the frame, and this feature does not do banner OCR. It
    // would otherwise pass the shape guard above, which only knows that a bib is
    // alphanumeric, and go on to sit in the queue as an unmatched detection forever.
    if (!/[0-9]/.test(key)) { discarded++; continue }

    parsed.push({
      bibNumber,
      // The SAME normaliser the snapshot keyed its entries with. If these ever diverge,
      // every lookup silently misses — which is why it is imported, not reimplemented.
      bibKey:      key,
      confidence:  clampUnit(e.confidence),
      boundingBox: parseBoundingBox(e.boundingBox ?? e.bbox ?? null),
    })
  }

  // ── Fold repeat reads of one bib ──
  // Two boxes reading "101" in one frame is one runner seen once, not twice. The higher
  // confidence wins, and its box comes with it.
  const byBib = new Map<string, BibDetection>()
  let deduplicated = 0
  for (const d of parsed) {
    const seen = byBib.get(d.bibKey)
    if (!seen) { byBib.set(d.bibKey, d); continue }
    deduplicated++
    if (d.confidence > seen.confidence) byBib.set(d.bibKey, d)
  }

  // Highest confidence first, so a truncation drops the least certain reads.
  const ordered = [...byBib.values()].sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence
    return a.bibKey.localeCompare(b.bibKey)   // deterministic tie-break
  })

  const kept      = ordered.slice(0, MAX_DETECTIONS_PER_PHOTO)
  const truncated = ordered.length - kept.length

  return { payload: { detections: kept }, discarded, truncated, deduplicated }
}

/** Reads a stored `aiResults.payload` back into the typed shape. */
export function readStoredPayload(raw: unknown): BibDetectionPayload {
  return parseDetectionPayload(raw).payload
}

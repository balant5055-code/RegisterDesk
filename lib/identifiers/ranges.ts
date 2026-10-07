// RD-EVENT-19A — Participant Identity Platform: numeric range domain.
//
// PURE. No I/O, no SDK, no Firestore — so the allocator, the config validator and
// (later) the allocation UI all reason about ranges through ONE implementation.
//
// ─── Why a pool needs more than one range ───────────────────────────────────
//
// An organizer hands out printed identifiers per pass, and the printed blocks are
// rarely contiguous. One pass may own 5001–5999 and 7000–7500 while another owns
// 8000–8799. Walking those in order must produce
//   5001 … 5999, 7000 … 7500
// and NEVER 6000–6999, which nobody printed.
//
// Nothing here knows what a pass "is". These are numbers.
//
// ─── Precedence, stated once ────────────────────────────────────────────────
//
//   pool.ranges[]  present and non-empty  ⇒ AUTHORITATIVE. rangeStart/rangeEnd
//                                           are IGNORED, never merged.
//   otherwise                             ⇒ the legacy rangeStart/rangeEnd pair.
//
// Merging the two could invent a range the organizer never configured, which is
// the one outcome a printed identifier cannot survive.

import { IdentifierConfigError } from './types'
import type { IdentifierPool, IdentifierRange } from './types'

/** Structural subset of a pool that carries range configuration. */
export type RangeBearing = Pick<IdentifierPool, 'ranges' | 'rangeStart' | 'rangeEnd'>

function isRangeInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n) && n >= 0
}

// ─── Reading a pool's ranges ────────────────────────────────────────────────

/**
 * The pool's explicitly configured `ranges[]`, ascending. Returns `[]` when the
 * pool declares none — which is how a caller tells "multi-range pool" from
 * "legacy single range or unbounded".
 *
 * Deliberately tolerant of a malformed stored entry: a range that is not a pair
 * of ordered non-negative integers is DROPPED rather than throwing, because this
 * is also the read path for an already-persisted document. `validateRanges`
 * is the write-side gate that stops such an entry being stored in the first place.
 */
export function configuredRanges(pool: RangeBearing | null | undefined): IdentifierRange[] {
  const raw = pool?.ranges
  if (!Array.isArray(raw) || raw.length === 0) return []
  return raw
    .filter((r): r is IdentifierRange =>
      !!r && typeof r === 'object' && isRangeInt((r as IdentifierRange).start) &&
      isRangeInt((r as IdentifierRange).end) && (r as IdentifierRange).start <= (r as IdentifierRange).end)
    .map(r => ({ start: r.start, end: r.end }))
    .sort((a, b) => a.start - b.start)
}

/**
 * Every range the pool effectively occupies, including the legacy pair.
 *
 * Used for VALIDATION, capacity and overlap reporting — not by the allocator,
 * which keeps the legacy scalar path untouched (see `nextNumberInRanges`).
 * A half-bounded legacy pool (a start with no end, or an end with no start) has
 * no closed range and yields `[]`.
 */
export function effectiveRanges(pool: RangeBearing | null | undefined): IdentifierRange[] {
  const explicit = configuredRanges(pool)
  if (explicit.length > 0) return explicit
  const start = pool?.rangeStart
  const end   = pool?.rangeEnd
  if (isRangeInt(start) && isRangeInt(end) && start <= end) return [{ start, end }]
  return []
}

/** True when the pool declares `ranges[]` AND a legacy pair, so the pair is ignored. */
export function hasSupersededLegacyRange(pool: RangeBearing | null | undefined): boolean {
  return configuredRanges(pool).length > 0 && (pool?.rangeStart != null || pool?.rangeEnd != null)
}

// ─── Membership / walking ───────────────────────────────────────────────────

export function isInRanges(ranges: IdentifierRange[], n: number): boolean {
  return ranges.some(r => n >= r.start && n <= r.end)
}

/**
 * The next allocatable number at or after `n`.
 *
 *   • `n` inside a range          → `n` itself
 *   • `n` in a gap between ranges → the start of the next range (5999 + 1 → 7000)
 *   • `n` past every range        → `null`, i.e. POOL_EXHAUSTED
 *   • no ranges configured        → `n` (unbounded pool; the caller decides)
 *
 * Ranges need not be pre-sorted; this sorts defensively.
 */
export function nextNumberInRanges(ranges: IdentifierRange[], n: number): number | null {
  if (ranges.length === 0) return n
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  for (const r of sorted) {
    if (n <= r.end) return Math.max(n, r.start)
  }
  return null
}

/**
 * RD-BIB-01 · the range set as an organizer reads it: `5001–5600`, or
 * `5001–5100 + 7001–7050` when there are several.
 *
 * ONE formatter, used by the engine's refusal message, the plan, the confirmation
 * and the result — so the numbers an organizer is shown before a run are written
 * the same way as the numbers they are shown after it, and as the ones in the error
 * if a manual value is refused. An en dash, because these are ranges, not subtractions.
 */
export function describeRanges(ranges: IdentifierRange[]): string {
  if (ranges.length === 0) return 'No limit'
  return [...ranges]
    .sort((a, b) => a.start - b.start)
    .map(r => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`))
    .join(' + ')
}

/** Total identifiers across every range (inclusive bounds). */
export function rangeCapacity(ranges: IdentifierRange[]): number {
  return ranges.reduce((sum, r) => sum + Math.max(0, r.end - r.start + 1), 0)
}

// ─── Overlap ────────────────────────────────────────────────────────────────

/** Inclusive-bound overlap. Adjacent ranges (5999 / 6000) do NOT overlap. */
export function rangesOverlap(a: IdentifierRange, b: IdentifierRange): boolean {
  return a.start <= b.end && b.start <= a.end
}

/** The first overlapping pair, or null. Used for both intra-pool and cross-pool checks. */
export function firstOverlap(ranges: IdentifierRange[]): [IdentifierRange, IdentifierRange] | null {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  for (let i = 1; i < sorted.length; i++) {
    if (rangesOverlap(sorted[i - 1], sorted[i])) return [sorted[i - 1], sorted[i]]
  }
  return null
}

// ─── Write-side validation ──────────────────────────────────────────────────

/**
 * Rejects a `ranges[]` value before it can be persisted. Throws
 * IdentifierConfigError (→ HTTP 400) with a message naming the range.
 *
 * RD-BIB-UX-02 · these messages are shown to ORGANIZERS — inline in the range
 * editor and in the toast when the API refuses a save — so they say "number
 * range", not "pool". The internal identifier is still the poolId; only the noun
 * the reader sees changed.
 *
 * Rejects: non-array, empty array, non-object entries, non-integers, NaN,
 * ±Infinity, negatives, start > end, duplicate ranges, overlapping ranges.
 *
 * Deliberately imposes NO maximum range size or count — the platform has no such
 * existing limit and inventing one here would silently cap a legitimate event.
 */
export function validateRanges(raw: unknown, poolId: string): IdentifierRange[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new IdentifierConfigError(`Number range "${poolId}" ranges must be a list.`)
  if (raw.length === 0) {
    throw new IdentifierConfigError(`Number range "${poolId}" ranges cannot be an empty list — remove the field instead.`)
  }

  const out: IdentifierRange[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      throw new IdentifierConfigError(`Number range "${poolId}" has a range that is not a { start, end } pair.`)
    }
    const { start, end } = entry as { start?: unknown; end?: unknown }
    if (!isRangeInt(start) || !isRangeInt(end)) {
      throw new IdentifierConfigError(
        `Number range "${poolId}" range bounds must be non-negative whole numbers.`,
      )
    }
    if (start > end) {
      throw new IdentifierConfigError(`Number range "${poolId}" range ${start}–${end} starts after it ends.`)
    }
    if (out.some(r => r.start === start && r.end === end)) {
      throw new IdentifierConfigError(`Number range "${poolId}" lists the range ${start}–${end} twice.`)
    }
    out.push({ start, end })
  }

  const clash = firstOverlap(out)
  if (clash) {
    throw new IdentifierConfigError(
      `Number range "${poolId}" ranges ${clash[0].start}–${clash[0].end} and ${clash[1].start}–${clash[1].end} overlap.`,
    )
  }
  return out.sort((a, b) => a.start - b.start)
}

// ─── Range-editing safety (consumed by a later phase's UI) ──────────────────

/**
 * RD-BIB-01 · does `outer` cover every number `inner` covers?
 *
 * The cheap half of range-edit safety. Widening 5001–5600 to 5001–6000, or merging
 * 5001–5100 and 5101–5200 into 5001–5200, cannot possibly strand anything — so the
 * expensive verification below is skipped entirely for those edits. Only a shrink,
 * a move or a split has to be counted.
 */
export function rangesContain(outer: IdentifierRange[], inner: IdentifierRange[]): boolean {
  if (inner.length === 0) return true
  if (outer.length === 0) return false        // a bounded set never contains an unbounded one
  const sorted = [...outer].sort((a, b) => a.start - b.start)
  return inner.every(r => {
    let cursor = r.start
    for (const o of sorted) {
      if (o.start > cursor) return false      // a hole before this block
      if (o.end >= cursor) cursor = o.end + 1
      if (cursor > r.end) return true
    }
    return cursor > r.end
  })
}

/**
 * RD-BIB-01 · the numeric bands a proposed range set does NOT cover, bounded below
 * by 0 and above by `ceiling`.
 *
 * This is what turns "is anything stranded?" into a small, fixed number of counting
 * queries instead of a scan: one aggregate per band, and there is one more band than
 * there are ranges. For 5001–5100 + 7001–7050 the bands are 0–5000, 5101–7000 and
 * 7051–ceiling — exactly the places an already-issued number must not be.
 */
export function bandsOutside(ranges: IdentifierRange[], ceiling: number): IdentifierRange[] {
  if (ranges.length === 0) return []          // unbounded ⇒ nothing is outside
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const bands: IdentifierRange[] = []
  let cursor = 0
  for (const r of sorted) {
    if (r.start > cursor) bands.push({ start: cursor, end: r.start - 1 })
    cursor = Math.max(cursor, r.end + 1)
  }
  if (cursor <= ceiling) bands.push({ start: cursor, end: ceiling })
  return bands
}

/**
 * RD-EVENT-19A · the numbers that a proposed range set would leave STRANDED.
 *
 * Changing a pool's ranges must never silently invalidate an identifier somebody
 * is already carrying: if 5500 is assigned and the ranges become 6000–7000, 5500
 * is now outside its own pool. This reports that, in full, so a caller can refuse
 * or require an explicit decision.
 *
 * PURE and read-only by construction — it takes the numbers, returns the strays,
 * and cannot release, reassign or delete anything. Nothing calls it yet; it is
 * the contract RD-EVENT-19D's range editor is required to consult.
 */
export function strandedByRanges(
  proposed: IdentifierRange[],
  assignedNumerics: readonly (number | null | undefined)[],
): number[] {
  if (proposed.length === 0) return []          // unbounded ⇒ nothing can be stranded
  const stray = assignedNumerics.filter(
    (n): n is number => typeof n === 'number' && Number.isFinite(n) && !isInRanges(proposed, n),
  )
  return [...new Set(stray)].sort((a, b) => a - b)
}

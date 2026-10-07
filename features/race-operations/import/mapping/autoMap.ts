// RD-RACEOPS-01 Sprint 2 · Column auto-mapping.
//
// PURE. Proposes a ColumnMapping from a file's headers using the alias table. The
// organizer confirms or corrects it in the mapping step; nothing here is final.
//
// RD-RACEOPS-02C · DETERMINISTIC AND ORDER-INDEPENDENT. The first version walked the
// headers in file order and gave a field to the first header whose alias resolved to it,
// so `Bib No | Finish Time | Chip Time` mapped chip ← Finish Time and left the real chip
// column unused (AUDIT-01 P1-1). Now every header that could serve a field is a
// CANDIDATE, and the best candidate wins by (alias tier, alias preference, header
// position) — position is only the final tiebreak, so the same headers in any order give
// the same mapping. Fields are decided in a fixed priority so chip time is settled before
// gun time, which lets "Finish Time" fall through to gun time when a chip column exists.
//
// Every decision also carries a CONFIDENCE. `exact` means an unambiguous alias matched and
// no other header competed for the field; `review` means the mapping is a guess — a
// generic alias ("Finish Time", "Time"), a substring match, or two headers that could both
// be this field. The mapping panel shows the difference instead of a green tick.

import type { ColumnMapping, ResultField } from '@/features/race-operations/types/results'
import { RESULT_FIELDS } from '@/features/race-operations/types/results'
import {
  ALIAS_RANK, ALIAS_TO_FIELD, GUN_WHEN_CHIP_PRESENT, aliasTier, isClockTimeHeading,
  isProviderCalculatedHeading, isSegmentScopedHeading, normalizeHeader,
} from './aliases'

export type MappingConfidence = 'exact' | 'review'

export interface AutoMapResult {
  mapping:          ColumnMapping
  unmappedHeaders:  string[]
  /**
   * RD-RACEOPS-RESULTS-04 · headers RegisterDesk calculates for itself (provider ranks,
   * pace, speed). Recognised and deliberately not mapped, so the validation report can say
   * so instead of listing them as unknown columns.
   */
  calculatedHeaders: string[]
  /** Per mapped field: was the choice unambiguous, or does it need a human look? */
  confidence:       Partial<Record<ResultField, MappingConfidence>>
}

/** Decision order: identity, then chip time BEFORE gun time, then the rest. */
const FIELD_PRIORITY: readonly ResultField[] = [
  'bibNumber', 'chipTime', 'gunTime', 'status', 'participantName', 'gender', 'category', 'ageGroup',
  // RD-RACEOPS-RESULTS-04 · last, and exact-only (see EXACT_ONLY_FIELDS): a wrong distance
  // silently halves or doubles every pace on the page.
  'distance',
]

/** Fields that accept ONLY an exact alias — never a generic one, never a substring. */
const EXACT_ONLY_FIELDS: ReadonlySet<ResultField> = new Set(['distance'])

/** Lower is better. Tier 0 exact alias, 1 generic alias, 2 substring containment. */
interface Candidate { header: string; score: [number, number, number]; confident: boolean }

// RD-RACEOPS-02E · a substring guess is allowed only for an alias that is both EXACT
// (names its field and nothing else) and long enough to be unmistakable. 'time' (4) is
// generic AND short: as a substring it turned "Start Time" and "Finish Time of Day" into
// chip-time guesses. 'chip' and 'name' (4) are excluded by length; their longer forms
// ('chiptime', 'fullname', 'participantname') still guess.
const MIN_SUBSTRING_ALIAS = 5
const TIMING_FIELDS: ReadonlySet<ResultField> = new Set(['chipTime', 'gunTime'])

/**
 * The substring rule, in ONE place: the length of the longest exact alias of `field` that
 * `norm` contains, or null when the field may not be guessed from this heading at all.
 *
 * Every safety rule lives here so the mapper and the PDF header detector (07B) cannot
 * drift apart: no guessing for exact-only fields, no clock or per-segment heading as a
 * result time, no generic or short alias as a substring.
 */
function substringAliasFor(norm: string, field: ResultField): number | null {
  if (EXACT_ONLY_FIELDS.has(field)) return null
  if (TIMING_FIELDS.has(field) && isClockTimeHeading(norm)) return null
  let best: number | null = null
  for (const [alias, f] of ALIAS_TO_FIELD) {
    if (f !== field || alias.length < MIN_SUBSTRING_ALIAS || aliasTier(alias) === 'generic') continue
    if (norm.includes(alias)) best = best === null ? alias.length : Math.max(best, alias.length)
  }
  return best
}

/**
 * RD-RACEOPS-RESULTS-07B · what the mapper makes of ONE heading on its own.
 *
 * `field` is the field the heading would feed, with how sure the mapper is of it;
 * `calculated` is a column RegisterDesk computes (rank, pace, speed) — recognised, never
 * mapped; null is a heading the mapper does not know.
 *
 * This is the mapper's own resolution — direct alias first, then the substring rule with
 * all of its safety checks — exposed so the PDF header detector can count exactly the
 * headings the mapper would map. RESULTS-07 found the detector using a stricter, direct-only
 * lookup: a real provider's `Finish ChipTime` was mapped happily by `autoMapColumns` yet
 * did not count toward recognising the header, and the whole listing was refused.
 *
 * Cross-column decisions (a "Finish Time" beside a chip column becoming the gun time, two
 * headers contesting one field) are `autoMapColumns`'s, not this function's.
 */
export type HeadingRecognition =
  | { kind: 'field'; field: ResultField; tier: 'exact' | 'generic' | 'substring' }
  | { kind: 'calculated' }

export function recogniseHeading(header: string): HeadingRecognition | null {
  const norm = normalizeHeader(header)
  if (norm === '') return null
  if (isProviderCalculatedHeading(norm)) return { kind: 'calculated' }
  const direct = ALIAS_TO_FIELD.get(norm)
  if (direct !== undefined) return { kind: 'field', field: direct, tier: aliasTier(norm) }
  for (const field of FIELD_PRIORITY) {
    if (substringAliasFor(norm, field) !== null) return { kind: 'field', field, tier: 'substring' }
  }
  return null
}

function candidatesFor(
  field:   ResultField,
  headers: readonly string[],
  claimed: ReadonlySet<string>,
  mapping: ColumnMapping,
): Candidate[] {
  const out: Candidate[] = []
  headers.forEach((header, position) => {
    if (!header || claimed.has(header)) return
    const norm = normalizeHeader(header)
    // RD-RACEOPS-RESULTS-04 · a column RegisterDesk calculates is never a candidate for any
    // field. It is reported as calculated, not mapped and not unknown.
    if (isProviderCalculatedHeading(norm)) return
    // The overall distance is the COURSE, never one leg of it.
    if (field === 'distance' && isSegmentScopedHeading(norm)) return
    const direct = ALIAS_TO_FIELD.get(norm)
    if (direct === field) {
      const tier = aliasTier(norm) === 'exact' ? 0 : 1
      out.push({ header, score: [tier, ALIAS_RANK.get(norm) ?? 99, position], confident: tier === 0 })
      return
    }
    // "Finish Time" / "Time" beside an EXACT chip column is the gun (start-to-finish) time.
    if (field === 'gunTime' && GUN_WHEN_CHIP_PRESENT.has(norm) && direct === 'chipTime' && mapping.chipTime !== undefined) {
      out.push({ header, score: [1, ALIAS_RANK.get(norm) ?? 99, position], confident: false })
      return
    }
    if (direct !== undefined) return          // an exact alias of ANOTHER field is never a substring guess
    // Containment: "Net Time (final)" → chipTime. Longest alias first inside the score.
    // Every rule that forbids a guess (exact-only field, clock heading, short or generic
    // alias) is inside `substringAliasFor`, shared with the PDF header detector.
    const best = substringAliasFor(norm, field)
    if (best !== null) out.push({ header, score: [2, 100 - best, position], confident: false })
  })
  return out.sort((a, b) => a.score[0] - b.score[0] || a.score[1] - b.score[1] || a.score[2] - b.score[2])
}

export function autoMapColumns(headers: readonly string[]): AutoMapResult {
  const mapping: ColumnMapping = {}
  const confidence: Partial<Record<ResultField, MappingConfidence>> = {}
  const claimed = new Set<string>()

  for (const field of FIELD_PRIORITY) {
    const candidates = candidatesFor(field, headers, claimed, mapping)
    const best = candidates[0]
    if (!best) continue
    mapping[field] = best.header
    claimed.add(best.header)
    // A second candidate of the same top tier means the file has two plausible columns
    // ("Chip Time" and "Net Time"): the pick is deterministic but deserves a look.
    const rival = candidates[1]
    const contested = rival !== undefined && rival.score[0] === best.score[0]
    confidence[field] = best.confident && !contested ? 'exact' : 'review'
  }

  const calculatedHeaders = headers.filter(h => h !== '' && isProviderCalculatedHeading(normalizeHeader(h)))
  const calculated = new Set(calculatedHeaders)
  const unmappedHeaders = headers.filter(h => h !== '' && !claimed.has(h) && !calculated.has(h))
  return { mapping, unmappedHeaders, calculatedHeaders, confidence }
}

/** Required fields (bib, chip time) that the current mapping leaves unassigned. */
export function missingRequiredFields(mapping: ColumnMapping): ResultField[] {
  return RESULT_FIELDS.filter(f => f.required && !mapping[f.field]).map(f => f.field)
}

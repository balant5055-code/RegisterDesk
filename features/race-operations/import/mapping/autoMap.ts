// RD-RACEOPS-01 Sprint 2 · Automatic column mapping.
//
// PURE. Proposes a ColumnMapping from a file's headers. The organizer always sees and
// can override the result — this only removes the tedium of mapping an obvious file.

import type { ColumnMapping, ResultField } from '@/features/race-operations/types/results'
import { RESULT_FIELDS } from '@/features/race-operations/types/results'
import { ALIAS_TO_FIELD, normalizeHeader } from './aliases'

/** Headers that matched no canonical field. Surfaced as an informational warning. */
export interface AutoMapResult {
  mapping:          ColumnMapping
  unmappedHeaders:  string[]
}

/**
 * Field order = RESULT_FIELDS order, so when two headers claim the same field the
 * earlier HEADER wins (first-come), and a field already taken is never reassigned.
 */
export function autoMapColumns(headers: readonly string[]): AutoMapResult {
  const mapping: ColumnMapping = {}
  const claimed = new Set<string>()

  // Pass 1 — exact alias match.
  for (const header of headers) {
    if (!header) continue
    const field = ALIAS_TO_FIELD.get(normalizeHeader(header))
    if (field && mapping[field] === undefined) {
      mapping[field] = header
      claimed.add(header)
    }
  }

  // Pass 2 — a still-unmapped field may match a header that CONTAINS its alias, e.g.
  // "Net Time (hh:mm:ss)" → chipTime. Longest alias first so the most specific wins.
  for (const { field } of RESULT_FIELDS) {
    if (mapping[field] !== undefined) continue
    const candidate = findContainedMatch(headers, claimed, field)
    if (candidate) {
      mapping[field] = candidate
      claimed.add(candidate)
    }
  }

  const unmappedHeaders = headers.filter(h => h !== '' && !claimed.has(h))
  return { mapping, unmappedHeaders }
}

function findContainedMatch(
  headers: readonly string[],
  claimed: ReadonlySet<string>,
  field:   ResultField,
): string | null {
  const aliases = [...(ALIAS_TO_FIELD.entries())]
    .filter(([, f]) => f === field)
    .map(([alias]) => alias)
    .sort((a, b) => b.length - a.length)

  for (const alias of aliases) {
    // Very short aliases ('no', 'mf') are too collision-prone for substring matching.
    if (alias.length < 4) continue
    for (const header of headers) {
      if (!header || claimed.has(header)) continue
      if (normalizeHeader(header).includes(alias)) return header
    }
  }
  return null
}

/** Canonical fields that are required but not yet mapped. */
export function missingRequiredFields(mapping: ColumnMapping): ResultField[] {
  return RESULT_FIELDS
    .filter(f => f.required && !mapping[f.field])
    .map(f => f.field)
}

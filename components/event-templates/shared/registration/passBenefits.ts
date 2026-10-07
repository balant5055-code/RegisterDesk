// Pass benefits — the ONE ranking model (RD-ST5.2).
//
// Every pass already carries `benefits: string[]`. The hero's "what's included" strip is
// derived from those and nothing else: collect → de-duplicate → count frequency → sort
// descending → take the top N. A benefit offered by every challenge outranks one offered
// by a single challenge, which is exactly the ordering a runner cares about.
//
// Directive-free so Server Components can call it (a function exported from a
// 'use client' module becomes a client reference and throws on the server).
// Pure — no JSX, no hooks, no fabricated values.

import type { PassPublic } from '@/components/event-templates/types'
import { formatBenefit } from '@/components/event-templates/shared/registration/benefitLabels'

export interface RankedBenefit {
  /**
   * The STORED entry, exactly as written: a curated benefit ID ('finisher_medal') or the
   * organiser's free text. Kept because `label` is no longer the raw value and callers
   * still need the original — `benefitIcon` in particular matches on it.
   */
  id: string
  /** Attendee-facing copy, resolved through the canonical `formatBenefit` vocabulary. */
  label: string
  /** How many active passes include it. */
  count: number
  /** How many active passes were considered — lets callers phrase coverage honestly. */
  total: number
}

/**
 * Rank the benefits across a set of passes by how many passes offer each one.
 *
 * De-duplication is case- and whitespace-insensitive ("Chip Timing" and "chip timing"
 * are one benefit) and runs on the STORED string; the entry kept is the first spelling,
 * so free text is never re-cased. Ties keep first-appearance order, so the result is
 * stable for a given event rather than shuffling between renders.
 *
 * `label` is then resolved through `formatBenefit`, because the stored string is often a
 * curated ID: the hero was publishing `e_certificate` and `medical_support` to attendees
 * verbatim. `id` carries the raw entry through for callers that key on it.
 */
export function rankPassBenefits(passes: PassPublic[], limit = 5): RankedBenefit[] {
  const active = passes.filter(p => p.status !== 'inactive')
  if (active.length === 0) return []

  const byKey = new Map<string, { label: string; count: number; firstSeen: number }>()
  let seq = 0

  for (const pass of active) {
    // One pass listing the same benefit twice must not count twice.
    const seenInPass = new Set<string>()
    for (const raw of pass.benefits ?? []) {
      const label = raw?.trim()
      if (!label) continue
      const key = label.toLowerCase()
      if (seenInPass.has(key)) continue
      seenInPass.add(key)

      const existing = byKey.get(key)
      if (existing) existing.count++
      else byKey.set(key, { label, count: 1, firstSeen: seq++ })
    }
  }

  return [...byKey.values()]
    .sort((a, b) => (b.count - a.count) || (a.firstSeen - b.firstSeen))
    .slice(0, limit)
    // Format LAST, at the emit boundary. Ranking, de-duplication and the limit all still
    // run on the raw stored string, so counts, ordering and the cap are bit-for-bit what
    // they were — only the copy that reaches a reader changes.
    .map(({ label, count }) => ({
      id: label, label: formatBenefit(label), count, total: active.length,
    }))
}

/** Honest coverage line for a ranked benefit — derived, never invented. */
export function benefitCoverage(b: RankedBenefit): string {
  if (b.total <= 1) return 'Included with your entry'
  return b.count >= b.total
    ? 'Included with every entry'
    : `Included with ${b.count} of ${b.total} entries`
}

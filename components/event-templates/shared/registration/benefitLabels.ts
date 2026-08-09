// Benefit labels — the ONE place a stored benefit ID becomes attendee-facing copy.
//
// RD-ST6.0. `pass.benefits` holds IDs from the wizard's curated vocabulary
// (`timing_chip`, `finisher_medal`, `e_certificate`, …) and `pass.customBenefits`
// holds organiser free-text. The public page was rendering the raw IDs, so attendees
// saw database keys. This resolves both through the SAME vocabulary the wizard writes
// with — `PASS_BENEFITS_BY_EVENT_TYPE` — so a label can never drift between the
// organiser's picker and the public page. Change a label there and every surface
// follows; there is deliberately no second copy of the strings here.
//
// Directive-free so Server Components can call it.

import { PASS_BENEFITS_BY_EVENT_TYPE } from '@/components/wizard/passEventTypeConfig'

/** id → label, flattened across every event type (first definition wins). */
const LABEL_BY_ID: Record<string, string> = (() => {
  const map: Record<string, string> = {}
  for (const config of Object.values(PASS_BENEFITS_BY_EVENT_TYPE)) {
    for (const group of config.groups) {
      for (const item of group.benefits) {
        if (!(item.id in map)) map[item.id] = item.label
      }
    }
  }
  return map
})()

// The picker labels read as sentences ("Bib Included", "Timing Chip Included") because
// they answer "is this in the pass?". In a benefits chip list the answer is already
// implied by being listed, so the qualifier is redundant noise.
const REDUNDANT_SUFFIX = /\s+(included|eligibility)$/i

/** snake_case / kebab-case → Title Case, for IDs outside the curated vocabulary. */
function humanise(raw: string): string {
  return raw
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
}

/**
 * Resolve one benefit entry to display copy.
 *
 * Curated ID  → the wizard's own label, minus a redundant trailing qualifier.
 * Custom text → returned as the organiser typed it (already human copy).
 * Unknown ID  → humanised, so a key can never reach the page verbatim.
 */
export function formatBenefit(entry: string): string {
  const raw = entry?.trim()
  if (!raw) return ''
  const known = LABEL_BY_ID[raw]
  if (known) return known.replace(REDUNDANT_SUFFIX, '')
  // Free-text custom benefits contain spaces/capitals; IDs do not.
  const looksLikeKey = /^[a-z0-9]+([_-][a-z0-9]+)*$/.test(raw)
  return looksLikeKey ? humanise(raw) : raw
}

/**
 * Resolve a pass's full benefit list — curated IDs first, then custom entries —
 * formatted, trimmed and de-duplicated case-insensitively.
 */
export function formatBenefits(
  benefits: string[] | undefined,
  customBenefits?: string[] | undefined,
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const entry of [...(benefits ?? []), ...(customBenefits ?? [])]) {
    const label = formatBenefit(entry)
    if (!label) continue
    const key = label.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(label)
  }
  return out
}

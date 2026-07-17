// Publish Governance — identity extraction + classification (EA-4 S1). PURE.
//
// Identity changes are CLASSIFIED, not compared as raw strings. Field paths mirror
// the wizard schema (components/wizard/eventDetailsConfig.ts) and are identical in
// the draft and the published event doc.

import type {
  EventIdentity, GovernanceConfig, IdentityClassification, IdentityChangeLevel,
} from './types'

const str  = (v: unknown): string => (typeof v === 'string' ? v : '')
const norm = (v: string): string => v.trim().toLowerCase().replace(/\s+/g, ' ')

/** Extracts identity-defining fields from a draft OR published event document. */
export function extractIdentity(d: Record<string, unknown>): EventIdentity {
  const details = (d.eventDetails as Record<string, unknown>) ?? {}
  const info    = (details.info     as Record<string, unknown>) ?? {}
  const venue   = (details.venue    as Record<string, unknown>) ?? {}
  const phys    = (venue.physical   as Record<string, unknown>) ?? {}
  const sched   = (details.schedule as Record<string, unknown>) ?? {}
  return {
    eventType:    str(d.eventType),
    eventSubtype: str(d.eventSubtype),
    city:         str(phys.city),
    startDate:    str(sched.startDate),
    name:         str(info.name),
    venue:        str(phys.name),
  }
}

/** Word-set (Jaccard) similarity in [0,1]. Cheap, dependency-free — lets a typo
 *  fix / minor rename pass while a wholesale rename registers as significant. */
function similarity(a: string, b: string): number {
  const A = new Set(norm(a).split(' ').filter(Boolean))
  const B = new Set(norm(b).split(' ').filter(Boolean))
  if (A.size === 0 && B.size === 0) return 1
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

/**
 * Classifies the drift between the baseline identity and the current draft identity
 * using the (config-driven) field significance tiers. Major wins over moderate.
 */
export function classifyIdentityChange(
  baseline: EventIdentity, current: EventIdentity, config: GovernanceConfig,
): IdentityClassification {
  const majorFields:    string[] = []
  const moderateFields: string[] = []

  for (const f of config.majorFields) {
    if (norm(str(baseline[f])) !== norm(str(current[f]))) majorFields.push(f)
  }
  for (const f of config.moderateFields) {
    if (f === 'name') {
      if (similarity(baseline.name, current.name) < config.nameSimilarityThreshold) moderateFields.push('name')
    } else if (norm(str(baseline[f])) !== norm(str(current[f]))) {
      moderateFields.push(f)
    }
  }

  const level: IdentityChangeLevel =
    majorFields.length ? 'major' : moderateFields.length ? 'moderate' : 'none'
  return { level, changedFields: [...majorFields, ...moderateFields], majorFields, moderateFields }
}

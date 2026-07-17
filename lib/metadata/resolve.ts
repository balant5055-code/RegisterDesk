// Phase H.3.5 — Schema resolution (Deliverable 3). Server-only (reads storage).
//
// Resolution = system fields (from the code registry) MERGED with the authored
// configurable fields (from storage), ordered by section/group. System fields are
// never stored, so they can never drift from the code. When nothing is authored,
// the resolved schema is exactly the system fields — i.e. today's behaviour.

import { systemFields } from './registry'
import { getPublishedSchema } from './storage'
import type {
  EntityType, SchemaScope, ResolvedSchema, FieldDefinition,
  SectionDefinition, GroupDefinition,
} from './types'

const DEFAULT_SECTION: SectionDefinition = { key: 'general', label: 'General', order: 0 }

/**
 * Resolves the effective schema for an entity. `now` is injected so the storage
 * cache stays deterministic/testable.
 */
export async function resolveSchema(
  entityType: EntityType,
  scope: SchemaScope = 'global',
  now: number = Date.now(),
): Promise<ResolvedSchema> {
  const sys = systemFields(entityType)
  const stored = scope === 'global' ? null : await getPublishedSchema(scope, entityType, now)

  const custom: FieldDefinition[] = stored?.fields ?? []
  const sections: SectionDefinition[] = stored?.sections?.length ? stored.sections : [DEFAULT_SECTION]
  const groups: GroupDefinition[] = stored?.groups ?? []

  // System fields first, then configurable; stable order by (section, group, order).
  const merged = [...sys, ...custom]
  const sectionOrder = new Map(sections.map(s => [s.key, s.order]))
  merged.sort((a, b) => {
    const sa = sectionOrder.get(a.section ?? 'general') ?? 0
    const sb = sectionOrder.get(b.section ?? 'general') ?? 0
    if (sa !== sb) return sa - sb
    return (a.order ?? 0) - (b.order ?? 0)
  })

  const byKey: Record<string, FieldDefinition> = {}
  for (const f of merged) byKey[f.key] = f

  return {
    entityType,
    scope,
    version: stored?.version ?? 0,
    sections,
    groups,
    fields: merged,
    byKey,
    customFields: custom,
  }
}

/**
 * System-only resolution with NO I/O — for callers that just need the built-in
 * field set (e.g. a default export or token list) without a storage round-trip.
 */
export function resolveSystemSchema(entityType: EntityType): ResolvedSchema {
  const sys = systemFields(entityType)
  const byKey: Record<string, FieldDefinition> = {}
  for (const f of sys) byKey[f.key] = f
  return {
    entityType, scope: 'global', version: 0,
    sections: [DEFAULT_SECTION], groups: [], fields: sys, byKey, customFields: [],
  }
}

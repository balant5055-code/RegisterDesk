// Phase H.3.5 — Backward-compatibility adapters (Deliverable 15). Pure + SDK-free.
//
// The platform reads/writes custom values through an additive `custom` namespace
// on each entity document — WITHOUT moving, renaming, or migrating any existing
// field. For registrations, the adapter also bridges the EXISTING form system
// (attendee.formResponses) so today's dynamic fields are visible to the platform
// with zero migration.
//
// These are accessors and patch-builders only; they perform NO Firestore I/O.

import type { EntityType, CustomValues } from './types'

type Doc = Record<string, unknown>

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

/**
 * All custom values for an entity instance: the additive `custom` map, plus —
 * for registrations — the legacy attendee.formResponses (the existing form
 * answers), with `custom` taking precedence on key collisions.
 */
export function readCustomValues(doc: Doc, entityType: EntityType): CustomValues {
  const custom = asRecord(doc.custom)
  if (entityType === 'registration' || entityType === 'participant') {
    const attendee = asRecord(doc.attendee)
    const formResponses = asRecord(attendee.formResponses)
    return { ...formResponses, ...custom }
  }
  return { ...custom }
}

/** A single custom value (with the registration form bridge). */
export function readCustomValue(doc: Doc, entityType: EntityType, key: string): unknown {
  return readCustomValues(doc, entityType)[key]
}

/**
 * Builds an ADDITIVE Firestore update patch that writes a custom value under the
 * `custom` map using a dot-path — touching nothing else on the document. The
 * caller passes this to set(..., { merge: true }) / update(). No existing field
 * is ever modified.
 */
export function buildCustomPatch(values: CustomValues): Record<string, unknown> {
  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    patch[`custom.${key}`] = value
  }
  return patch
}

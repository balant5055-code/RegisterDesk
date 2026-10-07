// RD-EVENT-15A · the ONE definition of "is this event's waitlist switched on, and how big
// may the queue get".
//
// PURE — no Firestore, no clock. Imported by the registration gate, the public join route,
// the organizer waitlist route and the workspace, so all four answer the same question the
// same way.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Two fields carried the same meaning and neither knew about the other:
//
//   · The event builder wrote `registrationForm.registrationRules.waitlistEnabled`
//     (plus `waitlistMode` and `waitlistCapacity`) into the draft. Publish copies
//     `registrationForm` wholesale, so it reached `events/{slug}` too — where NOTHING
//     read it. Flipping the builder toggle changed nothing an attendee could observe.
//
//   · The organizer Waitlist tab wrote a TOP-LEVEL `events/{slug}.waitlistEnabled`, and
//     `checkRegistrationGate` read that. It was introduced by that tab's PATCH and has no
//     other producer.
//
// So the builder's switch was inert and the tab's switch was invisible to the builder.
//
// ═══ WHICH ONE IS CANONICAL, AND WHY ═════════════════════════════════════════
// `registrationForm.registrationRules`. Three reasons, all of them "this is already how
// the codebase works":
//
//   1. EVERY other registration rule lives there and is read from there by the server —
//      `approvalMode` (submit, create-order, the public register page), `limitPerEmail`
//      and `limitPerMobile` (check-duplicate, walk-in, settleCapturedRegistration),
//      `duplicatePolicy` (import). The waitlist was the lone exception.
//   2. The builder — the event-configuration source of truth — already writes it, and it
//      already has a home for the cap (`waitlistCapacity`).
//   3. Publish copies `registrationForm` verbatim, so the setting survives publish and
//      republish for free. The top-level field needed a bespoke carry-forward in the
//      publish transaction precisely BECAUSE it did not belong there.
//
// ═══ THE LEGACY FIELD ════════════════════════════════════════════════════════
// Documents written before this consolidation may carry only the top-level pair. They are
// read here — once, in this function — when the canonical rules object is absent entirely.
// That is a fallback for old data, not a second setting: there is one read path (this
// file) and one write path (`waitlistSettingUpdates`, which also clears the legacy pair).
//
// An event that has BOTH — canonical `false` from the builder's defaults and a legacy
// `true` from the tab — resolves to the canonical `false`. That is deliberate: the
// canonical field is the one the organizer can see and edit in two places now, and the
// change is observable to nobody today because `WAITLIST_ENABLED` is false platform-wide,
// so no attendee can join through either value. Saving the setting once from either
// surface makes the document self-consistent.

/** Field paths written by every producer. Flat, so they suit a Firestore field-mask update. */
export const WAITLIST_ENABLED_PATH  = 'registrationForm.registrationRules.waitlistEnabled'
export const WAITLIST_CAPACITY_PATH = 'registrationForm.registrationRules.waitlistCapacity'

/** The pre-consolidation top-level pair. Read as a fallback, cleared on any write. */
export const LEGACY_ENABLED_FIELD = 'waitlistEnabled'
export const LEGACY_LIMIT_FIELD   = 'waitlistLimit'

/**
 * A queue longer than this is not a queue.
 *
 * The cap exists so a pasted or fat-fingered value cannot become an effectively unbounded
 * number that later overflows the arithmetic the summary does on it.
 */
export const MAX_WAITLIST_LIMIT = 1_000_000

export interface WaitlistSettings {
  enabled: boolean
  /** null = no limit. Never 0 — see `normalizeWaitlistLimit`. */
  limit:   number | null
  /**
   * true = a limit IS stored but is not a usable number (a string, a decimal, a negative).
   * The surface must say so rather than present the event as uncapped, which is a
   * different and much more permissive claim.
   */
  limitInvalid: boolean
  /** Where the answer came from. `legacy` means the document predates the consolidation. */
  source: 'canonical' | 'legacy' | 'default'
}

/**
 * Is this a value an organizer could have meant as a queue cap?
 *
 * Deliberately strict. A string, a decimal or a zero is REFUSED rather than coerced:
 * silently turning `0` or `"abc"` into "no limit" is how a typo becomes an uncapped queue,
 * which is the opposite of what the person typing a limit was trying to do.
 */
export function isValidWaitlistLimit(v: unknown): v is number {
  return typeof v === 'number'
    && Number.isInteger(v)
    && v > 0
    && v <= MAX_WAITLIST_LIMIT
}

/**
 * Reads a STORED limit. `null`/`undefined` mean unlimited; anything else that is not a
 * valid limit is reported as invalid rather than quietly treated as unlimited.
 */
export function normalizeWaitlistLimit(v: unknown): { limit: number | null; invalid: boolean } {
  if (v === null || v === undefined) return { limit: null, invalid: false }
  if (isValidWaitlistLimit(v)) return { limit: v, invalid: false }
  return { limit: null, invalid: true }
}

/** Just the shapes this resolver reads — so callers can pass a draft or a published doc. */
export interface WaitlistSettingSource {
  registrationForm?: unknown
  waitlistEnabled?:  unknown
  waitlistLimit?:    unknown
}

const rulesOf = (doc: WaitlistSettingSource | null | undefined): Record<string, unknown> | null => {
  const form = doc?.registrationForm
  if (!form || typeof form !== 'object') return null
  const rules = (form as Record<string, unknown>).registrationRules
  return rules && typeof rules === 'object' ? rules as Record<string, unknown> : null
}

/**
 * The one answer, for a draft document or a published one.
 *
 * Canonical first. The legacy top-level pair is consulted ONLY when the canonical rules
 * object is absent altogether — i.e. an event published before the builder wrote rules.
 */
export function resolveWaitlistSettings(
  doc: WaitlistSettingSource | null | undefined,
): WaitlistSettings {
  const rules = rulesOf(doc)

  if (rules && typeof rules.waitlistEnabled === 'boolean') {
    const { limit, invalid } = normalizeWaitlistLimit(rules.waitlistCapacity)
    return { enabled: rules.waitlistEnabled, limit, limitInvalid: invalid, source: 'canonical' }
  }

  if (doc && (doc.waitlistEnabled !== undefined || doc.waitlistLimit !== undefined)) {
    const { limit, invalid } = normalizeWaitlistLimit(doc.waitlistLimit)
    return { enabled: doc.waitlistEnabled === true, limit, limitInvalid: invalid, source: 'legacy' }
  }

  // Neither shape present: the event has never had a waitlist configured. Off, uncapped —
  // a measured default, not a failed read. Callers that cannot READ the document at all
  // must report that separately; this function is only ever given data.
  return { enabled: false, limit: null, limitInvalid: false, source: 'default' }
}

export type WaitlistSettingPatch = {
  enabled?: boolean
  /** null = clear the cap. Anything invalid must be rejected by the caller first. */
  limit?:   number | null
}

/**
 * The flat field-path map a writer applies to BOTH the draft and the live document.
 *
 * Mirrors `buildEventEditUpdate` — the established shape for a post-publish organizer edit
 * — so the two documents can never drift. The legacy pair is DELETED on every write, so a
 * document that has been touched once carries exactly one setting.
 *
 * `deleteSentinel` is `FieldValue.delete()`, passed in so this module stays free of the
 * Admin SDK and testable without it.
 */
export function waitlistSettingUpdates(
  patch: WaitlistSettingPatch,
  deleteSentinel: unknown,
): Record<string, unknown> {
  const updates: Record<string, unknown> = {}
  if (patch.enabled !== undefined) updates[WAITLIST_ENABLED_PATH] = patch.enabled
  if (patch.limit   !== undefined) updates[WAITLIST_CAPACITY_PATH] = patch.limit
  if (Object.keys(updates).length === 0) return updates

  // Retiring the duplicate as we go: no migration job, no half-migrated estate.
  updates[LEGACY_ENABLED_FIELD] = deleteSentinel
  updates[LEGACY_LIMIT_FIELD]   = deleteSentinel
  return updates
}

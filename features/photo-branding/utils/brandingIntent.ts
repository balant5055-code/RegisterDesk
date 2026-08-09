// RD-PHOTO-04 · The branding state machine — PURE.
//
// ═══ WHAT THIS SOLVES ═════════════════════════════════════════════════════════
// Upload-time branding makes branding a PRECONDITION of import, not an independent setting.
// The audit's headline defect: an organizer could create an event, import 4,000 photos and
// only then discover branding was permanently unavailable — because the import page said
// nothing at all when no artwork existed.
//
// The fix is a recorded DECISION, made once per event before the first import, plus one
// resolver that every surface asks. Import, the branding page, the Media Studio hub and the
// gallery browser all render from this function, so they cannot disagree about an event.
//
// ═══ INTENT vs ARTWORK ════════════════════════════════════════════════════════
// `intent` is what the organizer CHOSE. The overlay is what they UPLOADED. They are separate
// because "I want branding" has to be expressible before any artwork exists — that is the
// whole of STATE 3, which was unreachable before this sprint (the `enabled` flag lived ON the
// overlay document, so no artwork meant no flag).
//
// The upload pipeline is NOT changed by this: it still brands when there is an enabled
// overlay. Recording an intent keeps `enabled` in step, so `brandingApplies` below stays the
// same condition `useUploadQueue` has always used.
//
// PURE: the caller supplies the facts. Nothing here reaches firebase-admin, so the rules are
// unit-testable — the trap this module has hit repeatedly.
// ══════════════════════════════════════════════════════════════════════════════

/** What the organizer chose. `null` means they have not been asked yet. */
export type BrandingIntent = 'branded' | 'unbranded'

export type BrandingWorkflowState =
  | 'undecided'   // STATE 0 — no decision recorded, no photos. Import is blocked.
  | 'enabled'     // STATE 1 — chose branding, artwork present and on.
  | 'disabled'    // STATE 2 — chose no branding.
  | 'required'    // STATE 3 — chose branding, artwork missing or switched off. Import blocked.
  | 'locked'      // STATE 4 — photos exist. Settled, whatever was decided.

export interface BrandingFacts {
  /** The recorded decision, or null if never made. */
  intent:     BrandingIntent | null
  /** Whether the event has artwork at all. */
  hasOverlay: boolean
  /** Whether that artwork is switched on. Meaningless without artwork. */
  overlayEnabled: boolean
  /** Ready photos already imported for this event. */
  photoCount: number
}

export interface BrandingWorkflow {
  state: BrandingWorkflowState
  /**
   * Whether an import may begin.
   *
   * FALSE for `undecided` and `required` only. A locked event can still import MORE photos —
   * the lock settles what branding IS, not whether importing continues.
   */
  canImport: boolean
  /**
   * Whether photos imported right now would carry the overlay.
   *
   * Deliberately derived from the artwork, not from the intent: this is the exact condition
   * the upload queue already uses, so the wizard's promise and the pipeline's behaviour are
   * the same fact rather than two that must be kept in sync.
   */
  brandingApplies: boolean
  /** True once photos exist — every mutating control is hidden or refused. */
  locked:     boolean
  photoCount: number
}

/**
 * Resolves exactly ONE state. The order of these branches is the specification.
 */
export function resolveBrandingWorkflow(facts: BrandingFacts): BrandingWorkflow {
  const photoCount = Number.isFinite(facts.photoCount) ? Math.max(0, Math.floor(facts.photoCount)) : 0
  const brandingApplies = facts.hasOverlay && facts.overlayEnabled

  // STATE 4 first: once photos exist nothing else can change the answer, including an
  // intent that was never recorded. Legacy events imported before this sprint land here and
  // report what actually happened to them rather than what someone later chose.
  if (photoCount > 0) {
    return { state: 'locked', canImport: true, brandingApplies, locked: true, photoCount }
  }

  if (facts.intent === null) {
    return { state: 'undecided', canImport: false, brandingApplies: false, locked: false, photoCount }
  }

  if (facts.intent === 'unbranded') {
    return { state: 'disabled', canImport: true, brandingApplies: false, locked: false, photoCount }
  }

  // intent === 'branded' from here.
  if (!brandingApplies) {
    // Artwork missing, or present but switched off. Both leave the organizer expecting
    // branding that would not happen — so both block, rather than importing silently.
    return { state: 'required', canImport: false, brandingApplies: false, locked: false, photoCount }
  }

  return { state: 'enabled', canImport: true, brandingApplies: true, locked: false, photoCount }
}

/** Narrow guard for the stored value, so a hand-edited document cannot inject a third state. */
export function isBrandingIntent(value: unknown): value is BrandingIntent {
  return value === 'branded' || value === 'unbranded'
}

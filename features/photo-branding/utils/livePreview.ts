// RD-PHOTO-07 · The live-preview decision — PURE.
//
// ═══ WHY THIS IS A FUNCTION AND NOT AN INLINE CONDITION ═══════════════════════
// This one boolean caused a defect that survived four attempted fixes. The condition used to
// be `preview` alone — "do I have a photo?" — so an event with photos but no artwork rendered
// a full-width `aspect-[3/2]` box (measured at 1093px on a 1640px column) to preview nothing.
// Every earlier fix went after the symptom (page height) instead of the predicate.
//
// Extracted so the state machine is verified by tests rather than by reading JSX, and so
// there is exactly ONE place in the application that answers the question.
//
// PURE: no React, no DOM, no SDKs.

export interface LivePreviewFacts {
  /** An imported event photo is available to preview against. */
  hasPhoto: boolean
  /** Artwork has been uploaded for this event. */
  hasOverlay: boolean
  /** The organizer has branding switched ON. */
  brandingEnabled: boolean
  /** Placement has been computed. Derived from the overlay, so never true without it. */
  hasPlacement: boolean
}

/**
 * Can a live preview be rendered?
 *
 * ALL FOUR inputs are required, and none is redundant:
 *   • no photo    → nothing to draw the artwork onto
 *   • no overlay  → nothing to draw
 *   • disabled    → the overlay image is not drawn, so the box would render empty
 *   • no placement→ nowhere to draw it
 *
 * `brandingEnabled` in particular is not belt-and-braces: the overlay image inside the
 * preview draws on exactly this, so a looser test would let a DISABLED overlay reproduce the
 * original empty-box defect.
 */
export function canRenderLivePreview(facts: LivePreviewFacts): boolean {
  return facts.hasPhoto && facts.hasOverlay && facts.brandingEnabled && facts.hasPlacement
}

/** Why a live preview is not being shown — drives the placeholder's message. */
export type PlaceholderReason =
  | 'nothing-yet'    // no photo, no overlay
  | 'needs-overlay'  // photo, but no artwork
  | 'needs-photo'    // artwork, but nothing imported to apply it to
  | 'disabled'       // both exist, but branding is switched off

/**
 * The reason, resolved in priority order.
 *
 * `disabled` is checked FIRST: when artwork exists but is switched off, that is the fact the
 * organizer needs, and it would otherwise be masked by "import some photos".
 */
export function previewPlaceholderReason(facts: LivePreviewFacts): PlaceholderReason {
  if (facts.hasOverlay && !facts.brandingEnabled) return 'disabled'
  if (facts.hasOverlay) return 'needs-photo'
  if (facts.hasPhoto)   return 'needs-overlay'
  return 'nothing-yet'
}

/** The message for each reason. One string per state, in one place. */
export const PLACEHOLDER_MESSAGE: Record<PlaceholderReason, string> = {
  'nothing-yet':   'Upload a transparent PNG, then import photos.',
  'needs-overlay': 'Upload a transparent PNG below to see it applied to your photos.',
  'needs-photo':   'Import photos for this event to see it applied to a real photograph.',
  'disabled':      'Enable branding to preview the overlay.',
}

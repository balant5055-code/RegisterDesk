// RD-PHOTO-04 · THE branding wording. One module, reused everywhere.
//
// ═══ WHY THIS FILE EXISTS ═════════════════════════════════════════════════════
// The audit found the same explanation written five different ways across the import page,
// the branding page and three toasts. When branding was a download-time convenience that was
// untidy. Now that it is an IRREVERSIBLE decision, it is a hazard: an organizer who reads
// "photos are never modified" on one page and "this cannot be undone" on another does not
// know which to believe, and picks the reassuring one.
//
// So every surface imports from here. Changing what the platform promises is a change in ONE
// place, and two pages cannot drift apart.
//
// PURE strings. No React, no SDKs — importable by a server route, a client component or a
// test without dragging anything behind it.
// ══════════════════════════════════════════════════════════════════════════════

/** The one-sentence description of what branding does. */
export const BRANDING_WHAT =
  'Your artwork is merged into every photo as it is imported.'

/**
 * The consequence, stated once. This is the sentence that matters — it is the difference
 * between a setting and a decision.
 */
export const BRANDING_PERMANENT =
  'Every imported photo will permanently include this branding.'

/** Why it cannot be changed later. Used by the lock, and as a warning before the first import. */
export const BRANDING_WHY_LOCKED =
  'Branding was applied during photo import and is now part of every stored image. '
  + 'Changing branding now would create inconsistent photos.'

/**
 * Said on the IMPORT surface, where the question is not "what is branding?" but "what will
 * happen to the files I am about to select?".
 */
export const BRANDING_SESSION_NOTE =
  'This branding will be applied automatically to every photo uploaded in this session.'

/** What "no branding" means, said as plainly as the branded case. */
export const BRANDING_NONE =
  'Photos will be imported exactly as uploaded.'

/** Shown when no decision has been recorded for the event yet. */
export const BRANDING_UNDECIDED =
  'This event has not yet been configured for photo branding.'

/** Shown when the organizer chose branding but there is no artwork to apply. */
export const BRANDING_REQUIRED =
  'You chose to use photo branding for this event, but no overlay has been uploaded yet. '
  + 'Upload your artwork before importing photos.'

/**
 * The decision is per event and asked once.
 *
 * Said at the point of choosing, so an organizer understands they are not setting a
 * preference they can revisit.
 */
export const BRANDING_DECIDE_ONCE =
  'Choose once for this event. Photo branding cannot be added or removed after the first '
  + 'photo is imported.'

/** Honest about what branding is for. Branding is not access control. */
export const BRANDING_NOT_PROTECTION =
  'Branding marks photos as yours so they carry your event\'s identity wherever they are '
  + 'shared. It is not a security control and does not restrict who can view or save a photo.'

/** Short labels, so a badge on one page reads identically to a chip on another. */
export const BRANDING_LABEL = {
  enabled:   'Branding Enabled',
  disabled:  'Branding Disabled',
  required:  'Branding Required',
  locked:    'Branding Locked',
  undecided: 'Not Configured',
} as const

/** The gallery browser's badge. Two words, no explanation — the brief is explicit. */
export const GALLERY_BADGE = {
  branded:   'Branded',
  unbranded: 'No Branding',
} as const

/** The Media Studio hub card's status word. */
export const HUB_STATUS = {
  enabled:   'Ready',
  disabled:  'Disabled',
  required:  'Not Configured',
  locked:    'Locked',
  undecided: 'Not Configured',
} as const

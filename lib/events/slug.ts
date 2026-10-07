// RD-EVENT-SLUG · The ONE rule that decides a published event's public slug. PURE.
//
// No Firestore, no env, no React — so the rule is unit-testable on its own and can be
// imported by the publish route (server) and the wizard (client) without a cycle.
//
// ═══ WHY THIS MODULE EXISTS ══════════════════════════════════════════════════
// The slug is not cosmetic. `events/{slug}` IS the live document's Firestore ID, and the
// draft's `eventDetails.seo.urlSlug` is the ONLY pointer from the draft to that document:
//
//     users/{uid}/eventDrafts/{draftId}.eventDetails.seo.urlSlug  ===  events/{id}
//
// Firestore document IDs are CASE-SENSITIVE. Two components used to disagree about the
// slug's legal character set:
//
//   • publish built `slugify(name) + '-' + draftId.slice(-6)`. `slugify` lowercases the
//     NAME, but the draft-id suffix was appended verbatim — and a Firestore auto-id is
//     base62, so ~97% of generated slugs carried an uppercase letter
//     (e.g. `palm-seed-plantation-festival-ADUlJ7`).
//   • the wizard's slug input coerces to `[a-z0-9-]` on every keystroke, and flagged the
//     uppercase slug as invalid — so the UI both told the organizer their live slug was
//     wrong AND silently rewrote it the moment they touched the field.
//
// The rewrite lowercased the draft's pointer. The live document, whose id can never
// change, became unreachable, and saving a published event failed with
// "Live event document not found."
//
// Generating a slug that already satisfies the wizard's own contract removes the
// disagreement at the source: there is nothing left for the UI to "correct".
//
// ⚠ This changes only slugs generated FROM NOW ON. Existing published documents keep
// their ids — those are public URLs and are never renamed.

/** The character set a slug may contain. The wizard's input and validator use this too. */
export const EVENT_SLUG_PATTERN = /^[a-z0-9-]+$/

/** True when a value is a slug this platform would generate today. */
export function isCanonicalEventSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && EVENT_SLUG_PATTERN.test(value)
}

/**
 * A human-readable name reduced to slug characters.
 *
 * Unchanged from the implementation this replaces (it was duplicated verbatim in
 * `app/api/events/publish/route.ts` and `components/wizard/eventDetailsConfig.ts`), so
 * existing names produce byte-identical output.
 */
export function slugifyEventName(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

/**
 * Force any candidate into the canonical character set.
 *
 * This is what the draft-id suffix was missing. A Firestore auto-id mixes upper and lower
 * case; lowering it keeps the slug inside `EVENT_SLUG_PATTERN` while leaving 36^6 ≈ 2.2
 * billion suffixes — and publish still runs its uniqueness check against the final
 * candidate, so a collision is refused rather than silently overwriting.
 */
export function normalizeEventSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
}

/**
 * The public slug for a newly published event.
 *
 * Precedence is unchanged: an organizer's custom slug wins, else name + draft-id suffix,
 * else the draft id alone. What changed is that EVERY branch now returns a value inside
 * `EVENT_SLUG_PATTERN`, including the two that previously did not.
 *
 * The caller must use the returned value for BOTH the uniqueness check and the document
 * id — normalizing after the check would re-open the same class of bug.
 */
export function buildEventSlug(args: {
  /** `eventDetails.seo.urlSlug` as stored on the draft; '' when the organizer set none. */
  customSlug: string
  /** `eventDetails.info.name`. */
  eventName:  string
  /** The draft document id — the uniqueness source when the name is blank or collides. */
  draftId:    string
}): string {
  const custom = normalizeEventSlug(args.customSlug.trim())
  if (custom) return custom

  const name = slugifyEventName(args.eventName)
  const suffix = normalizeEventSlug(args.draftId.slice(-6))

  if (name && suffix) return `${name}-${suffix}`
  if (name)           return name
  return normalizeEventSlug(args.draftId)
}

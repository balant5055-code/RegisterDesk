// RD-PHOTO-03 · The branding lock — pure.
//
// ═══ WHY A LOCK EXISTS AT ALL ═════════════════════════════════════════════════
// Branding is now applied ONCE, during import, and only the branded image is stored. That
// is what makes downloads free and removes runtime compositing entirely — but it also means
// the overlay is baked into pixels that already sit in object storage.
//
// So changing branding after photos exist cannot retroactively brand them. The event would
// end up with two visibly different sets of photos and no way to tell which is which. The
// honest answer is to say so and refuse, not to accept the change and quietly produce a
// mixed gallery.
//
// PURE on purpose: the count comes from the caller. Nothing here imports firebase-admin, so
// the rule is unit-testable — the trap this module hit repeatedly is that importing anything
// which transitively reaches `lib/firebase/admin` breaks the whole test file.
// ══════════════════════════════════════════════════════════════════════════════

export interface BrandingLock {
  /** True when the event already contains photos, so branding is fixed. */
  locked: boolean
  /** How many ready photos this event has. Shown to the organizer, never guessed at. */
  photoCount: number
  /** What to tell the organizer, or null when nothing is locked. */
  reason: string | null
}

/**
 * The message an organizer sees. One string, one place — the API returns exactly what the
 * page displays, so a refusal and its explanation can never drift apart.
 */
export const LOCK_MESSAGE =
  'Branding is locked because photos have already been imported. '
  + 'Changing branding requires re-importing or reprocessing existing photos.'

/**
 * The whole rule: one photo is enough.
 *
 * Not a threshold. The first imported photo is already branded (or already not), so the
 * second one must match it.
 */
export function describeBrandingLock(photoCount: number): BrandingLock {
  const count  = Number.isFinite(photoCount) ? Math.max(0, Math.floor(photoCount)) : 0
  const locked = count > 0
  return { locked, photoCount: count, reason: locked ? LOCK_MESSAGE : null }
}

/**
 * Which operations the lock actually blocks.
 *
 * Reading is always allowed — an organizer must still be able to SEE their branding, the
 * requirements and the templates after importing. Only changes that would alter what future
 * photos look like are refused.
 */
export type BrandingMutation = 'upload' | 'enable' | 'remove'

export function isBlockedByLock(lock: BrandingLock, mutation: BrandingMutation): boolean {
  // Every mutation is blocked identically. Enumerated rather than ignored so that adding a
  // future operation is a deliberate decision here, not an accidental hole.
  const guarded: BrandingMutation[] = ['upload', 'enable', 'remove']
  return lock.locked && guarded.includes(mutation)
}

// MC-06A · Slot addressing and bounds — PURE. No Firestore, no config, no I/O.
//
// ═══ WHY SLOTS ARE ADDRESSED, NOT COUNTED ════════════════════════════════════
// Architecture Spec v1.0 §11. Bounding a session to N photos is trivially done with a
// counter — and a counter is a shared document written once per photo, which is precisely
// the hot-document bottleneck the session model exists to remove (Spec §3 P3).
//
// So the bound is arithmetic instead of stateful. Two independent properties give exactness
// with no shared state at all:
//
//   1. BOUNDED   — a slot index must be < slotCount. Checked by comparison, reading nothing.
//   2. UNIQUE    — assetId is derived deterministically from (sessionId, slotIndex), and the
//                  reservation document is created under that id. Firestore's `create` fails
//                  if the document exists, so a reused index is refused atomically.
//
// Together: usage cannot exceed N, and a slot cannot be double-spent — without a counter,
// without a lock, and without any document two uploads both write.
//
// The derivation must be STABLE across processes and deploys: a retry has to land on the
// same assetId as the original attempt, or the replay protection in (2) silently stops
// working and the same photo is charged twice.

/** Upper bound on slots in one session. A guard on the arithmetic, not a business rule. */
export const MAX_SESSION_SLOTS = 10_000

export type SlotVerdict =
  | { ok: true;  assetId: string }
  | { ok: false; reason: 'not_an_integer' | 'negative' | 'out_of_range' }

/**
 * The canonical assetId for a slot.
 *
 * Deliberately a plain, readable composition rather than a hash: the id appears in storage
 * paths, logs and support conversations, and being able to read the session and slot straight
 * out of it is worth more than opacity. Nothing security-relevant depends on it being
 * unguessable — authorization is enforced by the session's `organizerUid`, never by the id.
 */
export function deriveAssetId(sessionId: string, slotIndex: number): string {
  return `${sessionId}-s${slotIndex}`
}

/**
 * Validates a slot request against a session's bound and returns its assetId.
 *
 * Returns a verdict rather than throwing: the caller maps each reason to its own HTTP status,
 * and a bad slot index is an ordinary client error, not an exceptional condition.
 */
export function resolveSlot(
  sessionId: string, slotIndex: number, slotCount: number,
): SlotVerdict {
  if (!Number.isInteger(slotIndex)) return { ok: false, reason: 'not_an_integer' }
  if (slotIndex < 0)                return { ok: false, reason: 'negative' }
  if (slotIndex >= slotCount)       return { ok: false, reason: 'out_of_range' }
  return { ok: true, assetId: deriveAssetId(sessionId, slotIndex) }
}

/**
 * Credits a session must hold to cover `slotCount` photos.
 *
 * Uses the value snapshotted at open, never live config — Spec §19. Truncation matches
 * `pricingService.creditsForPhotos`, so a session and a purchase price photos identically.
 */
export function creditsForSlots(slotCount: number, creditsPerPhoto: number): number {
  return Math.max(0, Math.trunc(slotCount)) * Math.max(0, Math.trunc(creditsPerPhoto))
}

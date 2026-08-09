// MC-10.2 · Which credit slot each queued photo uploads into — PURE. No React, no network.
//
// ═══ WHY THIS EXISTS ══════════════════════════════════════════════════════════
// MC-06B replaced per-photo credit reservations with a session-scoped allocation: one
// session holds the credits for a whole batch, and each photo claims one numbered slot
// inside it. The server contract landed; the browser half never did. With `creditsEnabled`
// on, `/uploads/prepare` fail-closes with HTTP 400 on every photo because the client sends
// no `sessionId` and no `slotIndex` (MC-10.1, finding #1).
//
// This file is the missing half's decision-making, extracted so the properties that matter
// are provable by unit test rather than by uploading a hundred photos and squinting:
//
//   • one session per batch — never one per photo
//   • slots are 0…N-1, no duplicates, no gaps
//   • a retry keeps the slot it already had, so it lands on the same assetId
//
// ═══ WHY A RETRY MUST NOT GET A NEW SLOT ═════════════════════════════════════
// The server derives `assetId = deriveAssetId(sessionId, slotIndex)`. Same slot ⇒ same
// assetId ⇒ the retry overwrites its own object and replays onto its own `held` reservation,
// which `ledgerService.reserve` treats as a no-op. A fresh slot would instead consume a
// SECOND allocation for one photo, and the first would sit held until the sweep reclaimed it.
// So slot stability is not tidiness — it is what stops a retry from double-charging.

/** The fields one photo must send to `/uploads/prepare` for its slot to be honoured. */
export interface SlotAssignment {
  /** Queue item id. */
  id:           string
  sessionId:    string
  slotIndex:    number
  /** The session's total slot count. Identical for every member of one batch. */
  sessionSlots: number
}

/** The shape `assignSlots` needs. Deliberately minimal so the queue's item type can grow. */
export interface Slottable {
  id:        string
  state:     string
  /** Non-null once this item belongs to a session. Never reassigned. */
  sessionId: string | null
}

/**
 * States that consume a slot when the queue next runs.
 *
 * `paused` is included: pausing parks an item mid-flight and resuming restarts it from the
 * beginning, so it still needs the slot it was given. `failed` is NOT — a failed item is
 * re-queued by `retryFailed` before `start` runs, and it already carries its original slot.
 */
const NEEDS_SLOT: ReadonlySet<string> = new Set(['queued', 'paused'])

/**
 * Assigns one session and a contiguous slot range to every item that does not already have one.
 *
 * Returns ONLY the items that were newly assigned — an empty array when every queued item is
 * already slotted, which is exactly what a pure retry looks like. The caller can then skip
 * minting a session entirely.
 *
 * `sessionSlots` counts only the newly-assigned items, because that is what the session will
 * be opened to hold. Counting the retries too would hold credits for slots that belong to a
 * different session and are already accounted for there.
 */
export function assignSlots(
  items: readonly Slottable[],
  sessionId: string,
): SlotAssignment[] {
  const needing = items.filter(i => i.sessionId === null && NEEDS_SLOT.has(i.state))
  // One pass, index === position. Contiguity is structural rather than checked: there is no
  // arithmetic here that could leave a gap.
  return needing.map((it, slotIndex) => ({
    id: it.id, sessionId, slotIndex, sessionSlots: needing.length,
  }))
}

/**
 * A session id for one batch.
 *
 * Impure, and separated from `assignSlots` for that reason — the allocation logic stays
 * testable without stubbing a clock or a random source.
 *
 * Opaque and client-minted. That is safe because the id authorises nothing: the server opens
 * the session against the caller's own workspace, re-checks ownership on every slot claim
 * (MC-06F), and bounds `slotIndex` against the slot count it stored itself. A forged id can
 * only ever reach the forger's own allocation.
 */
export function newUploadSessionId(): string {
  return `us_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

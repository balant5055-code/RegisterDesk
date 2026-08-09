// RD-EVENT-12 · The render/persistence split — PURE.
//
// A model of `useDraft`'s state division, extracted so the invariants can be tested without
// React, a DOM, or Firestore (this repo's vitest environment is `node`).
//
// ═══ THE SPLIT ═══════════════════════════════════════════════════════════════
// RD-EVENT-11 found that `draft` carried six responsibilities, four of which already ran on
// refs. Only two need to be visible to React, and neither of them during typing:
//
//   persistence  — what will be written to Firestore and to the crash snapshot.
//                  Lives in `draftRef` + `pendingRef`. Updated on EVERY edit.
//   render       — what components read while rendering. Lives in `draft` state.
//                  Updated ONLY at the audited synchronisation points below.
//
// An edit therefore advances persistence and leaves render alone. That is the whole change:
// `setDraft` used to run on the keystroke path, re-rendering a 4,000-line component for data
// that no mounted consumer reads — the active step owns its own editable state and seeds
// from `initialData` once, via a lazy `useState` initializer.
//
// ═══ WHY DIVERGENCE IS SAFE, AND WHERE IT MUST END ═══════════════════════════
// Divergence is only safe while nothing renders the stale copy. The audit found no consumer
// that reads `draft` during typing, but several that read it the moment the wizard moves.
// So render state must be resynchronised at exactly these points, and no others:
//
//   • navigation       — a newly mounted step seeds `initialData` from render state. Without
//                        a sync, Form could seed its pass list from a stale `pricing`.
//   • saveSuccess      — the write landed; render state should reflect what was persisted.
//   • saveFailure      — rare, but the error UI must not show pre-edit data.
//   • conflictResolved — resolution REPLACES the draft outright, so it assigns both copies.
//   • load / create    — the draft's first appearance; both copies start equal.
//
// Publish is deliberately NOT a synchronisation point: `markPublished` does not modify the
// draft, so syncing there could only ever be a no-op. Publish is already covered because it
// flushes first, which resolves through `saveSuccess`.

/** A draft document, modelled only as far as this invariant needs. */
export type DraftFields = Record<string, unknown>

export interface DraftSplit {
  /** Authoritative. Advanced by every edit. Backs Firestore and the crash snapshot. */
  persistence: DraftFields
  /** What React renders. Advanced only at a synchronisation point. */
  render: DraftFields
  /** Unsynced field names awaiting a write — the exact Firestore payload. */
  pending: DraftFields
}

/** Every point at which render state is allowed to catch up. */
export const SYNC_POINTS = [
  'navigation', 'saveSuccess', 'saveFailure', 'conflictResolved', 'load', 'create',
] as const

export type SyncPoint = typeof SYNC_POINTS[number]

export function createSplit(initial: DraftFields = {}): DraftSplit {
  // ONE object, shared by both copies — mirroring load/create, where `setDraft(loaded)` and
  // `draftRef.current = loaded` are handed the same reference. Cloning it per copy would
  // make a freshly loaded draft report as stale before a single edit.
  const seed = { ...initial }
  return { persistence: seed, render: seed, pending: {} }
}

/**
 * One edit — a keystroke's autosave payload.
 *
 * Advances persistence and pending. **Never touches render.** That omission is the sprint.
 */
export function applyEdit(state: DraftSplit, payload: DraftFields): DraftSplit {
  return {
    persistence: { ...state.persistence, ...payload },
    render:      state.render,
    pending:     { ...state.pending, ...payload },
  }
}

/**
 * Render state catches up with persistence.
 *
 * Pending is untouched: what has been WRITTEN and what is DISPLAYED are independent
 * questions, and conflating them is how a "saved" indicator starts lying.
 */
export function syncRenderState(state: DraftSplit): DraftSplit {
  return { ...state, render: state.persistence }
}

/** A successful write: the payload is no longer pending, and render catches up. */
export function commitSave(state: DraftSplit): DraftSplit {
  return { persistence: state.persistence, render: state.persistence, pending: {} }
}

/**
 * A failed write: the in-flight payload returns to pending, newer edits winning on key
 * collision, and render still catches up so an error UI shows current data.
 */
export function failSave(state: DraftSplit, inFlight: DraftFields): DraftSplit {
  return {
    persistence: state.persistence,
    render:      state.persistence,
    pending:     { ...inFlight, ...state.pending },
  }
}

/** Conflict resolution REPLACES the draft; both copies are assigned the same object. */
export function replaceDraft(state: DraftSplit, next: DraftFields): DraftSplit {
  return { persistence: next, render: next, pending: state.pending }
}

/** True when a component would render data older than what has been typed. */
export function isRenderStale(state: DraftSplit): boolean {
  return state.render !== state.persistence
}

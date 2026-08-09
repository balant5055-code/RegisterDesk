// RD-EVENT-08 · Autosave change detection — PURE.
//
// Extracted from `useAutosaveEmit` so the emit decision is testable without a DOM (this
// repo's vitest environment is `node`), and so the serialization has a single home.
//
// ═══ THE COMPARATOR IS DELIBERATELY UNCHANGED ════════════════════════════════
// This sprint moves serialization OFF the render path. It does not change WHAT is compared.
// `JSON.stringify` is kept as the signature function because its equality is not the same
// as structural deep-equality, and the difference is observable:
//
//   • KEY ORDER is significant. { a: 1, b: 2 } and { b: 2, a: 1 } produce different
//     strings, so today they count as a change and autosave fires. A deep-equal comparator
//     would call them equal and NOT fire.
//   • `undefined` members are DROPPED. { a: undefined } and {} serialize identically, so
//     today they count as no change.
//   • Dates become ISO strings; NaN and Infinity become null; functions and symbols vanish.
//
// Swapping in a structural comparator would therefore change which edits reach Firestore.
// That is a behaviour change, and this sprint forbids one. A cheaper comparator is a real
// opportunity — it is written up as a future sprint, not taken here.

/** The signature of a snapshot of step data. `null` means "nothing observed yet". */
export type AutosaveSignature = string | null

export interface EmitDecision {
  /** Whether the caller should invoke its autosave callback. */
  emit: boolean
  /** Signature to carry into the next comparison. Always store this, emit or not. */
  nextSignature: string
}

/**
 * Computes a snapshot's signature.
 *
 * `data ?? null` matches the original expression exactly: `undefined` and `null` both
 * serialize to the string "null", so a step that swaps one for the other does NOT emit.
 */
export function autosaveSignature(data: unknown): string {
  return JSON.stringify(data ?? null)
}

/**
 * Decides whether a committed change should emit to autosave.
 *
 * Mirrors the original hook exactly:
 *   • the FIRST observation never emits — it only records a baseline, so mounting a step
 *     with existing draft data does not immediately re-save it;
 *   • afterwards, emit only when the signature actually differs. A step that re-renders
 *     with a new object identity but identical content stays silent.
 */
export function decideAutosaveEmit(prev: AutosaveSignature, data: unknown): EmitDecision {
  const nextSignature = autosaveSignature(data)
  if (prev === null) return { emit: false, nextSignature }
  return { emit: nextSignature !== prev, nextSignature }
}

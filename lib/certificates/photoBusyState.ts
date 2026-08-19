// RD-CERT-PHOTO-BUSY · the Certificate Center's per-certificate "photo is being written"
// state transition. PURE — no React, no I/O, no DOM.
//
// ═══ THE LOOP THIS EXISTS TO PREVENT ═════════════════════════════════════════
// AttendeePhotoCard reports its busy state from an effect. The previous updater ALWAYS
// returned a freshly-allocated object:
//
//   setPhoto(prev => ({ ...prev, [id]: { ...prev[id], readiness: busy ? 'resolving' : prev[id].readiness } }))
//
// Look at the `busy === false` branch: it writes `prev[id].readiness` back over itself —
// the value is unchanged, but the object identity is new, so React re-rendered. The parent
// then handed the card a newly-allocated `onBusyChange`, whose changed identity re-fired the
// card's effect, which called this again. Effect → setState → render → new callback → effect,
// forever: "Maximum update depth exceeded", ~200 times per session, on a live public page.
//
// Returning `prev` UNCHANGED when nothing actually changed is what breaks that cycle at the
// source: React bails out of a state update that returns the identical reference, so no
// render occurs and there is nothing to re-trigger the effect. The callback identity is
// stabilised separately at the call site; either fix alone stops the loop, and both together
// mean neither one silently becoming wrong can bring it back.

/** The slice of a certificate's photo state this transition touches. */
export interface ReadinessEntry {
  readiness: 'resolving' | 'ready' | 'unavailable'
}

/**
 * Marks ONE certificate busy or not busy.
 *
 *   busy === true   ⇒ readiness becomes 'resolving' — the download target cannot be trusted
 *                     while the stored photo is being written underneath it.
 *   busy === false  ⇒ readiness is LEFT ALONE. Clearing it here would announce "ready" before
 *                     the new photo had been re-read; `refreshHasPhoto` owns that transition
 *                     and settles hasPhoto + readiness together.
 *
 * Returns `prev` BY REFERENCE whenever the outcome is identical — including for an unknown
 * certificateId. Callers rely on that: it is what makes repeated reports free.
 *
 * Generic over the entry so the caller's richer PhotoState flows through unchanged; only
 * `readiness` is read or written, and every other certificate's entry is untouched.
 */
export function applyPhotoBusy<T extends ReadinessEntry>(
  prev:          Record<string, T>,
  certificateId: string,
  busy:          boolean,
): Record<string, T> {
  const entry = prev[certificateId]
  // No session for this certificate (never minted, or already unmounted). Nothing to mark.
  if (!entry) return prev

  const next = busy ? 'resolving' : entry.readiness
  if (next === entry.readiness) return prev

  return { ...prev, [certificateId]: { ...entry, readiness: next } }
}

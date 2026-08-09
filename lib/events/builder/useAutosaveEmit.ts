'use client'

// RD-PRODUCT-01G Phase 8 — shared Event Builder autosave-emit hook.
//
// Extracted VERBATIM from the Event Builder monolith. SHARED by every editing step
// (Step 4 Passes & Pricing, Step 5 Registration Form, Step 6 Event Details), so it lives in
// the shared builder lib rather than any single step's file. Pure React (refs + effects), no
// business logic — the actual autosave/persistence is owned by the parent page's onAutosave
// callback that this hook forwards to.
//
// ═══ RD-EVENT-08 — serialization moved OFF the render path ═══════════════════
// It previously read:
//
//     const json = JSON.stringify(data ?? null)      // ← during render, EVERY render
//     useEffect(() => { …emit… }, [json])
//
// so every keystroke in Pricing, Form or Details serialized that step's entire draft before
// the browser could paint. The comparison itself is unchanged — same signature function,
// same equality — it now runs in the effect, after commit, where it cannot delay a frame.
// See `autosaveChangeDetection.ts` for why the comparator was deliberately NOT made cheaper.
//
// The two refs that mirrored `data` and `onAutosave` are gone: the effect closes over this
// render's values directly, which is what those refs were reconstructing anyway.

import { useEffect, useRef } from 'react'
import { decideAutosaveEmit, type AutosaveSignature } from './autosaveChangeDetection'

// RD-PRODUCT-01B — emit a step's data to the debounced autosave whenever its CONTENT
// changes, skipping the initial render.
export function useAutosaveEmit(data: unknown, onAutosave?: (d: unknown) => void) {
  const signature = useRef<AutosaveSignature>(null)

  // No dependency array: the effect runs after every commit and decides for itself. That is
  // the same set of opportunities the old `[json]` dependency had — React compared the
  // serialized value it was handed, this compares the one it computes — minus the
  // render-path cost of producing it.
  useEffect(() => {
    const { emit, nextSignature } = decideAutosaveEmit(signature.current, data)
    signature.current = nextSignature
    if (emit) onAutosave?.(data)
  })
}

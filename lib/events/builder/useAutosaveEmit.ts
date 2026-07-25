'use client'

// RD-PRODUCT-01G Phase 8 — shared Event Builder autosave-emit hook.
//
// Extracted VERBATIM from the Event Builder monolith. SHARED by every editing step
// (Step 4 Passes & Pricing, Step 5 Registration Form, Step 6 Event Details), so it lives in
// the shared builder lib rather than any single step's file. Pure React (refs + effects), no
// business logic — the actual autosave/persistence is owned by the parent page's onAutosave
// callback that this hook forwards to.

import { useEffect, useRef } from 'react'

// RD-PRODUCT-01B — emit a step's data to the debounced autosave whenever its CONTENT
// changes (diffed by JSON), skipping the initial render. Data + callback are held in
// refs so the only reactive dependency is the serialized content.
export function useAutosaveEmit(data: unknown, onAutosave?: (d: unknown) => void) {
  const first   = useRef(true)
  const dataRef = useRef(data)
  const cbRef   = useRef(onAutosave)
  // Sync refs in an effect (never during render) so the emit effect can depend only
  // on the serialized content. Declared BEFORE the emit effect so it runs first.
  useEffect(() => { dataRef.current = data; cbRef.current = onAutosave })
  const json = JSON.stringify(data ?? null)
  useEffect(() => {
    if (first.current) { first.current = false; return }
    cbRef.current?.(dataRef.current)
  }, [json])
}

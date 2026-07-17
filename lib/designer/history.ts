// Shared Designer Core — undo/redo history (GA-6 S2). Client-only, render-agnostic.
//
// Extracted VERBATIM from the Print Designer's inline history (coalesced push +
// past/future stacks) so BOTH the Print Designer and the Certificate Builder share
// ONE implementation. It owns ONLY editor state transitions — it knows nothing about
// certificates, print assets, rendering, storage, or schemas. Generic over the
// document snapshot type `D` (whatever a designer chooses to make undoable).

import { useCallback, useEffect, useRef, useState } from 'react'

export interface EditorHistory<D> {
  state:    D
  ref:      React.MutableRefObject<D>          // always-current value (avoids stale closures)
  /** History-recording update. `coalesce` merges rapid updates (e.g. a drag) into one entry. */
  mutate:   (producer: (d: D) => D, coalesce?: boolean) => void
  /** Non-recording set (e.g. loading a document) — clears the stacks. */
  reset:    (next: D) => void
  undo:     () => void
  redo:     () => void
  canUndo:  () => boolean
  canRedo:  () => boolean
}

/**
 * Coalesced undo/redo over an arbitrary document snapshot. `onChange` fires on every
 * applied change (mutate/undo/redo/reset) — designers use it to flag "unsaved" without
 * the core knowing what saving means.
 */
export function useEditorHistory<D>(initial: D, onChange?: () => void): EditorHistory<D> {
  const [state, setStateRaw] = useState<D>(initial)
  const ref      = useRef<D>(initial)
  const past     = useRef<D[]>([])
  const future   = useRef<D[]>([])
  const lastPush = useRef(0)
  const onChangeRef = useRef(onChange)
  // Keep the latest onChange without touching the ref during render — it is only read
  // inside event-handler-triggered updates, never during rendering.
  useEffect(() => { onChangeRef.current = onChange })

  const apply = useCallback((next: D) => {
    ref.current = next
    setStateRaw(next)
    onChangeRef.current?.()
  }, [])

  const mutate = useCallback((producer: (d: D) => D, coalesce = false) => {
    const prev = ref.current
    const next = producer(prev)
    const now  = Date.now()
    if (!coalesce || now - lastPush.current > 500) { past.current.push(prev); future.current = []; lastPush.current = now }
    apply(next)
  }, [apply])

  const undo = useCallback(() => {
    const prev = past.current.pop(); if (prev === undefined) return
    future.current.push(ref.current); apply(prev)
  }, [apply])

  const redo = useCallback(() => {
    const next = future.current.pop(); if (next === undefined) return
    past.current.push(ref.current); apply(next)
  }, [apply])

  const reset = useCallback((next: D) => {
    ref.current = next
    setStateRaw(next)
    past.current = []; future.current = []; lastPush.current = 0
    onChangeRef.current?.()
  }, [])

  const canUndo = useCallback(() => past.current.length > 0, [])
  const canRedo = useCallback(() => future.current.length > 0, [])

  return { state, ref, mutate, reset, undo, redo, canUndo, canRedo }
}

'use client'

// PA-9 S3 Part 8 — persist small designer prefs (zoom, preview mode, guide
// visibility, sidebar widths, simulation) in localStorage. Hydration-safe: starts
// from `initial`, loads the stored value after mount, then writes on change.

import { useEffect, useRef, useState } from 'react'

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const [val, setVal] = useState<T>(initial)
  const loaded = useRef(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(key)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw != null) setVal(JSON.parse(raw) as T)
    } catch { /* ignore */ }
    loaded.current = true
  }, [key])

  useEffect(() => {
    if (!loaded.current) return
    try { localStorage.setItem(key, JSON.stringify(val)) } catch { /* ignore */ }
  }, [key, val])

  return [val, setVal]
}

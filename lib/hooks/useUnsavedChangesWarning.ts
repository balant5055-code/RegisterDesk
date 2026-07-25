'use client'

// RD-PRODUCT-01B — warn before losing unsaved draft edits on tab close / reload /
// browser back-out. `onFlush` (if provided) is best-effort called to push any pending
// write before the page unloads. Only active while `hasUnsaved` is true.
//
// Note: the App Router does not expose client-side route-change events, so in-app <Link>
// navigations can't be intercepted here; the useDraft crash-recovery snapshot covers
// that case (unsynced edits are restored on return). This guard covers the native
// browser unload paths (close, reload, external back).

import { useEffect } from 'react'

export function useUnsavedChangesWarning(hasUnsaved: boolean, onFlush?: () => void) {
  useEffect(() => {
    if (!hasUnsaved) return
    const handler = (e: BeforeUnloadEvent) => {
      try { onFlush?.() } catch { /* best-effort */ }
      e.preventDefault()
      e.returnValue = ''   // triggers the browser's native "unsaved changes" prompt
      return ''
    }
    window.addEventListener('beforeunload', handler)
    return () => window.removeEventListener('beforeunload', handler)
  }, [hasUnsaved, onFlush])
}

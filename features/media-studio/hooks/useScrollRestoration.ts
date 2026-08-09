'use client'

// RD-MEDIA-UI-04 · Opt Media Studio out of automatic scroll restoration.
//
// ═══ THE BUG ══════════════════════════════════════════════════════════════════
// Reloading the Import page opened it already scrolled down to the Photos section, with no
// interaction at all.
//
// Nothing in the page scrolls. The cause is a race between the BROWSER's scroll restoration
// and a page whose content arrives after hydration:
//
//   t0  first paint    `useMediaEvents` is still loading, so `event` is null.
//                      Sections 2–7 are all absent. Document ≈ 300px.
//   t1  hydration      unchanged — the fetch has not resolved.
//   t2  fetch resolves `event` becomes non-null and sections 2, 3, 4 and 5 mount at
//                      once, adding roughly 1,000px.
//
// `history.scrollRestoration` defaults to 'auto', so on a reload the browser tries to
// re-apply the previous offset and keeps re-applying it as the document grows. The document
// only becomes tall enough at t2 — so the restore lands wherever that offset now falls,
// which is the Photos section.
//
// It is not focus: nothing in this subtree has `autoFocus` or calls `focus()`, and the
// `sr-only` file inputs are never focused programmatically.
//
// ═══ THE FIX ══════════════════════════════════════════════════════════════════
// Tell the browser not to restore a position into content that does not exist yet. 'manual'
// means Media Studio always opens where the organizer expects — at the top.
//
// Scoped, not global: the previous value is captured and put back on unmount, so leaving
// Media Studio restores whatever the rest of the app relies on. This changes no layout, no
// CSS and no conditional rendering.

import { useEffect } from 'react'

export function useManualScrollRestoration(): void {
  useEffect(() => {
    if (typeof window === 'undefined') return
    const history = window.history
    // Safari before 16 and some embedded webviews do not implement it. Absent support means
    // the browser is not restoring anyway, so there is nothing to opt out of.
    if (!history || !('scrollRestoration' in history)) return

    const previous = history.scrollRestoration
    history.scrollRestoration = 'manual'

    return () => {
      // Put it back exactly as it was rather than assuming 'auto' — another part of the app
      // may have set it deliberately.
      history.scrollRestoration = previous
    }
  }, [])
}

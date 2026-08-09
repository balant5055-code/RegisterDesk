'use client'

// RD-MEDIA-IMPORT-UX · A single-row chip strip that scrolls horizontally.
//
// ═══ WHY NOT `scrollIntoView` ═════════════════════════════════════════════════
// Bringing the selected chip into view is the obvious job for `el.scrollIntoView()`, and it
// is the wrong tool here: it scrolls EVERY scrollable ancestor, including `#main-content`.
// This project spent four sprints chasing a page that moved on its own, so nothing here is
// allowed to touch a scroll position other than this row's.
//
// `scrollLeft` on the row itself is mutated directly. It cannot move the page.
//
// ═══ WHY THE EDGES ARE MEASURED, NOT ASSUMED ══════════════════════════════════
// A row that scrolls with no visual cue is a row most people never scroll. The fades appear
// only when there is genuinely something past the edge, so they are information rather than
// decoration — a permanent gradient would imply more content even when the row fits.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

export interface ScrollRowProps {
  children: ReactNode
  /**
   * The `data-chip-id` of the active chip. When it changes, that chip is brought into view
   * horizontally — and only horizontally.
   */
  activeId?: string | null
  className?: string
  'aria-label'?: string
}

/** Breathing room left when a chip is scrolled to an edge. */
const EDGE_GAP = 12

export function ScrollRow({ children, activeId, className, ...rest }: ScrollRowProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ left: false, right: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // 1px of slack: sub-pixel layout makes an exact comparison flicker the right-hand fade.
    const left  = el.scrollLeft > 1
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1
    // Returning the SAME object when nothing changed skips the re-render entirely — a scroll
    // handler that setStates on every frame would be its own performance problem.
    setEdges(prev => (prev.left === left && prev.right === right ? prev : { left, right }))
  }, [])

  // ResizeObserver fires once on observe, which gives the initial measurement WITHOUT a
  // synchronous setState inside the effect.
  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  // Bring the active chip into view — horizontally, within this element only.
  useEffect(() => {
    const box = ref.current
    if (!box || !activeId) return
    const chip = box.querySelector<HTMLElement>(`[data-chip-id="${CSS.escape(activeId)}"]`)
    if (!chip) return

    const start = chip.offsetLeft
    const end   = start + chip.offsetWidth
    if (start < box.scrollLeft) {
      box.scrollTo({ left: Math.max(0, start - EDGE_GAP), behavior: 'smooth' })
    } else if (end > box.scrollLeft + box.clientWidth) {
      box.scrollTo({ left: end - box.clientWidth + EDGE_GAP, behavior: 'smooth' })
    }
  }, [activeId])

  return (
    <div className="relative">
      <div
        ref={ref}
        onScroll={measure}
        className={cn(
          '-mx-1 flex gap-1.5 overflow-x-auto scroll-smooth px-1 pb-1',
          className,
        )}
        {...rest}
      >
        {children}
      </div>

      {/* Shown only when there IS something past the edge. `pointer-events-none` so they
          never intercept a click meant for the chip underneath. */}
      {edges.left && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-card to-transparent"
        />
      )}
      {edges.right && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-card to-transparent"
        />
      )}
    </div>
  )
}

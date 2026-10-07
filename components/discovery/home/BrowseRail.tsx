'use client'

// ─── BrowseRail — the one-row category slider under the search bar ──────────
//
// The owner wants the categories on ONE row (no wrapping), as a slider — and a hidden
// horizontal scroll is exactly what a phone visitor never discovers. So the overflow is
// ANNOUNCED, not implied: whenever more categories lie off either edge, that edge fades
// and carries a visible arrow button that pages the row. When everything fits (desktop),
// neither edge has anything to announce and the rail is plain type and tiles.
//
// This is the only client JavaScript in Browse. The links themselves stay server-rendered
// by BrowseShortcuts and arrive as children, so every category is still a crawlable <a>
// in the HTML; the rail only measures scroll position and moves it.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { HIDE_SCROLLBAR } from '@/components/discovery/lib/motion'
import { cn } from '@/lib/utils/cn'

const FADE = '2.5rem'

export function BrowseRail({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLUListElement>(null)
  const [edges, setEdges] = useState({ prev: false, next: false })

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const max = el.scrollWidth - el.clientWidth
    setEdges({ prev: el.scrollLeft > 2, next: el.scrollLeft < max - 2 })
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => { el.removeEventListener('scroll', measure); ro.disconnect() }
  }, [measure])

  const page = (dir: 1 | -1) => {
    const el = ref.current
    if (!el) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: reduce ? 'auto' : 'smooth' })
  }

  // The fade sits only on an edge that has something beyond it.
  const mask = `linear-gradient(to right, ${edges.prev ? 'transparent' : 'black'}, black ${FADE}, black calc(100% - ${FADE}), ${edges.next ? 'transparent' : 'black'})`

  return (
    <div className="relative mt-4">
      <ul
        ref={ref}
        className="flex snap-x snap-mandatory items-start gap-x-1 overflow-x-auto scroll-px-1 pb-1 lg:justify-between lg:gap-x-0"
        style={{ ...HIDE_SCROLLBAR, maskImage: mask, WebkitMaskImage: mask }}
      >
        {children}
      </ul>

      <RailArrow side="prev" visible={edges.prev} onClick={() => page(-1)} />
      <RailArrow side="next" visible={edges.next} onClick={() => page(1)} />
    </div>
  )
}

function RailArrow({ side, visible, onClick }: { side: 'prev' | 'next'; visible: boolean; onClick: () => void }) {
  const Icon = side === 'prev' ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={side === 'prev' ? 'Previous categories' : 'More categories'}
      // Hidden from the tab order when there is nothing to page to; the links themselves
      // are ordinary focusable anchors, and a browser scrolls a focused link into view.
      tabIndex={visible ? 0 : -1}
      aria-hidden={!visible}
      className={cn(
        // Centred on the 44px icon tiles (py-1 + half of size-11), not on the whole item.
        'absolute top-[26px] z-[1] inline-flex size-8 -translate-y-1/2 items-center justify-center',
        'rounded-[var(--radius-control)] border border-border bg-card text-hero-ink',
        'shadow-[0_4px_14px_-6px_rgb(11_21_51/0.25)]',
        'transition-[opacity,color,border-color] duration-200 ease-out hover:border-action/40 hover:text-action',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-offset-2',
        side === 'prev' ? 'left-0' : 'right-0',
        visible ? 'opacity-100' : 'pointer-events-none opacity-0',
      )}
    >
      <Icon className="size-4" strokeWidth={2} aria-hidden />
    </button>
  )
}

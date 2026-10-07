'use client'

// ─── SportsSectionNav — one hairline of section links under the cover ────────
//
// SPORTS-ONLY. Sits directly under SportsCover: a single row of in-page links on one
// hairline, the current section marked by a short action-coloured rule. No pills, no
// container, no shadow. On narrow screens the row scrolls sideways.
//
// The template hands over the sections it RENDERS (it is the only file that can see the
// order and the conditions), but several of those sections still self-hide on empty data
// — Journey with no items, Sponsors with no partners, Good to Know with nothing to say —
// so the list is reconciled against the DOM once, on mount, and a link is never offered
// to a target that is not on the page. Until then the server-rendered list stands.
//
// Links are HashScrollLink, the template's existing in-page anchor (smooth scroll, focus
// hand-off, SECTION_SCROLL_MT offset); nothing new is invented for navigation.

import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils/cn'
import { EVENT_CONTAINER } from '@/components/event-templates/shared/ui/framework'
import { HashScrollLink } from '@/components/event-templates/shared/ui/HashScrollLink'

export interface SportsSectionNavItem {
  /** Element id of the target section, without '#'. */
  id:    string
  label: string
}

/** A section is current once its top has crossed this line — a quarter of the viewport,
 *  and never above the fixed-navbar offset a hash-scrolled section lands at. */
const spyLine = () => window.scrollY + Math.max(160, window.innerHeight * 0.25)

export function SportsSectionNav({ items }: { items: SportsSectionNavItem[] }) {
  const [present, setPresent] = useState(items)
  const [active, setActive]   = useState(items[0]?.id ?? '')
  const listRef = useRef<HTMLUListElement>(null)

  // Reconcile against the DOM (self-hiding sections), then follow the scroll position.
  useEffect(() => {
    let raf = 0
    const live = items.filter(i => document.getElementById(i.id))

    const spy = () => {
      raf = 0
      const line = spyLine()
      // The section whose top is the LAST one above the line, by position — not by list
      // order, because below lg the venue/kit rail sits earlier on the page than it does
      // in the tab list.
      let current = live[0]?.id ?? ''
      let best = -Infinity
      for (const i of live) {
        const el = document.getElementById(i.id)
        const top = el ? el.getBoundingClientRect().top + window.scrollY : Infinity
        if (top <= line && top > best) { best = top; current = i.id }
      }
      setActive(current)
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(spy) }

    // Deferred out of the synchronous effect body (repo rule: no setState directly in an
    // effect); the first spy pass also settles the initial state for a deep link.
    const first = requestAnimationFrame(() => { setPresent(live); spy() })
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onScroll)
    return () => {
      cancelAnimationFrame(first)
      if (raf) cancelAnimationFrame(raf)
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onScroll)
    }
  }, [items])

  // Keep the current link in view when the row scrolls sideways (phones).
  useEffect(() => {
    const list = listRef.current
    const link = list?.querySelector<HTMLElement>(`[data-section="${active}"]`)
    if (!list || !link) return
    const left = link.offsetLeft, right = left + link.offsetWidth
    if (left < list.scrollLeft) list.scrollTo({ left: left - 16, behavior: 'smooth' })
    else if (right > list.scrollLeft + list.clientWidth) list.scrollTo({ left: right - list.clientWidth + 16, behavior: 'smooth' })
  }, [active])

  if (present.length < 2) return null

  return (
    // 2026-09-25 luxury pass (owner): the programme's index line — widely tracked small
    // caps in soft ink, the current section in ink with a BRONZE underline, a quiet bronze
    // dot between entries. Centred when it fits (lg); on a phone the row scrolls, and its
    // edges fade so the overflow reads as "more" rather than a cut-off word.
    // STICKY (owner): it docks under the fixed site header (--disc-nav-h) and stays there
    // while the page scrolls. overflow-y-hidden: a horizontal scroller is otherwise also a
    // vertical one, and the underline's -1px pull drew a stray vertical scrollbar.
    <nav aria-label="On this page" className="sticky top-[var(--disc-nav-h)] z-40 border-y border-border/60 bg-background/95 supports-[backdrop-filter]:bg-background/85 supports-[backdrop-filter]:backdrop-saturate-150">
      <ul
        ref={listRef}
        className={cn(EVENT_CONTAINER, 'flex items-center gap-x-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:justify-center', '[mask-image:linear-gradient(to_right,transparent,black_1.25rem,black_calc(100%-1.25rem),transparent)] lg:[mask-image:none]')}
      >
        {present.map(i => {
          const isActive = i.id === active
          return (
            <li key={i.id} className="flex shrink-0 items-center gap-x-1 [&+li]:before:h-3 [&+li]:before:w-px [&+li]:before:bg-hero-accent-rule/40 [&+li]:before:content-['']">
              <HashScrollLink
                targetId={i.id}
                data-section={i.id}
                aria-current={isActive ? 'location' : undefined}
                className={cn(
                  'block whitespace-nowrap border-b-2 px-3 py-3.5 text-fs-2xs font-semibold uppercase tracking-[0.16em] transition-colors sm:px-4',
                  'focus-visible:outline-none focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-action focus-visible:ring-inset',
                  isActive ? 'border-hero-accent-rule text-hero-ink' : 'border-transparent text-hero-eyebrow hover:text-hero-ink',
                )}
              >
                {i.label}
              </HashScrollLink>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

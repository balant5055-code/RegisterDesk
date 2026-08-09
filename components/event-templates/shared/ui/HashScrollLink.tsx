'use client'

// An in-page anchor that actually scrolls. Public event templates only.
//
// ═══ WHY NOT next/link ═══════════════════════════════════════════════════════
// A hash-only <Link href="#register"> is intercepted by the App Router and turned into a
// client-side navigation. Two things go wrong:
//
//   1. FIRST CLICK — the router owns scroll restoration for the navigation, so the page
//      can be moved to the top before (or instead of) the browser's native anchor jump.
//      What the user sees is a jump to the wrong place.
//   2. REPEAT CLICKS — the URL already ends in #register, so navigating to the same hash
//      is a no-op. The router short-circuits and nothing scrolls at all, which is why the
//      CTA stops responding once it has been used.
//
// A plain <a> keeps deep links, middle-click, right-click → "open in new tab", and
// keyboard activation, while preventDefault() stops BOTH the router and the native jump
// so exactly one scroll runs — ours.
//
// ═══ OFFSET ══════════════════════════════════════════════════════════════════
// No magic pixel offset here. Target sections already carry SECTION_SCROLL_MT
// (scroll-mt-24) from SectionShell, which is the project's single fixed-navbar offset,
// and scroll-margin-top is honoured by scrollIntoView. Adding an offset here would
// double-count it.

import { useCallback } from 'react'
import { useReducedMotion } from 'framer-motion'

export function HashScrollLink({
  targetId, className, children, ...rest
}: {
  /** Element id to scroll to, WITHOUT the leading '#'. */
  targetId:  string
  className?: string
  children:  React.ReactNode
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href' | 'onClick'>) {
  const reduce = useReducedMotion()

  const onClick = useCallback((e: React.MouseEvent<HTMLAnchorElement>) => {
    // Let the browser handle modified clicks (new tab / new window) normally.
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return

    const target = document.getElementById(targetId)
    if (!target) return   // no target on this template — fall through to the native jump

    e.preventDefault()
    target.scrollIntoView({ behavior: reduce ? 'auto' : 'smooth', block: 'start' })

    // Move focus WITHOUT a second scroll (preventScroll), so keyboard users land in the
    // section they asked for instead of continuing from the hero. tabIndex is set only
    // for this programmatic focus and removed on blur, so the section never becomes a
    // stop in the normal tab order.
    if (!target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1')
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
    }
    target.focus({ preventScroll: true })
  }, [targetId, reduce])

  return (
    <a href={`#${targetId}`} onClick={onClick} className={className} {...rest}>
      {children}
    </a>
  )
}

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'
import { Ticket } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { buttonVariants } from '@/components/ui/button'
import type { PassPublic } from '@/components/event-templates/types'
import { formatINR, minPassPrice } from '@/components/event-templates/shared/utils/format'

// RD-ATTENDEE-03A C4 + RD-ATTENDEE-03B: the shared persistent registration CTA.
//  • Mobile (always): a bottom bar that self-gates on scroll, clears the safe area, and
//    reserves an in-flow spacer so it never covers the last section.
//  • Desktop (opt-in via showDesktop): a bottom-right "quick register" pill so templates
//    that bury the tickets section far down the page keep a persistent, one-click path to
//    registration — the desktop conversion gap the audit flagged (only the fallback had
//    a persistent desktop CTA). Additive + fixed-position (no layout reflow); uses the
//    existing card/button tokens — no new colours, type, or template layout changes.
//  • Both self-gate on scroll (appear after the hero), respect prefers-reduced-motion, and
//    scroll to THIS template's registration section (targetId).
const SHOW_AFTER_PX = 480

export function StickyMobileCTA({ visible, showDesktop = false, title, isFreeEvent, passes, registrationOpen, targetId = 'register' }: {
  // Optional external override. When omitted the CTA manages its own visibility from
  // scroll position; when provided it is ANDed with the scroll gate.
  visible?:         boolean
  // When true, also render the persistent desktop pill (templates without their own
  // desktop registration panel opt in; the fallback keeps its own and leaves this off).
  showDesktop?:     boolean
  title:            string
  isFreeEvent:      boolean
  passes:           PassPublic[]
  registrationOpen: boolean
  // id of THIS template's registration section so the CTA always scrolls to it.
  targetId?:        string
}) {
  const reduce = useReducedMotion()
  const [scrolled, setScrolled] = useState(false)

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > SHOW_AFTER_PX)
    window.addEventListener('scroll', onScroll, { passive: true })
    // Defer the initial read out of the synchronous effect body.
    const raf = window.requestAnimationFrame(onScroll)
    return () => { window.removeEventListener('scroll', onScroll); window.cancelAnimationFrame(raf) }
  }, [])

  const active = passes.filter(p => p.status !== 'inactive')
  if (!registrationOpen || active.length === 0) return null

  const shown     = (visible ?? true) && scrolled
  const priceLine = isFreeEvent ? 'Free registration' : `From ${formatINR(minPassPrice(passes))}`
  const ctaLabel  = isFreeEvent ? 'Register' : 'Get Tickets'

  return (
    <>
      {/* In-flow spacer so the fixed mobile bar never hides the final section. */}
      <div aria-hidden className="h-20 lg:hidden" />

      {/* ── Mobile: bottom bar ─────────────────────────────────────────────────── */}
      <AnimatePresence>
        {shown && (
          <motion.div
            initial={reduce ? false : { y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { y: '100%', opacity: 0 }}
            transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
            className="fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-card/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-[0_-4px_20px_rgb(0_0_0/0.1)] backdrop-blur-md lg:hidden"
          >
            <div className="mx-auto flex max-w-lg items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-bold text-foreground">{title}</p>
                <p className="text-[10.5px] text-muted-foreground">{priceLine}</p>
              </div>
              <Link
                href={`#${targetId}`}
                className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'shrink-0 gap-1.5')}
              >
                <Ticket className="size-3.5" aria-hidden />
                {ctaLabel}
              </Link>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Desktop: bottom-right quick-register pill (opt-in) ──────────────────── */}
      {showDesktop && (
        <AnimatePresence>
          {shown && (
            <motion.div
              initial={reduce ? false : { y: 24, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { y: 24, opacity: 0 }}
              transition={{ duration: 0.28, ease: [0.25, 0.46, 0.45, 0.94] }}
              className="fixed bottom-6 right-6 z-50 hidden lg:block"
            >
              <Link
                href={`#${targetId}`}
                aria-label={`Register — ${title}`}
                className="flex items-center gap-3 rounded-full border border-border bg-card/95 py-2 pl-4 pr-2 shadow-[0_8px_30px_rgb(0_0_0/0.12)] backdrop-blur-md transition-shadow hover:shadow-[0_10px_36px_rgb(0_0_0/0.18)]"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="text-[10.5px] font-medium text-muted-foreground">{priceLine}</span>
                  <span className="max-w-[180px] truncate text-[12.5px] font-bold text-foreground">{title}</span>
                </span>
                <span className={cn(buttonVariants({ variant: 'primary', size: 'sm' }), 'shrink-0 gap-1.5')}>
                  <Ticket className="size-3.5" aria-hidden />
                  {ctaLabel}
                </span>
              </Link>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </>
  )
}

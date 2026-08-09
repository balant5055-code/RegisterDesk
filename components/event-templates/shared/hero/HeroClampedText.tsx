'use client'

// HeroClampedText — clamp long organiser copy to a fixed number of lines and move the
// remainder into a dialog (RD-ST5.2).
//
// Why this exists: the hero is viewport-sized (ST5.1), so any block whose height tracks
// its content length can break that contract. A two-line description and a twenty-line
// description must occupy the SAME space. This component guarantees that two ways:
//
//   1. `clampClassName` caps the visible line count per breakpoint;
//   2. `reserveClassName` (optional) pins the block's height so a short value does not
//      shrink it either — otherwise the hero would still be content-sized, just bounded.
//
// The "read more" trigger is only rendered when the text ACTUALLY overflows its clamp,
// measured from the DOM rather than guessed from character counts (a guess is wrong the
// moment the breakpoint, font or column width changes). When it does render, the
// reserved height already accounts for it, so revealing it moves nothing.
//
// One component, two callers (description + venue address) — no duplicated disclosure
// logic. Dialog behaviour (focus trap, Escape, backdrop click, portal) is the shared
// components/ui/Dialog primitive; nothing new is introduced here.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Dialog } from '@/components/ui/Dialog'

export interface HeroClampedTextProps {
  /** The copy to clamp. Empty/blank renders nothing at all. */
  text:              string
  /** Per-breakpoint line caps, e.g. 'line-clamp-4 md:line-clamp-3 lg:line-clamp-2'. */
  clampClassName:    string
  /** Typography for the clamped paragraph. */
  className?:        string
  /** Height reservation for the whole block, so content length can't move the hero. */
  reserveClassName?: string
  /** Trigger copy, e.g. 'Read More' / 'View Full Address'. */
  triggerLabel:      string
  dialogTitle:       string
  /** Dialog body. Defaults to the same text, rendered as flowing paragraphs. */
  dialogBody?:       ReactNode
  dialogSize?:       'sm' | 'md' | 'lg'
}

export function HeroClampedText({
  text, clampClassName, className, reserveClassName,
  triggerLabel, dialogTitle, dialogBody, dialogSize = 'lg',
}: HeroClampedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  const [open, setOpen] = useState(false)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    // 1px tolerance absorbs sub-pixel line-height rounding.
    setOverflowing(el.scrollHeight - el.clientHeight > 1)
  }, [])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Deferred out of the synchronous effect body (repo rule: no setState directly in an
    // effect) and re-run on resize, because the clamp itself is breakpoint-dependent.
    const raf = requestAnimationFrame(measure)
    const ro = new ResizeObserver(() => requestAnimationFrame(measure))
    ro.observe(el)
    return () => { cancelAnimationFrame(raf); ro.disconnect() }
  }, [measure, text])

  if (!text.trim()) return null

  return (
    <div className={reserveClassName}>
      <p ref={ref} className={cn(clampClassName, 'text-pretty', className)}>{text}</p>

      {overflowing && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="mt-1 inline-flex items-center gap-1 text-fs-sm font-semibold text-primary underline-offset-2 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
        >
          {triggerLabel}
          <ArrowRight className="size-3.5" aria-hidden />
        </button>
      )}

      <Dialog open={open} onClose={() => setOpen(false)} title={dialogTitle} size={dialogSize}>
        <div className="max-h-[60vh] overflow-y-auto">
          {dialogBody ?? (
            <p className="whitespace-pre-line text-fs-base leading-relaxed text-muted-foreground">{text}</p>
          )}
        </div>
      </Dialog>
    </div>
  )
}

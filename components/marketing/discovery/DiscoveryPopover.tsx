'use client'

// ─── Discovery popover ───────────────────────────────────────────────────────
//
// The ONE overlay primitive the /events discovery controls use — location, date, sort and
// advanced filters all render through it. Written once so the dismissal contract (outside
// click, Escape, scroll-lock on mobile) cannot drift between four hand-rolled dropdowns, and
// so every one of them gets the same responsive behaviour:
//
//   ≥ sm  dropdown anchored under its trigger
//   < sm  bottom sheet — a 300px dropdown pinned to a trigger is unusable on a phone
//
// BOTH forms are PORTALLED to <body> and positioned `fixed`.
//
// That is not over-engineering, it is the fix for a bug this replaced: the desktop dropdown
// used to be `position: absolute` inside the trigger's DOM, so the hero section's
// `overflow-hidden` (which clips its own decorative brand wash) sliced the location panel in
// half. Any ancestor with overflow, a transform, or a lower stacking context can do that, and
// this component is used inside three different ones. Anchoring in the portal removes the
// whole class of failure — and lets the panel flip above the trigger and cap its own height
// when it would run off the bottom of the viewport.
//
// Presentation only: open state and content live in the caller.

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'framer-motion'
import { ChevronDown, X } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

/** Gap between the trigger and the panel, and the minimum breathing room at a viewport edge. */
const OFFSET = 8
const EDGE   = 10

interface Placement { top: number; left: number; maxHeight: number }

export function DiscoveryPopover({
  open,
  onClose,
  trigger,
  title,
  align = 'start',
  widthPx = 320,
  children,
  footer,
  className,
}: {
  open:     boolean
  onClose:  () => void
  /** Render-prop for the trigger so the popover owns the aria wiring. */
  trigger:  (props: { id: string; 'aria-haspopup': 'dialog'; 'aria-expanded': boolean; 'aria-controls': string }) => React.ReactNode
  /** Sheet heading on mobile; also the accessible name of the dropdown. */
  title:    string
  align?:   'start' | 'end'
  /** Desktop panel width in px — a number, because the panel is positioned, not just styled. */
  widthPx?: number
  children: React.ReactNode
  footer?:  React.ReactNode
  className?: string
}) {
  const anchorRef  = useRef<HTMLDivElement>(null)
  const panelId    = useId()
  const triggerId  = useId()
  const [place, setPlace] = useState<Placement | null>(null)

  // Anchor the fixed panel to the trigger's current viewport rect, flipping above it when
  // there is more room there than below.
  const reposition = useCallback(() => {
    const el = anchorRef.current
    if (!el || typeof window === 'undefined') return
    const r  = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight

    const below = vh - r.bottom - OFFSET - EDGE
    const above = r.top - OFFSET - EDGE
    const flip  = below < 260 && above > below

    const rawLeft = align === 'end' ? r.right - widthPx : r.left
    const left    = Math.max(EDGE, Math.min(rawLeft, vw - widthPx - EDGE))

    setPlace({
      top:       flip ? Math.max(EDGE, r.top - OFFSET) : r.bottom + OFFSET,
      left,
      maxHeight: Math.max(200, flip ? above : below),
    })
  }, [align, widthPx])

  // Measured in a LAYOUT effect so the panel is anchored before the browser paints it — a
  // passive effect would show one frame at the previous position. The last placement is left
  // in state on close rather than cleared: the panel is only rendered while `open`, and this
  // effect recomputes before paint on the next open, so a stale value can never be seen.
  useLayoutEffect(() => {
    if (!open) return
    reposition()
  }, [open, reposition])

  useEffect(() => {
    if (!open) return
    const onMove = () => reposition()
    // `capture` so the sticky refine bar's own scroll container is covered too.
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('resize', onMove)
    return () => {
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('resize', onMove)
    }
  }, [open, reposition])

  // Dismissal — pointerdown (not click) so a drag starting outside also closes, plus Escape.
  // Both listeners are torn down with the open state, so nothing listens while closed.
  useEffect(() => {
    if (!open) return
    const onPointer = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (anchorRef.current?.contains(target)) return
      if (target.closest?.('[data-popover-panel]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('pointerdown', onPointer)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointer)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])

  // Scroll-lock only while the mobile sheet is up, so the desktop dropdown never freezes the
  // page behind it.
  useEffect(() => {
    if (!open) return
    if (typeof window === 'undefined' || !window.matchMedia('(max-width: 639px)').matches) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  const body = (scrollMax?: number) => (
    <>
      <div
        className="overflow-y-auto overscroll-contain px-1"
        style={{ maxHeight: scrollMax ?? undefined }}
      >
        {children}
      </div>
      {footer && <div className="mt-1 border-t border-border/50 px-3 pb-1 pt-3 sm:px-2">{footer}</div>}
    </>
  )

  return (
    <div ref={anchorRef} className={cn('relative', className)}>
      {trigger({
        id: triggerId,
        'aria-haspopup': 'dialog',
        'aria-expanded': open,
        'aria-controls': panelId,
      })}
      <PopoverPortal
        open={open}
        onClose={onClose}
        title={title}
        panelId={panelId}
        place={place}
        widthPx={widthPx}
        hasFooter={!!footer}
        body={body}
      />
    </div>
  )
}

function PopoverPortal({
  open, onClose, title, panelId, place, widthPx, hasFooter, body,
}: {
  open: boolean
  onClose: () => void
  title: string
  panelId: string
  place: Placement | null
  widthPx: number
  hasFooter: boolean
  body: (scrollMax?: number) => React.ReactNode
}) {
  if (typeof document === 'undefined') return null

  // The footer sits outside the scroll area, so the scrollable region gets what is left.
  const scrollMax = place ? Math.max(140, place.maxHeight - (hasFooter ? 78 : 12)) : undefined

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          {/* ── ≥ sm: dropdown anchored to the trigger ── */}
          {place && (
            <motion.div
              key="dropdown"
              id={panelId}
              data-popover-panel
              role="dialog"
              aria-label={title}
              initial={{ opacity: 0, y: -6, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6, scale: 0.985 }}
              transition={{ duration: 0.16, ease: [0.25, 0.46, 0.45, 0.94] }}
              style={{ top: place.top, left: place.left, width: widthPx }}
              className="fixed z-[120] hidden origin-top rounded-2xl border border-border/70 bg-card p-2 shadow-2xl shadow-black/10 sm:block"
            >
              {body(scrollMax)}
            </motion.div>
          )}

          {/* ── < sm: bottom sheet ── */}
          <div className="sm:hidden">
            <motion.div
              key="scrim"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={onClose}
              className="fixed inset-0 z-[110] bg-foreground/35 backdrop-blur-[2px]"
            />
            <motion.div
              key="sheet"
              data-popover-panel
              role="dialog"
              aria-modal="true"
              aria-label={title}
              initial={{ y: '100%' }}
              animate={{ y: 0 }}
              exit={{ y: '100%' }}
              transition={{ type: 'spring', damping: 32, stiffness: 340 }}
              className="fixed inset-x-0 bottom-0 z-[111] flex max-h-[86vh] flex-col rounded-t-3xl border-t border-border/60 bg-card pb-[env(safe-area-inset-bottom)] shadow-2xl"
            >
              <div className="relative flex items-center justify-between px-4 pb-2 pt-4">
                <span aria-hidden className="absolute left-1/2 top-2 h-1 w-9 -translate-x-1/2 rounded-full bg-border-strong/70" />
                <h2 className="text-[15px] font-bold tracking-tight text-foreground">{title}</h2>
                <button
                  type="button"
                  onClick={onClose}
                  aria-label={`Close ${title}`}
                  className="flex size-8 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted active:bg-muted"
                >
                  <X className="size-4" />
                </button>
              </div>
              <div className="flex min-h-0 flex-1 flex-col px-2 pb-3">{body()}</div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  )
}

// ─── Row primitives shared by the popover contents ───────────────────────────

export function PopoverRow({
  active,
  onClick,
  icon,
  label,
  hint,
  trailing,
}: {
  active:    boolean
  onClick:   () => void
  icon?:     React.ReactNode
  label:     React.ReactNode
  hint?:     React.ReactNode
  trailing?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors',
        active ? 'bg-action/[0.07]' : 'hover:bg-muted/60',
      )}
    >
      {icon && (
        <span className={cn(
          'flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors',
          active ? 'bg-action text-white' : 'bg-muted/70 text-muted-foreground',
        )}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className={cn(
          'block truncate text-[13.5px] leading-tight',
          active ? 'font-semibold text-action' : 'font-medium text-foreground',
        )}>
          {label}
        </span>
        {hint && <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{hint}</span>}
      </span>
      {trailing}
    </button>
  )
}

export function PopoverGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-3 text-[10.5px] font-bold uppercase tracking-[0.08em] text-muted-foreground/70">
      {children}
    </p>
  )
}

/**
 * The secondary control inside the homepage search bar — category, location or date.
 *
 * It is deliberately QUIET. It used to be a 52px bordered field on a card fill, identical in
 * weight to the query input beside it, which is what made a row of them read as a form: five
 * boxes, nothing saying which to reach for first. Now the BAR carries the border and these
 * carry none — transparent until hovered, muted until they hold a value, 40px on a phone and
 * 44px from `sm`.
 *
 * The icon is hidden below `sm` because there is no room for it: three of these share one
 * 320px row as equal thirds, and an icon plus a chevron would leave ~28px of label. The
 * chevron stays, because it is the part that says the control opens.
 *
 * `shortValue` exists for the same reason — a caller whose idle label is too long for an
 * 88px third can supply a shorter spelling for phones without giving up the full one on
 * desktop. Both are rendered; CSS picks. Screen readers get `label`, which never changes.
 */
export function FieldTrigger({
  label,
  value,
  shortValue,
  icon,
  active,
  open,
  className,
  ...rest
}: {
  label:       string
  value:       string
  /** Phone-only spelling of `value`. Falls back to `value` when omitted. */
  shortValue?: string
  icon?:       React.ReactNode
  active:      boolean
  open:        boolean
  className?:  string
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      type="button"
      className={cn(
        // The phone padding and gap are as tight as they are because the arithmetic is tight:
        // at 320px each of the three thirds is 88px, and 12px of padding plus a 14px chevron
        // plus a 6px gap leaves 56px of label — just enough for "Category", "All India" and
        // "Any date" to render whole rather than as "Catego…". `sm` has room and relaxes.
        'flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-action',
        'sm:h-11 sm:gap-2.5 sm:px-3',
        // 2026-09-23 luxury pass: on a phone each filter is a quietly OUTLINED control (a
        // transparent word in a row of three read as text, not as something to tap); from
        // sm the bar's hairline dividers do that job and the outline goes.
        'max-sm:border max-sm:border-border/60',
        active || open ? 'bg-action/[0.06]' : 'hover:bg-muted/50',
        className,
      )}
    >
      {/* Icons from lg only: on a phone and a tablet the width goes to the value (the bronze
          label above it already names the field from sm). */}
      {icon && <span aria-hidden className="flex shrink-0 max-lg:hidden">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* From sm the field's NAME is set above its value in bronze small caps — the
            booking-bar convention — so "All India" reads as an answer to "Location". On a
            phone the row is too tight for two lines and the name stays screen-reader only. */}
        <span className="sr-only sm:not-sr-only sm:text-[0.625rem] sm:font-semibold sm:uppercase sm:leading-none sm:tracking-[0.18em] sm:text-hero-eyebrow">
          {label}
        </span>
        <span className={cn(
          'min-w-0 truncate text-fs-sm sm:mt-1 sm:leading-tight',
          active ? 'font-semibold text-foreground' : 'text-hero-ink-soft sm:text-hero-ink',
        )}>
          {shortValue ? (
            <>
              <span className="sm:hidden">{shortValue}</span>
              <span className="max-sm:hidden">{value}</span>
            </>
          ) : value}
        </span>
      </span>
      <ChevronDown
        aria-hidden
        className={cn(
          'size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-200',
          open && 'rotate-180',
        )}
      />
    </button>
  )
}

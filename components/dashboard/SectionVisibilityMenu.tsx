'use client'

// RD-DASHBOARD-05 · "Customise" — which dashboard sections this operator wants.
//
// A checkbox menu, not a drag-and-drop layout editor. Order is a product decision (it
// encodes the order of the questions an organizer asks, see the page header comment);
// PRESENCE is a personal one. Letting operators reorder would let them bury the
// Attention Center, which is the one section the page exists to surface.
//
// The locked row is rendered, disabled, with its reason visible — a control that
// silently ignores a click is worse than one that explains itself.

import { Check, Eye, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useDropdown } from '@/lib/hooks/useDropdown'
import { DASHBOARD_SECTIONS, hiddenCount, type DashboardSectionId } from '@/lib/dashboard/sections'

export function SectionVisibilityMenu({ visible, onToggle, onReset, className }: {
  visible:  Record<DashboardSectionId, boolean>
  onToggle: (id: DashboardSectionId) => void
  onReset:  () => void
  className?: string
}) {
  const { open, setOpen, containerRef } = useDropdown()
  const hidden = hiddenCount(visible)

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'inline-flex h-9 items-center gap-1.5 rounded-control border border-border bg-background px-2.5',
          'text-fs-sm font-medium text-foreground transition-colors hover:bg-muted/50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        )}
      >
        <SlidersHorizontal className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="hidden sm:inline">Customise</span>
        {/* The count is the only affordance telling an operator that a section is
            missing BY THEIR OWN CHOICE rather than because it failed to load. */}
        {hidden > 0 && (
          <span className="rounded-pill bg-muted px-1.5 text-fs-2xs tabular-nums text-muted-foreground">
            {hidden} hidden
          </span>
        )}
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Dashboard sections"
          className="absolute right-0 z-50 mt-1.5 w-[min(17rem,calc(100vw-2rem))] overflow-hidden rounded-surface border border-border bg-card shadow-lg"
        >
          <div className="flex items-center gap-1.5 border-b border-border px-3 py-2">
            <Eye className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-fs-xs font-semibold text-foreground">Show sections</span>
          </div>

          <div className="max-h-[min(22rem,55vh)] overflow-y-auto p-1.5">
            {DASHBOARD_SECTIONS.map(s => {
              const on = visible[s.id]
              return (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  disabled={s.locked}
                  onClick={() => onToggle(s.id)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-control px-2.5 py-1.5 text-left transition-colors',
                    s.locked ? 'cursor-default opacity-60' : 'hover:bg-muted',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded-[4px] border',
                      on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong',
                    )}
                    aria-hidden
                  >
                    {on && <Check className="size-3" strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fs-xs text-foreground">{s.label}</span>
                  {s.locked && <span className="shrink-0 text-fs-2xs text-muted-foreground">Always shown</span>}
                </button>
              )
            })}
          </div>

          <div className="border-t border-border p-1.5">
            <button
              type="button"
              onClick={onReset}
              className="flex w-full items-center gap-1.5 rounded-control px-2.5 py-1.5 text-fs-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <RotateCcw className="size-3.5" aria-hidden /> Show all sections
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

'use client'

// RD-EVENT-02 §4 · The events tab bar — a complete APG tab pattern.
//
// The previous bar carried `role="tablist"`, `role="tab"` and `aria-selected` but no
// panel, no `aria-controls` and no keyboard model, so a screen reader announced "tab 1 of
// 4, selected" about a relationship that did not exist. Incomplete ARIA is worse than
// none, so this either implements the pattern properly or does not claim it.
//
// It is deliberately NOT built on components/admin/FilterTabs: that component is a
// segmented pill control for admin lists, it carries the SAME missing-panel defect, and
// it is shared — changing it to fix this page would reach into the admin surface.

import { useRef } from 'react'
import { cn } from '@/lib/utils/cn'
import type { EventListingTabKey } from '@/lib/events/listingTabs'

export interface EventsTab {
  key:   EventListingTabKey
  label: string
}

/** Stable ids so `aria-controls` / `aria-labelledby` point at real elements. */
export const tabId      = (key: string) => `events-tab-${key}`
export const tabPanelId = (key: string) => `events-tabpanel-${key}`

export function EventsTabs({ tabs, active, onChange, className }: {
  tabs:      readonly EventsTab[]
  active:    EventListingTabKey
  onChange:  (key: EventListingTabKey) => void
  className?: string
}) {
  const listRef = useRef<HTMLDivElement>(null)

  /**
   * Arrow/Home/End move focus AND selection, which is the APG's automatic-activation
   * variant. It suits this bar because selecting a tab is cheap and reversible, and
   * because it matches what the mouse already does.
   */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const i = tabs.findIndex(t => t.key === active)
    if (i < 0) return

    let next: number | null = null
    switch (e.key) {
      case 'ArrowRight': next = (i + 1) % tabs.length; break
      case 'ArrowLeft':  next = (i - 1 + tabs.length) % tabs.length; break
      case 'Home':       next = 0; break
      case 'End':        next = tabs.length - 1; break
      default: return
    }

    e.preventDefault()
    const key = tabs[next].key
    onChange(key)
    // Focus follows selection, or the keyboard user would be arrowing through tabs while
    // their focus ring stayed behind on the old one.
    listRef.current?.querySelector<HTMLButtonElement>(`#${CSS.escape(tabId(key))}`)?.focus()
  }

  return (
    // 2026-09-29 luxury pass: a segmented control on a quiet track instead of an
    // underlined strip, so it can share one toolbar row with the search field.
    <div className={cn('w-full min-w-0 overflow-x-auto md:w-auto', className)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label="Event lifecycle"
        onKeyDown={onKeyDown}
        // Full width with equal segments on a phone; hugs its labels from md up.
        className="flex w-full gap-0.5 rounded-control border border-border/80 bg-muted/40 p-1 md:inline-flex md:w-auto"
      >
        {tabs.map(t => {
          const selected = t.key === active
          return (
            <button
              key={t.key}
              id={tabId(t.key)}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls={tabPanelId(t.key)}
              // Roving tabindex: one stop for the whole bar, then arrows inside it.
              tabIndex={selected ? 0 : -1}
              onClick={() => onChange(t.key)}
              className={cn(
                'inline-flex min-h-11 flex-1 shrink-0 items-center justify-center whitespace-nowrap sm:min-h-9 md:flex-none rounded-[calc(var(--radius-control)-2px)] px-3.5 text-fs-sm font-medium transition-[color,background-color,box-shadow] duration-150',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
                // `--primary-text` rather than `--primary`: the brand pink measures 4.27:1
                // as TEXT on a light ground, and this token is the darkened pair the design
                // system already added for exactly that case.
                selected
                  ? 'bg-card font-semibold text-[color:var(--primary-text)] shadow-[0_1px_2px_rgb(15_23_42_/_0.08)] ring-1 ring-inset ring-border/60'
                  : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}

'use client'

// RD-EVENT-08 · The event tab bar — the primary navigation of the event workspace.
//
// ═══ WHY THIS MEASURES ═══════════════════════════════════════════════════════
// Eighteen tabs do not fit a laptop, let alone a phone. The previous bar scrolled
// horizontally, which works but hides navigation behind a gesture with no affordance —
// an organizer on a 1280px screen had no way to know Settings existed.
//
// So the bar measures itself: every tab that fits is rendered inline, and the remainder
// move into a "More" menu. If the ACTIVE tab would fall into that overflow it is pulled
// forward and shown inline instead, because the one tab that must never be hidden is
// the one you are on.
//
// Navigation is real anchors throughout (cmd-click, Back/Forward, sharing all work) —
// the measurement only decides where a link is drawn, never how it behaves.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useDropdown } from '@/lib/hooks/useDropdown'
import { EVENT_ROOT_TAB, type EventTabDef, type EventTabKey } from '@/lib/events/eventTabs'

export const tabId      = (k: string) => `event-tab-${k}`
export const tabPanelId = (k: string) => `event-tabpanel-${k}`

/**
 * RD-EVENT-09 · The id the ROOT (Event Command Center) uses in the bar. It is a string,
 * never an `EventTabKey`, because the command center has no `?tab=` value — it is the
 * event route itself.
 */
export const ROOT_TAB_ID = 'command-center'

/** Width reserved for the More control while measuring. */
const MORE_WIDTH = 96

export function EventTabsBar({ tabs, active, rootHref, hrefFor }: {
  tabs:     readonly EventTabDef[]
  /** `null` = the root Event Command Center is showing. */
  active:   EventTabKey | null
  rootHref: string
  hrefFor:  (k: EventTabKey) => string
}) {
  const listRef  = useRef<HTMLDivElement>(null)
  const widths   = useRef<Map<string, number>>(new Map())
  // `null` = not measured yet, so the first paint renders every tab and the measurement
  // pass reads real widths from it. Nothing is hidden before we know what fits.
  const [visibleCount, setVisibleCount] = useState<number | null>(null)

  const measure = useCallback(() => {
    const el = listRef.current
    if (!el) return
    // The root entry is always drawn and never overflows — it is the way back to the
    // command center — so its width is spent before anything else is considered.
    const rootWidth = widths.current.get(ROOT_TAB_ID) ?? 0
    const available = el.clientWidth - rootWidth
    if (el.clientWidth === 0) return

    let used = 0
    let fits = 0
    for (const t of tabs) {
      const w = widths.current.get(t.key)
      if (w === undefined) return                 // not measured yet — try again later
      if (used + w > available - MORE_WIDTH) break
      used += w
      fits++
    }
    // Everything fits with room to spare: no More control at all.
    const total = tabs.reduce((s, t) => s + (widths.current.get(t.key) ?? 0), 0)
    // `fits` may legitimately be 0 on a narrow phone: the root entry is already drawn,
    // so the bar is never empty and everything else is reachable through More.
    setVisibleCount(total <= available ? tabs.length : fits)
  }, [tabs])

  // Layout effect so the adjustment lands in the same frame as the first paint.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    for (const node of el.querySelectorAll<HTMLElement>('[data-tab-key]')) {
      const key = node.dataset.tabKey
      if (key && !widths.current.has(key)) {
        // +gap: the bar has no gap between items, so the measured box is the full cost.
        widths.current.set(key, Math.ceil(node.getBoundingClientRect().width))
      }
    }
    measure()
  }, [measure, tabs])

  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => measure())
    ro.observe(el)
    return () => ro.disconnect()
  }, [measure])

  const count = visibleCount ?? tabs.length
  let inline = tabs.slice(0, count)
  let overflow = tabs.slice(count)

  // The active tab must never hide. If it overflowed, swap it forward for the last
  // inline tab so the bar still shows where you are. (When `active` is null the root
  // entry is selected, and that one is always drawn.)
  if (active !== null && overflow.some(t => t.key === active)) {
    if (inline.length > 0) {
      inline = [...inline.slice(0, -1), tabs.find(t => t.key === active)!]
    } else {
      inline = [tabs.find(t => t.key === active)!]
    }
    overflow = tabs.filter(t => !inline.some(i => i.key === t.key))
  }

  const RootIcon = EVENT_ROOT_TAB.icon

  return (
    <div className="border-b border-border">
      <div
        ref={listRef}
        role="tablist"
        aria-label="Event workspace"
        className="flex min-w-0 items-stretch px-4 sm:px-6"
      >
        {/* The root entry: the Event Command Center. It leads because it is where the
            workspace starts, and it never moves into More — a workspace you cannot get
            back to the front of is a trap. */}
        <Link
          id={tabId(ROOT_TAB_ID)}
          data-tab-key={ROOT_TAB_ID}
          href={rootHref}
          scroll={false}
          role="tab"
          aria-selected={active === null}
          {...(active === null ? { 'aria-controls': tabPanelId(ROOT_TAB_ID) } : {})}
          tabIndex={active === null ? 0 : -1}
          className={cn(
            'inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3.5 text-fs-sm font-medium transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
            active === null
              ? 'border-primary text-[color:var(--primary-text)]'
              : 'border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground',
          )}
        >
          <RootIcon className="size-4 shrink-0" aria-hidden />
          {EVENT_ROOT_TAB.label}
        </Link>

        {/* The inline tabs. `overflow-hidden` guarantees the bar can never widen the
            page even in the frame before measurement settles. */}
        <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
          {inline.map(t => (
            <TabLink key={t.key} tab={t} active={active === t.key} href={hrefFor(t.key)} />
          ))}
        </div>
        {overflow.length > 0 && (
          <MoreMenu tabs={overflow} active={active} hrefFor={hrefFor} />
        )}
      </div>
    </div>
  )
}

// ─── One tab ──────────────────────────────────────────────────────────────────

/**
 * RD-EVENT-16 · `aria-controls` is set ONLY on the selected tab.
 *
 * The shell renders one panel — the active one — so every other tab was pointing at an
 * element id that does not exist in the document. Nine orphaned references per page.
 */
function TabLink({ tab, active, href }: { tab: EventTabDef; active: boolean; href: string }) {
  return (
    <Link
      id={tabId(tab.key)}
      data-tab-key={tab.key}
      href={href}
      scroll={false}
      role="tab"
      aria-selected={active}
      {...(active ? { 'aria-controls': tabPanelId(tab.key) } : {})}
      // Roving tabindex: the bar is one tab stop, then arrows move inside it.
      tabIndex={active ? 0 : -1}
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap border-b-2 px-3.5 text-fs-sm font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
        active
          ? 'border-primary text-[color:var(--primary-text)]'
          : 'border-transparent text-muted-foreground hover:border-border-strong hover:text-foreground',
      )}
    >
      {tab.label}
    </Link>
  )
}

// ─── More ─────────────────────────────────────────────────────────────────────

function MoreMenu({ tabs, active, hrefFor }: {
  tabs:    readonly EventTabDef[]
  active:  EventTabKey | null
  hrefFor: (k: EventTabKey) => string
}) {
  const { open, setOpen, containerRef } = useDropdown()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef    = useRef<HTMLDivElement>(null)
  const wasOpen    = useRef(false)

  // Focus the first item on open; hand focus back to the trigger on close, so a
  // keyboard user who presses Escape does not lose their place.
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    } else if (wasOpen.current) {
      wasOpen.current = false
      triggerRef.current?.focus()
    }
  }, [open])

  function move(from: HTMLElement, delta: number) {
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    if (all.length === 0) return
    const i = all.indexOf(from)
    all[(i + delta + all.length) % all.length].focus()
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const all = Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(e.target as HTMLElement, 1); break
      case 'ArrowUp':   e.preventDefault(); move(e.target as HTMLElement, -1); break
      case 'Home':      e.preventDefault(); all[0]?.focus(); break
      case 'End':       e.preventDefault(); all[all.length - 1]?.focus(); break
      case 'Tab':       setOpen(false); break   // Escape is handled by useDropdown
    }
  }

  return (
    <div ref={containerRef} className="relative flex shrink-0 items-stretch">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={e => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) } }}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`More event sections (${tabs.length})`}
        className={cn(
          'inline-flex min-h-11 items-center gap-1 whitespace-nowrap border-b-2 px-3 text-fs-sm font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40',
          tabs.some(t => t.key === active)
            ? 'border-primary text-[color:var(--primary-text)]'
            : 'border-transparent text-muted-foreground hover:text-foreground',
        )}
      >
        More <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label="More event sections"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-full z-30 mt-px max-h-[min(24rem,60vh)] w-56 overflow-y-auto rounded-surface border border-border bg-card py-1 shadow-lg"
        >
          {tabs.map(t => (
            <Link
              key={t.key}
              href={hrefFor(t.key)}
              scroll={false}
              role="menuitem"
              tabIndex={-1}
              aria-current={active === t.key ? 'page' : undefined}
              onClick={() => setOpen(false)}
              className={cn(
                'flex min-h-11 items-center gap-2.5 px-3 text-fs-sm transition-colors',
                'focus-visible:outline-none focus-visible:bg-muted',
                active === t.key
                  ? 'font-semibold text-[color:var(--primary-text)]'
                  : 'text-foreground hover:bg-muted/60',
              )}
            >
              <t.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{t.label}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

'use client'

// RD-EVENT-02 §12 · The card's overflow menu — a real ARIA menu.
//
// Built on `useDropdown` (the shell's canonical click-outside + Escape hook) rather than
// a third private copy of that logic; what this adds on top is the part the hook does not
// cover and the old menu did not have: menu semantics, arrow-key roving focus, and
// returning focus to the trigger on close. Without that last piece a keyboard user who
// pressed Escape lost their place on the page entirely.

import { useEffect, useRef } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { useDropdown } from '@/lib/hooks/useDropdown'

export interface EventMenuItem {
  key:      string
  label:    string
  icon:     LucideIcon
  onSelect: () => void
  /** Renders above the item as a separated group — used for irreversible actions. */
  separated?: boolean
  destructive?: boolean
  disabled?: boolean
  /** Why the item is disabled. Required when `disabled` — a control that silently
   *  ignores a click is worse than one that explains itself. */
  disabledReason?: string
  /** Replaces the label while the action is in flight ("Archiving…"). */
  pendingLabel?: string
  pending?: boolean
}

export function EventCardMenu({ items, label }: {
  items: EventMenuItem[]
  /** Names WHICH event's menu this is, so a grid of cards has distinguishable triggers. */
  label: string
}) {
  const { open, setOpen, containerRef } = useDropdown()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef    = useRef<HTMLDivElement>(null)
  const wasOpen    = useRef(false)

  // Focus the first enabled item on open; hand focus back to the trigger on close.
  useEffect(() => {
    if (open) {
      wasOpen.current = true
      menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus()
    } else if (wasOpen.current) {
      wasOpen.current = false
      triggerRef.current?.focus()
    }
  }, [open])

  function moveFocus(from: HTMLElement, delta: number) {
    const all = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    )
    if (all.length === 0) return
    const i = all.indexOf(from as HTMLButtonElement)
    all[(i + delta + all.length) % all.length].focus()
  }

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement
    const all = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [],
    )
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); moveFocus(target, 1); break
      case 'ArrowUp':   e.preventDefault(); moveFocus(target, -1); break
      case 'Home':      e.preventDefault(); all[0]?.focus(); break
      case 'End':       e.preventDefault(); all[all.length - 1]?.focus(); break
      case 'Tab':       setOpen(false); break   // Escape is handled by useDropdown
    }
  }

  function onTriggerKeyDown(e: React.KeyboardEvent<HTMLButtonElement>) {
    // Opening with an arrow key is the menu-button convention and lands focus on the
    // first item, which the open effect already does.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setOpen(true) }
  }

  if (items.length === 0) return null

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        onKeyDown={onTriggerKeyDown}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        className={cn(
          'inline-flex size-11 items-center justify-center rounded-control border border-border bg-card sm:size-9',
          'text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40',
        )}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </button>

      {open && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={label}
          onKeyDown={onMenuKeyDown}
          className={cn(
            'absolute bottom-full right-0 z-30 mb-1.5 w-56 overflow-hidden',
            'rounded-surface border border-border bg-card shadow-lg',
          )}
        >
          {items.map(item => {
            const Icon = item.icon
            const busy = Boolean(item.pending)
            return (
              <div key={item.key}>
                {item.separated && <div className="my-1 border-t border-border/60" />}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  disabled={item.disabled || busy}
                  aria-describedby={item.disabled && item.disabledReason
                    ? `${item.key}-reason` : undefined}
                  onClick={() => { setOpen(false); item.onSelect() }}
                  className={cn(
                    'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-fs-sm transition-colors',
                    'focus-visible:outline-none focus-visible:bg-muted',
                    item.destructive
                      ? 'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10'
                      : 'text-foreground hover:bg-muted/60',
                    (item.disabled || busy) && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                  )}
                >
                  <Icon className="size-4 shrink-0" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {busy ? (item.pendingLabel ?? item.label) : item.label}
                  </span>
                </button>
                {item.disabled && item.disabledReason && (
                  <p id={`${item.key}-reason`} className="px-3 pb-2 text-fs-2xs text-muted-foreground">
                    {item.disabledReason}
                  </p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

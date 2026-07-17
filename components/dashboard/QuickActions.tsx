'use client'

// Phase H.2.4 — Reusable Workspace Quick Actions.
//
// A single dropdown surfacing the most common create/export/manage actions, each
// a link to an EXISTING route. Presentation only — no data fetching, no new
// backend. Callers may pass their own `items`; the default set covers the global
// workspace actions.

import { memo, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  Zap, ChevronDown, CalendarPlus, HeartHandshake, Megaphone, BarChart3,
  Wallet, UserPlus,
} from 'lucide-react'
import { CREATE_EVENT_HREF } from '@/config/workspaceNav'
import { cn } from '@/lib/utils/cn'

export interface QuickAction {
  label: string
  href:  string
  icon:  LucideIcon
  /** Optional grouping label shown as a section heading in the menu. */
  group?: string
}

// Default global actions — every href is an existing route.
export const DEFAULT_QUICK_ACTIONS: QuickAction[] = [
  { label: 'Create event',         href: CREATE_EVENT_HREF,                       icon: CalendarPlus,   group: 'Create' },
  { label: 'Create campaign',      href: '/dashboard/campaigns',                  icon: HeartHandshake, group: 'Create' },
  { label: 'New broadcast',        href: '/dashboard/communications/broadcasts',  icon: Megaphone,      group: 'Create' },
  { label: 'Download report',      href: '/dashboard/reports',                    icon: BarChart3,      group: 'Manage' },
  { label: 'Top up wallet',        href: '/dashboard/wallet',                     icon: Wallet,         group: 'Manage' },
  { label: 'Invite team member',   href: '/dashboard/settings/team',              icon: UserPlus,       group: 'Manage' },
]

export interface QuickActionsProps {
  items?:     QuickAction[]
  className?: string
}

function QuickActionsImpl({ items = DEFAULT_QUICK_ACTIONS, className }: QuickActionsProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Preserve insertion order while grouping.
  const groups: { name: string; items: QuickAction[] }[] = []
  for (const it of items) {
    const name = it.group ?? 'Actions'
    const g = groups.find(x => x.name === name) ?? (groups.push({ name, items: [] }), groups[groups.length - 1])
    g.items.push(it)
  }

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border bg-card px-3 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <Zap className="size-4 text-primary" aria-hidden />
        Quick actions
        <ChevronDown className={cn('size-3.5 text-muted-foreground/60 transition-transform', open && 'rotate-180')} aria-hidden />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Quick actions"
          className="absolute right-0 top-full z-50 mt-1.5 w-64 overflow-hidden rounded-xl border border-border bg-card py-1 shadow-lg"
        >
          {groups.map((g, gi) => (
            <div key={g.name} className={cn(gi > 0 && 'mt-1 border-t border-border pt-1')}>
              <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">{g.name}</p>
              {g.items.map(it => {
                const Icon = it.icon
                return (
                  <Link
                    key={it.label}
                    href={it.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className="flex items-center gap-2.5 px-3 py-2 text-[14px] text-foreground transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    {it.label}
                  </Link>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export const QuickActions = memo(QuickActionsImpl)

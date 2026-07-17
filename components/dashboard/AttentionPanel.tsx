'use client'

// Phase H.2.1 — Reusable "needs attention" surface.
//
// Generic: callers map data from existing APIs into AttentionItem[] (pending
// settlements, failed broadcasts, low wallet, webhook failures, reconciliation
// warnings, certificate jobs, session conflicts, failed refunds, events starting
// today …). This component only renders + orders by severity. No data fetching,
// no hardcoded demo items.

import { memo, useMemo } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { CheckCircle2, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

export type AttentionSeverity = 'critical' | 'warning' | 'info'

// Phase H.2.4 — Notification categories (Step 7). Real items are tagged by the
// caller from existing data; this component only groups + renders them.
export type AttentionCategory =
  | 'financial' | 'registrations' | 'checkin' | 'certificates'
  | 'broadcasts' | 'crm' | 'operations'

export interface AttentionItem {
  id:        string
  severity:  AttentionSeverity
  title:     string
  meta?:     string
  icon:      LucideIcon
  href?:     string
  /** In-place handler (e.g. switch tab). Used when there is no href. */
  onClick?:  () => void
  category?: AttentionCategory
}

const SEVERITY_RANK: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 }

// Display order + labels for the categorized (Notifications Center) view.
const CATEGORY_ORDER: AttentionCategory[] = [
  'financial', 'registrations', 'checkin', 'certificates', 'broadcasts', 'crm', 'operations',
]
const CATEGORY_LABEL: Record<AttentionCategory, string> = {
  financial:     'Financial',
  registrations: 'Registrations',
  checkin:       'Check-in',
  certificates:  'Certificates',
  broadcasts:    'Broadcasts',
  crm:           'CRM',
  operations:    'Operations',
}

const SEVERITY_STYLE: Record<AttentionSeverity, { ring: string; icon: string; bg: string }> = {
  critical: { ring: 'ring-rose-500/15',  icon: 'text-rose-600',  bg: 'bg-rose-50' },
  warning:  { ring: 'ring-amber-500/15', icon: 'text-amber-600', bg: 'bg-amber-50' },
  info:     { ring: 'ring-sky-500/15',   icon: 'text-sky-600',   bg: 'bg-sky-50' },
}

function Item({ item }: { item: AttentionItem }) {
  const s = SEVERITY_STYLE[item.severity]
  const Icon = item.icon
  const inner = (
    <>
      <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg', s.bg)}>
        <Icon className={cn('size-4', s.icon)} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-foreground">{item.title}</p>
        {item.meta && <p className="truncate text-[12px] text-muted-foreground">{item.meta}</p>}
      </div>
      {(item.href || item.onClick) && <ChevronRight className="size-4 shrink-0 text-muted-foreground/50" aria-hidden />}
    </>
  )
  const cls = cn('flex items-center gap-3 rounded-xl px-3 py-2.5 ring-1', s.ring, item.severity === 'critical' ? 'bg-rose-50/40' : 'bg-card')
  if (item.href) return <Link href={item.href} className={cn(cls, 'transition-colors hover:bg-muted/40')}>{inner}</Link>
  if (item.onClick) return <button type="button" onClick={item.onClick} className={cn(cls, 'w-full text-left transition-colors hover:bg-muted/40')}>{inner}</button>
  return <div className={cls}>{inner}</div>
}

export interface AttentionPanelProps {
  items: AttentionItem[]
  /** Phase H.2.4: group items under category headers (Notifications Center). */
  grouped?: boolean
}

function AttentionPanelImpl({ items, grouped }: AttentionPanelProps) {
  const ordered = useMemo(
    () => [...items].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]),
    [items],
  )

  if (ordered.length === 0) {
    return (
      <div className="flex items-center gap-2 px-5 py-6 text-[13px] text-muted-foreground">
        <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
        All clear — nothing needs your attention right now.
      </div>
    )
  }

  if (grouped) {
    const sections = CATEGORY_ORDER
      .map(cat => ({ cat, items: ordered.filter(i => (i.category ?? 'operations') === cat) }))
      .filter(s => s.items.length > 0)

    return (
      <div className="space-y-3 p-3" role="list" aria-label="Notifications by category">
        {sections.map(s => (
          <div key={s.cat}>
            <p className="mb-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/60">
              {CATEGORY_LABEL[s.cat]}
            </p>
            <div className="space-y-1.5">
              {s.items.map(item => <div role="listitem" key={item.id}><Item item={item} /></div>)}
            </div>
          </div>
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-1.5 p-3" role="list" aria-label="Items needing attention">
      {ordered.map(item => <div role="listitem" key={item.id}><Item item={item} /></div>)}
    </div>
  )
}

export const AttentionPanel = memo(AttentionPanelImpl)

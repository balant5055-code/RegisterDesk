'use client'

// Phase H.2.1 — One reusable activity system for the whole workspace.
//
// Supports every workspace event kind. Callers map their data (from existing
// APIs) into ActivityItem[]; this component handles icon/colour, relative time,
// newest-first ordering, links, and the empty state. No data fetching here.

import { memo, useMemo } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  Ticket, Heart, RotateCcw, ScanLine, Award, Megaphone, Banknote,
  CalendarClock, IdCard, UserCog, ReceiptText, Webhook, Users, Activity,
} from 'lucide-react'
import { EmptyState } from './EmptyState'
import { cn } from '@/lib/utils/cn'

// ─── Kinds ──────────────────────────────────────────────────────────────────

export type ActivityKind =
  | 'registration' | 'donation' | 'refund' | 'checkin' | 'certificate'
  | 'broadcast' | 'settlement' | 'session' | 'identifier' | 'team'
  | 'billing' | 'webhook' | 'crm'

export interface ActivityItem {
  id:          string
  kind:        ActivityKind
  title:       string
  description?: string
  timestamp:   string         // ISO 8601
  href?:       string
}

const KIND_STYLE: Record<ActivityKind, { icon: LucideIcon; color: string; bg: string }> = {
  registration: { icon: Ticket,        color: 'text-primary',      bg: 'bg-primary/10' },
  donation:     { icon: Heart,         color: 'text-rose-600',     bg: 'bg-rose-50' },
  refund:       { icon: RotateCcw,     color: 'text-amber-600',    bg: 'bg-amber-50' },
  checkin:      { icon: ScanLine,      color: 'text-emerald-600',  bg: 'bg-emerald-50' },
  certificate:  { icon: Award,         color: 'text-violet-600',   bg: 'bg-violet-50' },
  broadcast:    { icon: Megaphone,     color: 'text-sky-600',      bg: 'bg-sky-50' },
  settlement:   { icon: Banknote,      color: 'text-emerald-700',  bg: 'bg-emerald-50' },
  session:      { icon: CalendarClock, color: 'text-indigo-600',   bg: 'bg-indigo-50' },
  identifier:   { icon: IdCard,        color: 'text-cyan-700',     bg: 'bg-cyan-50' },
  team:         { icon: UserCog,       color: 'text-slate-600',    bg: 'bg-slate-100' },
  billing:      { icon: ReceiptText,   color: 'text-amber-700',    bg: 'bg-amber-50' },
  webhook:      { icon: Webhook,       color: 'text-fuchsia-600',  bg: 'bg-fuchsia-50' },
  crm:          { icon: Users,         color: 'text-teal-600',     bg: 'bg-teal-50' },
}

// ─── Relative time ──────────────────────────────────────────────────────────

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = Date.now() - then
  if (diff < 0) return 'just now'
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 7) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ─── Row ────────────────────────────────────────────────────────────────────

function Row({ item }: { item: ActivityItem }) {
  const style = KIND_STYLE[item.kind] ?? KIND_STYLE.registration
  const Icon  = style.icon

  const inner = (
    <>
      <span className={cn('mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg', style.bg)}>
        <Icon className={cn('size-3.5', style.color)} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[14px] font-medium text-foreground">{item.title}</p>
        {item.description && (
          <p className="truncate text-[12px] text-muted-foreground">{item.description}</p>
        )}
      </div>
      <time className="shrink-0 text-[12px] tabular-nums text-muted-foreground/80" dateTime={item.timestamp}>
        {timeAgo(item.timestamp)}
      </time>
    </>
  )

  const cls = 'flex items-start gap-3 px-5 py-3 border-b border-border last:border-0'
  return item.href
    ? <Link href={item.href} className={cn(cls, 'transition-colors hover:bg-muted/40')}>{inner}</Link>
    : <div className={cls}>{inner}</div>
}

// ─── Timeline ───────────────────────────────────────────────────────────────

export interface ActivityTimelineProps {
  items:    ActivityItem[]
  /** Cap the number of rows shown (newest-first). */
  limit?:   number
  emptyTitle?:       string
  emptyDescription?: string
}

function ActivityTimelineImpl({
  items, limit, emptyTitle = 'No activity yet', emptyDescription = 'Workspace activity will appear here as it happens.',
}: ActivityTimelineProps) {
  const rows = useMemo(() => {
    const sorted = [...items].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    )
    return typeof limit === 'number' ? sorted.slice(0, limit) : sorted
  }, [items, limit])

  if (rows.length === 0) {
    return <EmptyState icon={Activity} title={emptyTitle} description={emptyDescription} />
  }

  return (
    <ul aria-label="Activity timeline" className="divide-border">
      {rows.map(item => <li key={item.id}><Row item={item} /></li>)}
    </ul>
  )
}

export const ActivityTimeline = memo(ActivityTimelineImpl)

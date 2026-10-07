'use client'

// Phase H.2.1 — One reusable activity system for the whole workspace.
//
// Supports every workspace event kind. Callers map their data (from existing
// APIs) into ActivityItem[]; this component handles icon/colour, relative time,
// newest-first ordering, links, and the empty state. No data fetching here.

import { memo, useMemo, useState } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import {
  Ticket, Heart, RotateCcw, ScanLine, Award, Megaphone, Banknote,
  CalendarClock, IdCard, UserCog, ReceiptText, Webhook, Users, Activity,
} from 'lucide-react'
import { EmptyState } from './EmptyState'
import { cn } from '@/lib/utils/cn'
import { accent, type AccentTone } from '@/lib/dashboard/accents'
import { formatActivityInstant } from '@/lib/dashboard/activityTime'

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
  webhook:      { icon: Webhook,       color: 'text-purple-600',   bg: 'bg-purple-50' },
  crm:          { icon: Users,         color: 'text-teal-600',     bg: 'bg-teal-50' },
}

/**
 * RD-DASHBOARD-11 · Semantic tones for the COMPACT variant.
 *
 * The map above uses raw Tailwind palette classes (`bg-emerald-50`, `text-rose-600`). That
 * is unreadable in dark mode — a 50-weight surface under a dark canvas — and it lets
 * "green" mean three different things on one screen. The dashboard's own accent tokens
 * solve both, and are what every other card on that page already uses.
 *
 * The palette map is left ALONE so the three other consumers (check-in operations, the
 * event home tab) render byte-identically; only the opt-in compact variant reads this.
 */
const KIND_TONE: Record<ActivityKind, AccentTone> = {
  registration: 'people',  donation: 'money',    refund: 'pending',
  checkin:      'verify',  certificate: 'event', broadcast: 'people',
  settlement:   'money',   session: 'event',     identifier: 'verify',
  team:         'neutral', billing: 'pending',   webhook: 'neutral',
  crm:          'people',
}

/** Screen-reader text for the activity type. Icon + colour alone convey nothing to AT. */
const KIND_LABEL: Record<ActivityKind, string> = {
  registration: 'Registration', donation: 'Donation',    refund: 'Refund',
  checkin:      'Check-in',     certificate: 'Certificate', broadcast: 'Broadcast',
  settlement:   'Settlement',   session: 'Session',      identifier: 'Identifier',
  team:         'Team',         billing: 'Billing',      webhook: 'Webhook',
  crm:          'CRM',
}

// ─── Relative time ──────────────────────────────────────────────────────────

/**
 * `now` is INJECTED, never read from the clock here.
 *
 * `Date.now()` during render is impure and React 19 rejects it; it also gave every row a
 * slightly different "now", so two activities one second apart could both read "1m ago"
 * or disagree. One clock per render settles both.
 */
function timeAgo(iso: string, now: number): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diff = now - then
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

/**
 * RD-DASH-03 · the compact row.
 *
 * Four facts, three lines, one scannable grid:
 *
 *   REGISTRATION                        21 Aug 2026 · 9:13 PM · 4d ago
 *   E. Nalan registered
 *   5 KM Marathon
 *
 * The activity TYPE is an eyebrow rather than a badge, and the instant sits opposite it, so
 * the strongest thing on the row is the person and what they did. The exact instant is
 * RENDERED, not hidden in a `title` — it was invisible on touch and in a screenshot, which is
 * exactly when an organizer reconciling a gate dispute needs it. Rows share one border and no
 * shadow: ten of them read as a list, not as ten stacked cards.
 */
function CompactRow({ item, now }: { item: ActivityItem; now: number }) {
  const a         = accent(KIND_TONE[item.kind] ?? 'people')
  const Icon      = (KIND_STYLE[item.kind] ?? KIND_STYLE.registration).icon
  const kindLabel = KIND_LABEL[item.kind] ?? 'Activity'
  const t         = formatActivityInstant(item.timestamp, now)

  const inner = (
    <>
      <span className={cn('mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-control', a.tile)}>
        <Icon className="size-4" aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="shrink-0 text-fs-2xs font-semibold uppercase leading-snug tracking-wide text-muted-foreground">
            {kindLabel}
          </span>
          {t.valid && (
            <time
              dateTime={t.iso}
              // Tertiary, but never so faint it stops being readable.
              className="min-w-0 truncate text-right text-fs-2xs leading-snug tabular-nums text-muted-foreground"
            >
              {t.exact} · {t.relative}
            </time>
          )}
        </div>
        <p className="truncate text-fs-xs font-semibold leading-snug text-foreground">{item.title}</p>
        {item.description && (
          <p className="truncate text-fs-2xs leading-snug text-muted-foreground">{item.description}</p>
        )}
      </div>
    </>
  )

  const cls = 'flex items-start gap-3 px-3.5 py-2 border-b border-border last:border-0'
  return item.href
    ? (
      <Link
        href={item.href}
        className={cn(cls, 'transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40')}
      >
        {inner}
      </Link>
    )
    : <div className={cls}>{inner}</div>
}

function Row({ item, now, compact }: { item: ActivityItem; now: number; compact: boolean }) {
  const style = KIND_STYLE[item.kind] ?? KIND_STYLE.registration
  const Icon  = style.icon
  const a     = accent(KIND_TONE[item.kind] ?? 'people')
  const kindLabel = KIND_LABEL[item.kind] ?? 'Activity'

  if (compact) return <CompactRow item={item} now={now} />

  // Exact instant, for the tooltip AND for assistive tech. "1d ago" alone is not a
  // timestamp — an organizer reconciling a gate dispute needs the real one.
  const exact = (() => {
    const d = new Date(item.timestamp)
    return Number.isNaN(d.getTime())
      ? '' : d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
  })()

  const inner = (
    <>
      <span
        className={cn(
          'mt-0.5 flex shrink-0 items-center justify-center',
          compact ? cn('size-7 rounded-control', a.tile) : cn('size-7 rounded-lg', style.bg),
        )}
      >
        <Icon className={cn('size-3.5', !compact && style.color)} aria-hidden />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('truncate font-medium text-foreground', compact ? 'text-fs-xs' : 'text-[14px]')}>
          {/* The activity TYPE in words, so it is not conveyed by icon and colour alone. */}
          <span className="sr-only">{kindLabel}: </span>
          {item.title}
        </p>
        {item.description && (
          <p className={cn('truncate text-muted-foreground', compact ? 'text-fs-2xs' : 'text-[12px]')}>
            {item.description}
          </p>
        )}
      </div>
      <time
        className={cn('shrink-0 tabular-nums text-muted-foreground/80', compact ? 'text-fs-2xs' : 'text-[12px]')}
        dateTime={item.timestamp}
        title={exact}
      >
        <span aria-hidden>{timeAgo(item.timestamp, now)}</span>
        <span className="sr-only">{exact}</span>
      </time>
    </>
  )

  const cls = compact
    ? 'flex items-start gap-2.5 px-3 py-2 border-b border-border last:border-0'
    : 'flex items-start gap-3 px-5 py-3 border-b border-border last:border-0'
  return item.href
    ? <Link href={item.href} className={cn(cls, 'transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40')}>{inner}</Link>
    : <div className={cls}>{inner}</div>
}

// ─── Timeline ───────────────────────────────────────────────────────────────

export interface ActivityTimelineProps {
  items:    ActivityItem[]
  /** Cap the number of rows shown (newest-first). */
  limit?:   number
  emptyTitle?:       string
  emptyDescription?: string
  /**
   * OPT-IN compact treatment for the Dashboard feed.
   *
   * Additive on purpose: three other surfaces render this component, and none of them is
   * in this phase's scope. Omitting it leaves their output byte-identical.
   *
   * Compact = semantic accent tokens (dark-mode safe), the restrained radius scale, the
   * typography tokens, and tighter rows.
   */
  variant?: 'default' | 'compact'
  /** Replaces the default empty block — lets a caller give a scope-aware explanation. */
  emptySlot?: React.ReactNode
}

function ActivityTimelineImpl({
  items, limit, emptyTitle = 'No activity yet',
  emptyDescription = 'Workspace activity will appear here as it happens.',
  variant = 'default', emptySlot,
}: ActivityTimelineProps) {
  // ONE clock for the whole list, captured once at mount. Every row's relative time is
  // measured against the same instant, and no row reads the clock during render.
  const [now] = useState(() => Date.now())

  const rows = useMemo(() => {
    // Newest first, with a STABLE tie-break: two activities sharing a timestamp otherwise
    // swap places on every re-render, which reads as the feed shuffling itself.
    const sorted = [...items].sort((a, b) =>
      (new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()) || a.id.localeCompare(b.id))
    return typeof limit === 'number' ? sorted.slice(0, limit) : sorted
  }, [items, limit])

  if (rows.length === 0) {
    return emptySlot ?? <EmptyState icon={Activity} title={emptyTitle} description={emptyDescription} />
  }

  return (
    <ul aria-label="Activity timeline" className="divide-border">
      {rows.map(item => (
        <li key={item.id}><Row item={item} now={now} compact={variant === 'compact'} /></li>
      ))}
    </ul>
  )
}

export const ActivityTimeline = memo(ActivityTimelineImpl)

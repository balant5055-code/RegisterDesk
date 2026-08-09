'use client'

// RD-MEDIA-UX-04 · The canonical Media Studio UI layer.
//
// ═══ WHY ONE MODULE ═══════════════════════════════════════════════════════════
// The audit found seven pages that had each grown their own answer to the same questions:
// three typography systems (41 token utilities, 44 arbitrary CSS-variable font sizes, 26 raw
//
// NOTE — do not write an arbitrary font-size class literally in a comment here. Tailwind v4
// scans raw source text for class candidates and does not parse JS, so a class name written
// inside a comment is extracted and compiled exactly as if it were live markup. A wildcard
// placeholder spelled out in prose therefore emitted a real rule with an invalid `*` value
// and failed the CSS parser at build time.
// pixel values including 14.5px and 12.5px, which exist on no scale), five loading patterns,
// four card-grid rhythms, three renderings of a metric tile, and two page headers.
//
// These are the ONE answer to each. Every Media Studio page composes from here.
//
// ═══ NOTHING NEW IS INVENTED ══════════════════════════════════════════════════
// Every component below is assembled from primitives that already ship:
//   Card · Button · StatusChip · EmptyState · Skeleton · SearchInput · FilterTabs
// No second card system, no second type scale, no second spacing rhythm.
//
// `StatusPill` from components/admin is DELIBERATELY not used: it hardcodes palette literals
// (bg-emerald-50, text-amber-700, ring-rose-600/20) and would undo the RD-DS-V3 token
// centralisation. `StatusChip` is token-driven and is the canonical status primitive.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { Calendar, ChevronRight, FolderOpen, Layers } from 'lucide-react'
import { Card, EmptyState, Skeleton } from '@/components/ui'
import { SearchInput, FilterTabs } from '@/components/admin'
import { cn } from '@/lib/utils/cn'

// ─── Layout · re-exported from the shared primitives ─────────────────────────
//
// RD-RESPONSIVE-02: these were defined here first, then promoted to `components/ui/layout`
// so the rest of the application inherits the same rules instead of re-deriving them. The
// resolved class strings are IDENTICAL to what Media Studio shipped — this removes
// duplication, not behaviour.
//
// The reasoning for the zero grid minimum, the zero flex minimum, desktop-only stickiness
// and content-sized rail columns now lives with the primitives, where every consumer of the
// shared layer can read it.

export {
  PAGE_STACK as MEDIA_PAGE_STACK,
  WORKSPACE_GRID as MEDIA_WORKSPACE_GRID,
  RAIL_COLUMN as MEDIA_RAIL_COLUMN,
} from '@/components/ui/layout'

// ─── MediaWorkspaceBar ────────────────────────────────────────────────────────

export interface MediaWorkspaceBarProps {
  eventName:    string | null
  galleryName?: string | null
  albumName?:   string | null
  loading?:     boolean
  action?:      ReactNode
}

/**
 * One row answering "where am I working?" — promoted from Import, where it replaced three
 * separate restatements of the same destination.
 *
 * `min-w-0` + `truncate` on every crumb is what keeps it to a single row on desktop no
 * matter how long an event is named.
 */
export function MediaWorkspaceBar({
  eventName, galleryName, albumName, loading, action,
}: MediaWorkspaceBarProps) {
  if (loading) return <Skeleton className="h-11 w-full rounded-xl" />

  return (
    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-xl border border-border bg-card px-3 py-2">
      <Crumb icon={Calendar} value={eventName} fallback="No event selected" strong />
      {galleryName !== undefined && (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
          <Crumb icon={FolderOpen} value={galleryName} fallback="No gallery" />
        </>
      )}
      {albumName !== undefined && (
        <>
          <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" aria-hidden />
          <Crumb icon={Layers} value={albumName} fallback="No album" />
        </>
      )}
      {action && <div className="ml-auto shrink-0">{action}</div>}
    </div>
  )
}

function Crumb({
  icon: Icon, value, fallback, strong,
}: { icon: LucideIcon; value: string | null | undefined; fallback: string; strong?: boolean }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      <span
        className={cn(
          'truncate text-fs-sm',
          value ? (strong ? 'font-semibold text-foreground' : 'text-foreground') : 'text-muted-foreground',
        )}
      >
        {value ?? fallback}
      </span>
    </span>
  )
}

// ─── MediaToolbar ─────────────────────────────────────────────────────────────

/**
 * Title, optional description, right-aligned actions.
 *
 * Mirrors `AdminToolbar`'s shape deliberately, so a toolbar in Media Studio and one in the
 * admin console read identically — but uses Media Studio's type tokens rather than importing
 * a component whose spacing was tuned for a different shell.
 */
export function MediaToolbar({
  title, description, actions, className,
}: { title: string; description?: string; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0">
        <h2 className="text-fs-md font-semibold leading-tight text-foreground">{title}</h2>
        {description && (
          <p className="mt-0.5 text-fs-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

// ─── MediaFilterBar ───────────────────────────────────────────────────────────

export interface MediaFilterBarProps<T extends string> {
  search:      string
  onSearch:    (value: string) => void
  placeholder?: string
  filters?:    ReadonlyArray<{ value: T; label: string; count?: number }>
  filter?:     T
  onFilter?:   (value: T) => void
  actions?:    ReactNode
}

/**
 * Search + filter tabs + actions, on one line where there is room.
 *
 * Built from the EXISTING `SearchInput` and `FilterTabs` in components/admin — the audit's
 * headline finding was that Media Studio shipped no search at all while those primitives sat
 * unused in the same repo.
 */
export function MediaFilterBar<T extends string>({
  search, onSearch, placeholder, filters, filter, onFilter, actions,
}: MediaFilterBarProps<T>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="min-w-[200px] flex-1">
        <SearchInput value={search} onChange={onSearch} placeholder={placeholder} />
      </div>
      {filters && filter !== undefined && onFilter && (
        <FilterTabs options={filters} value={filter} onChange={onFilter} />
      )}
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

// ─── MediaMetricCard ──────────────────────────────────────────────────────────

/**
 * ONE metric tile.
 *
 * Replaces three renderings of the same idea: `StudioStat` (Storage, Maintenance), Import's
 * private `Stat`, and Galleries' inline count text.
 */
export function MediaMetricCard({
  label, value, hint, icon: Icon, tone = 'default',
}: {
  label: string
  value: string
  hint?: string
  icon?: LucideIcon
  tone?: 'default' | 'warning' | 'danger'
}) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
        <p className="truncate text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
      </div>
      <p
        className={cn(
          'mt-1 text-fs-xl font-bold leading-none tabular-nums',
          tone === 'danger' ? 'text-destructive' : tone === 'warning' ? 'text-warning' : 'text-foreground',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 truncate text-fs-2xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/** The canonical metric row. Four across on desktop, two on tablet, two on mobile. */
export function MediaMetricRow({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
}

// ─── MediaSummaryRail ─────────────────────────────────────────────────────────

/**
 * The right-hand rail.
 *
 * Deliberately NOT sticky itself — `MEDIA_RAIL_COLUMN` on the grid item owns that, so the
 * item is content-sized rather than stretched to the workflow column's height. See that
 * constant for why the distinction matters.
 */
export function MediaSummaryRail({
  children, className,
}: { children: ReactNode; className?: string }) {
  return (
    <Card variant="elevated" className={className}>
      {children}
    </Card>
  )
}

/** A label/value row inside a rail. */
export function RailMetric({
  label, value, emphasis, truncate,
}: { label: string; value: ReactNode; emphasis?: boolean; truncate?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-fs-sm text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right tabular-nums',
          truncate && 'truncate',
          emphasis ? 'text-fs-md font-bold text-foreground' : 'text-fs-sm font-semibold text-foreground',
        )}
      >
        {value}
      </dd>
    </div>
  )
}

// ─── MediaLoadingState ────────────────────────────────────────────────────────

/**
 * ONE loading pattern. Replaces `StudioBusy`, bare `Loader2`, the literal string "Loading…"
 * and hand-rolled `animate-pulse` grids — five patterns for one concept.
 *
 * Skeletons rather than a spinner: they preserve the page's height while data arrives, which
 * is also what stops the document growing after hydration and moving the viewport.
 */
export function MediaLoadingState({
  rows = 3, variant = 'list',
}: { rows?: number; variant?: 'list' | 'grid' | 'metrics' }) {
  if (variant === 'metrics') {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading">
        {Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[76px] rounded-xl" />)}
      </div>
    )
  }
  if (variant === 'grid') {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-busy="true" aria-label="Loading">
        {Array.from({ length: rows * 2 }, (_, i) => <Skeleton key={i} className="aspect-square rounded-xl" />)}
      </div>
    )
  }
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
    </div>
  )
}

// ─── MediaEmptyState ──────────────────────────────────────────────────────────

/**
 * ONE empty state signature — a deliberate narrowing of `EmptyState`.
 *
 * `EmptyState` accepts no children, so a page that wants an action places it beside this
 * rather than inside. Narrowing the signature here means no page has to rediscover that.
 */
export function MediaEmptyState({
  icon, title, description,
}: { icon: LucideIcon; title: string; description?: string }) {
  return <EmptyState icon={icon} size="sm" title={title} description={description ?? ''} />
}

// ─── MediaActionBar ───────────────────────────────────────────────────────────

/**
 * The mobile sticky action bar.
 *
 * The negative margins mirror `<main>`'s own padding (`px-4 md:px-5 lg:px-6`) so the bar
 * spans edge to edge at every breakpoint it is visible — a flat `-mx-4` left a visible
 * gutter through the `md` range, which was the RD-MEDIA-UX-03 finding.
 */
export function MediaActionBar({
  children, className,
}: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'sticky bottom-0 z-10 -mx-4 border-t border-border bg-card/95 px-4 py-2.5 backdrop-blur',
        'pb-[max(0.625rem,env(safe-area-inset-bottom))] md:-mx-5 md:px-5 lg:hidden',
        className,
      )}
    >
      {children}
    </div>
  )
}

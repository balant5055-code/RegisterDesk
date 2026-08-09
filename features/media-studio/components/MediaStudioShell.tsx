'use client'

// RD-MEDIA-01 · Shared chrome for every Media Studio page.
//
// Built entirely from the existing design system (components/ui, token variables). No new
// colour, size or radius is introduced.

import type { ReactNode } from 'react'
import Link from 'next/link'
import type { LucideIcon } from 'lucide-react'
import { ArrowRight, CalendarDays, Loader2, Camera } from 'lucide-react'
import { Banner, Card, EmptyState, ErrorState, Skeleton, StatusChip } from '@/components/ui'
import { cn } from '@/lib/utils/cn'
import { useMediaEvents, type MediaEventRow } from '@/features/media-studio/hooks/useMediaEvents'

// ─── Event picker ─────────────────────────────────────────────────────────────

export interface EventPickerProps {
  selectedEventId: string | null
  onSelect: (event: MediaEventRow) => void
}

/**
 * Lists the events this workspace owns, from the EXISTING `GET /api/organizer/events`
 * endpoint. Media Studio adds no event API of its own, and ownership is enforced there.
 */
export function MediaEventPicker({ selectedEventId, onSelect }: EventPickerProps) {
  const { events, loading, error } = useMediaEvents()

  if (loading) {
    return (
      <div className="space-y-2.5" aria-busy="true" aria-label="Loading your events">
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-[68px] w-full rounded-xl" />)}
      </div>
    )
  }
  if (error)            return <ErrorState message={error} />
  if (events.length === 0) {
    return (
      <EmptyState
        icon={CalendarDays}
        title="No published events"
        description="Publish an event before importing media — photos are stored under its public URL."
        action={{ label: 'Go to events', href: '/dashboard/events' }}
      />
    )
  }

  return (
    <ul className="space-y-2.5">
      {events.map(event => {
        const selected = event.eventId === selectedEventId
        return (
          <li key={event.eventId}>
            <button
              type="button"
              onClick={() => onSelect(event)}
              aria-pressed={selected}
              className={cn(
                'w-full rounded-xl border bg-card p-4 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                selected
                  ? 'border-primary/50 bg-primary/[0.04]'
                  : 'border-border hover:border-border-strong hover:bg-muted/40',
              )}
            >
              <p className="truncate text-fs-md font-semibold text-foreground">{event.name}</p>
              <p className="mt-0.5 text-fs-sm text-muted-foreground">
                {event.startDate ?? 'Date not set'}
              </p>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

// ─── Section ──────────────────────────────────────────────────────────────────

export function StudioSection({
  title, description, children, action,
}: { title: string; description?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-fs-lg font-semibold tracking-tight text-foreground">{title}</h2>
          {description && (
            <p className="mt-1 text-fs-sm leading-relaxed text-muted-foreground">{description}</p>
          )}
        </div>
        {action}
      </div>
      {children}
    </section>
  )
}

// ─── Stat tile ────────────────────────────────────────────────────────────────

export function StudioStat({
  label, value, icon: Icon, hint,
}: { label: string; value: string; icon: LucideIcon; hint?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-1.5 text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      <p className="mt-1.5 text-fs-xl font-bold leading-none tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-1 text-fs-2xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

// ─── Storage-not-configured notice ────────────────────────────────────────────

/** Says plainly that the deployment has no object storage, instead of showing an empty
 *  dashboard that reads as "no photos yet". */
export function StorageNotConfigured() {
  return (
    <Banner tone="warning" title="Media storage is not configured">
      This deployment has no object-storage credentials, so photos cannot be uploaded or
      served yet. Set the R2 variables described in{' '}
      <code className="rounded bg-muted px-1 py-0.5 text-fs-2xs">docs/RD-STORAGE-ARCHITECTURE.md</code>{' '}
      and redeploy.
    </Banner>
  )
}

// ─── Nav card (hub) ───────────────────────────────────────────────────────────

export function StudioNavCard({
  icon: Icon, title, description, href, badge,
}: { icon: LucideIcon; title: string; description: string; href: string; badge?: string }) {
  return (
    <Card hover className="h-full">
      <div className="flex h-full flex-col gap-3">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted" aria-hidden>
            <Icon className="size-[18px] text-muted-foreground" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-fs-md font-semibold text-foreground">{title}</h2>
              {badge && <StatusChip tone="neutral">{badge}</StatusChip>}
            </div>
            <p className="mt-1 text-fs-base leading-relaxed text-muted-foreground">{description}</p>
          </div>
        </div>
        <Link
          href={href}
          className="mt-auto inline-flex items-center gap-1.5 self-start text-fs-base font-semibold text-primary transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Open
          <ArrowRight className="size-3.5" aria-hidden />
        </Link>
      </div>
    </Card>
  )
}

export function StudioBusy({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3">
      <Loader2 className="size-4 shrink-0 animate-spin text-primary" aria-hidden />
      <p className="text-fs-base text-foreground">{label}</p>
    </div>
  )
}

export { Camera as MediaStudioIcon }

// ─── Workspace panel (RD-MEDIA-UX-01) ─────────────────────────────────────────

/**
 * A workflow panel for the Import workspace.
 *
 * ADDITIVE. `StudioSection` is untouched and still used by Galleries, Albums, Storage,
 * Processing and Branding — changing it would move five other pages for one page's redesign.
 *
 * The difference from `StudioSection` is hierarchy. That component gives every section an
 * 18px heading, so a page of seven of them has no focal point. Here the label is an 11px
 * overline and the title is 15px, which leaves the page's single 24px `PageHeader` and the
 * one primary action as the only loud things on screen.
 */
export function Panel({
  label, title, action, children, className, dense,
}: {
  label:     string
  title?:    string
  action?:   ReactNode
  children:  ReactNode
  className?: string
  /**
   * RD-MEDIA-IMPORT-05A · Tighter chrome for configuration panels.
   *
   * Measured on Import: Destination was 340px and Compression 145px, of which ~48px each was
   * Card padding plus header. A panel holding two chip rows does not need the same frame as
   * one holding a drop zone.
   *
   * Padding `p-4 sm:p-5` → `p-3 sm:p-4`, content offset `mt-3` → `mt-2`. Content untouched;
   * only the frame tightens.
   */
  dense?: boolean
}) {
  return (
    <Card className={cn(dense && 'p-3 sm:p-4', className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-fs-2xs font-semibold uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          {title && (
            <h2 className="mt-0.5 text-fs-md font-semibold leading-tight text-foreground">
              {title}
            </h2>
          )}
        </div>
        {action}
      </div>
      {/* space-y-3 is NOT decoration — it is the rhythm StudioSection applied to its
          children, and dropping it in the RD-MEDIA-UX-04 conversion is what made every
          multi-child panel collapse into a single flush block. A page that passes a
          preview, its metadata and its actions relies on this. */}
      <div className={cn(dense ? 'mt-2 space-y-2' : 'mt-3 space-y-3')}>{children}</div>
    </Card>
  )
}

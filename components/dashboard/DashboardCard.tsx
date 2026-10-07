import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── SectionHeader ────────────────────────────────────────────────────────────

export interface SectionHeaderProps {
  headingId:  string
  title:      string
  /**
   * RD-DASHBOARD-03 — optional glyph rendered before the title.
   *
   * A separate slot rather than widening `title` to ReactNode: the title is also
   * interpolated into the "View all: {title}" aria-label, and a node there would
   * render "[object Object]" to a screen reader.
   */
  leading?:   React.ReactNode
  viewHref?:  string
  viewLabel?: string
  action?:    React.ReactNode
  className?: string
}

export function SectionHeader({
  headingId,
  title,
  leading,
  viewHref,
  viewLabel = 'View all',
  action,
  className,
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        'flex items-center justify-between border-b border-border px-5 py-3.5',
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        {leading}
        <h2 id={headingId} className="truncate text-[15px] font-semibold text-foreground">
          {title}
        </h2>
      </div>
      <div className="flex items-center gap-3">
        {action}
        {viewHref && (
          <Link
            href={viewHref}
            // RD-DASH-15 · `text-primary-text`, not `text-primary`: the brand FILL is 4.28:1
            // as body text. The ring stays `primary` — it is a fill, not text.
            className="flex items-center gap-0.5 text-[13px] font-medium text-primary-text hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
            aria-label={`${viewLabel}: ${title}`}
          >
            {viewLabel} <ArrowRight className="size-3" aria-hidden />
          </Link>
        )}
      </div>
    </div>
  )
}

// ─── DashboardCard ────────────────────────────────────────────────────────────

export interface DashboardCardProps {
  title:      string
  /** Optional glyph before the title — see SectionHeaderProps.leading. */
  leading?:   React.ReactNode
  viewHref?:  string
  viewLabel?: string
  action?:    React.ReactNode
  children:   React.ReactNode
  className?: string
}

export function DashboardCard({
  title,
  leading,
  viewHref,
  viewLabel,
  action,
  children,
  className,
}: DashboardCardProps) {
  const headingId = `card-${title.toLowerCase().replace(/\W+/g, '-')}`

  return (
    <section
      aria-labelledby={headingId}
      className={cn('rounded-surface border border-border bg-card', className)}
    >
      <SectionHeader
        headingId={headingId}
        title={title}
        leading={leading}
        viewHref={viewHref}
        viewLabel={viewLabel}
        action={action}
      />
      {children}
    </section>
  )
}

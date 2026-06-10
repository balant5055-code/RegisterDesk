import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { cn } from '@/lib/utils/cn'

// ─── SectionHeader ────────────────────────────────────────────────────────────

export interface SectionHeaderProps {
  headingId:  string
  title:      string
  viewHref?:  string
  viewLabel?: string
  action?:    React.ReactNode
  className?: string
}

export function SectionHeader({
  headingId,
  title,
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
      <h2
        id={headingId}
        className="text-[15px] font-semibold text-foreground"
      >
        {title}
      </h2>
      <div className="flex items-center gap-3">
        {action}
        {viewHref && (
          <Link
            href={viewHref}
            className="flex items-center gap-0.5 text-[13px] font-medium text-primary hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded"
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
  viewHref?:  string
  viewLabel?: string
  action?:    React.ReactNode
  children:   React.ReactNode
  className?: string
}

export function DashboardCard({
  title,
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
      className={cn('rounded-xl border border-border bg-card shadow-sm', className)}
    >
      <SectionHeader
        headingId={headingId}
        title={title}
        viewHref={viewHref}
        viewLabel={viewLabel}
        action={action}
      />
      {children}
    </section>
  )
}

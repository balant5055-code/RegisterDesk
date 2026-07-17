import type { ReactNode } from 'react'
import Link from 'next/link'
import { HelpCircle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { Breadcrumbs } from './Breadcrumbs'
import type { BreadcrumbItem } from './Breadcrumbs'

// ─── Types ────────────────────────────────────────────────────────────────────

export type { BreadcrumbItem }

export type StatusTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

export interface PageHeaderStatus {
  label: string
  tone?: StatusTone
}

export interface PageHeaderProps {
  /** Primary page title */
  title: string
  /** Optional subtitle / description line */
  subtitle?: string
  /** Optional breadcrumb trail rendered above the title */
  breadcrumb?: BreadcrumbItem[]
  /** Right-side primary action slot — typically a Button or Link */
  action?: ReactNode
  /** Phase H.2.4: optional secondary action, rendered left of the primary one */
  secondaryAction?: ReactNode
  /** Phase H.2.4: status chips rendered beside the title */
  status?: PageHeaderStatus[]
  /** Phase H.2.4: when set, a help button links here (new tab) */
  helpHref?: string
  /** Phase H.2.4: short "last updated" caption (e.g. "Updated 2m ago") */
  lastUpdated?: string
  /** Additional className on the wrapper */
  className?: string
}

// ─── Status chip styles ────────────────────────────────────────────────────────

const TONE: Record<StatusTone, string> = {
  neutral: 'bg-muted text-muted-foreground ring-border',
  success: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  warning: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  danger:  'bg-rose-50 text-rose-700 ring-rose-600/20',
  info:    'bg-sky-50 text-sky-700 ring-sky-600/20',
}

// ─── Component ───────────────────────────────────────────────────────────────

export function PageHeader({
  title,
  subtitle,
  breadcrumb,
  action,
  secondaryAction,
  status,
  helpHref,
  lastUpdated,
  className,
}: PageHeaderProps) {
  const hasRight = action || secondaryAction || helpHref

  return (
    <div className={cn('flex flex-col gap-1', className)}>

      {/* ── Breadcrumb ──────────────────────────────────────── */}
      {breadcrumb && breadcrumb.length > 0 && (
        <Breadcrumbs items={breadcrumb} />
      )}

      {/* ── Title row ───────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[var(--fs-2xl)] font-bold tracking-tight text-foreground">
              {title}
            </h1>
            {status?.map((s, i) => (
              <span
                key={`${s.label}-${i}`}
                className={cn(
                  'rounded-full px-2 py-0.5 text-[var(--fs-2xs)] font-semibold ring-1',
                  TONE[s.tone ?? 'neutral'],
                )}
              >
                {s.label}
              </span>
            ))}
          </div>
          {subtitle && (
            <p className="mt-0.5 text-[var(--fs-sm)] text-muted-foreground">
              {subtitle}
            </p>
          )}
          {lastUpdated && (
            <p className="mt-0.5 text-[var(--fs-2xs)] text-muted-foreground/70">
              {lastUpdated}
            </p>
          )}
        </div>

        {hasRight && (
          <div className="flex shrink-0 items-center gap-2 self-start">
            {helpHref && (
              <Link
                href={helpHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Help"
                className="flex size-9 items-center justify-center rounded-xl border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <HelpCircle className="size-4" aria-hidden />
              </Link>
            )}
            {secondaryAction}
            {action}
          </div>
        )}
      </div>

    </div>
  )
}

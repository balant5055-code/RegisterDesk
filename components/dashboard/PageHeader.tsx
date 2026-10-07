'use client'

// RD-ORG-FOUNDATION · Page header — the typographic anchor of every organizer page.
//
// ═══ WHY THIS EXISTS SEPARATELY FROM components/ui/PageHeader ════════════════
// The shared `components/ui/PageHeader` is used by public and admin surfaces and
// carries its own breadcrumb slot. In the organizer shell the breadcrumb is OWNED BY
// THE SHELL (header row 2) — a page that renders its own would put two trails on one
// screen, which is what happens today on several organizer pages.
//
// So this variant has no breadcrumb slot at all. It cannot produce the duplicate.
//
// ═══ THE TYPOGRAPHY CONTRACT ═════════════════════════════════════════════════
// One page title size, one description size, everywhere in the organizer portal.
// Pages must not set their own heading sizes — that is how a portal ends up with
// four different "page titles". If a page needs a different emphasis, it needs a
// different component, not a different font size.
//
//   title       text-fs-xl   semibold  foreground
//   description text-fs-sm             muted-foreground
//   badge       text-fs-2xs  medium    tone-owned

import { cn } from '@/lib/utils/cn'

export interface PageHeaderBadge {
  label:     string
  /** Tone classes from the caller — the badge does not own a palette. */
  className: string
}

export interface DashboardPageHeaderProps {
  title:        string
  description?: string
  badge?:       PageHeaderBadge
  /** Primary/secondary controls, right-aligned on wide screens. */
  actions?:     React.ReactNode
  className?:   string
}

export function PageHeader({ title, description, badge, actions, className }: DashboardPageHeaderProps) {
  return (
    <div className={cn('flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          {/* Truncates rather than wraps: event names run long, and a two-line title
              shifts every metric below it on a phone. */}
          <h1 className="min-w-0 truncate text-fs-xl font-semibold tracking-tight text-foreground" title={title}>
            {title}
          </h1>
          {badge && (
            <span className={cn(
              'shrink-0 rounded-control px-1.5 py-0.5 text-fs-2xs font-medium',
              badge.className,
            )}>
              {badge.label}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 text-fs-sm text-muted-foreground">{description}</p>
        )}
      </div>

      {actions && <div className="shrink-0">{actions}</div>}
    </div>
  )
}

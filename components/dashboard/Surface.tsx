'use client'

// RD-ORG-FOUNDATION · Surface — the one panel primitive for the organizer shell.
//
// ═══ WHY ANOTHER CARD ════════════════════════════════════════════════════════
// It is not another card — it is the one that replaces four. The organizer portal
// carries StatCard (9 files), MetricCard (6), DashboardCard (14) and Widget (3):
// four components with overlapping jobs, four radii, four padding scales and four
// border treatments. That is why two organizer screens never looked like the same
// product.
//
// Surface deliberately does LESS than any of them: it is a bordered, correctly
// rounded container and nothing more. It owns no title slot, no metric formatting
// and no icon convention, because those are exactly the opinions that made the
// previous four impossible to merge. Content composes on top.
//
// The four legacy components are untouched — every page still using them renders
// byte-identically, and each is retired inside its own module phase rather than in a
// sweeping rename that would touch 30 files at once.

import { cn } from '@/lib/utils/cn'

export interface SurfaceProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Raise off the canvas. Default is flat — most panels sit on a bordered plane. */
  elevated?: boolean
}

export function Surface({ className, elevated = false, children, ...rest }: SurfaceProps) {
  return (
    <div
      className={cn(
        // rounded-surface (8px), never rounded-xl/2xl. See styles/tokens.css.
        'overflow-hidden rounded-surface border border-border bg-card',
        elevated && 'shadow-sm',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  )
}

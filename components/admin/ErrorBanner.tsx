import type { ReactNode } from 'react'
import { cn } from '@/lib/utils/cn'

// ─── ErrorBanner ────────────────────────────────────────────────────────────────
// Inline, dismissable-height error strip used above admin lists. This is the
// lightweight sibling of the full-page `ErrorState` — use it when the page still
// shows its table/filters and only needs to surface a request failure.

export interface ErrorBannerProps {
  children:   ReactNode
  className?: string
}

export function ErrorBanner({ children, className }: ErrorBannerProps) {
  return (
    <div
      role="alert"
      className={cn(
        'rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive',
        className,
      )}
    >
      {children}
    </div>
  )
}

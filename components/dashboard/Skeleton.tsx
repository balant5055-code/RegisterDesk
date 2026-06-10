import { cn } from '@/lib/utils/cn'

// ─── Base ─────────────────────────────────────────────────────────────────────

export function Skeleton({ className }: { className?: string }) {
  return (
    <div className={cn('animate-pulse rounded-md bg-muted', className)} aria-hidden />
  )
}

// ─── KPI card ─────────────────────────────────────────────────────────────────

export function KpiCardSkeleton() {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm" aria-hidden>
      <div className="flex items-start justify-between">
        <Skeleton className="size-9 rounded-lg" />
        <Skeleton className="h-3.5 w-8 rounded" />
      </div>
      <Skeleton className="mt-3 h-8 w-24 rounded" />
      <Skeleton className="mt-2 h-3 w-20 rounded" />
      <Skeleton className="mt-1.5 h-3 w-28 rounded" />
    </div>
  )
}

// ─── Event row ────────────────────────────────────────────────────────────────

export function EventRowSkeleton() {
  return (
    <div
      className="flex items-center gap-4 border-b border-border px-5 py-3.5 last:border-0"
      aria-hidden
    >
      <Skeleton className="size-12 shrink-0 rounded-lg" />
      <div className="flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <Skeleton className="h-3.5 w-36 rounded" />
          <Skeleton className="h-4 w-12 rounded-full" />
        </div>
        <Skeleton className="h-3 w-28 rounded" />
        <Skeleton className="h-1.5 w-full rounded-full" />
      </div>
    </div>
  )
}

// ─── Registration row ─────────────────────────────────────────────────────────

export function RegRowSkeleton() {
  return (
    <div
      className="flex items-center gap-3 border-b border-border px-5 py-3 last:border-0"
      aria-hidden
    >
      <Skeleton className="size-8 shrink-0 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-28 rounded" />
        <Skeleton className="h-3 w-40 rounded" />
      </div>
      <Skeleton className="hidden h-3 w-24 rounded sm:block" />
      <Skeleton className="h-5 w-[68px] rounded-full" />
    </div>
  )
}

// ─── Chart area ───────────────────────────────────────────────────────────────

export function ChartSkeleton() {
  return (
    <div className="px-5 py-4" aria-hidden>
      <Skeleton className="mb-3 h-3 w-52 rounded" />
      <Skeleton className="h-[72px] w-full rounded-md" />
      <div className="mt-2 flex justify-between gap-2">
        {[1, 2, 3, 4, 5].map(i => (
          <Skeleton key={i} className="h-2.5 w-8 rounded" />
        ))}
      </div>
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, Inbox, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { statusToneCls } from '@/lib/ui/statusColors'

// ─── Shared list fetch hook ──────────────────────────────────────────────────

interface ListPage<T> { items: T[] }

export function useAttendeeList<T>(path: string): {
  items: T[] | null; loading: boolean; error: string | null; reload: () => void
} {
  const [items,   setItems]   = useState<T[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)

  const reload = useCallback(() => {
    setLoading(true); setError(null)
    fetch(path, { cache: 'no-store' })
      .then(async res => { if (!res.ok) throw new Error('Failed to load. Please try again.'); return res.json() as Promise<ListPage<T>> })
      .then(d => setItems(d.items))
      .catch(e => setError(e instanceof Error ? e.message : 'Failed to load'))
      .finally(() => setLoading(false))
  }, [path])

  // Deferred so the fetch's setState calls don't run synchronously in the effect body.
  useEffect(() => {
    const t = setTimeout(() => { reload() }, 0)
    return () => clearTimeout(t)
  }, [reload])

  return { items, loading, error, reload }
}

// ─── Formatting ────────────────────────────────────────────────────────────────

export function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

export function fmtINR(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0 })}`
}

// ─── Page header ────────────────────────────────────────────────────────────────

export function AttendeePageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="mb-5">
      <h1 className="text-[20px] font-bold tracking-tight text-foreground">{title}</h1>
      {subtitle && <p className="mt-0.5 text-[13.5px] text-muted-foreground">{subtitle}</p>}
    </div>
  )
}

// ─── States ──────────────────────────────────────────────────────────────────────

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border bg-card py-16 text-muted-foreground">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <p className="text-[13px]">{label}</p>
    </div>
  )
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-destructive/30 bg-destructive/5 py-14 text-center">
      <AlertCircle className="size-6 text-destructive" aria-hidden />
      <p className="px-6 text-[13.5px] text-destructive">{message}</p>
      {onRetry && (
        <button onClick={onRetry} className="rounded-lg border border-border bg-card px-4 py-2 text-[13px] font-medium text-foreground hover:bg-muted">
          Try again
        </button>
      )}
    </div>
  )
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border py-16 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-muted/60">
        <Inbox className="size-5 text-muted-foreground" aria-hidden />
      </div>
      <p className="text-[14px] font-medium text-foreground">{title}</p>
      {hint && <p className="max-w-xs px-6 text-[13px] text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-2.5" aria-hidden>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-14 animate-pulse rounded-xl border border-border bg-muted/30" />
      ))}
    </div>
  )
}

// ─── Status badge ──────────────────────────────────────────────────────────────
// GA-7D S2: tone map centralised in lib/ui/statusColors (statusToneCls) — no local
// duplicate, so an attendee's status never renders a different colour than the
// organizer sees for the same status.

export function StatusBadge({ status }: { status: string }) {
  const tone = statusToneCls[status] ?? 'bg-muted text-muted-foreground ring-border'
  return (
    <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold capitalize ring-1', tone)}>
      {status.replace(/_/g, ' ')}
    </span>
  )
}

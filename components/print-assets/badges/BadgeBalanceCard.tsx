'use client'

// RD-PRINT-BILL-P6 · The event's ID-badge balance — every figure from
// GET /api/organizer/events/[slug]/print-badges (the server summary). Nothing is computed here.
// Buying is a hand-off to License & Services (increaseLimitHref), shown only when the server says
// this caller can buy; the purchase routes re-authorize regardless.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { IdCard, ArrowUpRight } from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { ErrorState, Skeleton, StatusChip } from '@/components/ui'
import { formatPaise } from '@/lib/licensing/capacityPricing'
import { increaseLimitHref } from '@/lib/wallet/purchaseIntent'
import type { PrintBadgeSummary } from '@/lib/printAssets/badgeBilling/summary'
import type { PrintBadgeSummaryResponse } from '@/app/api/organizer/events/[eventId]/print-badges/route'
import { PURCHASE_STATE_TEXT } from './badgeErrors'

export const BADGE_MODE_LABEL: Record<PrintBadgeSummary['billing']['mode'], string> = {
  paid: 'Paid', complimentary: 'Complimentary', free: 'Free',
}
const MODE_TONE = { paid: 'primary', complimentary: 'success', free: 'neutral' } as const

/** Loads the summary for one published event. Re-loads when `slug` or `reloadKey` changes. */
export function useBadgeSummary(slug: string | null, reloadKey = 0) {
  const [data, setData] = useState<{ key: string; summary: PrintBadgeSummary | null; error: string | null } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const key = `${slug}|${reloadKey}|${attempt}`
  useEffect(() => {
    if (!slug) return
    let alive = true
    void (async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        const res = await fetch(`/api/organizer/events/${encodeURIComponent(slug)}/print-badges`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store',
        })
        const body = await res.json().catch(() => null) as PrintBadgeSummaryResponse | null
        if (!alive) return
        if (res.ok && body?.success) setData({ key, summary: body.summary, error: null })
        else setData({ key, summary: null, error: (body && !body.success && body.error) || 'Could not load ID badges.' })
      } catch {
        if (alive) setData({ key, summary: null, error: 'Could not reach RegisterDesk. Check your connection and try again.' })
      }
    })()
    return () => { alive = false }
  }, [slug, key])
  const current = data && data.key === key ? data : null
  return {
    summary: current?.summary ?? null,
    error:   current?.error ?? null,
    loading: !!slug && !current,
    retry:   useCallback(() => setAttempt(a => a + 1), []),
  }
}

const n = (v: number) => v.toLocaleString('en-IN')

export function BadgeBalanceCard({ slug, draftId, reloadKey = 0, className }: {
  /** The PUBLISHED event's slug from the event list (never a draft's own urlSlug). */
  slug: string | null
  draftId: string | null
  reloadKey?: number
  className?: string
}) {
  const { summary, error, loading, retry } = useBadgeSummary(slug, reloadKey)
  if (!slug) return null

  return (
    <section aria-label="ID badges" className={cn('rounded-2xl border border-border bg-card p-4 sm:p-5', className)}>
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/[0.08]">
          <IdCard className="size-4 text-primary" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[13.5px] font-semibold text-foreground">ID badges</h2>
            {summary && <StatusChip tone={MODE_TONE[summary.billing.mode]}>{BADGE_MODE_LABEL[summary.billing.mode]}</StatusChip>}
          </div>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">
            {summary?.billing.mode === 'paid'
              ? <>Each attendee printed for the first time uses one badge{summary.billing.unitPricePaise !== null && <> ({formatPaise(summary.billing.unitPricePaise)} incl. GST)</>}. Reprints are free.</>
              : summary?.billing.mode === 'complimentary'
                ? 'Badges for this event are complimentary — no units are used.'
                : summary ? 'ID cards and badges for this event are not charged.' : 'Prepaid ID-badge units for this event.'}
          </p>
        </div>
      </div>

      {loading && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[auto_1fr]" aria-busy="true">
          <Skeleton className="h-10 w-24" />
          <div className="grid grid-cols-3 gap-2"><Skeleton className="h-9" /><Skeleton className="h-9" /><Skeleton className="h-9" /></div>
        </div>
      )}

      {!loading && error && <ErrorState size="sm" message={error} onRetry={retry} className="mt-3" />}

      {!loading && summary && (
        <div className="mt-4 grid gap-4 sm:grid-cols-[auto_1fr] sm:items-end">
          <div>
            <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">Available</p>
            <p className="text-[32px] font-bold leading-none tracking-tight tabular-nums text-foreground" data-testid="badge-available">{n(summary.units.available)}</p>
          </div>
          <dl className="grid grid-cols-3 gap-2 rounded-xl bg-surface-3 p-2.5 text-[12px]">
            <Figure label="Bought" value={n(summary.units.purchased + summary.units.carriedIn)} />
            <Figure label="Used" value={n(summary.units.used)} />
            <Figure label="In running jobs" value={n(summary.units.reserved)} />
          </dl>
          {summary.units.purchased + summary.units.carriedIn === 0 && summary.billing.mode === 'paid' && (
            <p className="text-[12.5px] text-muted-foreground sm:col-span-2">No ID badges yet. Buy units before printing attendees for the first time.</p>
          )}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            {summary.purchase.canBuy && draftId
              ? <Link href={increaseLimitHref(draftId, 'print_badges')} className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-primary hover:underline">
                  Buy ID badges <ArrowUpRight className="size-3.5" aria-hidden />
                </Link>
              : summary.billing.mode === 'paid' && (
                <p className="text-[12px] text-muted-foreground">
                  {summary.purchase.state === 'available' ? 'Only the workspace owner can buy ID badges.' : PURCHASE_STATE_TEXT[summary.purchase.state]}
                </p>
              )}
          </div>
        </div>
      )}
    </section>
  )
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-card px-2.5 py-2 shadow-[0_0_0_1px_var(--border)]">
      <dt className="text-[11px] leading-tight text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-semibold tabular-nums text-foreground">{value}</dd>
    </div>
  )
}

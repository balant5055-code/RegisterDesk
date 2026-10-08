'use client'

// RD-FEE-04 · Razorpay gateway cost — the FROZEN estimate vs Razorpay's ACTUAL fee, and the variance.
//
// Super Admin reporting only (GET /api/admin/finance/gateway-variance is ADMIN_UIDS-gated). It
// compares two numbers; it moves no money and changes no payable, net, wallet or payout. The
// comparison covers ONLY payments Razorpay has reported a fee for — the rest are shown as
// "awaiting", never as a fee of ₹0.

import { useCallback, useEffect, useState } from 'react'
import { Landmark, RotateCw } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { MaybeMoney, Unavailable } from '@/lib/finance/gatewayFee'
import type { GatewayVarianceResponse } from '@/app/api/admin/finance/gateway-variance/route'

const UNAVAILABLE: Record<Unavailable, string> = {
  no_authoritative_field: 'No Razorpay fee received yet',
  requires_index:         'Needs a Firestore index',
  query_failed:           'Couldn’t be read',
  out_of_budget:          'Too many payments to total here',
}

const inr = (paise: number) =>
  `₹${(Math.abs(paise) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const show = (m: MaybeMoney) => (m.ok ? inr(m.paise) : '—')
const signed = (m: MaybeMoney) => (!m.ok ? '—' : m.paise > 0 ? `+${inr(m.paise)}` : m.paise < 0 ? `−${inr(m.paise)}` : inr(0))

export function GatewayVarianceCard({ getToken, eventSlug, scopeLabel }: {
  getToken:   () => Promise<string>
  /** Event scope (Event 360). Omitted ⇒ every organizer. */
  eventSlug?: string
  scopeLabel: string
}) {
  const [data, setData]   = useState<GatewayVarianceResponse | null>(null)
  const [error, setError] = useState(false)

  const load = useCallback(() => {
    void (async () => {
      try {
        const token = await getToken()
        const qs = eventSlug ? `?eventSlug=${encodeURIComponent(eventSlug)}` : ''
        const res = await fetch(`/api/admin/finance/gateway-variance${qs}`, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(String(res.status))
        setData(await res.json() as GatewayVarianceResponse); setError(false)
      } catch { setError(true) }
    })()
  }, [getToken, eventSlug])

  useEffect(() => { load() }, [load])

  const v = data?.variance
  const unavailableReason = v && !v.variance.ok ? UNAVAILABLE[v.variance.reason] : null

  return (
    <section aria-labelledby="gateway-variance-heading" className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <Landmark className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <p id="gateway-variance-heading" className="text-[13.5px] font-semibold text-foreground">Razorpay gateway cost</p>
        </div>
        <span className="text-[12px] text-muted-foreground">{scopeLabel}</span>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 px-5 py-4 text-[13px] text-muted-foreground" role="alert">
          Gateway cost couldn’t be loaded.
          <button type="button" onClick={load} className="inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[12px] font-medium text-foreground hover:bg-muted/50">
            <RotateCw className="size-3" aria-hidden />Retry
          </button>
        </div>
      ) : !v ? (
        <div className="px-5 py-4"><div className="h-14 animate-pulse rounded-lg bg-muted" /></div>
      ) : (
        <div className="px-5 py-4">
          <dl className="grid grid-cols-3 gap-3">
            <div className="min-w-0">
              <dt className="text-[12px] text-muted-foreground">Estimated</dt>
              <dd className="mt-0.5 text-[18px] font-bold tabular-nums text-foreground">{show(v.estimatedReconciled)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px] text-muted-foreground">Actual</dt>
              <dd className="mt-0.5 text-[18px] font-bold tabular-nums text-foreground">{show(v.actual)}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-[12px] text-muted-foreground">Variance</dt>
              <dd className={cn('mt-0.5 text-[18px] font-bold tabular-nums',
                v.variance.ok && v.variance.paise < 0 ? 'text-amber-700 dark:text-amber-300' : 'text-foreground')}>
                {signed(v.variance)}
              </dd>
            </div>
          </dl>

          <p className="mt-3 text-[12px] tabular-nums text-muted-foreground">
            {unavailableReason
              ? <>{unavailableReason}.</>
              : <>Razorpay fee received for {(v.reconciled ?? 0).toLocaleString('en-IN')} / {(v.transactions ?? 0).toLocaleString('en-IN')} payments
                  {v.basis === 'mixed' && v.estimatedAwaiting.ok && <> · {inr(v.estimatedAwaiting.paise)} estimated on payments awaiting Razorpay’s fee (not compared)</>}
                  {v.actualTax.ok && <> · Razorpay GST {inr(v.actualTax.paise)} is included in Actual</>}.</>}
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-muted-foreground">
            Variance compares the frozen gateway estimate used for organizer settlement with the actual Razorpay fee
            received from captured payments. It is a cost reconciliation only — not platform revenue, and it does not
            change any organizer payout.
          </p>
        </div>
      )}
    </section>
  )
}

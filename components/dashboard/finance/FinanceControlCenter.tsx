'use client'

// RD-FINANCE-P3 · the Finance Control Center. PRESENTATION ONLY.
//
// ═══ NO FINANCIAL ARITHMETIC LIVES HERE ══════════════════════════════════════
// Every figure arrives already summed and already attributed from
// /api/organizer/finance/analytics, which composes lib/finance/financeAnalytics.ts. This
// file formats paise into rupees, lays out cards, and renders bars. If a number is needed
// that the server does not send, the server is where it belongs — the previous Finance table
// computed one fee total in React and rendered `250 − 9.20 = 250` for months.
//
// ═══ UNAVAILABLE IS A FIRST-CLASS STATE ══════════════════════════════════════
// Several figures genuinely cannot be computed: the actual gateway fee has no writer, and
// per-pass / per-coupon money needs indexes that were deliberately not created. Those render
// as "Not reconciled" / "Requires index" — never as ₹0, which would be a claim rather than
// an absence.

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Loader2, TrendingUp, Ticket, Wallet,
  Landmark, Receipt, Users, Percent, RotateCcw,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { ErrorState } from '@/components/ui'
import type {
  FinanceAnalyticsResponse, EventOption,
} from '@/app/api/organizer/finance/analytics/route'
import type { MaybeMoney, HealthItem } from '@/lib/finance/financeAnalytics'

// ─── Formatting (the only transformation this file performs) ─────────────────

/** ₹X,XX,XXX.XX — integer paise in, string out. No arithmetic beyond the unit shift. */
function inr(paise: number): string {
  const neg = paise < 0
  const abs = Math.abs(Math.trunc(paise))
  const rupees = Math.trunc(abs / 100)
  const p = String(abs % 100).padStart(2, '0')
  return `${neg ? '−' : ''}₹${rupees.toLocaleString('en-IN')}.${p}`
}

const REASON_LABEL: Record<string, string> = {
  no_authoritative_field: 'Not reconciled',
  requires_index:         'Requires index',
  query_failed:           'Unavailable',
  out_of_budget:          'Partial',
}

/** Renders a money value or, when it could not be sourced, why. Never falls back to ₹0. */
function Money({ v, className }: { v: MaybeMoney; className?: string }) {
  if (v.ok) return <span className={cn('tabular-nums', className)}>{inr(v.paise)}</span>
  return (
    <span className="text-[13px] font-medium text-muted-foreground" title={v.reason}>
      {REASON_LABEL[v.reason] ?? 'Unavailable'}
    </span>
  )
}

const pct = (n: number, d: number) => (d > 0 ? ((n / d) * 100).toFixed(1) : '0.0')

// ─── KPI card ────────────────────────────────────────────────────────────────

function Kpi({
  label, value, sub, icon: Icon, tone = 'default', hint,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  icon: typeof Wallet
  tone?: 'default' | 'primary' | 'warn'
  hint: string
}) {
  return (
    <div
      title={hint}
      className={cn(
        'rounded-xl border border-border bg-card p-4',
        tone === 'primary' && 'border-primary/30 bg-primary/[0.03]',
        tone === 'warn' && 'border-warning/30 bg-warning/[0.03]',
      )}
    >
      <div className="flex items-center gap-1.5 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Icon className="size-3.5 shrink-0" aria-hidden />
        <span className="line-clamp-1">{label}</span>
      </div>
      <div className="mt-1.5 text-[19px] font-bold leading-tight text-foreground">{value}</div>
      {sub && <div className="mt-0.5 text-[12px] text-muted-foreground">{sub}</div>}
    </div>
  )
}

// ─── Horizontal bar (counts / money, server-supplied) ────────────────────────

function Bar({ value, max, tone = 'primary' }: { value: number; max: number; tone?: 'primary' | 'muted' }) {
  const w = max > 0 ? Math.max(1, Math.round((value / max) * 100)) : 0
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', tone === 'primary' ? 'bg-primary' : 'bg-muted-foreground/40')}
           style={{ width: `${w}%` }} />
    </div>
  )
}

// ─── Health panel ────────────────────────────────────────────────────────────

function Health({ items }: { items: HealthItem[] }) {
  const warns = items.filter(i => i.state === 'warn')
  const oks   = items.filter(i => i.state === 'ok')
  return (
    <DashboardCard title="Finance health">
      <div className="space-y-2 p-1">
        {oks.map(i => (
          <div key={i.key} className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
            <div>
              <p className="text-[13.5px] font-medium text-foreground">{i.label}</p>
              <p className="text-[12px] text-muted-foreground">{i.detail}</p>
            </div>
          </div>
        ))}
        {warns.map(i => (
          <div key={i.key} className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <div>
              <p className="text-[13.5px] font-medium text-foreground">{i.label}</p>
              <p className="text-[12px] text-muted-foreground">{i.detail}</p>
            </div>
          </div>
        ))}
      </div>
    </DashboardCard>
  )
}

// ─── Main ────────────────────────────────────────────────────────────────────

const RANGES = [
  { key: '7',   label: '7 days',  days: 7 },
  { key: '30',  label: '30 days', days: 30 },
  { key: '90',  label: '90 days', days: 90 },
] as const

export function FinanceControlCenter({ token }: { token: string }) {
  const [data, setData]       = useState<FinanceAnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [eventSlug, setEventSlug] = useState<string>('')
  const [rangeKey, setRangeKey]   = useState<string>('30')

  const load = useCallback(async () => {
    setError(null)
    const days = RANGES.find(r => r.key === rangeKey)?.days ?? 30
    const to   = new Date()
    const from = new Date(to.getTime() - days * 86_400_000)
    const qs = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() })
    if (eventSlug) qs.set('eventSlug', eventSlug)
    const res = await fetch(`/api/organizer/finance/analytics?${qs}`, {
      headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
    })
    if (!res.ok) { setError(`Could not load finance data. (${res.status})`); setLoading(false); return }
    setData(await res.json() as FinanceAnalyticsResponse)
    setLoading(false)
  }, [token, eventSlug, rangeKey])

  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { setLoading(true); void load().catch(() => { setError('Could not load finance data.'); setLoading(false) }) }, [load])

  const trendMax = useMemo(
    () => Math.max(1, ...(data?.trend.points ?? []).map(p => p.grossPaise)),
    [data],
  )

  if (error) return <ErrorState message={error} onRetry={() => { setLoading(true); void load().catch(() => setError('Could not load finance data.')) }} />

  if (loading || !data) {
    return (
      <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-8 text-[13.5px] text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading finance data…
      </div>
    )
  }

  const { ledger, attendeePaid, registrations, statuses, coupons, passes, trend, health, scope } = data
  const platformEarned: MaybeMoney = ledger.platformFeeBase.ok && ledger.platformFeeGst.ok
    ? { ok: true, paise: ledger.platformFeeBase.paise + ledger.platformFeeGst.paise }
    : { ok: false, reason: 'query_failed' }
  const refundRow = statuses.rows.find(r => r.status === 'refunded')
  // Hoisted so the null-narrowing survives into the map callbacks below.
  const regTotal = registrations.total
  const regFree  = registrations.free
  const regPaid  = registrations.paid

  return (
    <div className="space-y-5">
      {/* ── Filters ───────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={eventSlug}
          onChange={e => setEventSlug(e.target.value)}
          aria-label="Filter by event"
          className="h-8 rounded-lg border border-border bg-card px-2.5 text-[13px] text-foreground"
        >
          <option value="">All events</option>
          {scope.events.map((e: EventOption) => (
            <option key={e.slug} value={e.slug}>{e.slug}</option>
          ))}
        </select>
        <div role="group" aria-label="Date range" className="flex items-center gap-px rounded-lg border border-border bg-muted p-0.5">
          {RANGES.map(r => (
            <button key={r.key} onClick={() => setRangeKey(r.key)} aria-pressed={rangeKey === r.key}
              className={cn('rounded-md px-2.5 py-1 text-[12px] font-medium',
                rangeKey === r.key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {r.label}
            </button>
          ))}
        </div>
        {!scope.eventSlug && (
          <span className="text-[12px] text-muted-foreground">
            Select an event for status, coupon, pass and trend detail.
          </span>
        )}
      </div>

      {/* ── A · KPI cards ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Users} label="Attendee paid" value={<Money v={attendeePaid.totalPaise} />}
          hint="Amount actually charged to attendees, from the registration record."
          sub={attendeePaid.byStatus.map(s => `${s.status} ${inr(s.paise)}`).join(' · ')} />
        <Kpi icon={Ticket} label="Ticket value" value={<Money v={ledger.grossPaise} />}
          hint="Ticket value after discount — the base the platform fee was charged on."
          sub={`${ledger.transactions ?? 0} transactions`} />
        <Kpi icon={Wallet} label="Organizer payable" value={<Money v={ledger.organizerPayable} />} tone="primary"
          hint="Organizer-attributable revenue per the stored ledger (netSettlementPaise)." />
        <Kpi icon={Landmark} label="Platform earned" value={<Money v={platformEarned} />}
          hint="RegisterDesk platform fee plus GST on that fee."
          sub={<>fee <Money v={ledger.platformFeeBase} /> · GST <Money v={ledger.platformFeeGst} /></>} />
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={Receipt} label="Platform fee" value={<Money v={ledger.platformFeeBase} />}
          hint="Stored per transaction at the rate that applied then — never recomputed." />
        <Kpi icon={Percent} label="Platform GST" value={<Money v={ledger.platformFeeGst} />}
          hint="GST on the RegisterDesk platform fee, stored per transaction." />
        <Kpi icon={TrendingUp} label="Gateway fee (estimate)" value={<Money v={ledger.gatewayEstimate} />} tone="warn"
          hint="Calculated estimate. NOT reconciled against gateway settlement data."
          sub={<span className="text-warning">Actual: <Money v={ledger.gatewayActual} /></span>} />
        <Kpi icon={RotateCcw} label="Refunds" value={refundRow ? <Money v={refundRow.grossPaise} /> : <span className="text-muted-foreground text-[13px]">—</span>}
          hint="Reversed transactions. Never counted as successful revenue."
          sub={refundRow ? `${refundRow.count ?? 0} transactions` : 'Select an event'} />
      </div>

      {/* ── B · Waterfall ─────────────────────────────────────────────────── */}
      <DashboardCard title="Money flow">
        <div className="space-y-2.5 p-1">
          {[
            ['Attendee paid',     attendeePaid.totalPaise, 'What attendees were charged'],
            ['Ticket value',      ledger.grossPaise,       'Platform-fee base, after discount'],
            ['Platform fee',      ledger.platformFeeBase,  'RegisterDesk fee'],
            ['Platform GST',      ledger.platformFeeGst,   'GST on the RegisterDesk fee'],
            ['Organizer payable', ledger.organizerPayable, 'Settlement basis'],
          ].map(([label, v, note], i, arr) => (
            <div key={label as string} className={cn('flex items-baseline justify-between gap-3 py-1',
              i < arr.length - 1 && 'border-b border-border/60')}>
              <div>
                <p className={cn('text-[13.5px]', i === arr.length - 1 ? 'font-semibold text-foreground' : 'text-foreground')}>{label as string}</p>
                <p className="text-[11.5px] text-muted-foreground">{note as string}</p>
              </div>
              <div className={cn('text-[15px]', i === arr.length - 1 ? 'font-bold text-foreground' : 'font-medium text-foreground')}>
                <Money v={v as MaybeMoney} />
              </div>
            </div>
          ))}
          <p className="pt-1 text-[11.5px] text-muted-foreground">
            Gateway fee is listed separately because it is an estimate and, under the stored fee
            model, may have been borne by the attendee rather than deducted from the payout.
          </p>
        </div>
      </DashboardCard>

      {/* ── E · Free vs paid ──────────────────────────────────────────────── */}
      <DashboardCard title="Registrations">
        <div className="space-y-3 p-1">
          {regTotal !== null && regFree !== null && regPaid !== null ? (
            <>
              <div className="grid grid-cols-3 gap-3">
                {([['Total', regTotal], ['Paid', regPaid], ['Free', regFree]] as const).map(([l, n]) => (
                  <div key={l}>
                    <p className="text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{l}</p>
                    <p className="text-[19px] font-bold text-foreground">{n.toLocaleString('en-IN')}</p>
                    {l !== 'Total' && (
                      <p className="text-[12px] text-muted-foreground">{pct(n, regTotal)}%</p>
                    )}
                  </div>
                ))}
              </div>
              <Bar value={regPaid} max={regTotal} />
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
                {registrations.byPaymentStatus.map(s => (
                  <span key={s.paymentStatus}>{s.paymentStatus}: <strong className="text-foreground">{s.count.toLocaleString('en-IN')}</strong></span>
                ))}
              </div>
              <p className="text-[11.5px] text-muted-foreground">Free registrations collect ₹0 by definition.</p>
            </>
          ) : <p className="text-[13px] text-muted-foreground">Registration counts unavailable.</p>}
        </div>
      </DashboardCard>

      {/* ── G · Payment status ────────────────────────────────────────────── */}
      <DashboardCard title="Payment status">
        {statuses.scoped ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead><tr className="border-b border-border">
                {['Status', 'Transactions', 'Ticket value', 'Organizer payable', 'Platform fee'].map(h => (
                  <th key={h} className="px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {statuses.rows.filter(r => (r.count ?? 0) > 0).map(r => (
                  <tr key={r.status} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2.5">
                      <span className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-semibold',
                        r.isReversal ? 'bg-destructive/10 text-destructive' : 'bg-success/10 text-success')}>
                        {r.status}
                      </span>
                      {r.isReversal && <span className="ml-2 text-[11.5px] text-muted-foreground">not revenue</span>}
                    </td>
                    <td className="px-3 py-2.5 tabular-nums text-foreground">{r.count?.toLocaleString('en-IN') ?? '—'}</td>
                    <td className="px-3 py-2.5 text-foreground"><Money v={r.grossPaise} /></td>
                    <td className="px-3 py-2.5 text-foreground"><Money v={r.organizerPayable} /></td>
                    <td className="px-3 py-2.5 text-foreground"><Money v={r.platformFeeBase} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="p-1 text-[13px] text-muted-foreground">Select an event to see the status breakdown.</p>}
      </DashboardCard>

      {/* ── H · Trend ─────────────────────────────────────────────────────── */}
      <DashboardCard title="Ticket value over time">
        {trend.points.length > 0 ? (
          <div className="space-y-1.5 p-1">
            {trend.points.filter(p => p.grossPaise > 0).map(p => (
              <div key={p.bucket} className="grid grid-cols-[90px_1fr_120px] items-center gap-3">
                <span className="text-[12px] tabular-nums text-muted-foreground">{p.bucket.slice(0, 10)}</span>
                <Bar value={p.grossPaise} max={trendMax} />
                <span className="text-right text-[12.5px] font-medium tabular-nums text-foreground">{inr(p.grossPaise)}</span>
              </div>
            ))}
            <p className="pt-1 text-[11.5px] text-muted-foreground">
              Transaction counts per day are not shown — they would require an additional index.
            </p>
          </div>
        ) : <p className="p-1 text-[13px] text-muted-foreground">Select an event to see the trend.</p>}
      </DashboardCard>

      {/* ── D · Coupons ───────────────────────────────────────────────────── */}
      <DashboardCard title="Coupons & discounts">
        <div className="space-y-3 p-1">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <div><p className="text-[11.5px] uppercase tracking-wide text-muted-foreground">Total discount</p>
              <p className="text-[17px] font-bold text-foreground"><Money v={coupons.discountPaise} /></p></div>
            <div><p className="text-[11.5px] uppercase tracking-wide text-muted-foreground">Original value</p>
              <p className="text-[17px] font-bold text-foreground"><Money v={coupons.originalPaise} /></p></div>
            <div><p className="text-[11.5px] uppercase tracking-wide text-muted-foreground">Coupon uses</p>
              <p className="text-[17px] font-bold text-foreground">{coupons.registrations?.toLocaleString('en-IN') ?? '—'}</p></div>
            <div><p className="text-[11.5px] uppercase tracking-wide text-muted-foreground">Free / paid uses</p>
              <p className="text-[17px] font-bold text-foreground">
                {coupons.freeUses?.toLocaleString('en-IN') ?? '—'} / {coupons.paidUses?.toLocaleString('en-IN') ?? '—'}</p></div>
          </div>
          {coupons.rows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[620px] text-left text-[13px]">
                <thead><tr className="border-b border-border">
                  {['Coupon', 'Type', 'Uses', 'Free', 'Paid', 'Discount'].map(h => (
                    <th key={h} className="px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {coupons.rows.map(c => (
                    <tr key={c.code} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2 font-medium text-foreground">{c.code}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {c.couponType ?? '—'}{c.couponValue !== null && <span className="ml-1">{c.couponValue}</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-foreground">
                        {c.uses?.toLocaleString('en-IN') ?? '—'}{c.maxUses !== null && <span className="text-muted-foreground">/{c.maxUses}</span>}
                      </td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{c.freeUses?.toLocaleString('en-IN') ?? '—'}</td>
                      <td className="px-3 py-2 tabular-nums text-muted-foreground">{c.paidUses?.toLocaleString('en-IN') ?? '—'}</td>
                      <td className="px-3 py-2"><Money v={c.discountPaise} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[11.5px] text-muted-foreground">
            Per-coupon amounts require a composite index that has not been created; event-level
            discount totals are shown above.
          </p>
        </div>
      </DashboardCard>

      {/* ── F · Passes ────────────────────────────────────────────────────── */}
      <DashboardCard title="Pass performance">
        {passes.rows.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-[13px]">
              <thead><tr className="border-b border-border">
                {['Pass', 'Registrations', 'Paid', 'Free', 'Collected'].map(h => (
                  <th key={h} className="px-3 py-2 text-[11.5px] font-semibold uppercase tracking-wide text-muted-foreground">{h}</th>
                ))}
              </tr></thead>
              <tbody>
                {passes.rows.map(p => (
                  <tr key={p.passId} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2 font-medium text-foreground">{p.passName ?? p.passId}</td>
                    <td className="px-3 py-2 tabular-nums text-foreground">{p.registrations?.toLocaleString('en-IN') ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{p.paid?.toLocaleString('en-IN') ?? '—'}</td>
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">{p.free?.toLocaleString('en-IN') ?? '—'}</td>
                    <td className="px-3 py-2"><Money v={p.collectedPaise} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="p-1 text-[13px] text-muted-foreground">Select an event to see pass performance.</p>}
      </DashboardCard>

      {/* ── K · Health ────────────────────────────────────────────────────── */}
      <Health items={health} />
    </div>
  )
}

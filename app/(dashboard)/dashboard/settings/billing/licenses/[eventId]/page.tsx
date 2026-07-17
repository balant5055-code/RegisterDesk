'use client'

// Organizer License Center (RD-LIC-ORG-01) — the premium, per-event view of a
// workspace's Event License: overview, usage, effective feature matrix, immutable
// timeline, billing history, and upgrade path. Read-only; reuses the Billing
// Center design tokens. All data comes from /api/organizer/licenses/[eventId].

import { useEffect, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import {
  Loader2, ArrowLeft, ArrowRight, Check, Minus, ShieldCheck, Gift, Sparkles,
  Ticket, Clock, CreditCard, TrendingUp, AlertTriangle,
} from 'lucide-react'
import { useBranding } from '@/lib/config/brandingClient'
import type {
  LicenseCenterDetail, LicenseCenterStatus, LicenseCenterPayment,
} from '@/lib/organizer/licenseCenterTypes'

const rupees  = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
const fmtDateTime = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const regLabel = (n: number | null) => n == null ? 'Unlimited' : n.toLocaleString('en-IN')

const STATUS_META: Record<LicenseCenterStatus, { label: string; cls: string }> = {
  active:    { label: 'Active',    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  pending:   { label: 'Pending',   cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  suspended: { label: 'Suspended', cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  cancelled: { label: 'Cancelled', cls: 'bg-rose-50 text-rose-700 ring-rose-600/20' },
}
const PAYMENT_META: Record<LicenseCenterPayment, { label: string; cls: string }> = {
  paid:          { label: 'Paid',          cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  pending:       { label: 'Pending',       cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  failed:        { label: 'Failed',        cls: 'bg-rose-50 text-rose-700 ring-rose-600/20' },
  refunded:      { label: 'Refunded',      cls: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  free:          { label: 'Free',          cls: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  complimentary: { label: 'Complimentary', cls: 'bg-violet-50 text-violet-700 ring-violet-600/20' },
}

function Pill({ meta }: { meta: { label: string; cls: string } }) {
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', meta.cls)}>{meta.label}</span>
}

export default function LicenseCenterPage() {
  const params  = useParams<{ eventId: string }>()
  const eventId = params?.eventId ?? ''
  const branding = useBranding()

  const [detail, setDetail]   = useState<LicenseCenterDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { if (alive) { setError('You must be signed in.'); setLoading(false) } return }
      try {
        const res = await fetch(`/api/organizer/licenses/${eventId}`, { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error(res.status === 404 ? 'License not found.' : res.status === 403 ? 'You do not have access to this license.' : 'Could not load license.')
        const data = await res.json() as { detail: LicenseCenterDetail }
        if (alive) setDetail(data.detail)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [eventId])

  if (loading) return <div className="flex justify-center py-24"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error || !detail) return (
    <div className="p-5 sm:p-6">
      <BackLink />
      <div className="mt-4 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive">{error ?? 'License not found.'}</div>
    </div>
  )

  const d = detail
  const pct = d.registrationLimit == null || d.registrationLimit === 0
    ? (d.registrationLimit === 0 ? 100 : 0)
    : Math.min(100, Math.round((d.used / d.registrationLimit) * 100))
  const barCls = pct >= 100 ? 'bg-rose-500' : pct >= 90 ? 'bg-orange-500' : pct >= 80 ? 'bg-amber-500' : 'bg-primary'
  const warn = d.registrationLimit != null && (pct >= 80)

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <BackLink />

      {/* ── Header ── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><Ticket className="size-5" aria-hidden /></div>
          <div>
            <h1 className="text-[20px] font-bold tracking-tight text-foreground">{d.eventName}</h1>
            <p className="text-[13px] text-muted-foreground">/{d.eventId}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill meta={STATUS_META[d.status]} />
          <Pill meta={PAYMENT_META[d.payment]} />
          {d.complimentary && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-50 px-2 py-0.5 text-[11px] font-semibold text-violet-700 ring-1 ring-violet-600/20">
              <Gift className="size-3" /> Complimentary
            </span>
          )}
          {d.hasOverrides && !d.complimentary && (
            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700 ring-1 ring-blue-600/20">
              <ShieldCheck className="size-3" /> Admin adjusted
            </span>
          )}
        </div>
      </div>

      {/* ── Overview KPIs ── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi label="License tier" value={d.tierName} />
        <Kpi label="Reg. limit" value={regLabel(d.registrationLimit)} />
        <Kpi label="Used" value={d.used.toLocaleString('en-IN')} />
        <Kpi label="Remaining" value={d.remaining == null ? 'Unlimited' : d.remaining.toLocaleString('en-IN')} />
        <Kpi label="Price paid" value={d.amountPaidPaise > 0 ? rupees(d.amountPaidPaise) : 'Free'} />
        <Kpi
          label="Effective price"
          value={rupees(d.effectivePricePaise)}
          hint={d.effectivePricePaise !== d.amountPaidPaise ? 'Adjusted' : undefined}
        />
      </div>

      {/* ── Usage dashboard ── */}
      <Card title="Registration usage" icon={<TrendingUp className="size-4" />}>
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[24px] font-bold text-foreground">{d.used.toLocaleString('en-IN')}
              <span className="text-[14px] font-medium text-muted-foreground"> / {regLabel(d.registrationLimit)}</span>
            </p>
            <p className="text-[12.5px] text-muted-foreground">{d.remaining == null ? 'Unlimited capacity' : `${d.remaining.toLocaleString('en-IN')} remaining`}</p>
          </div>
          {d.registrationLimit != null && <span className={cn('text-[20px] font-bold', pct >= 100 ? 'text-rose-600' : pct >= 90 ? 'text-orange-600' : pct >= 80 ? 'text-amber-600' : 'text-foreground')}>{pct}%</span>}
        </div>
        {d.registrationLimit != null && (
          <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-muted">
            <div className={cn('h-full rounded-full transition-all', barCls)} style={{ width: `${pct}%` }} />
          </div>
        )}
        {warn && (
          <div className={cn('mt-3 flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-medium',
            pct >= 100 ? 'bg-rose-50 text-rose-700' : pct >= 90 ? 'bg-orange-50 text-orange-700' : 'bg-amber-50 text-amber-700')}>
            <AlertTriangle className="size-4 shrink-0" />
            {pct >= 100 ? 'Registration limit reached — upgrade to accept more registrations.'
              : pct >= 90 ? 'Over 90% of your registration limit is used.'
              : 'Over 80% of your registration limit is used.'}
          </div>
        )}
        {d.limitOverridden && (
          <p className="mt-2 text-[12px] text-muted-foreground">
            Registration limit adjusted by admin — tier default: <span className="font-medium text-foreground">{regLabel(d.baseRegistrationLimit)}</span>,
            now: <span className="font-medium text-foreground">{regLabel(d.registrationLimit)}</span>.
          </p>
        )}
      </Card>

      {/* ── Feature matrix ── */}
      <Card title="Features" icon={<Sparkles className="size-4" />} subtitle="Everything your license includes for this event.">
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {d.features.map(f => (
            <div key={f.key} className={cn('flex items-center justify-between rounded-lg border px-3 py-2', f.included ? 'border-border bg-card' : 'border-border bg-muted/20')}>
              <div className="flex items-center gap-2.5">
                {f.included
                  ? <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500"><Check className="size-3 text-white" /></span>
                  : <span className="flex size-5 items-center justify-center rounded-full bg-muted"><Minus className="size-3 text-muted-foreground" /></span>}
                <span className={cn('text-[13px]', f.included ? 'font-medium text-foreground' : 'text-muted-foreground')}>{f.label}</span>
              </div>
              {f.adminGranted
                ? <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10.5px] font-semibold text-violet-700">Admin granted</span>
                : f.overridden
                ? <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10.5px] font-semibold text-blue-700">Overridden</span>
                : !f.included
                ? <span className="text-[10.5px] font-medium text-muted-foreground/60">Unavailable</span>
                : null}
            </div>
          ))}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* ── Timeline ── */}
        <Card title="License timeline" icon={<Clock className="size-4" />}>
          {d.timeline.length === 0 ? (
            <p className="text-[13px] text-muted-foreground">No history yet.</p>
          ) : (
            <ol className="relative space-y-3 border-l border-border pl-4">
              {d.timeline.map(t => (
                <li key={t.id} className="relative">
                  <span className="absolute -left-[21px] top-1 size-2.5 rounded-full bg-primary ring-4 ring-background" />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[13px] font-medium text-foreground">{t.label}</span>
                    <span className="text-[11px] text-muted-foreground">{fmtDate(t.createdAt)}</span>
                  </div>
                  {t.bySystem && <span className="text-[11px] text-muted-foreground/70">by RegisterDesk team</span>}
                </li>
              ))}
            </ol>
          )}
        </Card>

        {/* ── Billing history ── */}
        <Card title="Billing" icon={<CreditCard className="size-4" />}>
          <dl className="space-y-2 text-[13px]">
            <Row k="Amount" v={d.billing.amountPaise > 0 ? rupees(d.billing.amountPaise) : 'Free'} />
            <Row k="Paid via wallet" v={rupees(d.billing.walletUsedPaise)} />
            <Row k="Paid via gateway" v={rupees(d.billing.gatewayPaise)} />
            <Row k="Status" v={<span className="capitalize">{d.billing.status}</span>} />
            <Row k="Date" v={fmtDateTime(d.billing.date)} />
            {d.billing.razorpayPaymentId && <Row k="Razorpay payment" v={<span className="font-mono text-[11.5px]">{d.billing.razorpayPaymentId}</span>} />}
            {d.billing.orderId && <Row k="Order" v={<span className="font-mono text-[11.5px]">{d.billing.orderId}</span>} />}
          </dl>
        </Card>
      </div>

      {/* ── Upgrade ── */}
      {d.upgrade && d.status !== 'cancelled' && (
        <Card title="Upgrade this event" icon={<TrendingUp className="size-4" />} subtitle={`Move from ${d.tierName} to ${d.upgrade.nextTierName} for more capacity and features.`}>
          <div className="flex flex-wrap items-center gap-3">
            <div className="rounded-xl border border-border bg-muted/20 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Current</p>
              <p className="text-[15px] font-bold text-foreground">{d.tierName}</p>
            </div>
            <ArrowRight className="size-4 text-muted-foreground" />
            <div className="rounded-xl border border-primary/30 bg-primary/[0.04] px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-primary">Upgrade to</p>
              <p className="text-[15px] font-bold text-foreground">{d.upgrade.nextTierName}</p>
            </div>
            <div className="ml-auto text-right">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Price difference</p>
              <p className="text-[18px] font-bold text-foreground">{d.upgrade.priceDifferencePaise > 0 ? rupees(d.upgrade.priceDifferencePaise) : 'Free'}</p>
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">What you get</p>
            <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {d.upgrade.benefits.map(b => (
                <li key={b} className="flex items-center gap-2 text-[13px] text-foreground">
                  <Check className="size-3.5 shrink-0 text-emerald-500" /> {b}
                </li>
              ))}
            </ul>
          </div>

          <a
            href={`mailto:${branding.supportEmail}?subject=${encodeURIComponent(`Upgrade request: ${d.eventName} → ${d.upgrade.nextTierName}`)}&body=${encodeURIComponent(`I'd like to upgrade the license for event ${d.eventId} from ${d.tierName} to ${d.upgrade.nextTierName}.`)}`}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm"
            style={{ backgroundImage: 'var(--primary-gradient)' }}
          >
            Request upgrade <ArrowRight className="size-3.5" />
          </a>
          <p className="mt-2 text-[11.5px] text-muted-foreground">Upgrades for a published event are processed by our team.</p>
        </Card>
      )}
    </div>
  )
}

// ─── Presentational helpers (reuse Billing Center tokens) ──────────────────────

function BackLink() {
  return (
    <Link href="/dashboard/settings/billing" className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
      <ArrowLeft className="size-4" /> Back to Billing
    </Link>
  )
}

function Kpi({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <p className="text-[12px] text-muted-foreground">{label}</p>
      <p className="mt-1 truncate text-[18px] font-bold text-foreground">{value}</p>
      {hint && <p className="text-[11px] font-semibold text-primary">{hint}</p>}
    </div>
  )
}

function Card({ title, icon, subtitle, children }: { title: string; icon: ReactNode; subtitle?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-3 flex items-center gap-2">
        <span className="flex size-7 items-center justify-center rounded-lg bg-primary/[0.09] text-primary">{icon}</span>
        <div>
          <h2 className="text-[14px] font-bold text-foreground">{title}</h2>
          {subtitle && <p className="text-[12px] text-muted-foreground">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  )
}

function Row({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground">{v}</dd>
    </div>
  )
}

'use client'

// Enterprise License & Coupon Command Center (GA-2 S3).
// The single admin workspace for every license, coupon, purchase, expiry, override
// and promotion across the platform. Five workspaces over a permanent Health Panel.
// Purely additive + reuse-first: every read hits an EXISTING or thin admin endpoint;
// every MUTATION reuses an EXISTING route — license actions via
// POST /api/admin/licenses/[eventId] (all 21 EA-4 actions), coupon actions via the
// existing /api/admin/license-coupons engine. NO new licensing/coupon engine, NO new
// payment flow, NO duplicated mutations.

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import {
  Loader2, RefreshCw, KeyRound, Gift, IndianRupee, Ticket, TrendingUp, ScrollText,
  ShieldCheck, ExternalLink, X, PlusCircle, PauseCircle, PlayCircle,
  Archive, Copy, PencilLine, Building2, LayoutGrid, CalendarClock, Percent,
  ArrowUpCircle, ArrowDownCircle, BadgeCheck, Undo2, XCircle, RotateCcw,
  CalendarPlus, CalendarMinus, CalendarX, Zap, Unlock, Fingerprint, ShieldAlert,
} from 'lucide-react'
import {
  StatusPill, ErrorBanner, SearchInput, FilterTabs, LoadMoreButton,
} from '@/components/admin'
import type { PillTone } from '@/components/admin'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Bars, HBars } from '@/components/analytics/Charts'
import { EVENT_LICENSE_TIERS, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import type {
  LicenseRow, LicenseListResponse, LicenseDetail,
  LicenseAdminActionType, LicenseAdminActionRequest,
} from '@/lib/admin/licenseAdminTypes'
import type {
  LicenseCenterOverview, LicenseCenterOverviewResponse, CouponListResponse,
  CouponView, CouponDetailResponse, LicenseCenterTimelineEntry, LicenseCenterTimelineResponse,
  HealthIndicator, HealthLevel,
} from '@/lib/admin/licenseCenterTypes'
import type { AdminAnalytics } from '@/lib/analytics/adminAnalytics'

// ─── Utilities ──────────────────────────────────────────────────────────────

async function getToken(): Promise<string> {
  const u = auth.currentUser
  if (!u) throw new Error('Not authenticated')
  return u.getIdToken()
}
async function authedGet<T>(url: string): Promise<T> {
  const token = await getToken()
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' })
  if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
  return await res.json() as T
}
async function authedSend(url: string, method: 'POST' | 'PATCH', body: unknown): Promise<void> {
  const token = await getToken()
  const res = await fetch(url, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) { const b = await res.json().catch(() => null) as { error?: string } | null; throw new Error(b?.error ?? `Request failed (${res.status})`) }
}

const rupees = (p: number): string => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const num = (n: number): string => n.toLocaleString('en-IN')
const fmtDate = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'
const fmtDay = (iso: string | null): string =>
  iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

const HEALTH_DOT: Record<HealthLevel, string> = {
  green: 'bg-emerald-500', yellow: 'bg-amber-500', red: 'bg-red-500', neutral: 'bg-muted-foreground/40',
}

type TabKey = 'overview' | 'licenses' | 'coupons' | 'business' | 'governance'
const TABS: { key: TabKey; label: string }[] = [
  { key: 'overview',   label: 'Overview' },
  { key: 'licenses',   label: 'Licenses' },
  { key: 'coupons',    label: 'Coupons' },
  { key: 'business',   label: 'Business' },
  { key: 'governance', label: 'Governance' },
]

// ─── Page ───────────────────────────────────────────────────────────────────

export default function LicenseCenterPage() {
  const [tab, setTab] = useState<TabKey>('overview')
  const [overview, setOverview] = useState<LicenseCenterOverview | null>(null)
  const [overviewErr, setOverviewErr] = useState<string | null>(null)
  const [ovKey, setOvKey] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const d = await authedGet<LicenseCenterOverviewResponse>('/api/admin/license-center/overview')
        if (!alive) return
        setOverviewErr(null); setOverview(d.overview)
      } catch (e) { if (alive) setOverviewErr(e instanceof Error ? e.message : 'Failed to load overview') }
    })()
    return () => { alive = false }
  }, [ovKey])

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/admin/licenses" className="mb-1 inline-flex items-center gap-1.5 text-[12.5px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            <KeyRound className="size-3.5" /> License Console
          </Link>
          <h1 className="text-[20px] font-bold tracking-tight text-foreground">License &amp; Coupon Command Center</h1>
          <p className="mt-0.5 text-[12.5px] text-muted-foreground">Every license, coupon, purchase, expiry, override and promotion across the platform.</p>
        </div>
        <button onClick={() => setOvKey(k => k + 1)} className={btnOutline}><RefreshCw className="size-3.5" /> Refresh</button>
      </div>

      {overviewErr && <ErrorBanner>{overviewErr}</ErrorBanner>}

      <HealthPanel indicators={overview?.health ?? []} />

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} aria-current={tab === t.key ? 'page' : undefined}
            className={cn('rounded-t-md px-3.5 py-2 text-[13.5px] font-medium transition-colors',
              tab === t.key ? 'border-b-2 border-primary text-primary' : 'text-muted-foreground hover:text-foreground')}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (overview ? <OverviewWorkspace o={overview} onGoto={setTab} /> : !overviewErr && <CenterSpin />)}
      {tab === 'licenses' && <LicensesWorkspace />}
      {tab === 'coupons' && <CouponsWorkspace />}
      {tab === 'business' && <BusinessWorkspace />}
      {tab === 'governance' && <GovernanceWorkspace />}
    </div>
  )
}

// ─── Health Panel ─────────────────────────────────────────────────────────────

function HealthPanel({ indicators }: { indicators: HealthIndicator[] }) {
  if (!indicators.length) {
    return <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-[13px] text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Evaluating health…</div>
  }
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {indicators.map(h => (
          <div key={h.key} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
            <div className="flex items-center gap-1.5">
              <span className={cn('size-2 shrink-0 rounded-full', HEALTH_DOT[h.level])} aria-hidden />
              <span className="truncate text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{h.label}</span>
            </div>
            <p className="mt-1 truncate text-[12.5px] font-medium text-foreground" title={h.detail}>{h.detail}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Overview workspace ────────────────────────────────────────────────────────

function OverviewWorkspace({ o, onGoto }: { o: LicenseCenterOverview; onGoto: (t: TabKey) => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <Kpi icon={KeyRound} label="Licenses" value={num(o.licenses.total)} />
        <Kpi icon={BadgeCheck} label="Active" value={num(o.licenses.active)} />
        <Kpi icon={CalendarX} label="Expired" value={num(o.licenses.expired)} />
        <Kpi icon={Zap} label="Consumed" value={num(o.licenses.consumed)} />
        <Kpi icon={IndianRupee} label="Revenue" value={rupees(o.revenue.licenseRevenuePaise)} />
        <Kpi icon={Percent} label="Discount" value={rupees(o.revenue.discountGivenPaise)} />
        <Kpi icon={Gift} label="Redemptions" value={num(o.revenue.couponRedemptions)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="License status" icon={KeyRound}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Active" value={num(o.licenses.active)} />
            <Row label="Pending" value={num(o.licenses.pending)} />
            <Row label="Suspended" value={num(o.licenses.suspended)} />
            <Row label="Cancelled" value={num(o.licenses.cancelled)} />
            <Row label="Consumed" value={num(o.licenses.consumed)} />
            <Row label="Expired windows" value={num(o.licenses.expired)} />
          </dl>
        </Card>
        <Card title="Coupon status" icon={Gift}>
          <dl className="space-y-2 p-4 text-[13.5px]">
            <Row label="Active" value={num(o.coupons.active)} />
            <Row label="Paused" value={num(o.coupons.paused)} />
            <Row label="Scheduled" value={num(o.coupons.scheduled)} />
            <Row label="Expired" value={num(o.coupons.expired)} />
            <Row label="Archived" value={num(o.coupons.archived)} />
            <Row label="Campaigns" value={num(o.coupons.campaigns)} />
          </dl>
        </Card>

        <Card title="License sales by tier" icon={TrendingUp}>
          <div className="p-4">{o.byTier.length ? <HBars data={o.byTier} /> : <Empty>No sales yet.</Empty>}</div>
        </Card>
        <Card title="Top coupons" icon={Gift}>
          <div className="p-4">{o.topCoupons.length ? <HBars data={o.topCoupons} /> : <Empty>No redemptions yet.</Empty>}</div>
        </Card>
      </div>

      <Card title="Quick actions" icon={Zap}>
        <div className="flex flex-col gap-2 p-4 sm:flex-row sm:flex-wrap">
          <button onClick={() => onGoto('licenses')} className={btnOutline}><KeyRound className="size-3.5" /> Manage licenses</button>
          <button onClick={() => onGoto('coupons')} className={btnOutline}><Gift className="size-3.5" /> Manage coupons</button>
          <button onClick={() => onGoto('business')} className={btnOutline}><TrendingUp className="size-3.5" /> Business analytics</button>
          <button onClick={() => onGoto('governance')} className={btnOutline}><ScrollText className="size-3.5" /> Governance &amp; timeline</button>
          <DeepLink href="/admin/business-configuration" label="Business Configuration" />
        </div>
      </Card>
    </div>
  )
}

// ─── Licenses workspace ────────────────────────────────────────────────────────

const LICENSE_STATUS_FILTERS = [
  { value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'pending', label: 'Pending' },
  { value: 'suspended', label: 'Suspended' }, { value: 'cancelled', label: 'Cancelled' }, { value: 'complimentary', label: 'Comp' },
]

function LicensesWorkspace() {
  const [items, setItems] = useState<LicenseRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('')
  const [detailId, setDetailId] = useState<string | null>(null)

  const load = useCallback(async (opts: { cursor?: string | null } = {}) => {
    const append = !!opts.cursor
    try {
      const qs = new URLSearchParams({ pageSize: '25' })
      if (search) qs.set('search', search)
      if (status) qs.set('status', status)
      if (opts.cursor) qs.set('cursor', opts.cursor)
      const data = await authedGet<LicenseListResponse>(`/api/admin/licenses?${qs.toString()}`)
      setErr(null)
      setItems(prev => append ? [...prev, ...data.items] : data.items)
      setCursor(data.nextCursor)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load licenses')
    } finally { setLoading(false); setLoadingMore(false) }
  }, [search, status])

  useEffect(() => { const t = setTimeout(() => { setLoading(true); void load() }, 300); return () => clearTimeout(t) }, [load])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search event, organizer, email, tier…" className="max-w-xs flex-1" />
        <FilterTabs options={LICENSE_STATUS_FILTERS} value={status} onChange={setStatus} aria-label="Filter by status" />
      </div>
      {err && <ErrorBanner>{err}</ErrorBanner>}

      <Card title="All licenses" icon={KeyRound}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-semibold">Event</th><th className="px-4 py-2 font-semibold">Organizer</th>
                <th className="px-4 py-2 font-semibold">Tier</th><th className="px-4 py-2 font-semibold">Status</th>
                <th className="px-4 py-2 text-right font-semibold">Used</th><th className="px-4 py-2 text-right font-semibold">Paid</th>
                <th className="px-4 py-2 text-right font-semibold">Manage</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={7} className="px-4 py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></td></tr>
                : items.length === 0 ? <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No licenses found.</td></tr>
                : items.map(r => (
                  <tr key={r.eventId} className="border-b border-border/60">
                    <td className="px-4 py-2"><div className="max-w-[200px] truncate font-medium text-foreground">{r.eventName}</div><div className="max-w-[200px] truncate text-[11px] text-muted-foreground">{r.eventId}</div></td>
                    <td className="px-4 py-2"><div className="max-w-[150px] truncate text-foreground">{r.organizerName || '—'}</div><div className="max-w-[150px] truncate text-[11px] text-muted-foreground">{r.organizerEmail}</div></td>
                    <td className="px-4 py-2 capitalize">{r.tier}{r.complimentary && <StatusPill tone="accent">comp</StatusPill>}</td>
                    <td className="px-4 py-2"><StatusPill tone={r.displayStatus === 'active' ? 'success' : r.displayStatus === 'pending' ? 'warning' : 'danger'}>{r.displayStatus}</StatusPill></td>
                    <td className="px-4 py-2 text-right tabular-nums">{r.registrationLimit === null ? `${num(r.used)}/∞` : `${num(r.used)}/${num(r.registrationLimit)}`}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{rupees(r.amountPaidPaise)}</td>
                    <td className="px-4 py-2 text-right"><button onClick={() => setDetailId(r.eventId)} className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11.5px] font-medium text-foreground hover:bg-muted"><SlidersIcon /> Manage</button></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      {cursor && !loading && <LoadMoreButton onClick={() => { setLoadingMore(true); void load({ cursor }) }} loading={loadingMore} />}
      {detailId && <LicenseDrawer eventId={detailId} onClose={() => setDetailId(null)} onChanged={() => void load()} />}
    </div>
  )
}

function SlidersIcon() { return <KeyRound className="size-3.5" /> }

// ─── License drawer — full EA-4 action set (reuses POST /api/admin/licenses/[id]) ─

function LicenseDrawer({ eventId, onClose, onChanged }: { eventId: string; onClose: () => void; onChanged: () => void }) {
  const [detail, setDetail] = useState<LicenseDetail | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<LicenseAdminActionType | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const { confirm, prompt } = useConfirm()

  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<LicenseDetail>(`/api/admin/licenses/${eventId}`); if (alive) { setErr(null); setDetail(d) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
    })()
    return () => { alive = false }
  }, [eventId, reloadKey])

  async function act(action: LicenseAdminActionType, body: Partial<LicenseAdminActionRequest>) {
    setBusy(action); setErr(null)
    try { await authedSend(`/api/admin/licenses/${eventId}`, 'POST', { action, reason: '', ...body }); setReloadKey(k => k + 1); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Action failed') } finally { setBusy(null) }
  }
  async function withReason(action: LicenseAdminActionType, extra: Partial<LicenseAdminActionRequest> = {}, confirmMsg?: string, danger = false) {
    if (confirmMsg && !(await confirm({ message: confirmMsg, tone: danger ? 'danger' : undefined }))) return
    const reason = (await prompt({ title: 'Reason required', message: `Reason for "${action}":`, required: true }))?.trim()
    if (!reason) return
    await act(action, { ...extra, reason })
  }
  async function promptTier(action: 'upgrade' | 'downgrade') {
    const tier = (await prompt({ title: 'Select tier', message: `Target tier (${EVENT_LICENSE_TIERS.join(' / ')}):`, placeholder: EVENT_LICENSE_TIERS.join(' / ') }))?.trim() as EventLicenseTier
    if (!EVENT_LICENSE_TIERS.includes(tier)) { if (tier) setErr('Invalid tier'); return }
    await withReason(action, { tier })
  }
  async function promptDays(action: 'extendExpiry' | 'reduceExpiry') {
    const v = (await prompt({ title: action === 'extendExpiry' ? 'Extend expiry' : 'Reduce expiry', message: 'New expiry window in days:', placeholder: 'e.g. 30' }))?.trim()
    if (!v) return
    const n = Number(v); if (!Number.isInteger(n) || n <= 0) { setErr('Days must be a positive integer'); return }
    await withReason(action, { expiryDays: n })
  }

  const row = detail?.row
  const lifecycle = detail?.overlay?.lifecycle ?? 'active'
  const ov = detail?.overlay

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-xl overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[16px] font-semibold text-foreground">License management</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button>
        </div>
        {err && <div className="mb-3"><ErrorBanner>{err}</ErrorBanner></div>}
        {!row ? <CenterSpin /> : (
          <div className="space-y-5 text-[13.5px]">
            <div>
              <p className="font-semibold text-foreground">{row.eventName}</p>
              <p className="text-[12px] text-muted-foreground">{row.eventId}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <StatusPill tone={row.displayStatus === 'active' ? 'success' : row.displayStatus === 'pending' ? 'warning' : 'danger'}>{row.displayStatus}</StatusPill>
                <StatusPill tone="neutral">{row.tier}</StatusPill>
                {row.hasOverrides && <StatusPill tone="info">overrides</StatusPill>}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <Link href={`/admin/events/${row.eventId}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"><LayoutGrid className="size-3.5" /> Event 360</Link>
                {row.organizerUid && <Link href={`/admin/organizers/${row.organizerUid}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-primary hover:underline"><Building2 className="size-3.5" /> Organizer 360</Link>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat label="Reg. limit" value={row.registrationLimit === null ? 'Unlimited' : num(row.registrationLimit)} />
              <Stat label="Used" value={num(row.used)} />
              <Stat label="Price paid" value={rupees(row.amountPaidPaise)} />
              <Stat label="Payment" value={row.paymentStatus} />
              {detail?.order?.razorpayPaymentId && <Stat label="Razorpay" value={detail.order.razorpayPaymentId} />}
              {ov?.paymentReceived !== undefined && <Stat label="Payment received" value={ov.paymentReceived ? 'Yes' : 'No'} />}
            </div>

            {/* Lifecycle + tier + payment */}
            <ActionGroup title="Lifecycle & tier">
              {lifecycle !== 'active'
                ? <Act icon={PlayCircle} label="Reactivate" tone="emerald" busy={busy === 'reactivate'} onClick={() => void withReason('reactivate', {}, 'Reactivate this license?')} />
                : <Act icon={PauseCircle} label="Suspend" tone="amber" busy={busy === 'suspend'} onClick={() => void withReason('suspend')} />}
              <Act icon={XCircle} label="Cancel" tone="red" busy={busy === 'cancel'} onClick={() => void withReason('cancel', {}, 'Cancel this license?', true)} />
              <Act icon={ArrowUpCircle} label="Upgrade" busy={busy === 'upgrade'} onClick={() => void promptTier('upgrade')} />
              <Act icon={ArrowDownCircle} label="Downgrade" busy={busy === 'downgrade'} onClick={() => void promptTier('downgrade')} />
              <Act icon={BadgeCheck} label="Mark paid" tone="emerald" busy={busy === 'markPaymentReceived'} onClick={() => void withReason('markPaymentReceived', {}, 'Mark payment received?')} />
              <Act icon={Undo2} label="Refund" tone="red" busy={busy === 'refund'} onClick={() => void withReason('refund', {}, 'Refund and cancel this license?', true)} />
              <Act icon={RefreshCw} label="Reissue" busy={busy === 'reissue'} onClick={() => void withReason('reissue', {}, 'Reissue this license?')} />
            </ActionGroup>

            {/* Expiry & consumption (API-only) */}
            <ActionGroup title="Expiry & consumption">
              <Act icon={CalendarPlus} label="Extend expiry" busy={busy === 'extendExpiry'} onClick={() => void promptDays('extendExpiry')} />
              <Act icon={CalendarMinus} label="Reduce expiry" busy={busy === 'reduceExpiry'} onClick={() => void promptDays('reduceExpiry')} />
              <Act icon={CalendarX} label="Disable expiry" busy={busy === 'disableExpiry'} onClick={() => void withReason('disableExpiry', {}, 'Make this license perpetual?')} />
              <Act icon={Zap} label="Force consume" tone="amber" busy={busy === 'forceConsume'} onClick={() => void withReason('forceConsume', {}, 'Force-consume this license?', true)} />
              <Act icon={RotateCcw} label="Reset license" tone="red" busy={busy === 'resetLicense'} onClick={() => void withReason('resetLicense', {}, 'Reset this license (clears consumption + binding)?', true)} />
            </ActionGroup>

            {/* Governance overrides (API-only) */}
            <ActionGroup title="Governance overrides">
              <Act icon={Unlock} label="Override publish" busy={busy === 'overridePublish'} onClick={() => void withReason('overridePublish', { overrideEnabled: true }, 'Force-publish: bypass ALL governance?', true)} />
              <Act icon={Fingerprint} label="Override identity" busy={busy === 'overrideIdentity'} onClick={() => void withReason('overrideIdentity', { overrideEnabled: true }, 'Bypass identity validation?', true)} />
              <Act icon={ShieldAlert} label="Override reg-safety" busy={busy === 'overrideRegistrationSafety'} onClick={() => void withReason('overrideRegistrationSafety', { overrideEnabled: true }, 'Bypass registration-safety escalation?', true)} />
            </ActionGroup>

            {/* Timeline / history */}
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Timeline &amp; history</p>
              {detail && detail.timeline.length === 0 ? <Empty>No history yet.</Empty> : (
                <div className="space-y-2">
                  {detail?.timeline.map(t => (
                    <div key={t.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                      <div className="flex items-center justify-between gap-2"><span className="font-medium capitalize text-foreground">{t.action.replace(/_/g, ' ')}</span><span className="text-[11px] text-muted-foreground">{fmtDay(t.createdAt)}</span></div>
                      {t.note && <p className="mt-0.5 text-[12px] text-muted-foreground">{t.note}</p>}
                      {t.reason && <p className="mt-0.5 text-[12px] text-muted-foreground">Reason: {t.reason}</p>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function ActionGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  )
}

// ─── Coupons workspace ─────────────────────────────────────────────────────────

const COUPON_FILTERS = [
  { value: '', label: 'All' }, { value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' },
  { value: 'scheduled', label: 'Scheduled' }, { value: 'expired', label: 'Expired' }, { value: 'archived', label: 'Archived' },
]

function CouponsWorkspace() {
  const [coupons, setCoupons] = useState<CouponView[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [lifecycle, setLifecycle] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [creating, setCreating] = useState(false)
  const [detailCode, setDetailCode] = useState<string | null>(null)
  const { confirm, prompt } = useConfirm()

  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<CouponListResponse>('/api/admin/license-coupons?includeArchived=1'); if (alive) { setErr(null); setCoupons(d.coupons) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load coupons') }
    })()
    return () => { alive = false }
  }, [reloadKey])

  const reload = useCallback(() => setReloadKey(k => k + 1), [])

  async function couponAction(code: string, action: 'pause' | 'resume' | 'archive' | 'clone', label: string) {
    let extra: Record<string, string> = {}
    if (action === 'clone') {
      const newCode = (await prompt({ title: 'Clone coupon', message: 'New coupon code:', required: true, placeholder: 'SUMMER2026' }))?.trim()
      if (!newCode) return
      extra = { newCode }
    } else if (action === 'archive' && !(await confirm({ message: `Archive coupon ${code}? It can no longer be applied.`, tone: 'danger' }))) return
    const reason = (await prompt({ title: 'Reason required', message: `Reason to ${label.toLowerCase()}:`, required: true }))?.trim()
    if (!reason) return
    try { await authedSend(`/api/admin/license-coupons/${code}`, 'POST', { action, reason, ...extra }); reload() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Action failed') }
  }

  const filtered = (coupons ?? []).filter(c => {
    if (lifecycle && c.lifecycle !== lifecycle) return false
    const q = search.trim().toLowerCase()
    if (q && !(c.code.toLowerCase().includes(q) || c.campaign.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))) return false
    return true
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <SearchInput value={search} onChange={setSearch} placeholder="Search code, campaign, description…" className="max-w-xs flex-1" />
        <FilterTabs options={COUPON_FILTERS} value={lifecycle} onChange={setLifecycle} aria-label="Filter by lifecycle" />
        <button onClick={() => setCreating(true)} className={cn(btnOutline, 'ml-auto')}><PlusCircle className="size-3.5" /> New coupon</button>
      </div>
      {err && <ErrorBanner>{err}</ErrorBanner>}

      <Card title="Coupons" icon={Gift}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-[13px]">
            <thead className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-semibold">Code</th><th className="px-4 py-2 font-semibold">Type</th>
                <th className="px-4 py-2 font-semibold">Campaign</th><th className="px-4 py-2 font-semibold">Lifecycle</th>
                <th className="px-4 py-2 text-right font-semibold">Uses</th><th className="px-4 py-2 font-semibold">Expires</th>
                <th className="px-4 py-2 text-right font-semibold">Actions</th>
              </tr>
            </thead>
            <tbody>
              {coupons === null ? <tr><td colSpan={7} className="px-4 py-10 text-center"><Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" /></td></tr>
                : filtered.length === 0 ? <tr><td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">No coupons.</td></tr>
                : filtered.map(c => (
                  <tr key={c.code} className="border-b border-border/60">
                    <td className="px-4 py-2"><button onClick={() => setDetailCode(c.code)} className="font-mono font-medium text-primary hover:underline">{c.code}</button><div className="max-w-[180px] truncate text-[11px] text-muted-foreground">{c.description}</div></td>
                    <td className="px-4 py-2">{c.type === 'percentage' ? `${c.value}%` : c.type === 'fixed' ? rupees(c.value) : 'Free'}</td>
                    <td className="px-4 py-2 text-muted-foreground">{c.campaign || '—'}</td>
                    <td className="px-4 py-2"><StatusPill tone={COUPON_TONE[c.lifecycle]}>{c.lifecycle}</StatusPill></td>
                    <td className="px-4 py-2 text-right tabular-nums">{num(c.currentUses)}{c.usageLimit != null ? `/${num(c.usageLimit)}` : ''}</td>
                    <td className="px-4 py-2 text-muted-foreground">{c.expiresAt ? fmtDay(c.expiresAt) : 'Never'}</td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {c.lifecycle === 'paused'
                          ? <IconBtn title="Resume" onClick={() => void couponAction(c.code, 'resume', 'Resume')}><PlayCircle className="size-3.5" /></IconBtn>
                          : <IconBtn title="Pause" onClick={() => void couponAction(c.code, 'pause', 'Pause')}><PauseCircle className="size-3.5" /></IconBtn>}
                        <IconBtn title="Clone" onClick={() => void couponAction(c.code, 'clone', 'Clone')}><Copy className="size-3.5" /></IconBtn>
                        <IconBtn title="Edit" onClick={() => setDetailCode(c.code)}><PencilLine className="size-3.5" /></IconBtn>
                        {!c.archived && <IconBtn title="Archive" onClick={() => void couponAction(c.code, 'archive', 'Archive')}><Archive className="size-3.5" /></IconBtn>}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </Card>

      {creating && <CouponCreateDialog onClose={() => setCreating(false)} onCreated={() => { setCreating(false); reload() }} />}
      {detailCode && <CouponDrawer code={detailCode} onClose={() => setDetailCode(null)} onChanged={reload} />}
    </div>
  )
}

const COUPON_TONE: Record<CouponView['lifecycle'], PillTone> = {
  draft: 'neutral', scheduled: 'info', active: 'success', paused: 'warning', expired: 'neutral', archived: 'neutral',
}

function IconBtn({ title, onClick, children }: { title: string; onClick: () => void; children: React.ReactNode }) {
  return <button title={title} onClick={onClick} className="flex items-center justify-center rounded-md border border-border p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">{children}</button>
}

function CouponCreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [code, setCode] = useState('')
  const [type, setType] = useState<'percentage' | 'fixed' | 'free'>('percentage')
  const [value, setValue] = useState('')
  const [campaign, setCampaign] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [usageLimit, setUsageLimit] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  async function submit() {
    if (!reason.trim()) { setErr('A reason is required'); return }
    setBusy(true); setErr(null)
    const coupon: Record<string, unknown> = {
      code, type, campaign: campaign || undefined,
      value: type === 'free' ? 0 : Number(value),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
      usageLimit: usageLimit ? Number(usageLimit) : null,
      enabled: true,
    }
    try { await authedSend('/api/admin/license-coupons', 'POST', { reason: reason.trim(), coupon }); onCreated() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Create failed'); setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><h2 className="text-[16px] font-semibold text-foreground">New license coupon</h2><button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button></div>
        {err && <div className="mb-3"><ErrorBanner>{err}</ErrorBanner></div>}
        <div className="space-y-3 text-[13px]">
          <Field label="Code"><input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="SUMMER2026" className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type"><select value={type} onChange={e => setType(e.target.value as typeof type)} className={inputCls}><option value="percentage">Percentage</option><option value="fixed">Fixed (₹)</option><option value="free">Free</option></select></Field>
            <Field label={type === 'percentage' ? 'Percent (1–100)' : type === 'fixed' ? 'Amount (₹)' : 'Value'}><input value={value} onChange={e => setValue(e.target.value)} disabled={type === 'free'} type="number" className={inputCls} /></Field>
          </div>
          <Field label="Campaign (optional)"><input value={campaign} onChange={e => setCampaign(e.target.value)} placeholder="launch" className={inputCls} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Expires (optional)"><input value={expiresAt} onChange={e => setExpiresAt(e.target.value)} type="date" className={inputCls} /></Field>
            <Field label="Usage limit (optional)"><input value={usageLimit} onChange={e => setUsageLimit(e.target.value)} type="number" className={inputCls} /></Field>
          </div>
          <Field label="Reason (required, audited)"><input value={reason} onChange={e => setReason(e.target.value)} placeholder="Launch promo" className={inputCls} /></Field>
          <p className="text-[11px] text-muted-foreground">Fixed amounts are in ₹ and stored as paise; the value shown is what you type here (rupees for fixed). New coupons start enabled; the coupon engine derives the lifecycle from dates + flags.</p>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button onClick={onClose} className={btnOutline}>Cancel</button>
          <button onClick={() => void submit()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground disabled:opacity-50">{busy ? <Loader2 className="size-3.5 animate-spin" /> : <PlusCircle className="size-3.5" />} Create</button>
        </div>
      </div>
    </div>
  )
}

function CouponDrawer({ code, onClose, onChanged }: { code: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<CouponDetailResponse | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)
  const { prompt } = useConfirm()

  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<CouponDetailResponse>(`/api/admin/license-coupons/${code}`); if (alive) { setErr(null); setData(d) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load') }
    })()
    return () => { alive = false }
  }, [code, reloadKey])

  async function editField(field: 'description' | 'campaign' | 'usageLimit' | 'expiresAt', label: string) {
    const raw = (await prompt({ title: `Edit ${label}`, message: `New ${label}:`, required: false }))
    if (raw === null) return
    const v = raw.trim()
    const reason = (await prompt({ title: 'Reason required', message: 'Reason for edit:', required: true }))?.trim()
    if (!reason) return
    const patch: Record<string, unknown> =
      field === 'usageLimit' ? { usageLimit: v ? Number(v) : null }
      : field === 'expiresAt' ? { expiresAt: v ? new Date(v).toISOString() : null }
      : { [field]: v }
    try { await authedSend(`/api/admin/license-coupons/${code}`, 'POST', { action: 'update', reason, coupon: patch }); setReloadKey(k => k + 1); onChanged() }
    catch (e) { setErr(e instanceof Error ? e.message : 'Update failed') }
  }

  const c = data?.coupon
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/50" onClick={onClose}>
      <div className="h-full w-full max-w-lg overflow-y-auto bg-card p-5 shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between"><h2 className="text-[16px] font-semibold text-foreground">Coupon {code}</h2><button onClick={onClose} className="rounded-md p-1 text-muted-foreground hover:bg-muted"><X className="size-4" /></button></div>
        {err && <div className="mb-3"><ErrorBanner>{err}</ErrorBanner></div>}
        {!c ? <CenterSpin /> : (
          <div className="space-y-4 text-[13.5px]">
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={COUPON_TONE[c.lifecycle]}>{c.lifecycle}</StatusPill>
              <StatusPill tone="neutral">{c.type === 'percentage' ? `${c.value}%` : c.type === 'fixed' ? rupees(c.value) : 'free'}</StatusPill>
              <StatusPill tone="neutral">{c.visibility}</StatusPill>
              {c.stackable && <StatusPill tone="info">stackable</StatusPill>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Uses" value={`${num(data.usage.currentUses)}${c.usageLimit != null ? ` / ${num(c.usageLimit)}` : ''}`} />
              <Stat label="Paid redemptions" value={num(data.usage.paidRedemptions)} />
              <Stat label="Discount given" value={rupees(data.usage.discountGivenPaise)} />
              <Stat label="Per-organizer limit" value={c.perOrganizerLimit != null ? num(c.perOrganizerLimit) : '∞'} />
              <Stat label="Campaign" value={c.campaign || '—'} />
              <Stat label="Expires" value={c.expiresAt ? fmtDay(c.expiresAt) : 'Never'} />
            </div>
            {(c.restrictions.tiers.length > 0 || c.restrictions.eventTypes.length > 0) && (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[12.5px]">
                <p className="font-semibold text-foreground">Restrictions</p>
                {c.restrictions.tiers.length > 0 && <p className="text-muted-foreground">Tiers: {c.restrictions.tiers.join(', ')}</p>}
                {c.restrictions.eventTypes.length > 0 && <p className="text-muted-foreground">Event types: {c.restrictions.eventTypes.join(', ')}</p>}
              </div>
            )}
            <ActionGroup title="Edit (audited)">
              <Act icon={PencilLine} label="Description" onClick={() => void editField('description', 'description')} />
              <Act icon={PencilLine} label="Campaign" onClick={() => void editField('campaign', 'campaign')} />
              <Act icon={CalendarClock} label="Usage limit" onClick={() => void editField('usageLimit', 'usageLimit')} />
              <Act icon={CalendarClock} label="Expiry" onClick={() => void editField('expiresAt', 'expiresAt')} />
            </ActionGroup>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Business workspace ────────────────────────────────────────────────────────

function BusinessWorkspace() {
  const [data, setData] = useState<AdminAnalytics | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<{ analytics: AdminAnalytics }>('/api/admin/analytics'); if (alive) { setErr(null); setData(d.analytics) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load analytics') }
    })()
    return () => { alive = false }
  }, [])

  if (err) return <ErrorBanner>{err}</ErrorBanner>
  if (!data) return <CenterSpin />
  const ls = data.licenseSales

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Kpi icon={IndianRupee} label="License revenue" value={rupees(ls.revenuePaise)} />
        <Kpi icon={BadgeCheck} label="Paid" value={num(ls.paidCount)} />
        <Kpi icon={Undo2} label="Refunded" value={num(ls.refundedCount)} />
        <Kpi icon={Percent} label="Discount given" value={rupees(ls.discountGivenPaise)} />
        <Kpi icon={Gift} label="Redemptions" value={num(ls.couponRedemptions)} />
        <Kpi icon={IndianRupee} label="Platform gross" value={rupees(data.platform.lifetimeGrossPaise)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Platform growth — events / day" icon={TrendingUp}><div className="p-4"><Bars data={data.growth.eventsByDay} /></div></Card>
        <Card title="License sales by tier" icon={KeyRound}><div className="p-4">{ls.byTier.length ? <HBars data={ls.byTier} /> : <Empty>No sales.</Empty>}</div></Card>
        <Card title="Top coupons" icon={Gift}><div className="p-4">{ls.topCoupons.length ? <HBars data={ls.topCoupons} /> : <Empty>No redemptions.</Empty>}</div></Card>
        <Card title="Campaign performance" icon={TrendingUp}><div className="p-4">{ls.byCampaign.length ? <HBars data={ls.byCampaign} /> : <Empty>No campaigns.</Empty>}</div></Card>
        <Card title="Top organizers (gross)" icon={Building2}>
          <div className="p-4">{data.topOrganizers.length ? <HBars data={data.topOrganizers.map(o => ({ label: o.name || o.uid.slice(0, 8), value: Math.round(o.grossPaise / 100) }))} format={v => `₹${num(v)}`} /> : <Empty>No data.</Empty>}</div>
        </Card>
        <Card title="Top events (registrations)" icon={Ticket}>
          <div className="p-4">{data.topEvents.length ? <HBars data={data.topEvents.map(e => ({ label: e.name, value: e.registrations }))} /> : <Empty>No data.</Empty>}</div>
        </Card>
      </div>

      <Card title="Reports" icon={ScrollText}>
        <div className="flex flex-wrap gap-2 p-4">
          <DeepLink href="/admin/finance-reports" label="Finance Reports" />
          <DeepLink href="/admin/finance" label="Finance Console" />
          <DeepLink href="/admin/analytics" label="Platform Analytics" />
        </div>
      </Card>
    </div>
  )
}

// ─── Governance workspace ──────────────────────────────────────────────────────

function GovernanceWorkspace() {
  const [entries, setEntries] = useState<LicenseCenterTimelineEntry[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try { const d = await authedGet<LicenseCenterTimelineResponse>('/api/admin/license-center/timeline'); if (alive) { setErr(null); setEntries(d.entries) } }
      catch (e) { if (alive) setErr(e instanceof Error ? e.message : 'Failed to load timeline') }
    })()
    return () => { alive = false }
  }, [])

  return (
    <div className="space-y-4">
      {err && <ErrorBanner>{err}</ErrorBanner>}
      <Card title="Configuration & audit" icon={ShieldCheck}>
        <div className="flex flex-wrap gap-2 p-4">
          <DeepLink href="/admin/business-configuration" label="Business Configuration" />
          <DeepLink href="/admin/audit" label="Admin Audit Log" />
          <DeepLink href="/admin/licenses" label="License Console" />
        </div>
      </Card>

      <Card title="Merged timeline — license · coupon · payment · overrides · audit" icon={ScrollText}>
        <div className="p-4">
          {entries === null ? <CenterSpin /> : entries.length === 0 ? <Empty>No history yet.</Empty> : (
            <ol className="space-y-2">
              {entries.map(t => (
                <li key={t.id} className="rounded-lg border border-border bg-muted/30 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2"><StatusPill tone={TIMELINE_TONE[t.source]}>{t.source}</StatusPill><span className="font-medium capitalize text-foreground">{t.action.replace(/[._]/g, ' ')}</span>{t.entity && <span className="text-[11px] text-muted-foreground">{t.entity}</span>}</span>
                    <span className="text-[11px] text-muted-foreground">{fmtDate(t.at)}</span>
                  </div>
                  {t.detail && <p className="mt-0.5 text-[12.5px] text-muted-foreground">{t.detail}</p>}
                  {t.actor && <p className="mt-0.5 text-[11px] text-muted-foreground/70">{t.actor.slice(0, 10)}…</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </Card>
    </div>
  )
}

const TIMELINE_TONE: Record<LicenseCenterTimelineEntry['source'], PillTone> = {
  license: 'accent', coupon: 'info', billing: 'warning', audit: 'neutral',
}

// ─── Shared primitives ─────────────────────────────────────────────────────────

const btnOutline = 'inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted disabled:opacity-50'
const inputCls = 'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-[13px] text-foreground disabled:opacity-50'

function CenterSpin() { return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div> }
function Empty({ children }: { children: React.ReactNode }) { return <p className="text-[13px] text-muted-foreground">{children}</p> }

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1 block text-[12px] font-medium text-muted-foreground">{label}</span>{children}</label>
}
function Kpi({ icon: Icon, label, value }: { icon: typeof KeyRound; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3.5">
      <div className="flex items-center gap-1.5 text-muted-foreground"><Icon className="size-3.5" aria-hidden /><span className="truncate text-[11px] font-medium uppercase tracking-wide">{label}</span></div>
      <p className="mt-1.5 truncate text-[19px] font-bold tabular-nums text-foreground" title={value}>{value}</p>
    </div>
  )
}
function Card({ title, icon: Icon, children }: { title: string; icon?: typeof KeyRound; children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">{Icon && <Icon className="size-4 text-muted-foreground" aria-hidden />}<h2 className="text-[13.5px] font-semibold text-foreground">{title}</h2></header>
      {children}
    </section>
  )
}
function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><dt className="text-[12.5px] text-muted-foreground">{label}</dt><dd className="min-w-0 truncate text-right font-medium text-foreground" title={value}>{value}</dd></div>
}
function Stat({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-border bg-muted/30 px-3 py-2"><p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p><p className="mt-0.5 truncate text-[13.5px] font-semibold text-foreground" title={value}>{value}</p></div>
}
function DeepLink({ href, label }: { href: string; label: string }) {
  return <Link href={href} className={cn(btnOutline)}><span>{label}</span><ExternalLink className="size-3.5 text-muted-foreground" /></Link>
}
function Act({ icon: Icon, label, onClick, busy, tone }: {
  icon: typeof KeyRound; label: string; onClick: () => void; busy?: boolean; tone?: 'emerald' | 'amber' | 'red'
}) {
  const toneCls = tone === 'emerald' ? 'hover:border-emerald-300 hover:bg-emerald-50 hover:text-emerald-700'
    : tone === 'amber' ? 'hover:border-amber-300 hover:bg-amber-50 hover:text-amber-700'
    : tone === 'red' ? 'hover:border-red-300 hover:bg-red-50 hover:text-red-700' : 'hover:bg-muted'
  return (
    <button onClick={onClick} disabled={busy} className={cn('inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12.5px] font-medium text-foreground transition-colors disabled:opacity-40', toneCls)}>
      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Icon className="size-3.5" />}{label}
    </button>
  )
}

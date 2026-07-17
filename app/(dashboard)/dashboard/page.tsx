'use client'

// Phase H.2.1 — Organizer executive dashboard.
//
// A premium, connected overview composed entirely from the EXISTING
// /api/organizer/dashboard aggregation endpoint (one request, no new Firestore
// reads). All sections are derived client-side from that single payload using the
// reusable workspace components (MetricCard, ActivityTimeline, AttentionPanel,
// EventSwitcher, DashboardCard). No fake or hardcoded data.

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Ticket, Banknote, Wallet, CalendarDays,
  Flame, Award, Clock, CreditCard, MailWarning, Plus, CheckCircle2, Circle,
  Megaphone, Send, Users as UsersIcon, Activity as ActivityIcon,
} from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { isEventLicenseTier } from '@/lib/licensing/eventLicense'
import { useLicenseCatalog } from '@/lib/licensing/licenseCatalogClient'
import { formatINR } from '@/components/event-templates/shared/utils/format'
import { CREATE_EVENT_HREF } from '@/config/workspaceNav'
import { MetricCard } from '@/components/dashboard/MetricCard'
import { ActivityTimeline, type ActivityItem } from '@/components/dashboard/ActivityTimeline'
import { AttentionPanel, type AttentionItem } from '@/components/dashboard/AttentionPanel'
import { EventSwitcher, type SwitchableEvent } from '@/components/dashboard/EventSwitcher'
import { QuickActions } from '@/components/dashboard/QuickActions'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { EmptyState, ErrorState } from '@/components/dashboard/EmptyState'
import { KpiCardSkeleton, Skeleton } from '@/components/dashboard/Skeleton'
import type { DashboardData } from '@/app/api/organizer/dashboard/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rupees = (paise: number) => formatINR(Math.round(paise) / 100)

function todayYmd(): string {
  const n = new Date()
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`
}

const STATUS_LABEL: Record<string, string> = {
  published:           'Live',
  registration_closed: 'Closed',
  completed:           'Ended',
  pending_review:      'Pending',
  changes_requested:   'Changes',
  draft:               'Draft',
}
const STATUS_STYLE: Record<string, string> = {
  published:           'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  registration_closed: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  completed:           'bg-slate-100 text-slate-600 ring-slate-500/20',
  pending_review:      'bg-amber-50 text-amber-700 ring-amber-600/20',
  changes_requested:   'bg-orange-50 text-orange-700 ring-orange-600/20',
  draft:               'bg-slate-100 text-slate-600 ring-slate-500/20',
}

function greeting(): string {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

// Feature flag — the "Platform updates" widget is built but not yet enabled for
// organizers. Kept in the tree (not deleted) so a future release can flip this
// to true and reuse the widget as-is. While false it is hidden entirely — no
// "Coming soon" placeholder is shown. Typed as boolean so the render guard is
// not a constant expression.
const PLATFORM_UPDATES_ENABLED: boolean = false

// ─── Page ───────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data,    setData]    = useState<DashboardData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  // Tier display name from the effective (config-aware) catalog; unknown → as-is.
  const catalog  = useLicenseCatalog()
  const tierName = (tier: string): string => isEventLicenseTier(tier) ? catalog[tier].name : tier

  const load = useCallback(async () => {
    const u = auth.currentUser
    if (!u) { setError('Not authenticated'); setLoading(false); return }
    setLoading(true); setError(null)
    try {
      const token = await u.getIdToken()
      const res = await fetch('/api/organizer/dashboard', {
        headers: { authorization: `Bearer ${token}` },
        cache:   'no-store',
      })
      if (!res.ok) throw new Error(`Request failed (${res.status})`)
      setData(await res.json() as DashboardData)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t) }, [load])

  // ── Derived view models (memoized — no recompute unless data changes) ────────

  const activity = useMemo<ActivityItem[]>(() => {
    if (!data) return []
    return data.activity.map((a, i) => ({
      id:          `act-${i}-${a.timestamp}`,
      kind:        a.type === 'checkin' ? 'checkin' : 'registration',
      title:       a.type === 'checkin' ? `${a.attendeeName} checked in` : `${a.attendeeName} registered`,
      description: [a.eventName, a.passName].filter(Boolean).join(' · '),
      timestamp:   a.timestamp,
    }))
  }, [data])

  const attention = useMemo<AttentionItem[]>(() => {
    if (!data) return []
    const items: AttentionItem[] = []

    data.alerts.forEach((a, i) => {
      const icon = a.type === 'nearly_full' ? Flame
        : a.type === 'cert_missing'     ? Award
        : a.type === 'reg_closing_soon' ? Clock
        : CreditCard
      const category = a.type === 'comm_payment_pending' ? 'financial' as const
        : a.type === 'cert_missing' ? 'certificates' as const
        : 'registrations' as const
      items.push({
        id: `alert-${i}`, severity: a.severity, title: a.title, meta: a.meta, icon,
        href: '/dashboard/events', category,
      })
    })

    if (data.walletBalancePaise < 10_000) {
      items.push({
        id: 'wallet-low', severity: 'warning', title: 'Wallet balance is low',
        meta: `${rupees(data.walletBalancePaise)} remaining`, icon: Wallet, href: '/dashboard/wallet',
        category: 'financial',
      })
    }
    if (data.communications.emailsFailedToday > 0) {
      items.push({
        id: 'email-failed', severity: 'warning',
        title: `${data.communications.emailsFailedToday} email${data.communications.emailsFailedToday > 1 ? 's' : ''} failed today`,
        meta: 'Review delivery in Communications', icon: MailWarning, href: '/dashboard/communications/email-logs',
        category: 'broadcasts',
      })
    }
    // Events needing review action — surfaced from the summary endpoint.
    data.actionEvents.forEach(e => {
      if (e.reviewStatus === 'rejected') {
        items.push({ id: `rej-${e.draftId}`, severity: 'critical', title: `${e.name} was not approved`,
          meta: 'Review the reason and resubmit', icon: MailWarning, href: '/dashboard/events', category: 'registrations' })
      } else if (e.lifecycleStatus === 'changes_requested' || e.reviewStatus === 'changes_requested') {
        items.push({ id: `chg-${e.draftId}`, severity: 'warning', title: `${e.name} — changes requested`,
          meta: 'Update your event and resubmit', icon: MailWarning, href: '/dashboard/events', category: 'registrations' })
      } else if (e.lifecycleStatus === 'pending_review') {
        items.push({ id: `pnd-${e.draftId}`, severity: 'info', title: `${e.name} is pending approval`,
          meta: 'Awaiting admin review', icon: Clock, href: `/dashboard/events/${e.draftId}`, category: 'registrations' })
      }
    })

    const today = todayYmd()
    data.events.forEach(e => {
      if (e.startDate && e.startDate.slice(0, 10) === today && e.lifecycleStatus !== 'completed') {
        items.push({
          id: `starts-${e.draftId}`, severity: 'info', title: `${e.name} starts today`,
          meta: `${e.registered} registered`, icon: CalendarDays, href: `/dashboard/events/${e.draftId}`,
          category: 'registrations',
        })
      }
    })
    return items
  }, [data])

  const switchable = useMemo<SwitchableEvent[]>(
    () => (data?.events ?? []).map(e => ({ draftId: e.draftId, name: e.name, lifecycleStatus: e.lifecycleStatus })),
    [data],
  )

  const upcoming = useMemo(() => {
    if (!data) return []
    return [...data.events]
      .filter(e => e.lifecycleStatus !== 'completed')
      .sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''))
      .slice(0, 6)
  }, [data])

  // ── Header (always rendered, even while loading) ─────────────────────────────
  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-[32px] font-bold leading-tight tracking-tight text-foreground">
          {greeting()}{data?.organizer.name ? `, ${data.organizer.name.split(' ')[0]}` : ''}
        </h1>
        <p className="mt-0.5 text-[14px] text-muted-foreground">
          Manage your events, approvals, participants and finances.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <EventSwitcher events={switchable} />
        <QuickActions />
        <Link
          href="/dashboard/wallet"
          className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-border px-3.5 text-[14px] font-semibold text-foreground transition-colors hover:bg-muted"
        >
          <Wallet className="size-4" aria-hidden /> Top up wallet
        </Link>
        <Link
          href={CREATE_EVENT_HREF}
          className="inline-flex h-9 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-semibold text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
          style={{ backgroundImage: 'var(--primary-gradient)' }}
        >
          <Plus className="size-4" aria-hidden /> Create event
        </Link>
      </div>
    </div>
  )

  if (loading && !data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
          {Array.from({ length: 8 }).map((_, i) => <KpiCardSkeleton key={i} />)}
        </div>
        {/* Mirror the final two-column card layout (left: 3 cards, right: 4 cards)
            with matching rounded-xl corners to minimise layout shift on load. */}
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <Skeleton className="h-56 rounded-xl" />
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-60 rounded-xl" />
          </div>
          <div className="space-y-4">
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-44 rounded-xl" />
          </div>
        </div>
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="rounded-2xl border border-border bg-card">
          <ErrorState message={error ?? 'No data available.'} onRetry={() => void load()} />
        </div>
      </div>
    )
  }

  const { overview, settlement, communications, healthScore } = data

  return (
    <div className="space-y-6">
      {header}

      {/* ── Executive metrics ── */}
      <section aria-label="Key metrics" className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8">
        <MetricCard label="Wallet balance" value={rupees(data.walletBalancePaise)} hint="Available"
          icon={Wallet} iconColor="text-sky-700" iconBg="bg-sky-50" href="/dashboard/wallet" />
        <MetricCard label="Pending approval" value={String(data.licenseSummary.pendingApproval)} hint="Awaiting review"
          icon={Clock} iconColor="text-amber-700" iconBg="bg-amber-50" href="/dashboard/events" />
        <MetricCard label="Changes requested" value={String(data.licenseSummary.changesRequested)} hint="Needs edits"
          icon={MailWarning} iconColor="text-orange-700" iconBg="bg-orange-50" href="/dashboard/events" />
        <MetricCard label="Published events" value={String(data.licenseSummary.published)} hint="All-time"
          icon={CalendarDays} iconColor="text-emerald-700" iconBg="bg-emerald-50" href="/dashboard/events" />
        {/* Distinct from "Published events" (which includes completed): live events
            = published + registration_closed. Reuses overview.activeEvents already
            in the payload; Billing shortcut retained. */}
        <MetricCard label="Active licenses" value={String(overview.activeEvents)} hint="Live now"
          icon={CreditCard} iconColor="text-violet-700" iconBg="bg-violet-50" href="/dashboard/settings/billing" />
        <MetricCard label="Registrations today" value={String(overview.todayRegistrations)} hint="Today"
          icon={Ticket} iconColor="text-primary" iconBg="bg-primary/10" href="/dashboard/registrations" />
        <MetricCard label="Revenue today" value={rupees(overview.todayRevenuePaise)} hint="Today"
          icon={Banknote} iconColor="text-emerald-700" iconBg="bg-emerald-50" href="/dashboard/finance" />
        {/* Renamed from "Notifications" — this counts needs-attention items, NOT
            the Notification Center inbox (that remains the header bell). */}
        <MetricCard label="Needs attention" value={String(attention.length)} hint="Action items"
          icon={Flame} iconColor="text-rose-700" iconBg="bg-rose-50" />
      </section>

      {/* ── Main grid ── */}
      <div className="grid gap-4 lg:grid-cols-3">

        {/* Left column (2/3) */}
        <div className="space-y-4 lg:col-span-2">
          <DashboardCard title="Needs attention">
            <AttentionPanel items={attention} grouped />
          </DashboardCard>

          <DashboardCard title="Live activity" viewHref="/dashboard/registrations" viewLabel="View registrations">
            <ActivityTimeline items={activity} limit={12}
              emptyTitle="No recent activity"
              emptyDescription="Registrations and check-ins will stream in here." />
          </DashboardCard>

          <DashboardCard title="Recent events" viewHref="/dashboard/events">
            {upcoming.length === 0 ? (
              <EmptyState icon={CalendarDays} title="No events yet"
                description="Create an event to start taking registrations."
                action={{ label: 'Create event', href: CREATE_EVENT_HREF }} />
            ) : (
              <ul className="divide-y divide-border">
                {upcoming.map(e => (
                  <li key={e.draftId}>
                    <Link href={`/dashboard/events/${e.draftId}`}
                      className="flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-muted/40">
                      {e.bannerUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={e.bannerUrl} alt="" className="h-10 w-14 shrink-0 rounded-lg object-cover" />
                      ) : (
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted">
                          <CalendarDays className="size-4 text-muted-foreground" aria-hidden />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <p className="truncate text-[14px] font-medium text-foreground">{e.name}</p>
                          <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', STATUS_STYLE[e.lifecycleStatus] ?? STATUS_STYLE.completed)}>
                            {STATUS_LABEL[e.lifecycleStatus] ?? e.lifecycleStatus}
                          </span>
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{tierName(e.licenseTier)}</span>
                        </div>
                        <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
                          {e.registered} registered{e.capacity ? ` · ${e.fillPct}% full` : ''}{e.revenuePaise > 0 ? ` · ${rupees(e.revenuePaise)}` : ''}{e.startDate ? ` · ${e.startDate.slice(0, 10)}` : ''}
                        </p>
                        {e.capacity ? (
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, e.fillPct)}%` }} aria-hidden />
                          </div>
                        ) : null}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </DashboardCard>
        </div>

        {/* Right column (1/3) */}
        <div className="space-y-4">
          <DashboardCard title="Settlement summary" viewHref="/dashboard/finance">
            <dl className="divide-y divide-border">
              <MoneyRow label="Gross revenue"        value={rupees(settlement.grossRevenuePaise)} />
              <MoneyRow label={`Platform fee (${(settlement.platformFeeRateBps / 100).toFixed(1)}%)`} value={`– ${rupees(settlement.platformFeePaise)}`} muted />
              <MoneyRow label="Communication cost"   value={`– ${rupees(settlement.communicationCostPaise)}`} muted />
              <MoneyRow label="Net payout (est.)"    value={rupees(settlement.netPayoutPaise)} strong />
            </dl>
          </DashboardCard>

          <DashboardCard title="Wallet" viewHref="/dashboard/wallet" viewLabel="Manage">
            <div className="px-5 pb-4 pt-3">
              <div className="flex items-baseline justify-between">
                <p className="text-[12px] text-muted-foreground">Balance</p>
                <p className="text-[18px] font-bold text-foreground">{rupees(data.walletBalancePaise)}</p>
              </div>
              <ul className="mt-2.5 space-y-1.5">
                {data.recentTransactions.length === 0 ? (
                  <li className="text-[12.5px] text-muted-foreground">No wallet activity yet.</li>
                ) : data.recentTransactions.slice(0, 5).map(t => {
                  const credit = t.type === 'fund_added' || t.type === 'refund'
                  return (
                    <li key={t.id} className="flex items-center justify-between gap-2 text-[12.5px]">
                      <span className="truncate text-muted-foreground">{t.description || t.type}</span>
                      <span className={cn('shrink-0 font-semibold', credit ? 'text-emerald-600' : 'text-foreground')}>{credit ? '+' : '−'}{rupees(t.amountPaise)}</span>
                    </li>
                  )
                })}
              </ul>
            </div>
          </DashboardCard>

          <DashboardCard title="Communication usage" viewHref="/dashboard/communications">
            <div className="grid grid-cols-2 gap-px overflow-hidden rounded-b-2xl bg-border">
              <MiniStat icon={Send} label="Emails sent" value={communications.emailsSent} />
              <MiniStat icon={ActivityIcon} label="WhatsApp" value={communications.whatsappSent} />
              <MiniStat icon={UsersIcon} label="SMS" value={communications.smsSent} />
              <MiniStat icon={Megaphone} label="Campaigns" value={communications.campaignsSent} />
            </div>
          </DashboardCard>

          <DashboardCard title="Workspace health"
            action={<span className="text-[13px] font-semibold text-foreground tabular-nums">{healthScore.score}%</span>}>
            <div className="px-5 pb-4 pt-3">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className={cn('h-full rounded-full', healthScore.score >= 80 ? 'bg-emerald-500' : healthScore.score >= 50 ? 'bg-amber-500' : 'bg-rose-500')}
                  style={{ width: `${healthScore.score}%` }} aria-hidden />
              </div>
              <ul className="mt-3 space-y-1.5">
                {healthScore.items.map(item => (
                  <li key={item.label} className="flex items-center gap-2 text-[13px]">
                    {item.done
                      ? <CheckCircle2 className="size-4 shrink-0 text-emerald-500" aria-hidden />
                      : <Circle className="size-4 shrink-0 text-muted-foreground/40" aria-hidden />}
                    <span className={item.done ? 'text-muted-foreground line-through' : 'text-foreground'}>{item.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          </DashboardCard>

          {PLATFORM_UPDATES_ENABLED && (
            <DashboardCard title="Platform updates">
              <div className="px-5 pb-4 pt-3 text-[13px] text-muted-foreground">
                <p>Product updates, maintenance, and announcements will appear here.</p>
                <p className="mt-2 inline-flex rounded-lg bg-muted/50 px-3 py-1 text-[12px] font-semibold">Coming soon</p>
              </div>
            </DashboardCard>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Small presentational helpers ───────────────────────────────────────────────

function MoneyRow({ label, value, muted, strong }: { label: string; value: string; muted?: boolean; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between px-5 py-2.5">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className={cn('text-[14px] tabular-nums', strong ? 'font-bold text-foreground' : muted ? 'text-muted-foreground' : 'font-medium text-foreground')}>{value}</dd>
    </div>
  )
}

function MiniStat({ icon: Icon, label, value }: { icon: typeof Send; label: string; value: number }) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        <span className="text-[12px]">{label}</span>
      </div>
      <p className="mt-1 text-[18px] font-bold tabular-nums text-foreground">{value.toLocaleString('en-IN')}</p>
    </div>
  )
}

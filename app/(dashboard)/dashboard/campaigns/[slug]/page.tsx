'use client'

import { Suspense, useEffect, useState } from 'react'
import Link                              from 'next/link'
import { useParams }                     from 'next/navigation'
import { onAuthStateChanged }            from 'firebase/auth'
import { auth }                          from '@/lib/firebase/auth'
import {
  ArrowLeft,
  Award,
  BarChart3,
  CheckCircle2,
  Download,
  ExternalLink,
  Heart,
  Loader2,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react'
import { DashboardCard } from '@/components/dashboard/DashboardCard'
import { Skeleton }      from '@/components/dashboard/Skeleton'
import DonationRefundButton from '@/components/donations/DonationRefundButton'
import { cn }            from '@/lib/utils/cn'
import type {
  CampaignDashboardData,
  CampaignDashboardDonation,
  DailyDonationTotal,
} from '@/app/api/organizer/campaigns/[slug]/route'

// ─── Formatters ──────────────────────────────────────────────────────────────

function fmtINR(rupees: number): string {
  if (rupees >= 10_00_000) return `₹${(rupees / 10_00_000).toFixed(1)}L`
  if (rupees >= 1_000)     return `₹${(rupees / 1_000).toFixed(1)}K`
  return `₹${Math.round(rupees).toLocaleString('en-IN')}`
}

function fmtINRFull(rupees: number): string {
  return `₹${Math.round(rupees).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

interface KpiProps {
  label: string
  value: string
  icon:  React.ElementType
  color: string
  bg:    string
}

function KpiCard({ label, value, icon: Icon, color, bg }: KpiProps) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4">
      <div className={cn('flex size-10 shrink-0 items-center justify-center rounded-xl', bg)}>
        <Icon className={cn('size-5', color)} aria-hidden />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[12px] font-medium text-muted-foreground">{label}</p>
        <p className="mt-0.5 text-[18px] font-bold leading-none text-foreground">{value}</p>
      </div>
    </div>
  )
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const MAP: Record<string, string> = {
    active:    'bg-green-100 text-green-700',
    paused:    'bg-yellow-100 text-yellow-700',
    ended:     'bg-gray-100 text-gray-600',
    cancelled: 'bg-red-100 text-red-700',
  }
  return (
    <span className={cn('rounded-full px-2.5 py-0.5 text-[12px] font-semibold capitalize', MAP[status] ?? 'bg-gray-100 text-gray-600')}>
      {status}
    </span>
  )
}

// ─── Daily chart ──────────────────────────────────────────────────────────────

function DailyChart({ dailyTotals }: { dailyTotals: DailyDonationTotal[] }) {
  const maxAmount = Math.max(...dailyTotals.map(d => d.amountPaise), 1)
  const hasData   = dailyTotals.some(d => d.amountPaise > 0)
  const BAR_H     = 72

  return (
    <DashboardCard title="Daily Donations — Last 30 Days">
      <div className="p-4 pt-3">
        {!hasData ? (
          <p className="py-8 text-center text-[13px] text-muted-foreground">
            No donations in the last 30 days
          </p>
        ) : (
          <div
            className="flex items-end gap-px"
            style={{ height: `${BAR_H + 24}px` }}
            role="img"
            aria-label="Daily donation chart"
          >
            {dailyTotals.map((d, i) => {
              const fillH = d.amountPaise > 0
                ? Math.max(2, Math.round((d.amountPaise / maxAmount) * BAR_H))
                : 0
              const label = new Date(d.date + 'T00:00:00').toLocaleDateString('en-IN', {
                day: 'numeric', month: 'short',
              })
              return (
                <div
                  key={d.date}
                  className="relative flex flex-1 flex-col items-center"
                  title={`${label}: ${fmtINRFull(d.amountPaise / 100)}${d.count > 0 ? ` (${d.count} donation${d.count > 1 ? 's' : ''})` : ''}`}
                >
                  {/* Bar track */}
                  <div className="w-full rounded-t-sm bg-muted" style={{ height: `${BAR_H}px` }}>
                    {fillH > 0 && (
                      <div
                        className="absolute bottom-6 w-full rounded-t-sm bg-orange-400"
                        style={{ height: `${fillH}px` }}
                      />
                    )}
                  </div>
                  {/* X-axis label every 5 bars */}
                  {i % 5 === 0 && (
                    <span className="mt-1 shrink-0 text-[9px] leading-none text-muted-foreground sm:text-[10px]">
                      {label}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </DashboardCard>
  )
}

// ─── Recent donations table ───────────────────────────────────────────────────

function RecentDonationsTable({ donations }: { donations: CampaignDashboardDonation[] }) {
  if (donations.length === 0) {
    return (
      <DashboardCard title="Recent Donations">
        <p className="py-8 text-center text-[13px] text-muted-foreground">No donations yet</p>
      </DashboardCard>
    )
  }

  return (
    <DashboardCard title="Recent Donations">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-[13px]">
          <thead>
            <tr className="border-b border-border">
              <th className="px-5 pb-2.5 pt-3 text-left font-semibold text-muted-foreground">Donor</th>
              <th className="pb-2.5 pr-3 pt-3 text-right font-semibold text-muted-foreground">Amount</th>
              <th className="hidden pb-2.5 pr-3 pt-3 text-right font-semibold text-muted-foreground sm:table-cell">Date</th>
              <th className="pb-2.5 pr-5 pt-3 text-right font-semibold text-muted-foreground">Receipt</th>
              <th className="pb-2.5 pr-5 pt-3 text-right font-semibold text-muted-foreground">Refund</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {donations.map(d => (
              <tr key={d.donationId}>
                <td className="px-5 py-2.5">
                  <p className="font-medium text-foreground">
                    {d.donorName}
                    {d.isAnonymous && (
                      <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                        anon
                      </span>
                    )}
                  </p>
                  <p className="text-[12px] text-muted-foreground">{d.donorEmail}</p>
                </td>
                <td className="py-2.5 pr-3 text-right font-semibold text-foreground">
                  {fmtINRFull(d.amountRupees)}
                </td>
                <td className="hidden py-2.5 pr-3 text-right text-muted-foreground sm:table-cell">
                  {fmtDateTime(d.paidAt)}
                </td>
                <td className="py-2.5 pr-5 text-right">
                  {d.receiptNumber ? (
                    <span className="font-mono text-[11px] text-muted-foreground">{d.receiptNumber}</span>
                  ) : (
                    <span className="text-[12px] text-muted-foreground/50">—</span>
                  )}
                </td>
                <td className="py-2.5 pr-5 text-right">
                  <DonationRefundButton donationId={d.donationId} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  )
}

// ─── Top donations list ───────────────────────────────────────────────────────

function TopDonationsList({ donations }: { donations: CampaignDashboardDonation[] }) {
  if (donations.length === 0) {
    return (
      <DashboardCard title="Top Donors">
        <p className="py-8 text-center text-[13px] text-muted-foreground">No donations yet</p>
      </DashboardCard>
    )
  }

  const MEDALS = ['🥇', '🥈', '🥉']

  return (
    <DashboardCard title="Top Donors">
      <ul className="divide-y divide-border">
        {donations.map((d, i) => (
          <li key={d.donationId} className="flex items-center gap-3 px-5 py-3">
            <span className="w-5 text-center text-[16px]" aria-hidden>
              {MEDALS[i] ?? String(i + 1)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-semibold text-foreground">
                {d.donorName}
                {d.isAnonymous && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground">
                    anon
                  </span>
                )}
              </p>
              <p className="text-[12px] text-muted-foreground">{fmtDate(d.paidAt)}</p>
            </div>
            <p className="shrink-0 text-[14px] font-bold text-orange-600">
              {fmtINRFull(d.amountRupees)}
            </p>
          </li>
        ))}
      </ul>
    </DashboardCard>
  )
}

// ─── Campaign settings card ───────────────────────────────────────────────────

function CampaignSettingsCard({ data }: { data: CampaignDashboardData }) {
  const publicPageLink = (
    <a
      href={`/campaign/${data.slug}`}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
    >
      Public page
      <ExternalLink className="size-3" aria-hidden />
    </a>
  )

  const rows: { label: string; value: React.ReactNode }[] = [
    { label: 'Status',        value: <StatusBadge status={data.status} /> },
    { label: 'Visibility',    value: <span className="capitalize">{data.visibility}</span> },
    { label: '80G',           value: data.is80G ? '✓ Enabled' : 'Not enabled' },
    { label: 'Goal',          value: data.goalRupees ? fmtINRFull(data.goalRupees) : 'No goal set' },
    { label: 'End Date',      value: fmtDate(data.endDate) },
    { label: 'Organizer',     value: data.organizerName },
    { label: 'Last Donation', value: fmtDateTime(data.lastDonationAt) },
  ]

  return (
    <DashboardCard title="Campaign Info" action={publicPageLink}>
      <dl className="divide-y divide-border px-5">
        {rows.map(r => (
          <div key={r.label} className="flex items-center justify-between gap-4 py-3 text-[13px]">
            <dt className="shrink-0 text-muted-foreground">{r.label}</dt>
            <dd className="text-right font-medium text-foreground">{r.value}</dd>
          </div>
        ))}
      </dl>
    </DashboardCard>
  )
}

// ─── Loading skeleton ─────────────────────────────────────────────────────────

function PageSkeleton() {
  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-4">
        <Skeleton className="h-5 w-5 rounded" />
        <Skeleton className="h-7 w-52" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-36 rounded-xl" />
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  )
}

// ─── Main content ─────────────────────────────────────────────────────────────

function CampaignDashboardContent({ slug }: { slug: string }) {
  const [data,      setData]      = useState<CampaignDashboardData | null>(null)
  const [error,     setError]     = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async user => {
      if (!user) return
      try {
        const token = await user.getIdToken()
        const res   = await fetch(`/api/organizer/campaigns/${slug}`, {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: 'Request failed' }))
          setError((body as { error?: string }).error ?? 'Failed to load campaign data')
          return
        }
        setData(await res.json() as CampaignDashboardData)
      } catch {
        setError('Could not load campaign data. Please try again.')
      }
    })
    return unsub
  }, [slug])

  async function handleExport() {
    setExporting(true)
    try {
      const user = auth.currentUser
      if (!user) return
      const token = await user.getIdToken()
      const res   = await fetch(`/api/organizer/campaigns/${slug}/export`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) return
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      const a    = document.createElement('a')
      a.href     = url
      a.download = `${slug}-donations.csv`
      a.click()
      URL.revokeObjectURL(url)
    } finally {
      setExporting(false)
    }
  }

  if (!data && !error) return <PageSkeleton />

  if (error) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-6 text-center">
        <p className="text-[15px] font-semibold text-foreground">{error}</p>
        <Link href="/dashboard/campaigns" className="text-[14px] text-muted-foreground hover:text-foreground">
          ← Back to campaigns
        </Link>
      </div>
    )
  }

  if (!data) return null

  const {
    totalRaisedRupees, goalRupees, remainingRupees,
    goalPct, donorCount, donationCount, avgDonationRupees,
  } = data

  const progressPct  = goalPct ?? 0
  const showProgress = goalRupees !== null

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">

        {/* ── Page header ── */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Link
              href="/dashboard/campaigns"
              className="mb-1 flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              Campaigns
            </Link>
            <h1 className="text-xl font-bold text-foreground sm:text-2xl">{data.title}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-2">
              <StatusBadge status={data.status} />
              <span className="rounded-full bg-muted px-2.5 py-0.5 text-[12px] font-semibold capitalize text-muted-foreground">
                {data.visibility}
              </span>
              {data.is80G && (
                <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-[12px] font-semibold text-emerald-700">
                  80G Eligible
                </span>
              )}
            </div>
          </div>

          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            className={cn(
              'flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-2 text-[13px] font-semibold text-foreground',
              'transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {exporting
              ? <Loader2 className="size-4 animate-spin" aria-hidden />
              : <Download className="size-4" aria-hidden />
            }
            Export CSV
          </button>
        </div>

        {/* ── KPI Grid — Row 1: financial ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard
            label="Goal Amount"
            value={goalRupees !== null ? fmtINR(goalRupees) : 'No Goal'}
            icon={Target}
            color="text-violet-600"
            bg="bg-violet-50"
          />
          <KpiCard
            label="Amount Raised"
            value={fmtINR(totalRaisedRupees)}
            icon={TrendingUp}
            color="text-orange-600"
            bg="bg-orange-50"
          />
          <KpiCard
            label="Remaining"
            value={remainingRupees !== null ? fmtINR(remainingRupees) : '—'}
            icon={Heart}
            color="text-pink-600"
            bg="bg-pink-50"
          />
          <KpiCard
            label="Progress"
            value={goalPct !== null ? `${goalPct}%` : '—'}
            icon={Award}
            color="text-amber-600"
            bg="bg-amber-50"
          />
        </div>

        {/* ── KPI Grid — Row 2: volume ── */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <KpiCard
            label="Unique Donors"
            value={donorCount.toLocaleString('en-IN')}
            icon={Users}
            color="text-blue-600"
            bg="bg-blue-50"
          />
          <KpiCard
            label="Total Donations"
            value={donationCount.toLocaleString('en-IN')}
            icon={CheckCircle2}
            color="text-green-600"
            bg="bg-green-50"
          />
          <KpiCard
            label="Avg Donation"
            value={donationCount > 0 ? fmtINR(avgDonationRupees) : '—'}
            icon={BarChart3}
            color="text-teal-600"
            bg="bg-teal-50"
          />
        </div>

        {/* ── Progress bar ── */}
        {showProgress && (
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="mb-2 flex items-center justify-between text-[13px]">
              <span className="font-medium text-muted-foreground">Fundraising Progress</span>
              <span className="font-bold text-foreground">
                {fmtINRFull(totalRaisedRupees)} / {fmtINRFull(goalRupees!)}
              </span>
            </div>
            <div className="h-3 overflow-hidden rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-gradient-to-r from-orange-400 to-orange-500 transition-all duration-500"
                style={{ width: `${Math.min(100, progressPct)}%` }}
                role="progressbar"
                aria-valuenow={progressPct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`${progressPct}% of goal raised`}
              />
            </div>
            <p className="mt-1.5 text-right text-[12px] font-semibold text-orange-600">
              {progressPct}% of goal
            </p>
          </div>
        )}

        {/* ── Daily chart ── */}
        <DailyChart dailyTotals={data.dailyTotals} />

        {/* ── Donations + Top Donors ── */}
        <div className="grid gap-4 lg:grid-cols-2">
          <RecentDonationsTable donations={data.recentDonations} />
          <TopDonationsList     donations={data.topDonations} />
        </div>

        {/* ── Campaign settings ── */}
        <CampaignSettingsCard data={data} />

      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function CampaignDashboardInner() {
  const params = useParams<{ slug: string }>()
  const slug   = params?.slug ?? ''
  return <CampaignDashboardContent slug={slug} />
}

export default function CampaignDashboardPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CampaignDashboardInner />
    </Suspense>
  )
}

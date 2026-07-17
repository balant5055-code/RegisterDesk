'use client'

// Billing → Licenses tab. Read-only view of the workspace's Event Licenses
// (eventLicenses, the canonical license doc). Reuses the existing Billing page's
// design tokens (cards, tables, badges, spacing, typography). It modifies nothing.

import { useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import { cn } from '@/lib/utils/cn'
import { Loader2, Search, ArrowRight } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { nextEventLicenseTier, type EventLicenseTier } from '@/lib/licensing/eventLicense'
import { useLicenseCatalog } from '@/lib/licensing/licenseCatalogClient'

interface LicenseRow {
  slug:              string
  eventName:         string
  tier:              'starter' | 'growth' | 'professional' | 'enterprise'
  status:            string
  maxRegistrations:  number | null
  used:              number
  remaining:         number | null
  purchaseDate:      string | null
  amountPaidPaise:   number
  walletUsedPaise:   number
  orderId:           string | null
  razorpayPaymentId: string | null
  publishedAt:       string | null
}

const STATUS_META: Record<string, { label: string; cls: string }> = {
  active:            { label: 'Active',            cls: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20' },
  pending_approval:  { label: 'Pending Approval',  cls: 'bg-amber-50 text-amber-700 ring-amber-600/20' },
  changes_requested: { label: 'Changes Requested', cls: 'bg-orange-50 text-orange-700 ring-orange-600/20' },
  rejected:          { label: 'Rejected',          cls: 'bg-rose-50 text-rose-700 ring-rose-600/20' },
  cancelled:         { label: 'Cancelled',         cls: 'bg-slate-100 text-slate-600 ring-slate-500/20' },
  pending_payment:   { label: 'Pending Payment',   cls: 'bg-blue-50 text-blue-700 ring-blue-600/20' },
}

const rupees  = (p: number) => `₹${(p / 100).toLocaleString('en-IN')}`
const fmtDate = (iso: string | null) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
const regLabel = (max: number | null) => max == null ? 'Unlimited' : max.toLocaleString('en-IN')

const licenseHref = (slug: string) => `/dashboard/settings/billing/licenses/${slug}`

function StatusBadge({ status }: { status: string }) {
  const m = STATUS_META[status] ?? STATUS_META.active
  return <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1', m.cls)}>{m.label}</span>
}

export default function LicensesTab() {
  const [rows,    setRows]    = useState<LicenseRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [query,   setQuery]   = useState('')
  const [tierF,   setTierF]   = useState<'all' | LicenseRow['tier']>('all')
  const [statusF, setStatusF] = useState<'all' | string>('all')
  const router = useRouter()

  // Tier names + upgrade CTA from the effective (config-aware) catalog.
  const catalog  = useLicenseCatalog()
  const tierName = (tier: LicenseRow['tier']): string => catalog[tier].name
  const upgradeCta = (tier: LicenseRow['tier']): { label: string; href?: string } | null => {
    const next = nextEventLicenseTier(tier as EventLicenseTier)
    return next ? { label: `Upgrade to ${catalog[next].name}` } : null
  }

  useEffect(() => {
    let alive = true
    void (async () => {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { if (alive) { setError('You must be signed in.'); setLoading(false) } return }
      try {
        const res = await fetch('/api/organizer/licenses', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
        if (!res.ok) throw new Error('Could not load licenses.')
        const data = await res.json() as { licenses: LicenseRow[] }
        if (alive) setRows(data.licenses)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [])

  const q = query.trim().toLowerCase()
  const filtered = rows.filter(r => {
    if (tierF !== 'all' && r.tier !== tierF) return false
    if (statusF !== 'all' && r.status !== statusF) return false
    if (!q) return true
    return r.eventName.toLowerCase().includes(q)
      || tierName(r.tier).toLowerCase().includes(q)
      || (r.orderId ?? '').toLowerCase().includes(q)
  })

  if (loading) return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  if (error)   return <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13.5px] text-destructive">{error}</div>

  return (
    <div className="space-y-4">
      {/* Hero */}
      <div>
        <h2 className="text-[16px] font-bold tracking-tight text-foreground">Event Licenses</h2>
        <p className="text-[13px] text-muted-foreground">Every event runs on a license. See each event’s tier, status, capacity, and payment.</p>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-12 text-center">
          <p className="text-[14px] font-semibold text-foreground">No licenses yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">Publish an event to get your first Event License.</p>
          <Link href="/dashboard/events/new" className="mt-3 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm" style={{ backgroundImage: 'var(--primary-gradient)' }}>
            Create your first event <ArrowRight className="size-3.5" />
          </Link>
        </div>
      ) : (
        <>
          {/* Search + filters */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[200px] flex-1">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search event, tier, or order…"
                className="w-full rounded-lg border border-border bg-background py-1.5 pl-8 pr-3 text-[13px] text-foreground"
              />
            </div>
            <select value={tierF} onChange={e => setTierF(e.target.value as typeof tierF)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-[13px]">
              <option value="all">All tiers</option>
              <option value="starter">Starter</option>
              <option value="growth">Growth</option>
              <option value="professional">Professional</option>
              <option value="enterprise">Enterprise</option>
            </select>
            <select value={statusF} onChange={e => setStatusF(e.target.value)} className="rounded-lg border border-border bg-background px-2 py-1.5 text-[13px]">
              <option value="all">All statuses</option>
              {Object.entries(STATUS_META).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
          </div>

          {/* Desktop / tablet table */}
          <div className="hidden overflow-x-auto rounded-xl border border-border sm:block">
            <table className="w-full min-w-[820px] text-[13px]">
              <thead>
                <tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
                  <th className="px-3 py-2.5">Event</th>
                  <th className="px-3 py-2.5">License</th>
                  <th className="px-3 py-2.5">Status</th>
                  <th className="px-3 py-2.5">Registrations</th>
                  <th className="px-3 py-2.5">Purchased</th>
                  <th className="px-3 py-2.5 text-right">Amount</th>
                  <th className="px-3 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {filtered.map(r => {
                  const cta = upgradeCta(r.tier)
                  return (
                    <tr key={r.slug} className="cursor-pointer hover:bg-muted/20" onClick={() => router.push(licenseHref(r.slug))}>
                      <td className="px-3 py-2.5">
                        <div className="font-medium text-foreground">{r.eventName}</div>
                        <div className="text-[11.5px] text-muted-foreground">/{r.slug}</div>
                      </td>
                      <td className="px-3 py-2.5"><span className="inline-flex rounded-full bg-muted px-2 py-0.5 text-[11.5px] font-semibold text-foreground">{tierName(r.tier)}</span></td>
                      <td className="px-3 py-2.5"><StatusBadge status={r.status} /></td>
                      <td className="px-3 py-2.5 text-muted-foreground">{r.used.toLocaleString('en-IN')} / {regLabel(r.maxRegistrations)}{r.remaining != null && <span className="text-[11.5px]"> · {r.remaining.toLocaleString('en-IN')} left</span>}</td>
                      <td className="px-3 py-2.5 text-muted-foreground">{fmtDate(r.purchaseDate)}</td>
                      <td className="px-3 py-2.5 text-right font-semibold text-foreground">{r.amountPaidPaise > 0 ? rupees(r.amountPaidPaise) : 'Free'}</td>
                      <td className="px-3 py-2.5 text-right" onClick={e => e.stopPropagation()}>
                        <Link href={licenseHref(r.slug)} className="text-[12px] font-semibold text-primary">{cta ? cta.label : 'Manage'}</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="space-y-2.5 sm:hidden">
            {filtered.map(r => {
              const cta = upgradeCta(r.tier)
              return (
                <Link key={r.slug} href={licenseHref(r.slug)} className="block w-full rounded-xl border border-border bg-card p-3 text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-foreground">{r.eventName}</span>
                    <StatusBadge status={r.status} />
                  </div>
                  <div className="mt-1 flex items-center gap-2 text-[12px] text-muted-foreground">
                    <span className="rounded-full bg-muted px-1.5 py-0.5 font-semibold text-foreground">{tierName(r.tier)}</span>
                    <span>{r.used.toLocaleString('en-IN')} / {regLabel(r.maxRegistrations)}</span>
                    <span className="ml-auto font-semibold text-foreground">{r.amountPaidPaise > 0 ? rupees(r.amountPaidPaise) : 'Free'}</span>
                  </div>
                  {cta && <div className="mt-1.5 text-[12px] font-semibold text-primary">{cta.label}</div>}
                </Link>
              )
            })}
          </div>

          {filtered.length === 0 && <p className="py-6 text-center text-[13px] text-muted-foreground">No licenses match your filters.</p>}
        </>
      )}
    </div>
  )
}

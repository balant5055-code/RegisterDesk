'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { onAuthStateChanged, type User } from 'firebase/auth'
import { auth } from '@/lib/firebase/auth'
import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import { Users, Loader2, Search, AlertCircle, RefreshCw, Download } from 'lucide-react'
import { ErrorState } from '@/components/dashboard/EmptyState'
import type { CrmContactView, CrmAnalytics, CrmScope } from '@/lib/crm/types'

type Filter = 'all' | 'donors' | 'repeat' | 'checked_in' | 'not_checked_in'
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'donors', label: 'Donors' },
  { value: 'repeat', label: 'Repeat attendees' },
  { value: 'checked_in', label: 'Checked in' },
  { value: 'not_checked_in', label: 'Not checked in' },
]

const inr = (p: number) => `₹${(p / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`
const fmtDate = (ms: number) => ms ? new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

export default function CrmPage() {
  const { showToast } = useToast()
  const { confirm } = useConfirm()
  const userRef = useRef<User | null>(null)
  const [contacts, setContacts] = useState<CrmContactView[]>([])
  const [analytics, setAnalytics] = useState<CrmAnalytics | null>(null)
  const [scope, setScope] = useState<CrmScope>('full')
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [backfilling, setBackfilling] = useState(false)
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [exporting, setExporting] = useState(false)

  type ContactsResponse = {
    contacts: CrmContactView[]; scope: CrmScope
    total: number; truncated: boolean; nextCursor: string | null
  }

  const load = useCallback(async () => {
    const u = userRef.current
    if (!u) return
    setLoading(true); setError(null)
    try {
      const token = await u.getIdToken()
      const h = { Authorization: `Bearer ${token}` }
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (filter !== 'all') params.set('filter', filter)
      const [cRes, aRes] = await Promise.all([
        fetch(`/api/organizer/crm/contacts?${params}`, { headers: h, cache: 'no-store' }),
        fetch('/api/organizer/crm/analytics', { headers: h, cache: 'no-store' }),
      ])
      if (cRes.status === 403) throw new Error('CRM is not available for your role.')
      if (!cRes.ok) throw new Error('Could not load contacts.')
      const cData = await cRes.json() as ContactsResponse
      setContacts(cData.contacts); setScope(cData.scope)
      setTotal(cData.total); setTruncated(cData.truncated); setNextCursor(cData.nextCursor)
      if (aRes.ok) setAnalytics(((await aRes.json()) as { analytics: CrmAnalytics }).analytics)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load') } finally { setLoading(false) }
  }, [search, filter])

  const loadMore = useCallback(async () => {
    const u = userRef.current
    if (!u || !nextCursor) return
    setLoadingMore(true)
    try {
      const token = await u.getIdToken()
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (filter !== 'all') params.set('filter', filter)
      params.set('cursor', nextCursor)
      const res = await fetch(`/api/organizer/crm/contacts?${params}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) throw new Error('Could not load more contacts.')
      const data = await res.json() as ContactsResponse
      setContacts(prev => [...prev, ...data.contacts])
      setNextCursor(data.nextCursor)
    } catch (e) { setError(e instanceof Error ? e.message : 'Failed to load more') } finally { setLoadingMore(false) }
  }, [search, filter, nextCursor])

  async function exportCsv() {
    const u = userRef.current
    if (!u) return
    setExporting(true)
    try {
      const token = await u.getIdToken()
      const params = new URLSearchParams()
      if (search.trim()) params.set('search', search.trim())
      if (filter !== 'all') params.set('filter', filter)
      const res = await fetch(`/api/organizer/crm/contacts/export?${params}`, {
        headers: { Authorization: `Bearer ${token}` }, cache: 'no-store',
      })
      if (!res.ok) throw new Error('Export failed.')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = 'crm-contacts.csv'
      document.body.appendChild(a); a.click(); a.remove()
      URL.revokeObjectURL(url)
    } catch (e) { showToast(e instanceof Error ? e.message : 'Export failed', 'error') } finally { setExporting(false) }
  }

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, u => { userRef.current = u; if (u) void load() })
    return unsub
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Re-query on filter change (search is applied via the Apply button / Enter).
  useEffect(() => {
    if (userRef.current) void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])

  async function backfill() {
    const u = userRef.current
    if (!u) return
    if (!(await confirm({ message: 'Rebuild the CRM from your registrations, donations, certificates and broadcasts? This is safe to run anytime.' }))) return
    setBackfilling(true)
    try {
      const token = await u.getIdToken()
      const res = await fetch('/api/organizer/crm/backfill', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
      const d = await res.json().catch(() => null) as { error?: string; contacts?: number } | null
      if (!res.ok) throw new Error(d?.error ?? 'Backfill failed.')
      showToast(`CRM rebuilt: ${d?.contacts ?? 0} contacts.`, 'success')
      await load()
    } catch (e) { showToast(e instanceof Error ? e.message : 'Failed', 'error') } finally { setBackfilling(false) }
  }

  const kpis = analytics ? [
    { label: 'Total Contacts', value: analytics.totalContacts.toLocaleString('en-IN') },
    ...(scope === 'full' ? [
      { label: 'Repeat Attendees', value: analytics.repeatAttendees.toLocaleString('en-IN') },
      { label: 'Checked In', value: analytics.checkedInContacts.toLocaleString('en-IN') },
      { label: 'Retention', value: `${analytics.retentionRatePct}%` },
    ] : []),
    { label: 'Donors', value: analytics.donorCount.toLocaleString('en-IN') },
    { label: 'Donation Value', value: inr(analytics.totalDonationPaise) },
  ] : []

  return (
    <div className="space-y-6 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-xl bg-primary/[0.09] text-primary"><Users className="size-5" aria-hidden /></div>
          <div>
            <h1 className="text-[20px] font-bold tracking-tight text-foreground">CRM &amp; Attendee Intelligence</h1>
            <p className="text-[13.5px] text-muted-foreground">Unified contacts built from registrations, donations, certificates and broadcasts.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => void exportCsv()} disabled={exporting || loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
            {exporting ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Export CSV
          </button>
          {scope === 'full' && (
            <button onClick={() => void backfill()} disabled={backfilling}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
              {backfilling ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} Rebuild
            </button>
          )}
        </div>
      </div>

      {/* Analytics */}
      {kpis.length > 0 && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {kpis.map(k => (
            <div key={k.label} className="rounded-2xl border border-border bg-card p-4">
              <p className="text-[12px] text-muted-foreground">{k.label}</p>
              <p className="mt-1 text-[18px] font-bold text-foreground">{k.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Top donors */}
      {analytics && analytics.topDonors.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <p className="mb-2 text-[13px] font-semibold uppercase tracking-wider text-muted-foreground">Top Donors</p>
          <div className="flex flex-wrap gap-2">
            {analytics.topDonors.map(d => (
              <Link key={d.contactId} href={`/dashboard/crm/${d.contactId}`} className="rounded-lg border border-border px-3 py-1.5 text-[13px] hover:bg-muted">
                <span className="font-medium text-foreground">{d.name}</span> <span className="text-muted-foreground">· {inr(d.amountPaise)}</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Search + filters */}
      <div className="flex flex-wrap items-center gap-3">
        <form onSubmit={e => { e.preventDefault(); void load() }} className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search name, email, phone"
            className="w-64 rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-[13px]" />
        </form>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map(f => (
            <button key={f.value} onClick={() => setFilter(f.value)}
              className={cn('rounded-lg border px-3 py-1.5 text-[12.5px] font-medium',
                filter === f.value ? 'border-primary bg-primary/[0.08] text-primary' : 'border-border text-muted-foreground hover:bg-muted')}>
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {error && <ErrorState message={error} onRetry={() => void load()} className="rounded-xl border border-border" />}

      {!loading && !error && truncated && (
        <div className="flex items-center gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-[13px] text-amber-700 dark:text-amber-400">
          <AlertCircle className="size-4 shrink-0" />
          Showing your {total.toLocaleString('en-IN')} most recent matching contacts (scan limit reached). Refine your search or filters to narrow the results, or use Export CSV for the full list.
        </div>
      )}

      {loading && <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>}

      {!loading && !error && (
        <>
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[720px] text-[13px]">
            <thead><tr className="border-b border-border bg-muted/40 text-left text-[12px] font-semibold text-muted-foreground">
              <th className="px-4 py-2.5">Contact</th>
              <th className="px-4 py-2.5 text-right">Regs</th>
              <th className="px-4 py-2.5 text-right">Check-ins</th>
              <th className="px-4 py-2.5 text-right">Donations</th>
              <th className="px-4 py-2.5 text-right">Donated</th>
              <th className="px-4 py-2.5">Last seen</th>
            </tr></thead>
            <tbody className="divide-y divide-border">
              {contacts.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">No contacts found.</td></tr>
              ) : contacts.map(c => (
                <tr key={c.contactId} className="hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <Link href={`/dashboard/crm/${c.contactId}`} className="font-medium text-foreground hover:text-primary">{c.name || c.email}</Link>
                    <p className="text-[12px] text-muted-foreground">{c.email}{c.phone ? ` · ${c.phone}` : ''}</p>
                    {c.tags.length > 0 && <div className="mt-1 flex flex-wrap gap-1">{c.tags.map(t => <span key={t} className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t}</span>)}</div>}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.totalRegistrations}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.totalCheckIns}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{c.totalDonations}</td>
                  <td className="px-4 py-3 text-right tabular-nums font-medium">{c.totalDonationAmountPaise > 0 ? inr(c.totalDonationAmountPaise) : '—'}</td>
                  <td className="px-4 py-3 text-muted-foreground">{fmtDate(c.lastSeenAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {contacts.length > 0 && (
          <div className="flex flex-col items-center gap-3 pt-1 sm:flex-row sm:justify-between">
            <p className="text-[12.5px] text-muted-foreground">
              Showing {contacts.length.toLocaleString('en-IN')} of {total.toLocaleString('en-IN')} contacts
            </p>
            {nextCursor && (
              <button onClick={() => void loadMore()} disabled={loadingMore}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-4 py-2 text-[13px] font-medium text-foreground hover:bg-muted disabled:opacity-60">
                {loadingMore && <Loader2 className="size-3.5 animate-spin" />} Load more
              </button>
            )}
          </div>
        )}
        </>
      )}
    </div>
  )
}

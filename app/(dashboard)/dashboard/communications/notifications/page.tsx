'use client'

// Communication Center (Phase G3.6) — READ-ONLY organizer dashboard over the
// unified communication log (email + WhatsApp). View-only: message delivery is
// driven by the notification/broadcast/reminder engines, not from this log.
//
// RD-COMMS-P2-F — scoped to the event chosen in the dashboard's event selector (all events when
// "All events" is chosen); the server reads that event's rows directly. A message whose outcome
// the provider never confirmed is "Delivery unknown" — neither sent nor failed — and has no
// resend. Email is included; WhatsApp is drawn from the event's capacity (see Usage), so the
// only money shown is what the LEGACY balance paid.

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  Mail, MessageCircle, XCircle, MinusCircle, Gauge, Wallet, ShieldCheck,
  UserCog, Download, Filter, X, RefreshCw, Search, HelpCircle,
} from 'lucide-react'
import { auth } from '@/lib/firebase/auth'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import { COMMUNICATION_USAGE_HREF } from '@/lib/wallet/communicationBalance'
import { commStatusOf, COMM_STATUS_LABELS, DELIVERY_UNKNOWN_HELP, chargeLabel, type CommDisplayStatus } from '@/lib/communications/messageStatus'
import { PageHeader, Card, Badge } from '@/components/ui'
import { useFocusTrap } from '@/lib/hooks/useFocusTrap'
import { cn } from '@/lib/utils/cn'
import type { CommRow } from '@/app/api/organizer/communications/route'

const inr = (paise: number) => `₹${(Math.round(paise) / 100).toLocaleString('en-IN')}`
const fmtDateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })

interface Stats {
  emailsSent: number; whatsappSent: number; failed: number; unknown: number; skipped: number
  successRate: number; legacyChargesPaise: number; platformNotices: number; organizerNotices: number
}

function computeStats(rows: CommRow[]): Stats {
  const s: Stats = {
    emailsSent: 0, whatsappSent: 0, failed: 0, unknown: 0, skipped: 0, successRate: 0,
    legacyChargesPaise: 0, platformNotices: 0, organizerNotices: 0,
  }
  let sent = 0, failed = 0
  for (const r of rows) {
    const st = commStatusOf(r)
    if (st === 'failed') { s.failed++; failed++ }
    if (st === 'unknown') s.unknown++
    if (st === 'skipped') s.skipped++
    if (st === 'sent' || st === 'delivered') {
      sent++
      if (r.channel === 'email')    s.emailsSent++
      if (r.channel === 'whatsapp') s.whatsappSent++
    }
    s.legacyChargesPaise += r.costPaise
    if (r.audience === 'platform')  s.platformNotices++
    if (r.audience === 'organizer') s.organizerNotices++
  }
  // An unknown outcome is neither a success nor a failure, so it stays outside the rate.
  s.successRate = sent + failed > 0 ? Math.round((sent / (sent + failed)) * 100) : 0
  return s
}

// ─── KPI card ───────────────────────────────────────────────────────────────

function Kpi({ icon: Icon, label, value, tone }: {
  icon: React.ElementType; label: string; value: string; tone?: 'default' | 'rose' | 'amber' | 'emerald'
}) {
  const toneCls = tone === 'rose' ? 'text-rose-600' : tone === 'amber' ? 'text-amber-600'
    : tone === 'emerald' ? 'text-emerald-600' : 'text-foreground'
  return (
    <div className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p className={cn('mt-2 text-[22px] font-bold tabular-nums', toneCls)}>{value}</p>
    </div>
  )
}

// ─── Status badge ─────────────────────────────────────────────────────────────

const STATUS_TONE: Record<CommDisplayStatus, string> = {
  sent:      'bg-emerald-100 text-emerald-700',
  delivered: 'bg-emerald-100 text-emerald-700',
  failed:    'bg-rose-100 text-rose-700',
  unknown:   'bg-amber-100 text-amber-800 ring-1 ring-amber-600/30',
  skipped:   'bg-amber-100 text-amber-700',
  queued:    'bg-border/50 text-muted-foreground',
}

function StatusBadge({ row }: { row: CommRow }) {
  const st = commStatusOf(row)
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold', STATUS_TONE[st])}
      title={st === 'unknown' ? DELIVERY_UNKNOWN_HELP : undefined}>
      {st === 'unknown' && <HelpCircle className="size-3" aria-hidden />}
      {COMM_STATUS_LABELS[st]}
    </span>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function CommunicationCenterPage() {
  // The event selector decides the scope: one event (by its public slug), or every event.
  // null = the selector is still loading; '' = nothing to show (a draft has no messages yet).
  const { selectedEvent, isAllEvents, loading: eventsLoading } = useEventContext()
  const scope: string | null = eventsLoading ? null
    : selectedEvent ? (selectedEvent.slug ?? '') : isAllEvents ? '*' : ''
  const [rows, setRows]       = useState<CommRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [selected, setSelected] = useState<CommRow | null>(null)

  // Filters
  const [fChannel, setFChannel]     = useState('')
  const [fStatus, setFStatus]       = useState('')
  const [fType, setFType]           = useState('')
  const [fRecipient, setFRecipient] = useState('')
  const [dateFrom, setDateFrom]     = useState('')
  const [dateTo, setDateTo]         = useState('')

  const [reloadKey, setReloadKey] = useState(0)
  const refresh = () => setReloadKey(k => k + 1)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      // Await before any setState so the effect never setStates synchronously.
      const token = await auth.currentUser?.getIdToken()
      if (cancelled || scope === null) return
      setLoading(true); setError(null)
      if (scope === '') { setRows([]); setLoading(false); return }
      try {
        const qs = new URLSearchParams()
        if (scope !== '*') qs.set('event', scope)
        if (dateFrom) qs.set('dateFrom', dateFrom)
        if (dateTo)   qs.set('dateTo', dateTo)
        const res = await fetch(`/api/organizer/communications?${qs.toString()}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          cache: 'no-store',
        })
        const json = await res.json() as { success?: boolean; rows?: CommRow[]; error?: string }
        if (!res.ok || !json.success) throw new Error(json.error ?? 'Failed to load communications')
        if (cancelled) return
        setRows(json.rows ?? [])
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load communications')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [scope, dateFrom, dateTo, reloadKey])

  // Client-side filters (event scope and date range are applied server-side).
  const filtered = useMemo(() => rows.filter((r) => {
    if (fChannel && r.channel !== fChannel)        return false
    if (fStatus  && commStatusOf(r) !== fStatus)   return false
    if (fType    && r.notificationType !== fType)  return false
    if (fRecipient) {
      const hay = `${r.recipientEmail} ${r.recipientPhone} ${r.recipientName}`.toLowerCase()
      if (!hay.includes(fRecipient.toLowerCase().trim())) return false
    }
    return true
  }), [rows, fChannel, fStatus, fType, fRecipient])

  const stats = useMemo(() => computeStats(filtered), [filtered])
  const types = useMemo(() => [...new Set(rows.map(r => r.notificationType).filter(Boolean))].sort(), [rows])

  const hasFilters = fChannel || fStatus || fType || fRecipient || dateFrom || dateTo
  const clearFilters = () => { setFChannel(''); setFStatus(''); setFType(''); setFRecipient(''); setDateFrom(''); setDateTo('') }

  const exportCsv = () => {
    const headers = ['Date', 'Event', 'Recipient', 'Email', 'Phone', 'Type', 'Channel', 'Status', 'Provider', 'Message ID', 'Legacy balance charge (₹)']
    const esc = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`
    const lines = filtered.map(r => [
      fmtDateTime(r.createdAt), r.eventName, r.recipientName, r.recipientEmail, r.recipientPhone,
      r.notificationType, r.channel, COMM_STATUS_LABELS[commStatusOf(r)], r.provider, r.providerMessageId,
      r.costPaise > 0 ? (r.costPaise / 100).toFixed(2) : '0',
    ].map(v => esc(String(v))).join(','))
    const csv = [headers.join(','), ...lines].join('\r\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `communications-${new Date().toISOString().slice(0, 10)}.csv`
    a.click(); URL.revokeObjectURL(url)
  }

  const selectCls = 'rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary'

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title="Communication Center"
        subtitle="Every email and WhatsApp notification — read-only history and delivery status."
      />
      <p className="-mt-3 text-[12.5px] text-muted-foreground">
        {selectedEvent ? <>Showing messages for <span className="font-semibold text-foreground">{selectedEvent.name}</span>. Change the event in the selector at the top of the page.</>
          : isAllEvents ? 'Showing messages for all your events.' : 'Choose an event in the selector at the top of the page.'}
      </p>

      {/* ── SECTION 1 — KPIs ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
        <Kpi icon={Mail}          label="Emails Sent"           value={stats.emailsSent.toLocaleString('en-IN')} />
        <Kpi icon={MessageCircle} label="WhatsApp Sent"         value={stats.whatsappSent.toLocaleString('en-IN')} />
        <Kpi icon={XCircle}       label="Failed"                value={stats.failed.toLocaleString('en-IN')} tone={stats.failed ? 'rose' : 'default'} />
        <Kpi icon={HelpCircle}    label="Delivery unknown"      value={stats.unknown.toLocaleString('en-IN')} tone={stats.unknown ? 'amber' : 'default'} />
        <Kpi icon={MinusCircle}   label="Skipped"               value={stats.skipped.toLocaleString('en-IN')} tone={stats.skipped ? 'amber' : 'default'} />
        <Kpi icon={Gauge}         label="Delivery Success"      value={`${stats.successRate}%`} tone="emerald" />
        {/* Only the LEGACY balance ever charged per message; capacity-funded WhatsApp is on Usage. */}
        {stats.legacyChargesPaise > 0 && <Kpi icon={Wallet} label="Legacy balance charges" value={inr(stats.legacyChargesPaise)} />}
        <Kpi icon={ShieldCheck}   label="Platform notices"      value={stats.platformNotices.toLocaleString('en-IN')} />
        <Kpi icon={UserCog}       label="Organizer notices"     value={stats.organizerNotices.toLocaleString('en-IN')} />
      </div>

      {/* ── SECTION 3 — Filters ─────────────────────────────────────────────── */}
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[13px] font-semibold text-foreground">
            <Filter className="size-4 text-muted-foreground" aria-hidden />Filters
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {hasFilters && (
              <button type="button" onClick={clearFilters} className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                <X className="size-3.5" aria-hidden />Clear
              </button>
            )}
            <button type="button" onClick={refresh} className="flex items-center gap-1 text-[12px] font-medium text-muted-foreground hover:text-foreground">
              <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} aria-hidden />Refresh
            </button>
            <button type="button" onClick={exportCsv} disabled={!filtered.length}
              className={cn('flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[12px] font-semibold text-foreground hover:bg-muted/40', !filtered.length && 'cursor-not-allowed opacity-50')}>
              <Download className="size-3.5" aria-hidden />Export CSV
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={fChannel} onChange={e => setFChannel(e.target.value)} className={selectCls}>
            <option value="">All channels</option>
            <option value="email">Email</option>
            <option value="whatsapp">WhatsApp</option>
          </select>
          <select value={fStatus} onChange={e => setFStatus(e.target.value)} className={selectCls}>
            <option value="">All statuses</option>
            <option value="sent">Sent</option>
            <option value="delivered">Delivered</option>
            <option value="failed">Failed</option>
            <option value="unknown">Delivery unknown</option>
            <option value="skipped">Skipped</option>
            <option value="queued">Queued</option>
          </select>
          <select value={fType} onChange={e => setFType(e.target.value)} className={selectCls}>
            <option value="">All types</option>
            {types.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5">
            <Search className="size-3.5 text-muted-foreground" aria-hidden />
            <input value={fRecipient} onChange={e => setFRecipient(e.target.value)} placeholder="Recipient…"
              className="w-32 bg-transparent text-[12px] text-foreground focus:outline-none" />
          </div>
          <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className={selectCls} aria-label="From date" />
          <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className={selectCls} aria-label="To date" />
        </div>
      </Card>

      {/* ── SECTION 2 — History table ───────────────────────────────────────── */}
      <Card className="overflow-hidden p-0">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-[13px] font-bold text-foreground">Notification History</p>
          <span className="text-[12px] text-muted-foreground">{filtered.length.toLocaleString('en-IN')} shown</span>
        </div>
        {error ? (
          <div className="px-4 py-10 text-center text-[13px] text-rose-600">{error}</div>
        ) : loading ? (
          <div className="flex items-center justify-center gap-2 px-4 py-12 text-[13px] text-muted-foreground">
            <RefreshCw className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />Loading…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-muted-foreground">No notifications match the current filters.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-left">
              <thead>
                <tr className="border-b border-border/60 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                  <th scope="col" className="px-4 py-2.5">Date</th>
                  <th scope="col" className="px-4 py-2.5">Event</th>
                  <th scope="col" className="px-4 py-2.5">Recipient</th>
                  <th scope="col" className="px-4 py-2.5">Type</th>
                  <th scope="col" className="px-4 py-2.5">Channel</th>
                  <th scope="col" className="px-4 py-2.5">Status</th>
                  <th scope="col" className="px-4 py-2.5">Charge</th>
                  <th scope="col" className="px-4 py-2.5"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/40">
                {filtered.map((r) => (
                  <tr key={r.id} className="text-[12.5px] hover:bg-muted/20">
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{fmtDateTime(r.createdAt)}</td>
                    <td className="max-w-[160px] truncate px-4 py-2.5 text-foreground">{r.eventName || '—'}</td>
                    <td className="max-w-[180px] truncate px-4 py-2.5 text-foreground">{r.recipientName || r.recipientEmail || r.recipientPhone || '—'}</td>
                    <td className="px-4 py-2.5 text-muted-foreground">{r.notificationType || '—'}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={r.channel === 'whatsapp' ? 'success' : 'secondary'}>{r.channel === 'whatsapp' ? 'WhatsApp' : 'Email'}</Badge>
                    </td>
                    <td className="px-4 py-2.5"><StatusBadge row={r} /></td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted-foreground">{chargeLabel(r, inr)}</td>
                    <td className="px-4 py-2.5 text-right">
                      <button type="button" onClick={() => setSelected(r)} className="text-[12px] font-semibold text-primary hover:underline">Details</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* ── SECTION 5 — what these messages cost (RD-COMMS-P2-F: the wallet-era cards are gone) ── */}
      <div className="rounded-2xl border border-border bg-card p-4 text-[12.5px] text-muted-foreground">
        <span className="font-semibold text-foreground">Email</span> is included at no charge.{' '}
        <span className="font-semibold text-foreground">WhatsApp</span> uses each event’s purchased capacity — see{' '}
        <Link href={COMMUNICATION_USAGE_HREF} className="font-semibold text-primary hover:underline">Usage</Link> for what is used and what remains.
      </div>

      {selected && <DetailsDrawer row={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}

// ─── SECTION 4 — Details drawer ─────────────────────────────────────────────

function DetailsDrawer({ row, onClose }: { row: CommRow; onClose: () => void }) {
  const panelRef = useFocusTrap<HTMLDivElement>()   // P1-6: trap Tab + restore focus on close
  const rowItem = (label: string, value: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4 py-2.5">
      <dt className="shrink-0 text-[12px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words text-right text-[12.5px] font-medium text-foreground">{value || '—'}</dd>
    </div>
  )
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Notification details">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} aria-hidden />
      <div ref={panelRef} onKeyDown={e => { if (e.key === 'Escape') onClose() }} className="relative flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <p className="text-[14px] font-bold text-foreground">Notification Details</p>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{row.notificationType}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted/40"><X className="size-4" aria-hidden /></button>
        </div>
        <div className="px-5 py-2">
          <dl className="divide-y divide-border/40">
            {rowItem('Notification ID', row.id)}
            {rowItem('Recipient', row.recipientName)}
            {rowItem('Email Address', row.recipientEmail)}
            {rowItem('Phone Number', row.recipientPhone)}
            {rowItem('Event', row.eventName)}
            {rowItem('Registration', row.registrationId)}
            {rowItem('Notification Type', row.notificationType)}
            {rowItem('Channel', row.channel === 'whatsapp' ? 'WhatsApp' : 'Email')}
            {rowItem('Provider', row.provider || (row.channel === 'whatsapp' ? 'meta' : 'ses'))}
            {rowItem('Template Used', row.notificationType)}
            {rowItem('Meta Message ID', row.channel === 'whatsapp' ? row.providerMessageId : '—')}
            {rowItem('Email Provider Message ID', row.channel === 'email' ? row.providerMessageId : '—')}
            {rowItem('Charge', chargeLabel(row, inr))}
            {rowItem('Status', <StatusBadge row={row} />)}
            {commStatusOf(row) === 'unknown' && rowItem('What this means', DELIVERY_UNKNOWN_HELP)}
            {rowItem('Failure Reason', row.error)}
            {rowItem('Created Time', fmtDateTime(row.createdAt))}
          </dl>
        </div>
      </div>
    </div>
  )
}

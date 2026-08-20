'use client'

// RD-WA-LOGS-01 · Communications → WhatsApp Logs.
//
// Separate from Email Logs because the two channels fail differently. An email failure is
// usually a bounce; a WhatsApp failure is a Meta Graph rejection with a numeric code that
// tells the organizer exactly what to fix — 132001 means the template has no translation in
// the locale we requested, and that is a five-minute fix in WhatsApp Manager IF the code is
// visible. Showing only "Failed" turns that into a support ticket, so the code, the HTTP
// status and the normalized reason are all surfaced.
//
// Everything shown here is already sanitised server-side (see whatsappDiagnostics.ts); this
// component renders, it does not decide what is safe.

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  RefreshCw, RotateCcw, Search, AlertCircle, Loader2, CheckCircle2,
  XCircle, Clock, MessageCircle, X,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { emailLogStatusCls } from '@/lib/ui/statusColors'
import { EmptyState, PageHeader } from '@/components/ui'
import { useConfirm } from '@/components/ui/ConfirmDialog'
import type { WhatsAppLog } from '@/app/api/organizer/whatsapp-logs/route'
// TYPE-ONLY from the route (erased at build). The runtime constant comes from the
// client-safe types module — importing a value from the route would bundle the Admin SDK.
import type { WhatsAppLogType } from '@/lib/email-logs/types'
import { BROADCAST_TEMPLATE_KEY } from '@/lib/email-logs/types'

const TEMPLATE_KEY_LABELS: Record<string, string> = {
  registration_confirmation: 'Registration Confirmation',
  certificate_ready:         'Certificate Ready',
  broadcast:                 'Broadcast',
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '',          label: 'All Statuses' },
  { value: 'sent',      label: 'Sent' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed',    label: 'Failed' },
  { value: 'skipped',   label: 'Skipped' },
  { value: 'queued',    label: 'Queued' },
]

// Broadcast vs transactional. Only the broadcast half is an indexed equality server-side;
// the transactional half is refined on the server within a bounded scan (see the route).
const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: '',              label: 'All messages' },
  { value: 'broadcast',     label: 'Broadcast' },
  { value: 'transactional', label: 'Transactional' },
]

/** The Meta lifecycle is finer than the log status — prefer it when the webhook has run. */
function effectiveStatus(log: WhatsAppLog): string {
  // A timed-out send is NOT a failure: Meta may have delivered it. Say so rather than
  // asserting non-delivery, which is what sends organizers chasing a phantom problem.
  if (log.deliveryUnknown) return 'unknown'
  if (log.status === 'failed') return 'failed'
  return log.waStatus ?? log.status
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued', sent: 'Sent', delivered: 'Delivered',
  read: 'Read', failed: 'Failed', skipped: 'Skipped', unknown: 'Unknown',
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const fmtRupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`

/**
 * Broadcast or transactional? DERIVED from the row, exactly as the API derives it — the
 * broadcast job is the only writer that uses templateKey 'broadcast', and it is also the
 * only one that carries a campaignId. Nothing was added to the log documents for this.
 */
function logType(log: WhatsAppLog): WhatsAppLogType {
  return log.templateKey === BROADCAST_TEMPLATE_KEY ? 'broadcast' : 'transactional'
}

/**
 * What to show in the Template column.
 *
 * A TRANSACTIONAL row names its own template, and the list route resolves the approved
 * Meta name from the registry. A BROADCAST row cannot: the job writes
 * templateKey 'broadcast' for every recipient, and which Meta template the campaign used
 * lives on the campaign document. Resolving that per row would be an N+1 read across the
 * page, so the column reads "Broadcast" and the drawer carries the campaign id instead.
 */
function templateLabel(log: WhatsAppLog): string {
  return TEMPLATE_KEY_LABELS[log.templateKey]
    ?? log.templateName
    ?? log.templateKey
    ?? String.fromCharCode(8212)
}

/**
 * One line the organizer can act on: the reason, then the code that identifies it.
 *
 * This used to return '—' for every status except `failed`, which hid the reason on SKIPPED
 * rows even though `error` was populated on them — the wallet-skip reason was stored, and
 * shown in the details drawer, but never in the table. A row is now silent only when there
 * is genuinely nothing to say (a successful send clears `error`).
 */
function failureSummary(log: WhatsAppLog): string {
  // The classified sentence LEADS. Meta codes and raw provider text are diagnostics, not
  // the headline — they stay in Details, where someone debugging will look for them.
  if (log.failureMessage) return log.failureMessage
  const reason = log.error ?? (log.status === 'failed' ? 'WhatsApp send failed' : null)
  return reason ?? '—'
}

// ─── Details drawer ───────────────────────────────────────────────────────────

function DetailsDrawer({ log, onClose }: { log: WhatsAppLog; onClose: () => void }) {
  const status = effectiveStatus(log)
  const rows: Array<[string, string]> = [
    ['Status',              STATUS_LABELS[status] ?? status],
    ['Message type',        logType(log) === 'broadcast' ? 'Broadcast' : 'Transactional'],
    // Broadcast Campaign → this message → recipient → provider response. The campaign id is
    // written by the broadcast job onto every row it logs, so the trace needs no extra read.
    ['Campaign',            log.campaignId ?? '—'],
    ['Reason',              log.failureMessage ?? log.error ?? '—'],
    // The raw Meta text stays available for debugging — below the human sentence, never
    // instead of it. Credentials never reach here: providerResponse is sanitised at the
    // API boundary before it is ever returned.
    ['Category',            log.failureReason ?? '—'],
    ['Provider detail',     log.error ?? '—'],
    ['Provider error code', log.errorCode !== null ? String(log.errorCode) : '—'],
    ['HTTP status',         log.httpStatus !== null ? String(log.httpStatus) : '—'],
    ['Recipient',           [log.recipientPhone, log.recipientName].filter(Boolean).join(' · ') || '—'],
    ['Template',            log.templateName
                              ? `${log.templateName}${log.templateLanguage ? ` (${log.templateLanguage})` : ''}`
                              : log.templateKey || '—'],
    ['Time',                fmtTime(log.createdAt)],
    ['Wallet charged',      fmtRupees(log.costPaise)],
    ['Retry available',     log.retryAvailable ? 'Yes' : 'No'],
  ]
  if (log.providerMessageId) rows.push(['Meta message ID', log.providerMessageId])

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="WhatsApp delivery details">
      <button type="button" aria-label="Close details" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="relative z-10 flex h-full w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-5">
          <div>
            <h2 className="text-[15px] font-bold text-foreground">
              {log.status === 'failed' ? 'WhatsApp delivery failed' : 'WhatsApp delivery'}
            </h2>
            <p className="mt-0.5 text-[12px] text-muted-foreground">{log.eventName || log.eventSlug}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="size-4" />
          </button>
        </div>

        <dl className="divide-y divide-border">
          {rows.map(([label, value]) => (
            <div key={label} className="flex gap-4 px-5 py-3">
              <dt className="w-40 shrink-0 text-[12px] font-medium text-muted-foreground">{label}</dt>
              <dd className="min-w-0 flex-1 break-words text-[13px] text-foreground">{value}</dd>
            </div>
          ))}
        </dl>

        {log.providerResponse && (
          <div className="border-t border-border p-5">
            <p className="text-[12px] font-medium text-muted-foreground">Provider response</p>
            {/* Sanitised server-side — credentials are redacted before this reaches the browser. */}
            <p className="mt-1.5 break-words rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed text-foreground">
              {log.providerResponse}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function LogRow({ log, onRetry, retrying, onOpen }: {
  log:      WhatsAppLog
  onRetry:  (log: WhatsAppLog) => void
  retrying: boolean
  onOpen:   (log: WhatsAppLog) => void
}) {
  const status = effectiveStatus(log)
  const kind   = logType(log)
  const reason = failureSummary(log)
  const Icon = status === 'failed' ? XCircle
    : status === 'queued' ? Clock
    : CheckCircle2

  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/30">
      <td className="max-w-[240px] px-4 py-3">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold',
          emailLogStatusCls[status] ?? 'bg-muted text-muted-foreground')}>
          <Icon className="size-3" />
          {STATUS_LABELS[status] ?? status}
        </span>
        {log.recipientFault && (
          <div className="mt-1 text-[11px] leading-snug text-muted-foreground">
            Retrying without correcting the number will fail the same way.
          </div>
        )}
        {reason !== String.fromCharCode(8212) && (
          <div className="mt-1 text-[11px] leading-snug text-muted-foreground line-clamp-2">{reason}</div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="text-[13px] text-foreground">{log.recipientName || '—'}</div>
        {log.recipientPhone && <div className="text-[11px] text-muted-foreground">{log.recipientPhone}</div>}
      </td>
      <td className="px-4 py-3 text-[13px] text-foreground">{log.eventName || log.eventSlug || '—'}</td>
      <td className="px-4 py-3">
        <span className={cn('inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold',
          kind === 'broadcast' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
          {kind === 'broadcast' ? 'Broadcast' : 'Transactional'}
        </span>
      </td>
      <td className="max-w-[200px] px-4 py-3">
        <button type="button" onClick={() => onOpen(log)} className="text-left font-mono text-[12px] text-primary hover:underline">
          {templateLabel(log)}
        </button>
        {log.templateLanguage && <div className="text-[11px] text-muted-foreground">{log.templateLanguage}</div>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-[12px] text-muted-foreground">{fmtTime(log.createdAt)}</td>
      <td className="px-4 py-3 text-right">
        {log.retryAvailable ? (
          <button
            type="button"
            onClick={() => onRetry(log)}
            disabled={retrying}
            title="Re-send this WhatsApp message"
            className={cn(
              'inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-semibold',
              retrying ? 'cursor-not-allowed opacity-50' : 'hover:bg-muted',
            )}
          >
            {retrying ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />}
            {retrying ? 'Sending…' : 'Resend'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onOpen(log)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-[12px] font-semibold hover:bg-muted"
          >
            Details
          </button>
        )}
      </td>
    </tr>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function WhatsAppLogsClient() {
  const [logs,       setLogs]       = useState<WhatsAppLog[]>([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState<string | null>(null)
  const [status,     setStatus]     = useState('')
  const [search,     setSearch]     = useState('')
  const [type,       setType]       = useState('')
  const [eventSlug,  setEventSlug]  = useState('')
  const [dateFrom,   setDateFrom]   = useState('')
  const [dateTo,     setDateTo]     = useState('')
  // Cursor paging. `nextCursor` is opaque to this component — it is whatever the server
  // handed back, and it is the ONLY way to ask for more. No offsets, no total count.
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [events,     setEvents]     = useState<{ slug: string; name: string }[]>([])
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryMsg,   setRetryMsg]   = useState<{ id: string; ok: boolean; msg: string } | null>(null)
  const [detail,     setDetail]     = useState<WhatsAppLog | null>(null)
  const { confirm } = useConfirm()

  const load = useCallback(async (cursor?: string) => {
    try {
      // The token fetch is awaited BEFORE any setState so this is never a synchronous
      // state update inside the effect body below (react-hooks/set-state-in-effect).
      const token = await auth.currentUser?.getIdToken()
      setError(null)
      if (!token) { setError('Not authenticated'); setLoading(false); return }

      // EVERY filter is sent to the server. Nothing here narrows a full collection in the
      // browser — the client never receives rows it is not going to show.
      const params = new URLSearchParams()
      if (status)    params.set('status',    status)
      if (type)      params.set('type',      type)
      if (eventSlug) params.set('eventSlug', eventSlug)
      if (dateFrom)  params.set('dateFrom',  dateFrom)
      if (dateTo)    params.set('dateTo',    dateTo)
      if (cursor)    params.set('cursor',    cursor)

      const res  = await fetch(`/api/organizer/whatsapp-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json() as {
        success: boolean; items?: WhatsAppLog[]; nextCursor?: string | null; hasMore?: boolean; error?: string
      }
      if (!data.success) { setError(data.error ?? 'Failed to load'); setLoading(false); setLoadingMore(false); return }
      const page = data.items ?? []
      // Appending on a cursor load is what makes this incremental rather than a re-fetch.
      setLogs(prev => (cursor ? [...prev, ...page] : page))
      setNextCursor(data.hasMore ? (data.nextCursor ?? null) : null)
    } catch {
      setError('Network error')
    }
    setLoading(false)
    setLoadingMore(false)
  }, [status, type, eventSlug, dateFrom, dateTo])

  // The fetch runs inside an async IIFE so no state update happens synchronously during the
  // effect — the same shape the certificate builder uses, and what keeps this off the
  // cascading-render path that react-hooks/set-state-in-effect warns about.
  useEffect(() => {
    let cancelled = false
    ;(async () => { if (!cancelled) await load() })()
    return () => { cancelled = true }
  }, [load])

  // The event dropdown reuses the existing organizer events endpoint. One request, on
  // mount only — it is a label source for the filter, not part of the log query.
  useEffect(() => {
    let cancelled = false
    const run = async () => {
      try {
        const token = await auth.currentUser?.getIdToken()
        if (!token) return
        const res = await fetch('/api/organizer/events', { headers: { Authorization: `Bearer ${token}` } })
        const data = await res.json() as { events?: { slug: string | null; name: string }[] }
        if (cancelled) return
        setEvents((data.events ?? [])
          .filter((e): e is { slug: string; name: string } => typeof e.slug === 'string' && !!e.slug))
      } catch { /* the filter simply stays empty — the log table is unaffected */ }
    }
    void run()
    return () => { cancelled = true }
  }, [])

  async function handleRetry(log: WhatsAppLog) {
    const logId = log.id

    // ═══ INDETERMINATE DELIVERY NEEDS A HUMAN ════════════════════════════════
    // Meta never confirmed the original attempt, so it may already have been delivered.
    // The organizer is told exactly that, in those terms, and nothing is sent unless they
    // accept it. The confirmation runs BEFORE the request, and the endpoint refuses an
    // unconfirmed unknown retry anyway — this dialog is the explanation, not the control.
    if (log.requiresUnknownConfirmation) {
      const ok = await confirm({
        title:        'Delivery status is unknown',
        message:      'Meta did not confirm whether the previous request was accepted. Retrying may cause the attendee to receive this message more than once.',
        confirmLabel: 'Retry anyway',
        cancelLabel:  'Cancel',
        tone:         'danger',
      })
      if (!ok) return
    }

    setRetryingId(logId)
    setRetryMsg(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setRetryingId(null); return }

      const res  = await fetch(`/api/organizer/whatsapp-logs/${logId}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        // Sent ONLY for a row the server itself flagged indeterminate, and only after the
        // organizer confirmed. Never a default, never inferred.
        body: JSON.stringify({ confirmUnknownDelivery: log.requiresUnknownConfirmation === true }),
      })
      const data = await res.json() as { success: boolean; error?: string; code?: number }
      if (data.success) {
        setRetryMsg({ id: logId, ok: true, msg: 'WhatsApp message re-sent successfully.' })
      } else {
        // Surface the Meta code so a repeat failure is diagnosable without opening the row.
        const suffix = data.code ? ` (${data.code})` : ''
        setRetryMsg({ id: logId, ok: false, msg: `${data.error ?? 'Retry failed.'}${suffix}` })
      }
      await load()
    } catch {
      setRetryMsg({ id: logId, ok: false, msg: 'Network error.' })
    }
    setRetryingId(null)
  }

  const q = search.trim().toLowerCase()
  const visible = q
    ? logs.filter(l =>
        l.recipientPhone.toLowerCase().includes(q) ||
        l.recipientName.toLowerCase().includes(q) ||
        l.eventName.toLowerCase().includes(q))
    : logs

  return (
    <div className="space-y-5">
      <PageHeader
        title="WhatsApp Logs"
        subtitle="Attendee WhatsApp delivery history, with the exact reason Meta rejected a failed message."
        breadcrumb={[
          { label: 'Communications', href: '/dashboard/communications' },
          { label: 'WhatsApp Logs' },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search phone, name or event"
            className="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-[13px] outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          aria-label="Filter by delivery status"
          className="h-10 rounded-xl border border-border bg-card px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        >
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={type}
          onChange={e => setType(e.target.value)}
          aria-label="Filter by message type"
          className="h-10 rounded-xl border border-border bg-card px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        >
          {TYPE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <select
          value={eventSlug}
          onChange={e => setEventSlug(e.target.value)}
          aria-label="Filter by event"
          className="h-10 max-w-[220px] rounded-xl border border-border bg-card px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All events</option>
          {events.map(e => <option key={e.slug} value={e.slug}>{e.name}</option>)}
        </select>
        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          aria-label="From date"
          className="h-10 rounded-xl border border-border bg-card px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        />
        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          aria-label="To date"
          className="h-10 rounded-xl border border-border bg-card px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        />
        <button
          type="button"
          onClick={() => { setLoading(true); void load() }}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-border px-3 text-[13px] font-semibold hover:bg-muted"
        >
          <RefreshCw className="size-4" /> Refresh
        </button>
      </div>

      {retryMsg && (
        <div className={cn('flex items-start gap-2 rounded-xl border p-3 text-[13px]',
          retryMsg.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                      : 'border-rose-200 bg-rose-50 text-rose-800')}>
          {retryMsg.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0" /> : <AlertCircle className="mt-0.5 size-4 shrink-0" />}
          <span>{retryMsg.msg}</span>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[13px] text-rose-800">
          <AlertCircle className="mt-0.5 size-4 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : visible.length === 0 ? (
        <EmptyState
          icon={MessageCircle}
          title="No WhatsApp messages yet"
          description="Attendee WhatsApp confirmations appear here once WhatsApp is enabled for an event."
        />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[880px] text-left">
            <thead className="border-b border-border bg-muted/40">
              <tr className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Recipient</th>
                <th className="px-4 py-2.5">Event</th>
                <th className="px-4 py-2.5">Type</th>
                <th className="px-4 py-2.5">Template</th>
                <th className="px-4 py-2.5">Sent At</th>
                <th className="px-4 py-2.5 text-right">Details</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(log => (
                <LogRow
                  key={log.id}
                  log={log}
                  onRetry={handleRetry}
                  retrying={retryingId === log.id}
                  onOpen={setDetail}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Cursor paging. The server decides the page size and hands back the next cursor;
          this button is the only way more rows are ever requested. */}
      {!loading && nextCursor && (
        <div className="flex justify-center">
          <button
            type="button"
            disabled={loadingMore}
            onClick={() => { setLoadingMore(true); void load(nextCursor) }}
            className={cn(
              'inline-flex h-10 items-center gap-2 rounded-xl border border-border px-4 text-[13px] font-semibold',
              loadingMore ? 'cursor-not-allowed opacity-60' : 'hover:bg-muted',
            )}
          >
            {loadingMore ? <><Loader2 className="size-4 animate-spin" /> Loading…</> : 'Load more'}
          </button>
        </div>
      )}

      {detail && <DetailsDrawer log={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

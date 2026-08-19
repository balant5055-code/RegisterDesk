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
import type { WhatsAppLog } from '@/app/api/organizer/whatsapp-logs/route'

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

/** The Meta lifecycle is finer than the log status — prefer it when the webhook has run. */
function effectiveStatus(log: WhatsAppLog): string {
  if (log.status === 'failed') return 'failed'
  return log.waStatus ?? log.status
}

const STATUS_LABELS: Record<string, string> = {
  queued: 'Queued', sent: 'Sent', delivered: 'Delivered',
  read: 'Read', failed: 'Failed', skipped: 'Skipped',
}

function fmtTime(iso: string): string {
  const d = new Date(iso)
  return isNaN(d.getTime()) ? '—' : d.toLocaleString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

const fmtRupees = (paise: number): string => `₹${(paise / 100).toFixed(2)}`

/**
 * One line the organizer can act on: the reason, then the code that identifies it.
 *
 * This used to return '—' for every status except `failed`, which hid the reason on SKIPPED
 * rows even though `error` was populated on them — the wallet-skip reason was stored, and
 * shown in the details drawer, but never in the table. A row is now silent only when there
 * is genuinely nothing to say (a successful send clears `error`).
 */
function failureSummary(log: WhatsAppLog): string {
  const reason = log.error ?? (log.status === 'failed' ? 'WhatsApp send failed' : null)
  if (!reason) return '—'
  return log.errorCode ? `${reason} (${log.errorCode})` : reason
}

// ─── Details drawer ───────────────────────────────────────────────────────────

function DetailsDrawer({ log, onClose }: { log: WhatsAppLog; onClose: () => void }) {
  const status = effectiveStatus(log)
  const rows: Array<[string, string]> = [
    ['Status',              STATUS_LABELS[status] ?? status],
    ['Reason',              log.error ?? '—'],
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
  onRetry:  (id: string) => void
  retrying: boolean
  onOpen:   (log: WhatsAppLog) => void
}) {
  const status = effectiveStatus(log)
  const Icon = status === 'failed' ? XCircle
    : status === 'queued' ? Clock
    : CheckCircle2

  return (
    <tr className="border-b border-border last:border-0 hover:bg-muted/30">
      <td className="px-4 py-3">
        <button type="button" onClick={() => onOpen(log)} className="text-left text-[13px] font-semibold text-primary hover:underline">
          {TEMPLATE_KEY_LABELS[log.templateKey] ?? log.templateKey}
        </button>
      </td>
      <td className="px-4 py-3 text-[13px] text-foreground">{log.eventName || log.eventSlug || '—'}</td>
      <td className="px-4 py-3">
        <div className="text-[13px] text-foreground">{log.recipientPhone || '—'}</div>
        {log.recipientName && <div className="text-[11px] text-muted-foreground">{log.recipientName}</div>}
      </td>
      <td className="px-4 py-3">
        <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold',
          emailLogStatusCls[status] ?? 'bg-muted text-muted-foreground')}>
          <Icon className="size-3" />
          {STATUS_LABELS[status] ?? status}
        </span>
      </td>
      <td className="max-w-[280px] px-4 py-3 text-[12px] text-muted-foreground">
        <span className="line-clamp-2">{failureSummary(log)}</span>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-[12px] text-muted-foreground">{fmtTime(log.createdAt)}</td>
      <td className="px-4 py-3 text-right">
        {log.retryAvailable ? (
          <button
            type="button"
            onClick={() => onRetry(log.id)}
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
          <span className="text-[12px] text-muted-foreground">—</span>
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
  const [retryingId, setRetryingId] = useState<string | null>(null)
  const [retryMsg,   setRetryMsg]   = useState<{ id: string; ok: boolean; msg: string } | null>(null)
  const [detail,     setDetail]     = useState<WhatsAppLog | null>(null)

  const load = useCallback(async () => {
    try {
      // The token fetch is awaited BEFORE any setState so this is never a synchronous
      // state update inside the effect body below (react-hooks/set-state-in-effect).
      const token = await auth.currentUser?.getIdToken()
      setError(null)
      if (!token) { setError('Not authenticated'); setLoading(false); return }

      const params = new URLSearchParams()
      if (status) params.set('status', status)

      const res  = await fetch(`/api/organizer/whatsapp-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json() as { success: boolean; logs?: WhatsAppLog[]; error?: string }
      if (!data.success) { setError(data.error ?? 'Failed to load'); setLoading(false); return }
      setLogs(data.logs ?? [])
    } catch {
      setError('Network error')
    }
    setLoading(false)
  }, [status])

  // The fetch runs inside an async IIFE so no state update happens synchronously during the
  // effect — the same shape the certificate builder uses, and what keeps this off the
  // cascading-render path that react-hooks/set-state-in-effect warns about.
  useEffect(() => {
    let cancelled = false
    ;(async () => { if (!cancelled) await load() })()
    return () => { cancelled = true }
  }, [load])

  async function handleRetry(logId: string) {
    setRetryingId(logId)
    setRetryMsg(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setRetryingId(null); return }

      const res  = await fetch(`/api/organizer/whatsapp-logs/${logId}/retry`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
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
          className="h-10 rounded-xl border border-border bg-card px-3 text-[13px] outline-none focus:ring-2 focus:ring-ring"
        >
          {STATUS_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
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
                <th className="px-4 py-2.5">Message</th>
                <th className="px-4 py-2.5">Event</th>
                <th className="px-4 py-2.5">Recipient</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5">Failure Reason</th>
                <th className="px-4 py-2.5">Sent At</th>
                <th className="px-4 py-2.5 text-right">Action</th>
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

      {detail && <DetailsDrawer log={detail} onClose={() => setDetail(null)} />}
    </div>
  )
}

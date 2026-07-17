'use client'

import { useCallback, useEffect, useState } from 'react'
import { auth } from '@/lib/firebase/auth'
import {
  RefreshCw,
  RotateCcw,
  Search,
  AlertCircle,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Mail,
  ChevronDown,
  ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { EMAIL_LOG_STATUS_LABELS } from '@/lib/email-logs/types'
import type { EmailLog, EmailLogStatus } from '@/lib/email-logs/types'
import { emailLogStatusCls } from '@/lib/ui/statusColors'
import { EmptyState, PageHeader } from '@/components/ui'

// ─── Constants ────────────────────────────────────────────────────────────────

const TEMPLATE_KEY_LABELS: Record<string, string> = {
  registration_submitted:  'Registration Submitted',
  registration_approved:   'Registration Approved',
  registration_rejected:   'Registration Rejected',
  event_reminder:          'Event Reminder',
  certificate_available:   'Certificate Available',
}

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: '',          label: 'All Statuses' },
  { value: 'queued',    label: 'Queued' },
  { value: 'sent',      label: 'Sent' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'failed',    label: 'Failed' },
]

const TEMPLATE_OPTIONS: { value: string; label: string }[] = [
  { value: '',                         label: 'All Types' },
  { value: 'registration_submitted',   label: 'Registration Submitted' },
  { value: 'registration_approved',    label: 'Registration Approved' },
  { value: 'registration_rejected',    label: 'Registration Rejected' },
  { value: 'event_reminder',           label: 'Event Reminder' },
  { value: 'certificate_available',    label: 'Certificate Available' },
]

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: EmailLogStatus }) {
  const ICONS: Record<EmailLogStatus, React.ElementType> = {
    queued:    Clock,
    sent:      CheckCircle2,
    delivered: CheckCircle2,
    failed:    XCircle,
    skipped:   Clock,
  }
  const Icon = ICONS[status] ?? Clock
  const cls  = emailLogStatusCls[status] ?? 'bg-muted text-muted-foreground'
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold', cls)}>
      <Icon className="size-3" />
      {EMAIL_LOG_STATUS_LABELS[status] ?? status}
    </span>
  )
}

// ─── Row ──────────────────────────────────────────────────────────────────────

function LogRow({
  log,
  onRetry,
  retrying,
}: {
  log:      EmailLog
  onRetry:  (id: string) => void
  retrying: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const sentAt = log.createdAt
    ? new Date(log.createdAt).toLocaleString('en-IN', {
        day: '2-digit', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
      })
    : '—'

  return (
    <>
      <tr className="group border-b border-border hover:bg-muted/30 transition-colors">
        {/* Email Type */}
        <td className="py-3 pl-4 pr-3">
          <p className="text-[13.5px] font-medium text-foreground">
            {TEMPLATE_KEY_LABELS[log.templateKey] ?? log.templateKey}
          </p>
        </td>

        {/* Event */}
        <td className="py-3 px-3">
          <p className="max-w-[160px] truncate text-[13px] text-foreground" title={log.eventName}>
            {log.eventName || '—'}
          </p>
          <p className="text-[11.5px] text-muted-foreground">{log.eventSlug}</p>
        </td>

        {/* Recipient */}
        <td className="py-3 px-3">
          <p className="text-[13px] font-medium text-foreground">{log.recipientName}</p>
          <p className="text-[12px] text-muted-foreground">{log.recipientEmail}</p>
        </td>

        {/* Status */}
        <td className="py-3 px-3">
          <StatusBadge status={log.status} />
        </td>

        {/* Sent At */}
        <td className="py-3 px-3">
          <p className="text-[12.5px] tabular-nums text-muted-foreground whitespace-nowrap">{sentAt}</p>
        </td>

        {/* Actions */}
        <td className="py-3 pl-3 pr-4">
          <div className="flex items-center gap-2">
            {log.status === 'failed' && (
              <button
                type="button"
                onClick={() => onRetry(log.id)}
                disabled={retrying}
                title="Retry sending"
                className={cn(
                  'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium transition-colors',
                  retrying
                    ? 'cursor-not-allowed bg-muted text-muted-foreground'
                    : 'bg-primary/[0.08] text-primary hover:bg-primary/[0.14]',
                )}
              >
                {retrying
                  ? <Loader2 className="size-3 animate-spin" />
                  : <RotateCcw className="size-3" />
                }
                Retry
              </button>
            )}
            {log.error && (
              <button
                type="button"
                onClick={() => setExpanded(e => !e)}
                className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
                title={expanded ? 'Hide error' : 'Show error'}
              >
                {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
              </button>
            )}
          </div>
        </td>
      </tr>

      {/* Error detail row */}
      {expanded && log.error && (
        <tr className="border-b border-border bg-rose-50/50">
          <td colSpan={6} className="py-2 pl-4 pr-4">
            <p className="font-mono text-[12px] text-rose-700">{log.error}</p>
          </td>
        </tr>
      )}
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export function EmailLogsClient() {
  const [logs,        setLogs]        = useState<EmailLog[]>([])
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState<string | null>(null)
  const [retryingId,  setRetryingId]  = useState<string | null>(null)
  const [retryMsg,    setRetryMsg]    = useState<{ id: string; ok: boolean; msg: string } | null>(null)

  // Filters
  const [search,      setSearch]      = useState('')
  const [status,      setStatus]      = useState('')
  const [templateKey, setTemplateKey] = useState('')
  const [dateFrom,    setDateFrom]    = useState('')
  const [dateTo,      setDateTo]      = useState('')

  // ── Fetch ───────────────────────────────────────────────────────────────────
  const fetchLogs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) { setError('Not authenticated'); setLoading(false); return }

      const params = new URLSearchParams({ limit: '200' })
      if (status)      params.set('status',      status)
      if (templateKey) params.set('templateKey', templateKey)
      if (dateFrom)    params.set('dateFrom',    dateFrom)
      if (dateTo)      params.set('dateTo',      dateTo)

      const res  = await fetch(`/api/organizer/email-logs?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json() as { success: boolean; logs?: EmailLog[]; error?: string }
      if (!data.success) { setError(data.error ?? 'Failed to load'); setLoading(false); return }
      setLogs(data.logs ?? [])
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [status, templateKey, dateFrom, dateTo])

  useEffect(() => { void fetchLogs() }, [fetchLogs])

  // ── Retry ───────────────────────────────────────────────────────────────────
  async function handleRetry(logId: string) {
    setRetryingId(logId)
    setRetryMsg(null)
    try {
      const token = await auth.currentUser?.getIdToken()
      if (!token) return
      const res  = await fetch(`/api/organizer/email-logs/${logId}/retry`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const data = await res.json() as { success: boolean; error?: string }
      if (data.success) {
        setRetryMsg({ id: logId, ok: true, msg: 'Email re-sent successfully.' })
        // Update local state optimistically
        setLogs(prev => prev.map(l =>
          l.id === logId ? { ...l, status: 'sent' as EmailLogStatus } : l,
        ))
      } else {
        setRetryMsg({ id: logId, ok: false, msg: data.error ?? 'Retry failed.' })
      }
    } catch {
      setRetryMsg({ id: logId, ok: false, msg: 'Network error.' })
    } finally {
      setRetryingId(null)
    }
  }

  // ── Client-side search filter ───────────────────────────────────────────────
  const q = search.trim().toLowerCase()
  const filtered = q
    ? logs.filter(l =>
        l.recipientEmail.toLowerCase().includes(q) ||
        l.recipientName.toLowerCase().includes(q),
      )
    : logs

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <PageHeader
        title="Email Logs"
        subtitle="Delivery history for all transactional emails."
        breadcrumb={[
          { label: 'Communications', href: '/dashboard/communications' },
          { label: 'Email Logs' },
        ]}
        action={
          <button
            type="button"
            onClick={() => void fetchLogs()}
            className="flex items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2 text-[13.5px] font-medium text-muted-foreground transition-colors hover:bg-muted"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </button>
        }
      />

      {/* ── Filters ── */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {/* Search */}
        <div className="relative sm:col-span-2 lg:col-span-1">
          <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="text"
            placeholder="Search name or email…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full rounded-xl border border-border bg-background py-2 pl-8 pr-3.5 text-[13.5px] text-foreground placeholder:text-muted-foreground/50 focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
          />
        </div>

        {/* Status */}
        <select
          value={status}
          onChange={e => setStatus(e.target.value)}
          className="rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Template Type */}
        <select
          value={templateKey}
          onChange={e => setTemplateKey(e.target.value)}
          className="rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
        >
          {TEMPLATE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>

        {/* Date From */}
        <input
          type="date"
          value={dateFrom}
          onChange={e => setDateFrom(e.target.value)}
          className="rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />

        {/* Date To */}
        <input
          type="date"
          value={dateTo}
          onChange={e => setDateTo(e.target.value)}
          className="rounded-xl border border-border bg-background px-3 py-2 text-[13.5px] text-foreground focus:border-primary/50 focus:outline-none focus:ring-2 focus:ring-primary/20"
        />
      </div>

      {/* ── Retry feedback banner ── */}
      {retryMsg && (
        <div className={cn(
          'flex items-center gap-3 rounded-xl border px-4 py-3',
          retryMsg.ok
            ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
            : 'border-rose-200 bg-rose-50 text-rose-800',
        )}>
          {retryMsg.ok
            ? <CheckCircle2 className="size-4 shrink-0 text-emerald-600" />
            : <AlertCircle  className="size-4 shrink-0 text-rose-600" />
          }
          <p className="text-[13.5px] font-medium">{retryMsg.msg}</p>
          <button
            type="button"
            onClick={() => setRetryMsg(null)}
            className="ml-auto text-[12px] underline opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── Table ── */}
      <div className="rounded-2xl border border-border bg-card">

        {loading && (
          <div className="flex items-center justify-center gap-3 py-16">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
            <p className="text-[14px] text-muted-foreground">Loading email logs…</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="size-8 text-destructive/60" />
            <p className="text-[14px] text-destructive">{error}</p>
            <button
              type="button"
              onClick={() => void fetchLogs()}
              className="rounded-xl border border-border bg-card px-4 py-2 text-[13.5px] font-medium hover:bg-muted"
            >
              Try again
            </button>
          </div>
        )}

        {!loading && !error && filtered.length === 0 && (
          <EmptyState
            icon={Mail}
            title="No email logs found"
            description={logs.length > 0
              ? 'No results match your filters.'
              : 'Email logs will appear here once emails are sent.'
            }
            className="py-16"
          />
        )}

        {!loading && !error && filtered.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[700px]">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  {['Email Type', 'Event', 'Recipient', 'Status', 'Sent At', ''].map(h => (
                    <th
                      key={h}
                      className="py-3 pl-4 pr-3 text-left text-[12px] font-semibold uppercase tracking-[0.07em] text-muted-foreground first:pl-4 last:pr-4"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map(log => (
                  <LogRow
                    key={log.id}
                    log={log}
                    onRetry={id => void handleRetry(id)}
                    retrying={retryingId === log.id}
                  />
                ))}
              </tbody>
            </table>

            {/* Footer with count */}
            <div className="border-t border-border px-4 py-3">
              <p className="text-[12.5px] text-muted-foreground">
                Showing {filtered.length} of {logs.length} log{logs.length !== 1 ? 's' : ''}
                {logs.length >= 200 && ' (limit 200 — apply filters to narrow results)'}
              </p>
            </div>
          </div>
        )}
      </div>

    </div>
  )
}

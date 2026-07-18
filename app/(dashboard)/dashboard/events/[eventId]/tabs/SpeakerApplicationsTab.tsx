'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Loader2, AlertCircle, RefreshCw, Download, Mic,
  CheckCircle, XCircle, Clock, ChevronDown, ChevronUp,
} from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { TextLink } from '@/components/ui'
import type {
  SpeakerApplicationsApiResponse,
  SpeakerApplicationSummary,
  ApplicationStatus,
} from '@/lib/applications/types'

interface Props { eventId: string; token: string }

type StatusFilter = 'all' | ApplicationStatus

const STATUS_BADGE: Record<ApplicationStatus, string> = {
  pending:  'bg-amber-100 text-amber-700',
  approved: 'bg-green-100 text-green-700',
  rejected: 'bg-red-100 text-red-600',
}

function KpiCard({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div className={cn(
      'flex flex-col gap-1.5 rounded-xl border border-border p-4',
      accent ? 'bg-primary/5' : 'bg-card',
    )}>
      <span className="text-[12px] font-medium text-muted-foreground">{label}</span>
      <span className="text-[24px] font-bold tabular-nums text-foreground">{value.toLocaleString('en-IN')}</span>
    </div>
  )
}

function ApplicationRow({
  app, eventId, token, onUpdated,
}: {
  app:       SpeakerApplicationSummary
  eventId:   string
  token:     string
  onUpdated: () => void
}) {
  const [expanded,  setExpanded]  = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [note,      setNote]      = useState('')
  const [error,     setError]     = useState<string | null>(null)

  async function updateStatus(status: 'approved' | 'rejected') {
    setReviewing(true)
    setError(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/speaker-applications`, {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ appId: app.id, status, note: note || undefined }),
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`)
      onUpdated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to update')
    } finally {
      setReviewing(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* Header row */}
      <div className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[14px] font-semibold text-foreground">{app.name}</p>
            <span className={cn('rounded-full px-2 py-0.5 text-[11px] font-medium capitalize', STATUS_BADGE[app.status])}>
              {app.status}
            </span>
          </div>
          {(app.jobTitle || app.company) && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">
              {[app.jobTitle, app.company].filter(Boolean).join(' · ')}
            </p>
          )}
          <p className="mt-1 text-[13px] font-medium text-foreground">{app.talkTitle}</p>
          {app.talkDuration && (
            <p className="mt-0.5 text-[12px] text-muted-foreground">Duration: {app.talkDuration} min</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {app.submittedAt && (
            <span className="text-[11px] text-muted-foreground">
              {new Date(app.submittedAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}
            </span>
          )}
          <button
            onClick={() => setExpanded(v => !v)}
            className="rounded-lg border border-border bg-background px-2 py-1.5 text-muted-foreground hover:text-foreground"
            aria-label="Toggle details"
          >
            {expanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
          </button>
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-border px-4 pb-4 pt-3 space-y-3">
          <div className="grid gap-3 text-[13px] sm:grid-cols-2">
            <div>
              <p className="font-medium text-muted-foreground">Email</p>
              <a href={`mailto:${app.email}`} className="text-primary hover:underline">{app.email}</a>
            </div>
            {app.phone && (
              <div>
                <p className="font-medium text-muted-foreground">Phone</p>
                <p className="text-foreground">{app.phone}</p>
              </div>
            )}
            {app.portfolioUrl && (
              <div className="sm:col-span-2">
                <p className="font-medium text-muted-foreground">Portfolio / LinkedIn</p>
                <a href={app.portfolioUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline break-all">
                  {app.portfolioUrl}
                </a>
              </div>
            )}
          </div>

          {app.talkAbstract && (
            <div>
              <p className="mb-1 text-[13px] font-medium text-muted-foreground">Talk Abstract</p>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-foreground">{app.talkAbstract}</p>
            </div>
          )}

          {app.bio && (
            <div>
              <p className="mb-1 text-[13px] font-medium text-muted-foreground">Bio</p>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-foreground">{app.bio}</p>
            </div>
          )}

          {app.previousSpeaking && (
            <div>
              <p className="mb-1 text-[13px] font-medium text-muted-foreground">Previous Speaking</p>
              <p className="whitespace-pre-line text-[13px] leading-relaxed text-foreground">{app.previousSpeaking}</p>
            </div>
          )}

          {/* Review actions (only for pending) */}
          {app.status === 'pending' && (
            <div className="border-t border-border pt-3 space-y-2">
              <textarea
                value={note}
                onChange={e => setNote(e.target.value)}
                placeholder="Optional note to include in the email to the applicant…"
                rows={2}
                className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => void updateStatus('approved')}
                  disabled={reviewing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {reviewing ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle className="size-3.5" />}
                  Approve
                </button>
                <button
                  onClick={() => void updateStatus('rejected')}
                  disabled={reviewing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-[13px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  {reviewing ? <Loader2 className="size-3.5 animate-spin" /> : <XCircle className="size-3.5" />}
                  Reject
                </button>
              </div>
              {error && <p className="text-[12px] text-destructive">{error}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SpeakerApplicationsTab({ eventId, token }: Props) {
  const [data,    setData]    = useState<SpeakerApplicationsApiResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState<string | null>(null)
  const [filter,  setFilter]  = useState<StatusFilter>('all')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/organizer/events/${eventId}/speaker-applications`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error((await res.json() as { error?: string }).error ?? `HTTP ${res.status}`)
      setData(await res.json() as SpeakerApplicationsApiResponse)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [eventId, token])

  useEffect(() => { void load() }, [load])

  function downloadCSV() {
    const a = document.createElement('a')
    a.href = `/api/organizer/events/${eventId}/speaker-applications/export?token=${encodeURIComponent(token)}`
    a.setAttribute('download', '')
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <AlertCircle className="size-6 text-destructive" />
        <p className="text-[14px] text-muted-foreground">{error}</p>
        <TextLink onClick={load}>Retry</TextLink>
      </div>
    )
  }

  const all     = data?.applications ?? []
  const visible = filter === 'all' ? all : all.filter(a => a.status === filter)

  return (
    <div className="space-y-5">
      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total"    value={data?.total    ?? 0} accent />
        <KpiCard label="Pending"  value={data?.pending  ?? 0} />
        <KpiCard label="Approved" value={data?.approved ?? 0} />
        <KpiCard label="Rejected" value={data?.rejected ?? 0} />
      </div>

      {/* Actions bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {(['all', 'pending', 'approved', 'rejected'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-lg px-3 py-1.5 text-[13px] font-medium capitalize transition-colors',
                filter === f
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-background text-muted-foreground hover:text-foreground',
              )}
            >
              {f === 'all' ? `All (${data?.total ?? 0})` : `${f.charAt(0).toUpperCase()}${f.slice(1)} (${data?.[f] ?? 0})`}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => void load()}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw className={cn('size-3.5', loading && 'animate-spin')} />
            Refresh
          </button>
          <button
            onClick={downloadCSV}
            className="flex items-center gap-1.5 rounded-lg border border-border bg-background px-3 py-1.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <Download className="size-3.5" />
            Export CSV
          </button>
        </div>
      </div>

      {/* List */}
      {visible.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-border py-16 text-center">
          <Mic className="mx-auto mb-2 size-8 text-muted-foreground/30" />
          <p className="text-[14px] font-semibold text-foreground">
            {all.length === 0 ? 'No speaker applications yet' : `No ${filter} applications`}
          </p>
          {all.length === 0 && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">
              Enable speaker applications in event settings — submissions will appear here.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {visible.map(app => (
            <ApplicationRow key={app.id} app={app} eventId={eventId} token={token} onUpdated={() => void load()} />
          ))}
        </div>
      )}

      {/* Status legend */}
      <div className="flex flex-wrap gap-4 border-t border-border pt-4 text-[12px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><Clock className="size-3.5 text-amber-500" />Pending — awaiting review</span>
        <span className="flex items-center gap-1.5"><CheckCircle className="size-3.5 text-green-600" />Approved — email sent</span>
        <span className="flex items-center gap-1.5"><XCircle className="size-3.5 text-red-500" />Rejected — email sent</span>
      </div>
    </div>
  )
}

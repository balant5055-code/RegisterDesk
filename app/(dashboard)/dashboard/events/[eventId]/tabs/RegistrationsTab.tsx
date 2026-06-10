'use client'

import { useState, useMemo } from 'react'
import { cn }                 from '@/lib/utils/cn'
import {
  Search, Download, X, Users, CheckCircle, Clock, XCircle,
  Eye, Ticket, Mail, Phone, Calendar, Tag, Send, Loader2,
} from 'lucide-react'
import type {
  SerializedRegistration,
  RegistrationsApiResponse,
} from '@/app/api/organizer/events/[eventId]/registrations/route'
import type { ResendEmailResponse } from '@/app/api/organizer/registrations/[registrationId]/resend-email/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}

function statusMeta(status: string): { label: string; cls: string } {
  const map: Record<string, { label: string; cls: string }> = {
    confirmed:  { label: 'Confirmed',  cls: 'bg-emerald-100 text-emerald-700' },
    pending:    { label: 'Pending',    cls: 'bg-amber-100   text-amber-700'   },
    cancelled:  { label: 'Cancelled',  cls: 'bg-red-100     text-red-600'     },
    waitlisted: { label: 'Waitlisted', cls: 'bg-sky-100     text-sky-700'     },
  }
  return map[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' }
}

function csvEscape(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`
}

function exportToCsv(rows: SerializedRegistration[], slug: string) {
  const headers = ['Ticket Code', 'Name', 'Email', 'Phone', 'Pass', 'Status', 'Amount', 'Registered At']
  const body = rows.map(r => [
    r.ticketCode,
    r.attendee.name,
    r.attendee.email,
    r.attendee.phone ?? '',
    r.passName,
    r.status,
    r.amount ?? 0,
    r.registeredAt ?? '',
  ].map(csvEscape).join(','))
  const csv  = [headers.join(','), ...body].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href     = url
  a.download = `registrations-${slug}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ─── Detail Drawer ────────────────────────────────────────────────────────────

function RegistrationDrawer({
  reg,
  fieldLabels,
  token,
  onClose,
}: {
  reg:         SerializedRegistration
  fieldLabels: Record<string, string>
  token:       string
  onClose:     () => void
}) {
  const { label: statusLabel, cls: statusCls } = statusMeta(reg.status)
  const fields = (reg.attendee.formResponses as Record<string, unknown> | null) ?? {}

  const [emailSending, setEmailSending] = useState(false)
  const [emailFeedback, setEmailFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  async function handleResendEmail() {
    if (emailSending) return
    setEmailSending(true)
    setEmailFeedback(null)
    try {
      const res  = await fetch(`/api/organizer/registrations/${reg.id}/resend-email`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await res.json() as ResendEmailResponse
      setEmailFeedback(
        body.success
          ? { ok: true,  msg: 'Email sent successfully.' }
          : { ok: false, msg: body.error ?? 'Failed to send email.' },
      )
    } catch {
      setEmailFeedback({ ok: false, msg: 'Network error. Please try again.' })
    } finally {
      setEmailSending(false)
    }
  }

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
        onClick={onClose}
      />
      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col overflow-y-auto border-l border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border p-4">
          <div>
            <p className="text-[15px] font-semibold text-foreground">{reg.attendee.name}</p>
            <span className={cn('mt-1 inline-flex rounded-full px-2 py-0.5 text-[13px] font-semibold', statusCls)}>
              {statusLabel}
            </span>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-muted/60">
            <X className="size-4 text-muted-foreground" />
          </button>
        </div>

        {/* Details */}
        <div className="flex-1 space-y-4 p-4">
          {[
            { icon: Ticket,   label: 'Ticket Code', value: reg.ticketCode },
            { icon: Tag,      label: 'Pass',        value: reg.passName },
            { icon: Mail,     label: 'Email',       value: reg.attendee.email },
            { icon: Phone,    label: 'Phone',       value: reg.attendee.phone ?? null },
            { icon: Calendar, label: 'Registered',  value: fmtDate(reg.registeredAt) },
          ].map(({ icon: Icon, label, value }) => value && (
            <div key={label} className="flex items-start gap-3">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Icon className="size-3.5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-[13px] text-muted-foreground">{label}</p>
                <p className="break-all text-[14px] font-medium text-foreground">{value}</p>
              </div>
            </div>
          ))}

          {/* Form responses */}
          {Object.keys(fields).length > 0 && (
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <p className="mb-2 text-[13px] font-semibold text-muted-foreground">Form Responses</p>
              <div className="space-y-2">
                {Object.entries(fields).map(([k, v]) => (
                  <div key={k}>
                    <p className="text-[13px] text-muted-foreground">{fieldLabels[k] ?? k}</p>
                    <p className="text-[14px] text-foreground">{String(v)}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Email status + resend */}
          {reg.status !== 'cancelled' && token && (
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-[13px] font-semibold text-muted-foreground">Email</p>
                {reg.emailStatus && (
                  <span className={cn(
                    'rounded-full px-2 py-0.5 text-[12px] font-semibold',
                    reg.emailStatus === 'sent'
                      ? 'bg-emerald-100 text-emerald-700'
                      : reg.emailStatus === 'failed'
                        ? 'bg-red-100 text-red-600'
                        : 'bg-amber-100 text-amber-700',
                  )}>
                    {reg.emailStatus === 'sent' ? 'Sent' : reg.emailStatus === 'failed' ? 'Failed' : 'Pending'}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={handleResendEmail}
                disabled={emailSending}
                className="flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-card py-2 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/60 disabled:opacity-50"
              >
                {emailSending
                  ? <Loader2 className="size-3.5 animate-spin" />
                  : <Send className="size-3.5" />}
                {emailSending ? 'Sending…' : 'Resend Ticket Email'}
              </button>
              {emailFeedback && (
                <p className={cn(
                  'mt-1.5 text-center text-[13px]',
                  emailFeedback.ok ? 'text-emerald-600' : 'text-red-600',
                )}>
                  {emailFeedback.msg}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}

// ─── Stats Chip ───────────────────────────────────────────────────────────────

function StatChip({
  icon: Icon, label, value, colorCls,
}: {
  icon: React.ElementType; label: string; value: number; colorCls?: string
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 shadow-sm">
      <Icon className={cn('size-3.5 shrink-0', colorCls ?? 'text-muted-foreground')} />
      <span className="text-[13px] text-muted-foreground">{label}</span>
      <span className="text-[14px] font-bold tabular-nums text-foreground">{value}</span>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface RegistrationsTabProps {
  data:  RegistrationsApiResponse
  slug:  string
  token: string
}

export default function RegistrationsTab({ data, slug, token }: RegistrationsTabProps) {
  const { registrations, passes, fieldLabels, stats } = data

  const [query,        setQuery]        = useState('')
  const [passFilter,   setPassFilter]   = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [selected,     setSelected]     = useState<SerializedRegistration | null>(null)

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return registrations.filter(r => {
      if (passFilter   !== 'all' && r.passId !== passFilter)   return false
      if (statusFilter !== 'all' && r.status !== statusFilter) return false
      if (!q) return true
      return (
        r.attendee.name.toLowerCase().includes(q)  ||
        r.attendee.email.toLowerCase().includes(q) ||
        r.ticketCode.toLowerCase().includes(q)     ||
        (r.attendee.phone ?? '').includes(q)
      )
    })
  }, [registrations, query, passFilter, statusFilter])

  if (registrations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-dashed border-border py-20 text-center">
        <div className="flex size-14 items-center justify-center rounded-full bg-muted">
          <Users className="size-6 text-muted-foreground/60" />
        </div>
        <div>
          <p className="text-[15px] font-semibold text-foreground">No registrations yet</p>
          <p className="mt-1 text-[13px] text-muted-foreground">
            Share your event page to start collecting registrations.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="flex flex-wrap gap-2">
        <StatChip icon={Users}       label="Total"     value={stats.total}     />
        <StatChip icon={CheckCircle} label="Confirmed" value={stats.confirmed} colorCls="text-emerald-600" />
        <StatChip icon={Clock}       label="Pending"   value={stats.pending}   colorCls="text-amber-600" />
        <StatChip icon={XCircle}     label="Cancelled" value={stats.cancelled} colorCls="text-red-500" />
      </div>

      {/* Search + filters + export */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
          {/* Search */}
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              placeholder="Search name, email, ticket code…"
              value={query}
              onChange={e => setQuery(e.target.value)}
              className="w-full rounded-xl border border-border bg-card py-2 pl-9 pr-3 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
          </div>

          {/* Pass filter */}
          {passes.length > 1 && (
            <select
              value={passFilter}
              onChange={e => setPassFilter(e.target.value)}
              className="rounded-xl border border-border bg-card px-3 py-2 text-[14px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="all">All passes</option>
              {passes.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          )}

          {/* Status filter */}
          <select
            value={statusFilter}
            onChange={e => setStatusFilter(e.target.value)}
            className="rounded-xl border border-border bg-card px-3 py-2 text-[12.5px] text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30"
          >
            <option value="all">All statuses</option>
            <option value="confirmed">Confirmed</option>
            <option value="pending">Pending</option>
            <option value="cancelled">Cancelled</option>
            <option value="waitlisted">Waitlisted</option>
          </select>
        </div>

        <button
          type="button"
          onClick={() => exportToCsv(filtered, slug)}
          className="flex items-center gap-2 rounded-xl border border-border bg-card px-3 py-2 text-[14px] font-medium text-foreground transition-colors hover:bg-muted/60"
        >
          <Download className="size-3.5" />
          Export CSV
        </button>
      </div>

      {/* Count */}
      {filtered.length !== registrations.length && (
        <p className="text-[13px] text-muted-foreground">
          Showing {filtered.length} of {registrations.length} registrations
        </p>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[640px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Name', 'Pass', 'Status', 'Registered', ''].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map(r => {
              const { label, cls } = statusMeta(r.status)
              return (
                <tr key={r.id} className="group hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <p className="text-[14px] font-medium text-foreground">{r.attendee.name}</p>
                    <p className="text-[13px] text-muted-foreground">{r.attendee.email}</p>
                  </td>
                  <td className="px-4 py-3 text-[14px] text-foreground">{r.passName}</td>
                  <td className="px-4 py-3">
                    <span className={cn('rounded-full px-2 py-0.5 text-[13px] font-semibold', cls)}>
                      {label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[13px] text-muted-foreground tabular-nums">
                    {fmtDate(r.registeredAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      type="button"
                      onClick={() => setSelected(r)}
                      className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
                      aria-label={`View ${r.attendee.name}`}
                    >
                      <Eye className="size-3.5" />
                    </button>
                  </td>
                </tr>
              )
            })
          }
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="py-12 text-center text-[13px] text-muted-foreground">
            No registrations match your filters.
          </div>
        )}
      </div>

      {/* Detail drawer */}
      {selected && (
        <RegistrationDrawer
          reg={selected}
          fieldLabels={fieldLabels}
          token={token}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

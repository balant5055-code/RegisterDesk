'use client'

import Link from 'next/link'
import { cn } from '@/lib/utils/cn'
import { Users, CheckCircle, Clock, XCircle, AlertTriangle, ArrowRight } from 'lucide-react'
import type { RegistrationsApiResponse } from '@/app/api/organizer/events/[eventId]/registrations/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

function statusMeta(status: string): { label: string; cls: string } {
  const map: Record<string, { label: string; cls: string }> = {
    confirmed:  { label: 'Confirmed',  cls: 'bg-emerald-100 text-emerald-700' },
    pending:    { label: 'Pending',    cls: 'bg-amber-100   text-amber-700'   },
    cancelled:  { label: 'Cancelled',  cls: 'bg-red-100     text-red-600'     },
    waitlisted: { label: 'Waitlisted', cls: 'bg-sky-100     text-sky-700'     },
    rejected:   { label: 'Rejected',   cls: 'bg-red-100     text-red-700'     },
  }
  return map[status] ?? { label: status, cls: 'bg-muted text-muted-foreground' }
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
  data:    RegistrationsApiResponse
  eventId: string
}

export default function RegistrationsTab({ data, eventId }: RegistrationsTabProps) {
  const { registrations, stats } = data
  const latest5    = registrations.slice(0, 5)
  const managerUrl = `/dashboard/events/${eventId}/registrations`

  if (registrations.length === 0) {
    return (
      <div className="space-y-4">
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
        <div className="flex justify-center">
          <Link
            href={managerUrl}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Open Registration Manager
            <ArrowRight className="size-4" />
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Stats */}
      <div className="flex flex-wrap gap-2">
        <StatChip icon={Users}       label="Total"     value={stats.total}     />
        <StatChip icon={CheckCircle} label="Confirmed" value={stats.confirmed} colorCls="text-emerald-600" />
        <StatChip icon={Clock}       label="Pending"   value={stats.pending}   colorCls="text-amber-600" />
        <StatChip icon={XCircle}     label="Cancelled" value={stats.cancelled} colorCls="text-red-500" />
      </div>

      {/* Pending approval card */}
      {stats.pending > 0 && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <div className="flex gap-4">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-amber-100">
              <AlertTriangle className="size-5 text-amber-600" />
            </div>
            <div className="flex-1 space-y-3">
              <div>
                <p className="text-[15px] font-bold text-amber-900">Pending Approvals</p>
                <p className="mt-1 text-[13.5px] leading-relaxed text-amber-700">
                  {stats.pending} attendee{stats.pending === 1 ? '' : 's'}{' '}
                  {stats.pending === 1 ? 'is' : 'are'} waiting for organizer approval before
                  receiving confirmation.
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`${managerUrl}?status=pending`}
                  className="flex items-center gap-2 rounded-xl bg-amber-600 px-4 py-2 text-[13.5px] font-semibold text-white transition-opacity hover:opacity-90"
                >
                  Review Pending Registrations
                  <ArrowRight className="size-3.5" />
                </Link>
                <Link
                  href={managerUrl}
                  className="flex items-center gap-2 rounded-xl border border-amber-300 bg-white px-4 py-2 text-[13.5px] font-semibold text-amber-800 transition-colors hover:bg-amber-100"
                >
                  Open Registration Manager
                  <ArrowRight className="size-3.5" />
                </Link>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Latest 5 registrations — read-only */}
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[480px]">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              {['Name', 'Status', 'Registered'].map(h => (
                <th key={h} className="px-4 py-2.5 text-left text-[12px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {latest5.map(r => {
              const { label, cls } = statusMeta(r.status)
              return (
                <tr key={r.id} className="hover:bg-muted/20">
                  <td className="px-4 py-3">
                    <p className="text-[14px] font-medium text-foreground">{r.attendee.name}</p>
                    <p className="text-[13px] text-muted-foreground">{r.attendee.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={cn('rounded-full px-2 py-0.5 text-[13px] font-semibold', cls)}>
                      {label}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[13px] text-muted-foreground tabular-nums">
                    {fmtDate(r.registeredAt)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {stats.total > 5 && (
          <div className="border-t border-border px-4 py-2.5 text-center text-[13px] text-muted-foreground">
            Showing 5 of {stats.total} registrations
          </div>
        )}
      </div>

      {/* Primary CTA — card above handles both actions when pending > 0 */}
      {stats.pending === 0 && (
        <div className="flex">
          <Link
            href={managerUrl}
            className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-primary-foreground transition-opacity hover:opacity-90"
          >
            Open Registration Manager
            <ArrowRight className="size-4" />
          </Link>
        </div>
      )}
    </div>
  )
}

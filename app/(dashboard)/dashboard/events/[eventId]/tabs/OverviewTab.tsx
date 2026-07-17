'use client'

import { useMemo } from 'react'
import { cn }      from '@/lib/utils/cn'
import {
  Users, TrendingUp, BarChart3, CalendarDays,
  MapPin, Video, Globe, Clock, Activity,
  LockOpen, Lock, UserCheck, Heart,
} from 'lucide-react'
import Link from 'next/link'
import type { EventDetailResponse }    from '@/app/api/organizer/events/[eventId]/route'
import type { SerializedRegistration } from '@/app/api/organizer/events/[eventId]/registrations/route'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtINR(paise: number): string {
  if (paise === 0) return '₹0'
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(paise / 100)
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'TBD'
  return new Date(iso).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtDateTime(date: string | null, time: string | null, tz: string | null): string {
  const d = date ? fmtDate(date) : 'TBD'
  const t = time ?? ''
  const z = tz   ? ` (${tz})` : ''
  return `${d}${t ? `, ${t}` : ''}${z}`
}

// ─── Metric Card ──────────────────────────────────────────────────────────────

function Metric({
  icon: Icon, label, value, sub, accent,
}: {
  icon:   React.ElementType
  label:  string
  value:  string
  sub?:   string
  accent?: boolean
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[13px] text-muted-foreground">{label}</span>
        <div className={cn(
          'flex size-7 items-center justify-center rounded-lg',
          accent ? 'bg-primary/10' : 'bg-muted',
        )}>
          <Icon className={cn('size-3.5', accent ? 'text-primary' : 'text-muted-foreground')} />
        </div>
      </div>
      <p className="text-[22px] font-bold tabular-nums text-foreground">{value}</p>
      {sub && <p className="text-[13px] text-muted-foreground">{sub}</p>}
    </div>
  )
}

// ─── Trend Chart ──────────────────────────────────────────────────────────────

function TrendChart({ registrations }: { registrations: SerializedRegistration[] }) {
  const bars = useMemo(() => {
    const days: { label: string; date: string; count: number }[] = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      days.push({
        label: d.toLocaleDateString('en-IN', { weekday: 'short' }),
        date:  d.toISOString().slice(0, 10),
        count: 0,
      })
    }
    registrations.forEach(r => {
      const day = r.registeredAt?.slice(0, 10)
      const slot = days.find(d => d.date === day)
      if (slot) slot.count++
    })
    return days
  }, [registrations])

  const maxCount = Math.max(...bars.map(b => b.count), 1)

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="mb-4 flex items-center gap-2">
        <BarChart3 className="size-4 text-muted-foreground" />
        <span className="text-[14px] font-semibold text-foreground">Registration Trend (Last 7 Days)</span>
      </div>
      <div className="flex h-28 items-end gap-2">
        {bars.map(b => (
          <div key={b.date} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[12px] font-semibold text-muted-foreground tabular-nums">
              {b.count > 0 ? b.count : ''}
            </span>
            <div className="w-full rounded-t-sm bg-muted" style={{ height: '80px' }}>
              <div
                className={cn(
                  'w-full rounded-t-sm transition-all',
                  b.count > 0 ? 'bg-primary' : 'bg-transparent',
                )}
                style={{ height: `${(b.count / maxCount) * 80}px` }}
              />
            </div>
            <span className="text-[12px] text-muted-foreground">{b.label}</span>
          </div>
        ))}
      </div>
      {maxCount === 1 && registrations.length === 0 && (
        <p className="mt-3 text-center text-[13px] text-muted-foreground">No registrations yet</p>
      )}
    </div>
  )
}

// ─── Detail Row ───────────────────────────────────────────────────────────────

function DetailRow({
  icon: Icon, label, value,
}: {
  icon: React.ElementType; label: string; value: string | null
}) {
  if (!value) return null
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-muted">
        <Icon className="size-3.5 text-muted-foreground" />
      </div>
      <div>
        <p className="text-[13px] text-muted-foreground">{label}</p>
        <p className="text-[14px] font-medium text-foreground">{value}</p>
      </div>
    </div>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

interface OverviewTabProps {
  event:         EventDetailResponse
  registrations: SerializedRegistration[]
}

export default function OverviewTab({ event, registrations }: OverviewTabProps) {
  const capacityPct = event.totalCapacity
    ? Math.min(Math.round((event.totalRegistrations / event.totalCapacity) * 100), 100)
    : null

  const venueLine = event.venueType === 'online'
    ? event.onlinePlatform ?? 'Online'
    : event.venueType === 'hybrid'
      ? `${event.venueName ?? ''}${event.venueCity ? `, ${event.venueCity}` : ''} (Hybrid)`
      : event.venueName
        ? `${event.venueName}${event.venueCity ? `, ${event.venueCity}` : ''}`
        : null

  const VenueIcon = event.venueType === 'online' ? Video
                  : event.venueType === 'hybrid' ? Globe
                  : MapPin

  const ls = event.lifecycleStatus

  // Registration state labels
  const regStateLabel  =
    ls === 'published'            ? 'Open'
    : ls === 'registration_closed' ? 'Closed by Organizer'
    : ls === 'completed'           ? 'Closed (Completed)'
    : ls === 'cancelled'           ? 'Closed (Cancelled)'
    : ls === 'archived'            ? 'Archived'
    : 'Not Published'

  const regStateColor  =
    ls === 'published'             ? 'text-emerald-700 bg-emerald-100'
    : ls === 'registration_closed' ? 'text-amber-700 bg-amber-100'
    : 'text-muted-foreground bg-muted'

  return (
    <div className="space-y-5">
      {/* Event Health — top row */}
      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          icon={Users}
          label="Total Registrations"
          value={event.totalRegistrations.toLocaleString('en-IN')}
          sub={event.totalCapacity ? `of ${event.totalCapacity} capacity` : undefined}
          accent
        />
        <Metric
          icon={TrendingUp}
          label="Ticket Revenue"
          value={event.isFreeEvent ? 'Free' : fmtINR(event.estimatedRevenue)}
        />
        <Metric
          icon={BarChart3}
          label="Capacity Used"
          value={capacityPct !== null ? `${capacityPct}%` : '—'}
          sub={capacityPct !== null ? undefined : 'No capacity limit'}
        />
      </div>

      {/* Donation revenue — event_plus_donation only */}
      {event.campaignType === 'event_plus_donation' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Metric
            icon={Heart}
            label="Donation Revenue"
            value={fmtINR(event.donationTotalPaise)}
            sub={`${event.donorCount.toLocaleString('en-IN')} donor${event.donorCount === 1 ? '' : 's'}`}
            accent
          />
          <Metric
            icon={TrendingUp}
            label="Total Revenue"
            value={fmtINR(event.estimatedRevenue + event.donationTotalPaise)}
            sub="Tickets + donations"
          />
        </div>
      )}

      {/* Capacity bar */}
      {capacityPct !== null && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[13px] font-medium text-foreground">Capacity Usage</span>
            <span className="text-[13px] text-muted-foreground">
              {event.totalRegistrations} / {event.totalCapacity}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className={cn(
                'h-full rounded-full transition-all',
                capacityPct >= 90 ? 'bg-red-500' : capacityPct >= 70 ? 'bg-amber-500' : 'bg-primary',
              )}
              style={{ width: `${capacityPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[13px] text-muted-foreground">
            {event.totalCapacity! - event.totalRegistrations} spots remaining
          </p>
        </div>
      )}

      {/* Attendance metrics */}
      {event.totalRegistrations > 0 && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="size-4 text-muted-foreground" />
              <span className="text-[14px] font-semibold text-foreground">Attendance</span>
            </div>
            <Link
              href={`/dashboard/events/${event.draftId}/checkin`}
              className="text-[13px] text-primary hover:underline"
            >
              Open check-in →
            </Link>
          </div>
          {(() => {
            const rate = Math.round((event.checkedInCount / event.totalRegistrations) * 100)
            return (
              <>
                <div className="mb-2 flex items-end justify-between">
                  <p className="text-[22px] font-bold tabular-nums text-foreground">
                    {event.checkedInCount}
                    <span className="ml-1.5 text-[14px] font-normal text-muted-foreground">
                      / {event.totalRegistrations} checked in
                    </span>
                  </p>
                  <span className="text-[15px] font-semibold tabular-nums text-foreground">{rate}%</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all',
                      rate >= 80 ? 'bg-emerald-500' : rate >= 50 ? 'bg-primary' : 'bg-amber-500',
                    )}
                    style={{ width: `${rate}%` }}
                  />
                </div>
                <div className="mt-2 flex gap-4 text-[13px] text-muted-foreground">
                  <span>{event.totalRegistrations - event.checkedInCount} not yet checked in</span>
                </div>
              </>
            )
          })()}
        </div>
      )}

      {/* Trend chart */}
      <TrendChart registrations={registrations} />

      {/* Registration Control Panel */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3 flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" />
          <p className="text-[14px] font-semibold text-foreground">Registration Status</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <span className={cn('flex items-center gap-1.5 rounded-full px-3 py-1 text-[13px] font-semibold', regStateColor)}>
            {ls === 'published'
              ? <LockOpen className="size-3.5" />
              : <Lock className="size-3.5" />}
            {regStateLabel}
          </span>
          {ls === 'published' && event.slug && (
            <a
              href={`/events/${event.slug}/register`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-primary hover:underline"
            >
              Open registration link ↗
            </a>
          )}
        </div>
        {ls === 'published' && event.totalCapacity && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            {event.totalCapacity - event.totalRegistrations} of {event.totalCapacity} spots remaining
          </p>
        )}
        {ls === 'registration_closed' && (
          <p className="mt-2 text-[13px] text-muted-foreground">
            Registrations are paused. Use the action buttons above to reopen.
          </p>
        )}
      </div>

      {/* Event details */}
      <div className="rounded-xl border border-border bg-card p-4">
        <p className="mb-4 text-[14px] font-semibold text-foreground">Event Details</p>
        <div className="space-y-4">
          <DetailRow
            icon={CalendarDays}
            label="Start"
            value={fmtDateTime(event.startDate, event.startTime, event.timezone)}
          />
          <DetailRow
            icon={Clock}
            label="End"
            value={fmtDateTime(event.endDate, event.endTime, null)}
          />
          <DetailRow
            icon={VenueIcon}
            label="Venue"
            value={venueLine}
          />
        </div>
      </div>
    </div>
  )
}

'use client'

import { useState }    from 'react'
import Link             from 'next/link'
import { ExternalLink, Copy, Check, ScanLine, CalendarDays, MapPin, Tag } from 'lucide-react'
import { cn }           from '@/lib/utils/cn'
import type { EventDetailResponse }  from '@/app/api/organizer/events/[eventId]/route'
import type { EventLifecycleStatus } from '@/types/events'
import EventActionsPanel             from './EventActionsPanel'

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatINR(paise: number): string {
  const r = paise / 100
  if (r >= 100_000) return `₹${(r / 100_000).toFixed(1)}L`
  if (r >= 1_000)   return `₹${(r / 1_000).toFixed(1)}K`
  return `₹${r.toLocaleString('en-IN')}`
}

function formatDate(dateStr: string | null, timeStr: string | null): string | null {
  if (!dateStr) return null
  try {
    const [y, m, d] = dateStr.split('-').map(Number)
    const label = new Date(y, m - 1, d).toLocaleDateString('en-IN', {
      day: 'numeric', month: 'short', year: 'numeric',
    })
    return timeStr ? `${label}, ${timeStr}` : label
  } catch {
    return dateStr
  }
}

function getVenueLabel(e: EventDetailResponse): string | null {
  if (e.venueType === 'online')   return e.onlinePlatform ?? 'Online'
  if (e.venueType === 'physical') return [e.venueName, e.venueCity].filter(Boolean).join(', ') || null
  if (e.venueType === 'hybrid') {
    const parts = [e.venueName, e.venueCity].filter(Boolean)
    return parts.length ? `${parts.join(', ')} + Online` : 'Hybrid'
  }
  return null
}

const EVENT_TYPE_LABELS: Record<string, string> = {
  conference:  'Conference',
  exhibition:  'Exhibition & Expo',
  sports:      'Sports & Fitness',
  workshop:    'Workshop',
  meetup:      'Meetup',
  community:   'Community',
  cultural:    'Cultural',
  awards:      'Awards',
  fundraising: 'Fundraising',
  custom:      'Custom Event',
}

// ── Status Badge ──────────────────────────────────────────────────────────────

function StatusBadge({ ls }: { ls: EventLifecycleStatus }) {
  const map: Record<EventLifecycleStatus, { label: string; cls: string; dot: string }> = {
    draft:               { label: 'Draft',       cls: 'bg-muted text-muted-foreground',  dot: 'bg-muted-foreground' },
    pending_review:      { label: 'Pending Approval', cls: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500'      },
    changes_requested:   { label: 'Changes Requested', cls: 'bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
    published:           { label: 'Published',   cls: 'bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500'      },
    registration_closed: { label: 'Reg. Closed', cls: 'bg-amber-100 text-amber-700',     dot: 'bg-amber-500'        },
    completed:           { label: 'Completed',   cls: 'bg-sky-100 text-sky-700',         dot: 'bg-sky-500'          },
    cancelled:           { label: 'Cancelled',   cls: 'bg-red-100 text-red-600',         dot: 'bg-red-500'          },
    archived:            { label: 'Archived',    cls: 'bg-muted text-muted-foreground',  dot: 'bg-muted-foreground' },
    // Recognition only (Phase L2) — distinct from Draft; never emitted yet.
    unpublished:         { label: 'Unpublished', cls: 'bg-slate-100 text-slate-600',     dot: 'bg-slate-400'        },
  }
  const { label, cls, dot } = map[ls] ?? map.draft
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[12px] font-semibold', cls)}>
      <span className={cn('size-1.5 rounded-full', dot)} />
      {label}
    </span>
  )
}

// ── Copy Button ───────────────────────────────────────────────────────────────

function CopyButton({ text, label = 'Copy Link' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  async function handle() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <button
      type="button"
      onClick={handle}
      className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
      {copied ? 'Copied!' : label}
    </button>
  )
}

// ── KPI Pill ──────────────────────────────────────────────────────────────────

function KpiPill({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className={cn(
      'flex min-w-[84px] flex-col rounded-xl border px-3.5 py-2.5',
      highlight ? 'border-primary/20 bg-primary/[0.06]' : 'border-border bg-muted/30',
    )}>
      <span className={cn(
        'text-[18px] font-bold tabular-nums leading-tight',
        highlight ? 'text-primary' : 'text-foreground',
      )}>
        {value}
      </span>
      <span className="mt-0.5 text-[11px] text-muted-foreground">{label}</span>
    </div>
  )
}

// ── Meta Chip ─────────────────────────────────────────────────────────────────

function MetaChip({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/50 px-2.5 py-0.5 text-[12px] text-muted-foreground">
      <Icon className="size-3 shrink-0" />
      <span className="max-w-[180px] truncate">{text}</span>
    </span>
  )
}

// ── Main ──────────────────────────────────────────────────────────────────────

interface Props {
  event:     EventDetailResponse
  eventId:   string
  token:     string
  onSuccess: () => void
}

export default function EventCommandHeader({ event, eventId, token, onSuccess }: Props) {
  const publicUrl = event.slug
    ? `${typeof window !== 'undefined' ? window.location.origin : ''}${
        event.campaignType === 'donation_only' ? '/campaign' : '/events'
      }/${event.slug}`
    : null

  const showCheckin = ['published', 'registration_closed', 'completed'].includes(event.lifecycleStatus) && !!event.slug

  const fillRate = !event.isFreeEvent && event.totalCapacity && event.totalCapacity > 0
    ? Math.round((event.totalRegistrations / event.totalCapacity) * 100)
    : null

  const dateLabel  = formatDate(event.startDate, event.startTime)
  const venueLabel = getVenueLabel(event)
  const typeLabel  = event.eventType ? (EVENT_TYPE_LABELS[event.eventType] ?? event.eventType) : null

  return (
    <div className="border-b border-border">
      {/* Compact banner */}
      {event.bannerUrl ? (
        <div className="relative h-[90px] w-full overflow-hidden sm:h-[108px]">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={event.bannerUrl} alt="" className="h-full w-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent" />
        </div>
      ) : (
        <div className="h-14 w-full bg-gradient-to-br from-[var(--primary-from)]/15 via-[var(--primary)]/8 to-transparent" />
      )}

      {/* Content */}
      <div className="space-y-3 px-5 py-4 sm:px-6">

        {/* Row 1 — name + status */}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[19px] font-bold leading-tight text-foreground">{event.name}</h1>
            <StatusBadge ls={event.lifecycleStatus} />
          </div>
          {event.tagline && (
            <p className="mt-0.5 text-[13px] text-muted-foreground">{event.tagline}</p>
          )}
        </div>

        {/* Row 2 — meta chips */}
        {(typeLabel || dateLabel || venueLabel) && (
          <div className="flex flex-wrap items-center gap-1.5">
            {typeLabel  && <MetaChip icon={Tag}          text={typeLabel}  />}
            {dateLabel  && <MetaChip icon={CalendarDays} text={dateLabel}  />}
            {venueLabel && <MetaChip icon={MapPin}       text={venueLabel} />}
          </div>
        )}

        {/* Row 3 — KPI pills */}
        <div className="flex flex-wrap gap-2">
          <KpiPill label="Registrations" value={event.totalRegistrations.toLocaleString('en-IN')} highlight />
          {!event.isFreeEvent && (
            <KpiPill label="Est. Revenue" value={formatINR(event.estimatedRevenue)} />
          )}
          <KpiPill label="Checked In" value={event.checkedInCount.toLocaleString('en-IN')} />
          {fillRate !== null && (
            <KpiPill label="Capacity" value={`${fillRate}%`} />
          )}
        </div>

        {/* Row 4 — actions */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Primary: View Page */}
          {publicUrl && (
            <Link
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted/60"
            >
              <ExternalLink className="size-3.5" />
              {event.campaignType === 'donation_only' ? 'View Campaign' : 'View Page'}
            </Link>
          )}

          {/* Primary: Check-In */}
          {showCheckin && (
            <Link
              href={`/dashboard/events/${eventId}/checkin`}
              className="flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5 text-[13px] font-medium text-primary transition-colors hover:bg-primary/10"
            >
              <ScanLine className="size-3.5" />
              Check-In
            </Link>
          )}

          {/* Primary: Copy Link */}
          {publicUrl && <CopyButton text={publicUrl} />}

          {/* Divider + secondary actions dropdown */}
          {token && (
            <>
              <span className="hidden h-4 w-px bg-border sm:block" />
              <EventActionsPanel event={event} token={token} onSuccess={onSuccess} mode="dropdown" />
            </>
          )}
        </div>

        {/* Cancellation reason */}
        {event.lifecycleStatus === 'cancelled' && event.cancelReason && (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-[13px] font-semibold text-red-700">Cancellation reason</p>
            <p className="mt-0.5 text-[14px] text-red-600">{event.cancelReason}</p>
          </div>
        )}
      </div>
    </div>
  )
}

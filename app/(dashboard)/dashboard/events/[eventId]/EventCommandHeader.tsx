'use client'

// RD-EVENT-05 · The event command header.
//
// ═══ WHAT CHANGED, AND WHY ═══════════════════════════════════════════════════
//
// 1. ONE STATUS VOCABULARY. This file carried a THIRD hand-written lifecycle→label map
//    (after `eventLifecycleMeta` and `presentEventStatus`), in raw palette hues with no
//    dark-mode pair. It now uses `overviewStatus`, the composed resolver RD-EVENT-03
//    established, so the events list, the overview and this header cannot disagree.
//
// 2. NUMBERS TELL THE TRUTH. `checkedInCount` and `totalRegistrations` rendered raw, so
//    a failed counter read displayed "0 Registrations · 0 Checked In" with the same
//    confidence as a measurement — even though `statsUnavailable` has been on the
//    payload since RD-EVENT-03. Revenue was abbreviated to "₹3.4L", losing digits the
//    organizer needs; it is now shown in full, as everywhere else in the product.
//
// 3. TOKENS. Every arbitrary pixel size and legacy radius is gone.
//
// RD-EVENT-08 · The banner and the four large KPI cards are gone from this shell. Both
// were repeated above all eighteen tabs; together they cost ~220px of vertical space on
// every sub-page. The figures survive as one compact strip. The banner DATA and the
// public event page are untouched.

import { useState } from 'react'
import Link from 'next/link'
import { ExternalLink, Copy, Check, ScanLine, CalendarDays, MapPin, Tag, WalletCards } from 'lucide-react'
import { useWorkspacePermissions } from '@/lib/hooks/useWorkspacePermissions'
import { cn } from '@/lib/utils/cn'
import { useToast } from '@/components/ui/Toast'
import { useEventContext } from '@/components/dashboard/EventContextProvider'
import {
  UNAVAILABLE, capacityView, checkedInMetric, locationLabel,
  overviewStatus, publicEventHref, registrationsMetric, revenueMetric, statusChipClass,
  type MetricValue,
} from '@/lib/events/eventOverview'
import type { EventDetailResponse } from '@/app/api/organizer/events/[eventId]/route'
import EventActionsPanel from './EventActionsPanel'

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

function formatDate(dateStr: string | null, timeStr: string | null): string | null {
  if (!dateStr) return null
  const [y, m, d] = dateStr.split('-').map(Number)
  if (!y || !m || !d) return dateStr
  const dt = new Date(y, m - 1, d)
  if (Number.isNaN(dt.getTime())) return dateStr
  const label = dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  return timeStr ? `${label}, ${timeStr}` : label
}

// ─── Metric ───────────────────────────────────────────────────────────────────

/**
 * The headline figures as one compact line.
 *
 * Each entry keeps the zero-vs-unavailable contract: a figure that could not be read
 * renders as an em dash with an "Unavailable" label for screen readers, never as a zero.
 */
function MetricStrip({ items }: { items: { label: string; metric: MetricValue }[] }) {
  return (
    <dl className="mt-2.5 flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1">
      {items.map(({ label, metric }) => (
        <div key={label} className="flex min-w-0 items-baseline gap-1.5">
          <dd className={cn(
            'text-fs-sm font-semibold tabular-nums',
            metric.unavailable ? 'text-muted-foreground' : 'text-foreground',
          )}>
            {metric.unavailable
              ? <><span aria-hidden>{UNAVAILABLE}</span><span className="sr-only">Unavailable</span></>
              : metric.text}
          </dd>
          <dt className="truncate text-fs-xs text-muted-foreground">{label}</dt>
        </div>
      ))}
    </dl>
  )
}

function MetaChip({ icon: Icon, text }: { icon: React.ElementType; text: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 rounded-pill border border-border bg-muted/40 px-2.5 py-0.5 text-fs-2xs text-muted-foreground">
      <Icon className="size-3 shrink-0" aria-hidden />
      <span className="truncate">{text}</span>
    </span>
  )
}

// ─── Copy link ────────────────────────────────────────────────────────────────

function CopyLinkButton({ url }: { url: string }) {
  const { showToast } = useToast()
  const [copied, setCopied] = useState(false)

  async function handle() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard access is refused in an insecure context or without permission. The
      // old handler let that rejection go unhandled and gave the organizer no feedback.
      showToast('Couldn’t copy the link. Copy it from the address bar instead.', 'error')
    }
  }

  return (
    <button
      type="button"
      onClick={handle}
      aria-label={copied ? 'Link copied' : 'Copy the public event link'}
      className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border bg-card px-3 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9"
    >
      {copied
        ? <Check className="size-3.5 text-[color:var(--accent-verify-fg)]" aria-hidden />
        : <Copy className="size-3.5" aria-hidden />}
      {copied ? 'Copied' : 'Copy link'}
    </button>
  )
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function EventCommandHeader({
  event, eventId, token, onSuccess,
}: {
  event:     EventDetailResponse
  eventId:   string
  token:     string
  onSuccess: () => void
}) {
  // `now` comes from the event context: a value fixed at mount. Calling Date.now()
  // during render is impure and would also risk a server/client hydration mismatch.
  const { now } = useEventContext()
  const status    = overviewStatus(event, now)
  const publicUrl = publicEventHref(event)
  const absoluteUrl = publicUrl && typeof window !== 'undefined'
    ? `${window.location.origin}${publicUrl}`
    : publicUrl

  const showCheckin = ['published', 'registration_closed', 'completed'].includes(event.lifecycleStatus)
  const perms = useWorkspacePermissions()
  const canSeeWallet = !perms.loading && perms.has('wallet') && event.campaignType !== 'donation_only'
    && Boolean(event.slug)

  const dateLabel  = formatDate(event.startDate, event.startTime)
  const venueLabel = locationLabel(event)
  const typeLabel  = event.eventType ? (EVENT_TYPE_LABELS[event.eventType] ?? event.eventType) : null
  const capacity   = capacityView(event)

  const capacityMetric: MetricValue = capacity
    ? { text: `${capacity.pct}%`, unavailable: false, sub: `${capacity.remaining.toLocaleString('en-IN')} places left` }
    : event.statsUnavailable
      ? { text: UNAVAILABLE, unavailable: true, sub: null }
      : { text: 'Unlimited', unavailable: false, sub: 'No limit set' }

  return (
    // RD-EVENT-08 · No banner. The organizer shell is an operational surface, not the
    // public event page: a 112px hero repeated above all eighteen tabs pushed the actual
    // work below the fold on every single one. The banner data is untouched and the
    // public page still uses it.
    <header className="border-b border-border">
      <div className="flex flex-col gap-3 px-4 py-4 sm:px-6 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
        {/* Identity */}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
            <h1 className="min-w-0 break-words text-fs-xl font-semibold leading-tight text-foreground">
              {event.name}
            </h1>
            {/* Status carries a word, not only a hue — readable in grayscale. */}
            <span className={cn(
              'inline-flex shrink-0 items-center rounded-pill px-2 py-0.5 text-fs-2xs font-semibold',
              statusChipClass(status.tone),
            )}>
              {status.label}
            </span>
          </div>

          {event.tagline && (
            <p className="mt-1 line-clamp-2 break-words text-fs-sm text-muted-foreground">
              {event.tagline}
            </p>
          )}

          {(typeLabel || dateLabel || venueLabel) && (
            <div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
              {typeLabel  && <MetaChip icon={Tag}          text={typeLabel}  />}
              {dateLabel  && <MetaChip icon={CalendarDays} text={dateLabel}  />}
              {venueLabel && <MetaChip icon={MapPin}       text={venueLabel} />}
            </div>
          )}

          {/*
            The four headline figures, as ONE compact line rather than four large cards.
            The cards cost ~110px of vertical space above every tab and were the third
            copy of these numbers on screen; this keeps every figure — and its
            zero-vs-unavailable honesty — at roughly a fifth of the height.
          */}
          <MetricStrip
            items={[
              { label: 'registered',   metric: registrationsMetric(event) },
              { label: 'checked in',   metric: checkedInMetric(event) },
              ...(event.isFreeEvent ? [] : [{ label: 'revenue', metric: revenueMetric(event) }]),
              { label: 'capacity',     metric: capacityMetric },
            ]}
          />
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {publicUrl && (
            <Link
              href={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`${event.campaignType === 'donation_only' ? 'View campaign page' : 'View public page'} (opens in a new tab)`}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border bg-card px-3 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9"
            >
              <ExternalLink className="size-3.5" aria-hidden />
              {event.campaignType === 'donation_only' ? 'View campaign' : 'View page'}
            </Link>
          )}

          {showCheckin && (
            <Link
              href={`/dashboard/events/${encodeURIComponent(eventId)}/checkin`}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control bg-primary/[0.08] px-3 text-fs-sm font-semibold text-[color:var(--primary-text)] transition-colors hover:bg-primary/[0.14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9"
            >
              <ScanLine className="size-3.5" aria-hidden />
              Check-in
            </Link>
          )}

          {/* RD-CLOSE — this event's Wallet (services bought, used, refundable), one click away. */}
          {canSeeWallet && (
            <Link
              href={`/dashboard/wallet?eventId=${encodeURIComponent(eventId)}`}
              className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-control border border-border bg-card px-3 text-fs-sm font-medium text-foreground transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 sm:h-9"
            >
              <WalletCards className="size-3.5" aria-hidden />
              Wallet
            </Link>
          )}

          {absoluteUrl && <CopyLinkButton url={absoluteUrl} />}

          {token && (
            <>
              <span className="hidden h-4 w-px bg-border sm:block" aria-hidden />
              <EventActionsPanel event={event} token={token} onSuccess={onSuccess} mode="dropdown" />
            </>
          )}
        </div>

        {/* Cancellation — the one notice that must never be a subtle chip. */}
        {event.lifecycleStatus === 'cancelled' && (
          <div className={cn('rounded-surface border p-3.5', 'border-destructive/30 bg-destructive/[0.04]')}>
            <p className="text-fs-sm font-semibold text-foreground">This event is cancelled</p>
            {event.cancelReason && (
              <p className="mt-0.5 break-words text-fs-xs text-muted-foreground [overflow-wrap:anywhere]">
                {event.cancelReason}
              </p>
            )}
          </div>
        )}
      </div>
    </header>
  )
}

import { Globe, Shirt, Clock, Monitor, Undo2, ExternalLink } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { OnlineVenueConfig, RefundWindow } from '@/components/wizard/eventDetailsConfig'
import {
  ONLINE_PLATFORM_LABELS, LANGUAGE_OPTIONS, TIMEZONE_OPTIONS,
} from '@/components/wizard/eventDetailsConfig'
import { cn } from '@/lib/utils/cn'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'
import {
  SectionShell, EventSectionHeader, TYPE, CARD, CARD_PAD, GRID_GAP, ICON_TILE, ICON_TILE_ICON,
} from '@/components/event-templates/shared/ui/framework'

// RD-ATTENDEE-01 Phase 1B.2 — the ONE shared, data-driven "Good to know" logistics
// section that every Event Details template renders. It surfaces organizer-configured
// attendee logistics that previously disappeared inconsistently across templates.
// Each card renders ONLY when its field has data; the whole section renders nothing
// when none do. There are no template-specific copies and no duplicated mapping.
//
// RD-ST13.0 rework. The section was a single `<ul className="space-y-3">` of icon +
// label + value rows inside a max-w-3xl prose column: one flat list where a one-word
// timezone and a three-clause refund policy carried identical weight, and the right
// two-thirds of the band sat empty. It is now a quick-reference card grid — one card
// per essential, equal height, 1 / 2 / 4 columns.
//
// DEDUPLICATION (ST13.0, corrected in ST15.0). The "Online" card duplicates the venue
// section on templates that HAVE one — but only six of this component's nine consumers
// do. Awards, Cultural and Exhibition render no venue component at all, so ST13.0's
// unconditional removal silently dropped the platform, join instructions and meeting URL
// on those three templates.
//
// The card is therefore back, and de-duplication moved to the call site: a template that
// already renders online details simply stops passing `online`, and the card disappears.
// Presence of data — not a hardcoded assumption about the page — decides.
//
// This file has NO 'use client' and must keep it that way: hover lift and shadow are
// pure CSS at the framework's own values, so the whole section stays a Server Component.

function languageLabel(id: string): string {
  return LANGUAGE_OPTIONS.find(o => o.id === id)?.label ?? id
}
function timezoneLabel(id: string): string {
  return TIMEZONE_OPTIONS.find(o => o.id === id)?.label ?? id
}

// One clause per line. The refund window is the only essential with several independent
// facts, and joining them with ' · ' made the longest value the hardest one to read.
function refundLines(rw: RefundWindow): string[] {
  const day = (n: number) => `${n} day${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (rw.fullRefundDaysBefore != null)    parts.push(`Full refund up to ${day(rw.fullRefundDaysBefore)} before`)
  if (rw.partialRefundDaysBefore != null) parts.push(`${rw.partialRefundPercent}% refund up to ${day(rw.partialRefundDaysBefore)} before`)
  if (rw.noRefundDaysBefore != null)      parts.push(`No refund within ${day(rw.noRefundDaysBefore)} of the event`)
  return parts
}

interface Essential {
  key:   string
  Icon:  LucideIcon
  title: string
  /** One line, or several when the field genuinely holds several facts. */
  lines: string[]
  href?: string
}

// ── One essential ───────────────────────────────────────────────────────────────
// `h-full` + `flex flex-col` keeps every card the same height as its tallest sibling,
// so a one-word timezone still reads as a peer of a three-clause refund window.
function EssentialCard({ item }: { item: Essential }) {
  return (
    <article
      className={cn(
        CARD, CARD_PAD,
        'flex h-full flex-col transition duration-150 hover:-translate-y-[3px] hover:shadow-md motion-reduce:transform-none',
      )}
    >
      <span className={ICON_TILE} aria-hidden>
        <item.Icon className={ICON_TILE_ICON} />
      </span>

      <h3 className={cn('mt-3.5', TYPE.cardTitle)}>{item.title}</h3>

      {item.lines.length === 1 ? (
        <p className={cn('mt-1.5', TYPE.cardBody)}>{item.lines[0]}</p>
      ) : (
        <ul className={cn('mt-1.5 flex flex-col gap-1', TYPE.cardBody)}>
          {item.lines.map(line => (
            <li key={line} className="flex gap-2">
              <span aria-hidden className="mt-[0.5em] size-1 shrink-0 rounded-full bg-primary/50" />
              {line}
            </li>
          ))}
        </ul>
      )}

      {item.href && (
        <a
          href={item.href}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-auto inline-flex w-fit items-center gap-1 pt-3 text-fs-sm font-semibold text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2"
        >
          Open
          <ExternalLink className="size-3" aria-hidden />
        </a>
      )}
    </article>
  )
}

export function EventInfoSection({
  language, dressCode, timezone, venueType, online, refundWindow, refundPolicyUrl,
  layout = 'section',
}: {
  language?:        string
  dressCode?:       string
  timezone?:        string
  /** Omit on templates whose venue section already renders the online block. */
  venueType?:       string
  /** Omit on templates whose venue section already renders the online block. */
  online?:          OnlineVenueConfig | null
  refundWindow?:    RefundWindow | null
  refundPolicyUrl?: string
  // RD-ST4.4 (ST41-A01): templates render this as a top-level BAND, where it previously
  // had no container at all and painted edge-to-edge at x=0. 'section' gives it the ONE
  // canonical shell. 'inline' keeps the compact SectionWrapper for the legacy fallback,
  // which already nests it inside a <Container> and a two-column grid.
  layout?:          'section' | 'inline'
}) {
  // Language: hide the default English (matches the templates' facts-chip convention).
  const lang  = language?.trim() && language.trim() !== 'en' ? languageLabel(language.trim()) : null
  const dress = dressCode?.trim() || null
  const tz    = timezone?.trim() ? timezoneLabel(timezone.trim()) : null

  // Refund: the structured window unless the organizer chose an external URL; otherwise
  // fall back to the bare policy link.
  const rwLines   = refundWindow && !refundWindow.useExternalPolicyUrl ? refundLines(refundWindow) : []
  const refundUrl = (refundWindow?.useExternalPolicyUrl || rwLines.length === 0) ? (refundPolicyUrl?.trim() || null) : null

  // Online: only when this template has no venue section of its own to carry it.
  const showOnline  = (venueType === 'online' || venueType === 'hybrid') && !!online?.platform
  const onlineLabel = showOnline
    ? `${ONLINE_PLATFORM_LABELS[online!.platform] ?? online!.platform}${online!.platformCustomName?.trim() ? ` · ${online!.platformCustomName.trim()}` : ''}`
    : null
  const onlineNote  = showOnline
    ? (online!.revealAfterRegistration ? 'Joining link shared after registration' : online!.joinInstructions?.trim() || null)
    : null
  const onlineUrl   = showOnline && !online!.revealAfterRegistration ? online!.meetingUrl?.trim() || null : null

  const items: Essential[] = [
    lang  && { key: 'language', Icon: Globe, title: 'Language',   lines: [lang] },
    dress && { key: 'dress',    Icon: Shirt, title: 'Dress code', lines: [dress] },
    tz    && { key: 'timezone', Icon: Clock, title: 'Timezone',   lines: [tz] },
    onlineLabel && {
      key: 'online', Icon: Monitor, title: 'Online',
      lines: [onlineLabel, onlineNote].filter(Boolean) as string[],
      href:  onlineUrl ?? undefined,
    },
    (rwLines.length > 0 || refundUrl) && {
      key: 'refunds', Icon: Undo2, title: 'Refunds',
      lines: rwLines.length > 0 ? rwLines : ['See refund policy'],
      href:  refundUrl ?? undefined,
    },
  ].filter(Boolean) as Essential[]

  if (items.length === 0) return null

  const grid = (
    <div className={cn('grid grid-cols-1 sm:grid-cols-2', GRID_GAP, layout === 'section' && 'lg:grid-cols-4')}>
      {items.map(item => <EssentialCard key={item.key} item={item} />)}
    </div>
  )

  if (layout === 'inline') {
    return <SectionWrapper id="event-info" title="Good to know">{grid}</SectionWrapper>
  }

  return (
    <SectionShell id="event-info">
      <EventSectionHeader eyebrow="Essentials" title="Good to know" />
      {grid}
    </SectionShell>
  )
}

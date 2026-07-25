import { Globe, Shirt, Clock, Monitor, Undo2, ExternalLink } from 'lucide-react'
import type { OnlineVenueConfig, RefundWindow } from '@/components/wizard/eventDetailsConfig'
import {
  ONLINE_PLATFORM_LABELS, LANGUAGE_OPTIONS, TIMEZONE_OPTIONS,
} from '@/components/wizard/eventDetailsConfig'
import { SectionWrapper } from '@/components/event-templates/shared/ui/SectionWrapper'

// RD-ATTENDEE-01 Phase 1B.2 — the ONE shared, data-driven "Good to know" logistics
// section that every Event Details template renders. It surfaces organizer-configured
// attendee logistics that previously disappeared inconsistently across templates:
// language, dress code, timezone, online-join details, and the refund window. Each row
// renders ONLY when its field has data; the whole section renders nothing when none do.
// There are no template-specific copies and no duplicated mapping — every template
// consumes this same component.

function languageLabel(id: string): string {
  return LANGUAGE_OPTIONS.find(o => o.id === id)?.label ?? id
}
function timezoneLabel(id: string): string {
  return TIMEZONE_OPTIONS.find(o => o.id === id)?.label ?? id
}
function refundText(rw: RefundWindow): string | null {
  const day = (n: number) => `${n} day${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (rw.fullRefundDaysBefore != null)    parts.push(`Full refund up to ${day(rw.fullRefundDaysBefore)} before`)
  if (rw.partialRefundDaysBefore != null) parts.push(`${rw.partialRefundPercent}% refund up to ${day(rw.partialRefundDaysBefore)} before`)
  if (rw.noRefundDaysBefore != null)      parts.push(`No refund within ${day(rw.noRefundDaysBefore)} of the event`)
  return parts.length ? parts.join(' · ') : null
}

export function EventInfoSection({
  language, dressCode, timezone, venueType, online, refundWindow, refundPolicyUrl,
}: {
  language?:        string
  dressCode?:       string
  timezone?:        string
  venueType?:       string
  online?:          OnlineVenueConfig | null
  refundWindow?:    RefundWindow | null
  refundPolicyUrl?: string
}) {
  // Language: hide the default English (matches the templates' facts-chip convention).
  const lang  = language?.trim() && language.trim() !== 'en' ? languageLabel(language.trim()) : null
  const dress = dressCode?.trim() || null
  const tz    = timezone?.trim() ? timezoneLabel(timezone.trim()) : null

  const showOnline  = (venueType === 'online' || venueType === 'hybrid') && !!online?.platform
  const onlineLabel = showOnline
    ? `${ONLINE_PLATFORM_LABELS[online!.platform] ?? online!.platform}${online!.platformCustomName?.trim() ? ` · ${online!.platformCustomName.trim()}` : ''}`
    : null
  const onlineNote  = showOnline
    ? (online!.revealAfterRegistration ? 'Joining link shared after registration' : online!.joinInstructions?.trim() || null)
    : null
  const onlineUrl   = showOnline && !online!.revealAfterRegistration ? online!.meetingUrl?.trim() || null : null

  // Refund: the structured window unless the organizer chose an external URL; otherwise
  // fall back to the bare policy link.
  const rwText    = refundWindow && !refundWindow.useExternalPolicyUrl ? refundText(refundWindow) : null
  const refundUrl = (refundWindow?.useExternalPolicyUrl || !rwText) ? (refundPolicyUrl?.trim() || null) : null

  type Row = { icon: React.ReactNode; label: string; value: string; href?: string }
  const rows: Row[] = [
    lang        && { icon: <Globe   className="size-4 shrink-0 text-primary" aria-hidden />, label: 'Language',   value: lang },
    dress       && { icon: <Shirt   className="size-4 shrink-0 text-primary" aria-hidden />, label: 'Dress code', value: dress },
    tz          && { icon: <Clock   className="size-4 shrink-0 text-primary" aria-hidden />, label: 'Timezone',   value: tz },
    onlineLabel && { icon: <Monitor className="size-4 shrink-0 text-primary" aria-hidden />, label: 'Online',     value: [onlineLabel, onlineNote].filter(Boolean).join(' — '), href: onlineUrl ?? undefined },
    (rwText || refundUrl) && { icon: <Undo2 className="size-4 shrink-0 text-primary" aria-hidden />, label: 'Refunds', value: rwText ?? 'See refund policy', href: refundUrl ?? undefined },
  ].filter(Boolean) as Row[]

  if (rows.length === 0) return null

  return (
    <SectionWrapper id="event-info" title="Good to know">
      <ul className="space-y-3">
        {rows.map((row, i) => (
          <li key={i} className="flex items-start gap-3">
            <span className="mt-0.5">{row.icon}</span>
            <div className="min-w-0">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{row.label}</p>
              <p className="text-sm leading-relaxed text-foreground">
                {row.value}
                {row.href && (
                  <a
                    href={row.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-1.5 inline-flex items-center gap-1 font-semibold text-primary hover:underline"
                  >
                    Open
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </p>
            </div>
          </li>
        ))}
      </ul>
    </SectionWrapper>
  )
}

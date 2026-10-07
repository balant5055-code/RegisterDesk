// ─── SportsGoodToKnow — the colophon ─────────────────────────────────────────
//
// SPORTS-ONLY Server Component, and the page's last line: the practical facts an
// attendee checks once. The shared EventInfoSection renders them as a grid of lifting,
// shadowed cards with icon tiles — 373px of chrome for "Tamil" and a timezone. This is
// one row on a hairline, the same FIELD/VALUE pair the cover and the challenge index
// use, and it costs the client nothing.
//
//   LANGUAGE          TIMEZONE                              DRESS CODE   REFUNDS
//   Tamil             IST — India Standard Time (UTC+5:30)  …            …
//
// Same derivations as the shared section: English is hidden (it is the default), the
// refund window is expressed one clause per line, and an external policy URL replaces
// the clauses when the organiser chose one. Every field self-hides; the section
// disappears when an event has none of them.

import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import type { RefundWindow } from '@/components/wizard/eventDetailsConfig'
import { LANGUAGE_OPTIONS, TIMEZONE_OPTIONS } from '@/components/wizard/eventDetailsConfig'
import { FIELD, QUIET_ACTION, SectionHead, SportsSection } from './primitives'

const languageLabel = (id: string) => LANGUAGE_OPTIONS.find(o => o.id === id)?.label ?? id
const timezoneLabel = (id: string) => TIMEZONE_OPTIONS.find(o => o.id === id)?.label ?? id

function refundLines(rw: RefundWindow): string[] {
  const day = (n: number) => `${n} day${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (rw.fullRefundDaysBefore != null)    parts.push(`Full refund up to ${day(rw.fullRefundDaysBefore)} before`)
  if (rw.partialRefundDaysBefore != null) parts.push(`${rw.partialRefundPercent}% refund up to ${day(rw.partialRefundDaysBefore)} before`)
  if (rw.noRefundDaysBefore != null)      parts.push(`No refund within ${day(rw.noRefundDaysBefore)} of the event`)
  return parts
}

export interface SportsGoodToKnowProps {
  language?:        string
  dressCode?:       string
  timezone?:        string
  refundWindow?:    RefundWindow | null
  refundPolicyUrl?: string
  eyebrow?:         string
  title?:           string
}

export function SportsGoodToKnow({
  language, dressCode, timezone, refundWindow, refundPolicyUrl,
  eyebrow = 'Essentials', title = 'Good to Know',
}: SportsGoodToKnowProps) {
  const lang  = language?.trim() && language.trim() !== 'en' ? languageLabel(language.trim()) : null
  const dress = dressCode?.trim() || null
  const tz    = timezone?.trim() ? timezoneLabel(timezone.trim()) : null

  const rwLines   = refundWindow && !refundWindow.useExternalPolicyUrl ? refundLines(refundWindow) : []
  const refundUrl = (refundWindow?.useExternalPolicyUrl || rwLines.length === 0) ? (refundPolicyUrl?.trim() || null) : null

  const items = [
    lang  && { key: 'language', label: 'Language',   lines: [lang] },
    tz    && { key: 'timezone', label: 'Timezone',   lines: [tz] },
    dress && { key: 'dress',    label: 'Dress code', lines: [dress] },
    (rwLines.length > 0 || refundUrl) && {
      key: 'refunds', label: 'Refunds',
      lines: rwLines.length > 0 ? rwLines : ['See refund policy'],
      href: refundUrl ?? undefined,
    },
  ].filter(Boolean) as { key: string; label: string; lines: string[]; href?: string }[]

  if (items.length === 0) return null

  return (
    <SportsSection id="event-info" className="border-b-0 py-8 sm:py-10 lg:py-12">
      {/* The colophon: a short closing band, so a tighter rhythm (owner, 2026-09-25) —
          32 / 40 / 48px of padding instead of the full band's 40 / 48 / 64, and one rule
          above the facts instead of a boxed row (a boxed row ended the page on a line, a
          gap, then the footer's line). */}
      <SectionHead eyebrow={eyebrow} title={title} />

      <dl className={cn(
        'mx-auto mt-7 flex max-w-5xl flex-col gap-y-5 border-t border-border/60 pt-6 text-center',
        'sm:flex-row sm:justify-center sm:gap-y-0 sm:divide-x sm:divide-border/60',
      )}>
        {items.map(item => (
          <div key={item.key} className="min-w-0 sm:flex-1 sm:px-8">
            <dt className={FIELD}>{item.label}</dt>
            <dd className="mt-1.5 text-balance text-fs-md font-semibold leading-snug text-foreground">
              {item.lines.map(line => <span key={line} className="block">{line}</span>)}
              {item.href && (
                <a href={item.href} target="_blank" rel="noopener noreferrer" className={cn(QUIET_ACTION, 'mt-1 justify-center')}>
                  Open<ExternalLink className="size-3.5" aria-hidden />
                </a>
              )}
            </dd>
          </div>
        ))}
      </dl>
    </SportsSection>
  )
}

'use client'

// Custom Event template — the registration card. Sticky in the aside on desktop, the
// first thing after the hero on mobile. It is the page's ONE summary of when / where /
// how much, and its status reads the same admission resolver as the Admission section,
// so the two can never disagree.

import { useState } from 'react'
import Link from 'next/link'
import { ArrowRight, Share2, Check, CalendarDays, Clock, MapPin, Globe } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils/cn'
import { marketingButton } from '@/lib/marketing/theme'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { DownloadTicketLink } from '@/components/event-templates/shared/registration/DownloadTicketLink'
import { formatDateShort, formatTime, formatINR, minPassPrice } from '@/components/event-templates/shared/utils/format'
import type { EventDetailProps } from '@/components/event-templates/types'
import type { AdmissionState } from './admissionModel'
import { LUXE_CARD, LUXE_LABEL, longDateParts, formatSalesMoment } from './luxe'

interface Row { Icon: LucideIcon; value: string; sub?: string }

function buildRows(p: EventDetailProps): Row[] {
  const rows: Row[] = []
  const start = longDateParts(p.startDate)
  if (start) {
    rows.push(p.endDate && p.endDate !== p.startDate
      ? { Icon: CalendarDays, value: `${formatDateShort(p.startDate)} – ${formatDateShort(p.endDate)}` }
      : { Icon: CalendarDays, value: start.date, sub: start.weekday })
  }
  if (p.startTime) {
    rows.push({
      Icon:  Clock,
      value: `${formatTime(p.startTime)}${p.endTime ? ` – ${formatTime(p.endTime)}` : ''}`,
      sub:   p.doorsOpenTime ? `Doors open ${formatTime(p.doorsOpenTime)}` : undefined,
    })
  }
  const city  = p.physical?.city?.trim() ?? ''
  const venue = p.venueName?.trim() ?? ''
  if (p.venueType === 'online') {
    rows.push({ Icon: Globe, value: 'Online event' })
  } else if (venue || city) {
    // Never print the city twice ("Samalapuram, Tiruppur, Tiruppur" on the old page).
    const sub = city && !venue.toLowerCase().includes(city.toLowerCase()) ? city : undefined
    rows.push({
      Icon:  MapPin,
      value: venue || city,
      sub:   p.venueType === 'hybrid' ? [sub, 'In person & online'].filter(Boolean).join(' · ') : sub,
    })
  }
  return rows
}

export function CustomRegisterCard({ props, admission }: { props: EventDetailProps; admission: AdmissionState }) {
  const { title, slug, description, startDate, endDate, startTime, endTime, venueName, physical, isFreeEvent, passes } = props
  const [copied, setCopied] = useState(false)
  const rows   = buildRows(props)
  const isOpen = admission.kind === 'open'
  const free   = isFreeEvent || (isOpen && admission.purchasable.every(p => p.price === 0))
    || (!isOpen && passes.length > 0 && passes.every(p => p.price === 0))

  const price = passes.length === 0 ? null : free ? 'Free' : `From ${formatINR(minPassPrice(passes))}`

  const status =
    admission.kind === 'open'    ? 'Registration open'
    : admission.kind === 'opens' ? (formatSalesMoment(admission.opensOn) ? `Opens ${formatSalesMoment(admission.opensOn)}` : 'Opens soon')
    : admission.kind === 'soldout' ? 'Sold out'
    : admission.kind === 'soon'    ? 'Opening soon'
    : 'Registration closed'

  const remaining = isOpen && admission.purchasable.length === 1
    ? props.availability[admission.purchasable[0].id]?.remaining
    : null
  const showRemaining = isOpen && admission.purchasable.length === 1
    && admission.purchasable[0].showRemainingSeats && remaining != null

  const handleShare = () => {
    if (typeof window === 'undefined') return
    const url = window.location.href
    if (navigator.share) { navigator.share({ title, url }).catch(() => null); return }
    navigator.clipboard?.writeText(url).then(() => {
      setCopied(true); window.setTimeout(() => setCopied(false), 2000)
    }).catch(() => null)
  }

  return (
    <div className={cn(LUXE_CARD, 'shadow-[var(--shadow-lg)]')}>
      {/* Price + action: desktop only. Below lg the Admission section follows this card
          directly, so repeating the price and button here would stack them twice. */}
      <div className="hidden p-5 lg:block">
        <div className="flex items-baseline justify-between gap-3">
          <p className={LUXE_LABEL}>Admission</p>
          <p className="flex items-center gap-1.5 text-fs-xs font-medium text-hero-ink-soft">
            <span aria-hidden className={cn('size-1.5 rounded-pill', isOpen ? 'bg-action' : 'bg-hero-accent-rule')} />
            {status}
          </p>
        </div>
        {price && (
          <p className="mt-2 font-display text-fs-3xl font-light tabular-nums text-hero-ink leading-none">{price}</p>
        )}
        {showRemaining && (
          <p className="mt-2 text-fs-xs text-hero-ink-soft">{remaining!.toLocaleString('en-IN')} places left</p>
        )}

        <Link
          href={isOpen && admission.directHref ? admission.directHref : '#tickets'}
          className={cn(
            isOpen
              ? marketingButton({ emphasis: 'gradient', variant: 'primary', size: 'lg' })
              : marketingButton({ variant: 'outline', size: 'lg' }),
            'mt-5 w-full gap-2',
          )}
        >
          {isOpen ? (free ? 'Register now' : 'Get tickets') : 'View admission'}
          <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>

      {rows.length > 0 && (
        <ul className="space-y-3.5 p-5 lg:border-t lg:border-border/60">
          {rows.map((r, i) => (
            <li key={i} className="flex items-start gap-3">
              <r.Icon className="mt-0.5 size-4 shrink-0 text-hero-accent-rule" aria-hidden />
              <div className="min-w-0">
                <p className="text-fs-sm font-medium text-hero-ink leading-snug">{r.value}</p>
                {r.sub && <p className="mt-0.5 text-fs-xs text-hero-ink-soft">{r.sub}</p>}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="grid grid-cols-2 divide-x divide-border/60 border-t border-border/60">
        <button
          type="button"
          onClick={handleShare}
          className="inline-flex h-11 items-center justify-center gap-1.5 text-fs-sm font-medium text-hero-ink-soft transition-colors hover:bg-surface-3/60 hover:text-hero-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-action"
        >
          {copied ? <Check className="size-4" aria-hidden /> : <Share2 className="size-4" aria-hidden />}
          {copied ? 'Link copied' : 'Share'}
        </button>
        {startDate ? (
          <AddToCalendarButton
            title={title}
            startDate={startDate}
            endDate={endDate || startDate}
            startTime={startTime}
            endTime={endTime}
            location={[venueName, physical?.city].filter(Boolean).join(', ')}
            description={description}
            slug={slug}
            label="Calendar"
            className="h-11 w-full justify-center rounded-none border-0 bg-transparent text-fs-sm font-medium text-hero-ink-soft shadow-none hover:bg-surface-3/60 hover:text-hero-ink"
          />
        ) : <span />}
      </div>

      {/* The way back for attendees who already registered (lost email, new phone). */}
      {passes.length > 0 && (
        <div className="border-t border-border/60 px-5 py-3.5 text-center">
          <DownloadTicketLink slug={slug} />
        </div>
      )}
    </div>
  )
}

'use client'

// RD-ATTENDEE-01 Phase 1C — a GENERIC mapper onto the shared EventHeroFramework, for
// templates that don't need type-specific hero terminology (Meetup, Team Sports). It
// mirrors SportsHero exactly but is type-agnostic (eventType drives the breadcrumb +
// icon), so both new templates reuse ONE hero implementation. All hero composition and
// interaction live in EventHeroFramework; this only translates event data into it.

import { Calendar, MapPin, Globe } from 'lucide-react'
import { EventHeroFramework } from '@/components/event-templates/shared/hero/EventHeroFramework'
import { formatDate, formatTime, formatINR, minPassPrice } from '@/components/event-templates/shared/utils/format'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'
import { getTemplate } from '@/lib/events/templateRegistry'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import type { PassPublic } from '@/components/event-templates/types'

export interface EventHeroProps {
  eventType:          string
  kicker?:            string
  title:              string
  tagline?:           string
  bannerUrl?:         string
  slug:               string
  startDate:          string
  startTime?:         string
  endDate?:           string
  endTime?:           string
  venueType:          'physical' | 'online' | 'hybrid'
  venueName:          string
  city?:              string
  lifecycleStatus?:   string
  registrationOpen:   boolean
  isFreeEvent:        boolean
  passes:             PassPublic[]
  organizerVerified?: boolean
  /** Anchor the primary CTA scrolls to — the template's registration section id. */
  registerHref?:      string
}

export function EventHero(props: EventHeroProps) {
  const {
    eventType, kicker, title, tagline, bannerUrl, slug,
    startDate, startTime = '', endDate = '', endTime = '',
    venueType, venueName, city,
    lifecycleStatus, registrationOpen, isFreeEvent, passes,
    organizerVerified, registerHref = '#tickets',
  } = props

  const activePasses = passes.filter(p => p.status !== 'inactive')
  const minPrice     = minPassPrice(activePasses)
  const canRegister  = registrationOpen && activePasses.length > 0

  const salesCloseDate = activePasses
    .map(p => p.salesEndDate?.trim())
    .filter(Boolean)
    .sort()[0] as string | undefined

  const whenLine  = [startDate && formatDate(startDate), startTime && formatTime(startTime)].filter(Boolean).join(' · ')
  const whereLine = venueType === 'online' ? 'Online event' : [venueName, city].filter(Boolean).join(', ')
  const essentials = [
    whenLine  && { icon: Calendar, text: whenLine },
    whereLine && { icon: venueType === 'online' ? Globe : MapPin, text: whereLine },
  ].filter(Boolean) as { icon: typeof Calendar; text: string }[]

  const trust = ['Secure Registration', organizerVerified ? 'Verified Organizer' : ''].filter(Boolean)
  const priceLabel = canRegister
    ? (isFreeEvent || minPrice === 0 ? 'Free entry' : `From ${formatINR(minPrice)}`)
    : undefined

  const crumbs = buildEventBreadcrumbs(eventType, title)

  return (
    <>
      <div className="border-b border-border/60 bg-white">
        <div className="mx-auto max-w-7xl px-5 py-3 sm:px-8 lg:px-8">
          <Breadcrumbs items={crumbs} />
        </div>
      </div>

      <EventHeroFramework
        kicker={kicker}
        title={title}
        icon={getTemplate(eventType)?.icon}
        tagline={tagline}
        bannerUrl={bannerUrl}
        status={registrationOpen ? { label: 'Registration Open', tone: 'open' } : undefined}
        essentials={essentials}
        timing={{ startDate, startTime, endDate, registrationOpen, salesCloseDate, lifecycleStatus }}
        primary={canRegister
          ? { label: isFreeEvent ? 'Register Free' : 'Register Now', href: registerHref }
          : undefined}
        calendar={startDate ? {
          title, startDate, endDate: endDate || startDate, startTime, endTime,
          location: whereLine, description: tagline ?? '', slug,
        } : undefined}
        priceLabel={priceLabel}
        trust={trust}
      />
    </>
  )
}

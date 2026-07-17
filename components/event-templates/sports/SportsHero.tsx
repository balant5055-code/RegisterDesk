'use client'

// SportsHero — sports content mapped onto the shared EventHeroFramework.
// All hero composition/interaction lives in the framework; this file only translates
// sports data + terminology into the framework's content contract. Other templates
// compose the same framework with their own mappers.

import { Calendar, MapPin, Globe } from 'lucide-react'
import { EventHeroFramework } from '@/components/event-templates/shared/hero/EventHeroFramework'
import { formatDate, formatTime, formatINR, minPassPrice } from '@/components/event-templates/shared/utils/format'
import { buildEventBreadcrumbs } from '@/lib/events/breadcrumbs'
import { getTemplate } from '@/lib/events/templateRegistry'
import { Breadcrumbs } from '@/components/ui/Breadcrumbs'
import type { PassPublic } from '@/components/event-templates/types'

export interface SportsHeroProps {
  title:              string
  tagline?:           string
  discipline?:        string
  edition?:           string
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
  hasRefundPolicy?:   boolean
  ctaLabel?:          string
  countdownLabel?:    string
}

export function SportsHero(props: SportsHeroProps) {
  const {
    title, tagline, discipline, edition, bannerUrl, slug,
    startDate, startTime = '', endDate = '', endTime = '',
    venueType, venueName, city,
    lifecycleStatus, registrationOpen, isFreeEvent, passes,
    organizerVerified, ctaLabel, countdownLabel,
  } = props

  const activePasses = passes.filter(p => p.status !== 'inactive')
  const minPrice     = minPassPrice(activePasses)
  const canRegister  = registrationOpen && activePasses.length > 0

  const salesCloseDate = activePasses
    .map(p => p.salesEndDate?.trim())
    .filter(Boolean)
    .sort()[0] as string | undefined

  const whenLine = [startDate && formatDate(startDate), startTime && formatTime(startTime)]
    .filter(Boolean).join(' · ')
  const whereLine = venueType === 'online'
    ? 'Online event'
    : [venueName, city].filter(Boolean).join(', ')
  const essentials = [
    whenLine  && { icon: Calendar, text: whenLine },
    whereLine && { icon: venueType === 'online' ? Globe : MapPin, text: whereLine },
  ].filter(Boolean) as { icon: typeof Calendar; text: string }[]

  const kicker = [discipline, edition].filter(Boolean).join(' · ') || undefined

  // Minimal, integrated trust — the platform guarantee plus verification when real.
  const trust = [
    'Secure Registration',
    organizerVerified ? 'Verified Organizer' : '',
  ].filter(Boolean)

  const priceLabel = canRegister
    ? (isFreeEvent || minPrice === 0 ? 'Free entry' : `From ${formatINR(minPrice)}`)
    : undefined

  const crumbs = buildEventBreadcrumbs('sports', title)

  return (
    <>
      {/* Breadcrumb row — its own horizontal band between the navbar and the hero */}
      <div className="border-b border-border/60 bg-white">
        <div className="mx-auto max-w-7xl px-5 py-3 sm:px-8 lg:px-8">
          <Breadcrumbs items={crumbs} />
        </div>
      </div>

      <EventHeroFramework
        kicker={kicker}
        title={title}
        icon={getTemplate('sports')?.icon}
        tagline={tagline}
        bannerUrl={bannerUrl}
        status={registrationOpen ? { label: 'Registration Open', tone: 'open' } : undefined}
        essentials={essentials}
        timing={{
          startDate, startTime, endDate,
          registrationOpen,
          salesCloseDate,
          lifecycleStatus,
          startLabel: countdownLabel,
        }}
        primary={canRegister
          ? { label: ctaLabel ?? (isFreeEvent ? 'Register Free' : 'Register Now'), href: '#register' }
          : undefined}
        calendar={startDate ? {
          title,
          startDate,
          endDate: endDate || startDate,
          startTime,
          endTime,
          location: whereLine,
          description: tagline ?? '',
          slug,
        } : undefined}
        priceLabel={priceLabel}
        trust={trust}
      />
    </>
  )
}

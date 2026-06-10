import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import Link from 'next/link'
import {
  Calendar, MapPin, Globe, Clock, ExternalLink, Link2,
  Mail, Phone, Ticket, ArrowRight, ChevronRight, Building2,
  Users, Tag, XCircle, CheckCircle, Lock,
} from 'lucide-react'
import { Navbar }           from '@/components/layout/navbar'
import { Container }        from '@/components/ui/Container'
import { buttonVariants }   from '@/components/ui/button'
import { cn }               from '@/lib/utils/cn'
import { getEventBySlug }             from '@/lib/firebase/firestore/events'
import { getRegistrationCounter }     from '@/lib/firebase/firestore/registrationCounters'
import { computeEventAvailability }   from '@/lib/registrations/availability'
import type { PassAvailability, CapacityPlan } from '@/lib/registrations/types'
import type {
  EventDetailsDraft, AgendaSession, Speaker, Sponsor, SponsorTier,
  VenueType, PhysicalVenueConfig, OnlineVenueConfig, OrganizerInfo,
  PublicPageSettings, MediaAsset,
} from '@/components/wizard/eventDetailsConfig'
import {
  SESSION_TYPE_LABELS, SPONSOR_TIER_LABELS, ONLINE_PLATFORM_LABELS,
} from '@/components/wizard/eventDetailsConfig'

// ─── Config ──────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

// ─── Local types ─────────────────────────────────────────────────────────────

// Matches the subset of EventPassFull stored in Firestore pricing.passes[]
interface PassPublic {
  id:              string
  name:            string
  description:     string
  price:           number
  quantity:        number | null
  unlimited:       boolean
  salesStartDate?: string   // 'YYYY-MM-DD'
  salesEndDate?:   string   // 'YYYY-MM-DD'
  hideWhenSoldOut?: boolean
  showRemainingSeats?: boolean
  status?:         'active' | 'inactive'
  visibility?:     string
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  if (!dateStr) return ''
  const [y, m, d] = dateStr.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString('en-IN', {
    weekday: 'short', day: 'numeric', month: 'long', year: 'numeric',
  })
}

function formatTime(timeStr: string): string {
  if (!timeStr) return ''
  const [h, m] = timeStr.split(':').map(Number)
  const ampm = h >= 12 ? 'PM' : 'AM'
  const h12  = h % 12 || 12
  return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`
}

function formatDateRange(
  startDate: string, startTime: string,
  endDate: string,   endTime: string,
): string {
  if (!startDate) return ''
  const datePart = startDate === endDate
    ? formatDate(startDate)
    : `${formatDate(startDate)} – ${formatDate(endDate)}`
  const timePart = startTime
    ? ` · ${formatTime(startTime)}${endTime ? ` – ${formatTime(endTime)}` : ''}`
    : ''
  return datePart + timePart
}

function formatINR(amount: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', maximumFractionDigits: 0,
  }).format(amount)
}

function venueLabel(
  type: VenueType,
  physical: PhysicalVenueConfig | undefined,
  online: OnlineVenueConfig | undefined,
): string {
  if (type === 'online' || type === 'hybrid') {
    const platform = online?.platform
    return platform ? ONLINE_PLATFORM_LABELS[platform] ?? 'Online' : 'Online'
  }
  const city = physical?.city?.trim()
  const name = physical?.name?.trim()
  return city ? (name ? `${name}, ${city}` : city) : (name ?? 'Venue TBA')
}

function extractSpeakers(typeDetails: Record<string, unknown> | null): Speaker[] {
  if (!typeDetails) return []
  const lists = [typeDetails.speakers, typeDetails.trainers, typeDetails.artists]
  return lists
    .filter(Array.isArray)
    .flatMap(l => l as Speaker[])
    .filter(s => s.name?.trim())
}

function extractSponsors(typeDetails: Record<string, unknown> | null): Sponsor[] {
  if (!typeDetails || !Array.isArray(typeDetails.sponsors)) return []
  return (typeDetails.sponsors as Sponsor[]).filter(s => s.name?.trim())
}

// ─── generateMetadata ─────────────────────────────────────────────────────────

type PageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  const event = await getEventBySlug(slug)
  if (!event) {
    return { title: 'Event Not Found – RegisterDesk' }
  }

  const ed      = event.eventDetails as unknown as EventDetailsDraft
  const title   = ed.seo?.metaTitle?.trim()   || ed.info?.name?.trim()     || 'Event'
  const desc    = ed.seo?.metaDescription?.trim() || ed.info?.shortDesc?.trim() || ''
  const image   = ed.media?.coverBanner?.value?.trim() || ed.media?.logo?.value?.trim() || ''
  const keywords = (ed.seo?.keywords ?? []).join(', ')
  const url      = `${BASE_URL}/events/${slug}`

  return {
    title:       `${title} – RegisterDesk`,
    description: desc,
    keywords:    keywords || undefined,
    metadataBase: new URL(BASE_URL),
    alternates:  { canonical: url },
    openGraph: {
      type:        'website',
      url,
      title,
      description: desc,
      images:      image ? [{ url: image, width: 1200, height: 630, alt: title }] : [],
      siteName:    'RegisterDesk',
    },
    twitter: {
      card:        'summary_large_image',
      title,
      description: desc,
      images:      image ? [image] : [],
    },
  }
}

// ─── JSON-LD ──────────────────────────────────────────────────────────────────

function buildJsonLd(
  slug:     string,
  ed:       EventDetailsDraft,
  passes:   PassPublic[],
): Record<string, unknown> {
  const venueType = ed.venue?.type ?? 'physical'
  const physical  = ed.venue?.physical
  const online    = ed.venue?.online
  const organizer = ed.organizer

  const location: Record<string, unknown> =
    venueType === 'online'
      ? { '@type': 'VirtualLocation', url: online?.meetingUrl || BASE_URL }
      : {
          '@type': 'Place',
          name:    physical?.name    || 'TBA',
          address: {
            '@type':           'PostalAddress',
            streetAddress:     physical?.addressLine1 || '',
            addressLocality:   physical?.city         || '',
            addressRegion:     physical?.state        || '',
            postalCode:        physical?.pincode      || '',
            addressCountry:    physical?.country      || 'IN',
          },
        }

  return {
    '@context': 'https://schema.org',
    '@type':    'Event',
    name:        ed.info?.name        || 'Event',
    description: ed.info?.shortDesc   || ed.info?.fullDesc || '',
    image:       ed.media?.coverBanner?.value || ed.media?.logo?.value || '',
    url:         `${BASE_URL}/events/${slug}`,
    startDate:   ed.schedule?.startDate
      ? `${ed.schedule.startDate}T${ed.schedule.startTime || '00:00'}:00`
      : undefined,
    endDate:     ed.schedule?.endDate
      ? `${ed.schedule.endDate}T${ed.schedule.endTime || '23:59'}:00`
      : undefined,
    eventStatus: 'https://schema.org/EventScheduled',
    eventAttendanceMode:
      venueType === 'online'
        ? 'https://schema.org/OnlineEventAttendanceMode'
        : venueType === 'hybrid'
          ? 'https://schema.org/MixedEventAttendanceMode'
          : 'https://schema.org/OfflineEventAttendanceMode',
    location,
    organizer: organizer?.name
      ? { '@type': 'Organization', name: organizer.name, email: organizer.email || undefined }
      : undefined,
    offers: passes.map(pass => ({
      '@type':       'Offer',
      name:          pass.name,
      price:         pass.price,
      priceCurrency: 'INR',
      availability:  'https://schema.org/InStock',
      url:           `${BASE_URL}/events/${slug}`,
    })),
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SectionHeader({ icon, title, subtitle }: {
  icon:      React.ReactNode
  title:     string
  subtitle?: string
}) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
        {icon}
      </div>
      <div>
        <h2 className="text-[1.05rem] font-bold tracking-tight text-foreground">{title}</h2>
        {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
      </div>
    </div>
  )
}

function AvailabilityBadge({ avail }: { avail: PassAvailability | undefined }) {
  if (!avail) return null

  if (avail.status === 'sold_out') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-[10.5px] font-semibold text-rose-600">
        Sold Out
      </span>
    )
  }
  if (avail.status === 'low') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[10.5px] font-semibold text-amber-700">
        Only {avail.remaining} left
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[10.5px] font-semibold text-emerald-700">
      Available
    </span>
  )
}

function PassesPanel({ passes, isFreeEvent, slug, availability, registrationOpen, closedMessage }: {
  passes:           PassPublic[]
  isFreeEvent:      boolean
  slug:             string
  availability:     Map<string, PassAvailability>
  registrationOpen: boolean
  closedMessage?:   string
}) {
  // Filter out inactive passes; optionally hide sold-out passes based on pass config
  const visiblePasses = passes.filter(pass => {
    if (pass.status === 'inactive') return false
    const avail = availability.get(pass.id)
    if (pass.hideWhenSoldOut && avail?.status === 'sold_out') return false
    return true
  })

  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Ticket className="size-4 text-primary" aria-hidden />
          <p className="font-semibold text-foreground">
            {isFreeEvent ? 'Free Registration' : 'Get Tickets'}
          </p>
        </div>
      </div>

      {/* Registrations closed notice */}
      {!registrationOpen ? (
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <Lock className="size-8 text-muted-foreground/50" aria-hidden />
          <p className="text-[14px] font-semibold text-foreground">Registrations are closed</p>
          <p className="text-[12.5px] text-muted-foreground">
            {closedMessage || 'Registration for this event is no longer available.'}
          </p>
        </div>
      ) : visiblePasses.length === 0 ? (
        <div className="px-5 py-8 text-center">
          <p className="text-sm text-muted-foreground">Registration coming soon</p>
        </div>
      ) : (
        <div className="divide-y divide-border/40">
          {visiblePasses.map(pass => {
            const avail   = availability.get(pass.id)
            const soldOut = avail?.status === 'sold_out'

            return (
              <div key={pass.id} className={cn('px-5 py-4', soldOut && 'opacity-60')}>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold text-foreground">{pass.name}</p>
                      <AvailabilityBadge avail={avail} />
                    </div>
                    {pass.description && (
                      <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{pass.description}</p>
                    )}
                    {/* Remaining count — shown when the pass opts in via showRemainingSeats */}
                    {pass.showRemainingSeats && avail && avail.remaining !== null && avail.status !== 'sold_out' && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Users className="size-3 shrink-0" aria-hidden />
                        {avail.remaining.toLocaleString('en-IN')} seats remaining
                      </p>
                    )}
                    {pass.salesEndDate && !soldOut && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <Clock className="size-3 shrink-0" aria-hidden />
                        Sale ends {formatDate(pass.salesEndDate)}
                      </p>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className={cn(
                      'text-lg font-extrabold',
                      isFreeEvent || pass.price === 0 ? 'text-emerald-600' : 'text-foreground',
                    )}>
                      {isFreeEvent || pass.price === 0 ? 'Free' : formatINR(pass.price)}
                    </p>
                  </div>
                </div>

                {soldOut ? (
                  <div className={cn(
                    buttonVariants({ variant: 'outline', size: 'md' }),
                    'mt-3 w-full cursor-not-allowed opacity-50',
                  )}>
                    Sold Out
                  </div>
                ) : (
                  <Link
                    href={`/events/${slug}/register?passId=${encodeURIComponent(pass.id)}`}
                    className={cn(
                      buttonVariants({ variant: 'primary', size: 'md' }),
                      'mt-3 w-full gap-2',
                    )}
                  >
                    {isFreeEvent || pass.price === 0 ? 'Register for Free' : 'Buy Ticket'}
                    <ArrowRight className="size-4" aria-hidden />
                  </Link>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div className="border-t border-border/40 bg-muted/30 px-5 py-3">
        <p className="text-center text-[11px] text-muted-foreground">
          Powered by <span className="font-semibold text-foreground">RegisterDesk</span>
        </p>
      </div>
    </div>
  )
}

function DescriptionSection({ description }: { description: string }) {
  return (
    <section aria-label="About this event">
      <SectionHeader icon={<ChevronRight className="size-4" aria-hidden />} title="About This Event" />
      <div className="prose prose-sm max-w-none rounded-xl border border-border bg-card p-5 text-foreground">
        {description.split('\n').filter(Boolean).map((para, i) => (
          <p key={i} className="mb-3 text-[13.5px] leading-relaxed text-muted-foreground last:mb-0">
            {para}
          </p>
        ))}
      </div>
    </section>
  )
}

function AgendaSection({ agenda }: { agenda: AgendaSession[] }) {
  const sorted = [...agenda]
    .filter(s => s.title?.trim())
    .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`))

  const byDate = sorted.reduce<Record<string, AgendaSession[]>>((acc, s) => {
    const key = s.date || ''
    if (!acc[key]) acc[key] = []
    acc[key].push(s)
    return acc
  }, {})

  const dates = Object.keys(byDate).sort()

  return (
    <section aria-label="Agenda">
      <SectionHeader
        icon={<Calendar className="size-4" aria-hidden />}
        title="Agenda"
        subtitle={`${sorted.length} session${sorted.length !== 1 ? 's' : ''}`}
      />
      <div className="flex flex-col gap-6">
        {dates.map(date => (
          <div key={date}>
            {date && dates.length > 1 && (
              <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {formatDate(date)}
              </p>
            )}
            <div className="flex flex-col gap-2">
              {byDate[date].map(session => (
                <div key={session.id}
                  className={cn(
                    'flex gap-3 rounded-xl border p-4 transition-colors',
                    session.isBreak
                      ? 'border-border/40 bg-muted/30'
                      : 'border-border bg-card',
                  )}>
                  {/* Time column */}
                  <div className="w-[68px] shrink-0 pt-0.5 text-right text-xs text-muted-foreground">
                    <p className="font-medium">{formatTime(session.startTime)}</p>
                    {session.endTime && <p className="mt-0.5">–{formatTime(session.endTime)}</p>}
                  </div>

                  {/* Divider */}
                  <div className="w-px shrink-0 self-stretch bg-border" />

                  {/* Content */}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={cn('font-semibold text-[13.5px]', session.isBreak ? 'text-muted-foreground' : 'text-foreground')}>
                        {session.title}
                      </p>
                      {!session.isBreak && (
                        <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                          {SESSION_TYPE_LABELS[session.type] ?? session.type}
                        </span>
                      )}
                      {session.track && (
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {session.track}
                        </span>
                      )}
                    </div>
                    {session.description && !session.isBreak && (
                      <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground line-clamp-2">
                        {session.description}
                      </p>
                    )}
                    {session.location && (
                      <p className="mt-1.5 flex items-center gap-1 text-[11.5px] text-muted-foreground">
                        <MapPin className="size-3 shrink-0" aria-hidden />{session.location}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function SpeakersSection({ speakers }: { speakers: Speaker[] }) {
  return (
    <section aria-label="Speakers">
      <SectionHeader
        icon={<Users className="size-4" aria-hidden />}
        title="Speakers"
        subtitle={`${speakers.length} speaker${speakers.length !== 1 ? 's' : ''}`}
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3">
        {speakers.map(speaker => (
          <div key={speaker.id}
            className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card p-4 text-center">
            {/* Photo */}
            <div className="size-16 overflow-hidden rounded-full bg-muted">
              {speaker.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={speaker.photoUrl} alt={speaker.name}
                  className="h-full w-full object-cover" />
              ) : (
                <div className="flex h-full w-full items-center justify-center bg-primary/10 text-primary">
                  <span className="text-xl font-bold">
                    {speaker.name.charAt(0).toUpperCase()}
                  </span>
                </div>
              )}
            </div>

            {/* Info */}
            <div className="min-w-0 w-full">
              <p className="truncate font-semibold text-[13px] text-foreground">{speaker.name}</p>
              {speaker.title && (
                <p className="truncate text-[11.5px] text-muted-foreground">{speaker.title}</p>
              )}
              {speaker.company && (
                <p className="truncate text-[11.5px] font-medium text-primary">{speaker.company}</p>
              )}
            </div>

            {/* Social */}
            {(speaker.social?.linkedin || speaker.social?.twitter) && (
              <div className="flex items-center gap-2">
                {speaker.social.linkedin && (
                  <a href={speaker.social.linkedin} target="_blank" rel="noopener noreferrer"
                    aria-label={`${speaker.name} on LinkedIn`}
                    className="text-muted-foreground hover:text-primary transition-colors">
                    <Link2 className="size-3.5" aria-hidden />
                  </a>
                )}
                {speaker.social.twitter && (
                  <a href={speaker.social.twitter} target="_blank" rel="noopener noreferrer"
                    aria-label={`${speaker.name} on X / Twitter`}
                    className="text-muted-foreground hover:text-primary transition-colors">
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

const TIER_ORDER: SponsorTier[] = ['title', 'gold', 'silver', 'bronze', 'partner', 'media']

function SponsorsSection({ sponsors }: { sponsors: Sponsor[] }) {
  const byTier = TIER_ORDER.reduce<Record<string, Sponsor[]>>((acc, tier) => {
    const list = sponsors.filter(s => s.tier === tier)
    if (list.length > 0) acc[tier] = list
    return acc
  }, {})

  return (
    <section aria-label="Sponsors">
      <SectionHeader icon={<Tag className="size-4" aria-hidden />} title="Sponsors" />
      <div className="flex flex-col gap-6">
        {Object.entries(byTier).map(([tier, list]) => (
          <div key={tier}>
            <p className="mb-3 text-xs font-semibold uppercase tracking-widest text-muted-foreground">
              {SPONSOR_TIER_LABELS[tier as SponsorTier]}
            </p>
            <div className={cn(
              'grid gap-3',
              tier === 'title' ? 'grid-cols-1 sm:grid-cols-2'
                : tier === 'gold' ? 'grid-cols-2 sm:grid-cols-3'
                : 'grid-cols-3 sm:grid-cols-4',
            )}>
              {list.map(sponsor => (
                <a
                  key={sponsor.id}
                  href={sponsor.website || '#'}
                  target={sponsor.website ? '_blank' : undefined}
                  rel="noopener noreferrer"
                  aria-label={sponsor.name}
                  className={cn(
                    'flex items-center justify-center rounded-xl border border-border bg-card p-4 transition-colors hover:border-primary/30 hover:bg-primary/5',
                    !sponsor.website && 'pointer-events-none',
                  )}>
                  {sponsor.logoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={sponsor.logoUrl} alt={sponsor.name}
                      className="max-h-12 w-auto object-contain" />
                  ) : (
                    <span className="text-sm font-semibold text-foreground">{sponsor.name}</span>
                  )}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function GallerySection({ gallery }: { gallery: MediaAsset[] }) {
  const images = gallery.filter(img => img.value?.trim())
  if (images.length === 0) return null

  return (
    <section aria-label="Gallery">
      <SectionHeader icon={<Globe className="size-4" aria-hidden />} title="Gallery" />
      <div className={cn(
        'grid gap-2',
        images.length === 1 ? 'grid-cols-1'
          : images.length === 2 ? 'grid-cols-2'
          : 'grid-cols-2 sm:grid-cols-3',
      )}>
        {images.map((img, i) => (
          <div key={i}
            className={cn(
              'overflow-hidden rounded-xl border border-border bg-muted',
              images.length >= 3 && i === 0 ? 'col-span-2 sm:col-span-1' : '',
            )}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={img.value}
              alt={img.originalFileName ?? `Gallery image ${i + 1}`}
              className="aspect-video w-full object-cover transition-transform duration-300 hover:scale-105"
              loading="lazy"
            />
          </div>
        ))}
      </div>
    </section>
  )
}

function OrganizerSection({ organizer, showSocial }: {
  organizer:  OrganizerInfo
  showSocial: boolean
}) {
  return (
    <section aria-label="Organizer">
      <SectionHeader icon={<Building2 className="size-4" aria-hidden />} title="Organized By" />
      <div className="rounded-xl border border-border bg-card p-5">
        <div className="flex items-center gap-4">
          {organizer.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={organizer.logoUrl} alt={organizer.name}
              className="size-14 rounded-xl object-contain border border-border" />
          ) : (
            <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Building2 className="size-6" aria-hidden />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="font-bold text-foreground">{organizer.name}</p>
            {organizer.website && (
              <a href={organizer.website} target="_blank" rel="noopener noreferrer"
                className="mt-0.5 flex items-center gap-1 text-xs text-primary hover:underline">
                <ExternalLink className="size-3" aria-hidden />
                {organizer.website.replace(/^https?:\/\//, '')}
              </a>
            )}
          </div>
        </div>

        {/* Contact */}
        {(organizer.email || organizer.phone) && (
          <div className="mt-4 flex flex-wrap gap-3">
            {organizer.email && (
              <a href={`mailto:${organizer.email}`}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
                <Mail className="size-3.5" aria-hidden />{organizer.email}
              </a>
            )}
            {organizer.phone && (
              <a href={`tel:${organizer.phone}`}
                className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-primary transition-colors">
                <Phone className="size-3.5" aria-hidden />{organizer.phone}
              </a>
            )}
          </div>
        )}

        {/* Social links */}
        {showSocial && organizer.social && (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            {([
              ['Twitter / X',  organizer.social.twitter],
              ['LinkedIn',     organizer.social.linkedin],
              ['Facebook',     organizer.social.facebook],
              ['Instagram',    organizer.social.instagram],
              ['YouTube',      organizer.social.youtube],
            ] as [string, string][]).filter(([, url]) => url?.trim()).map(([label, url]) => (
              <a key={label} href={url} target="_blank" rel="noopener noreferrer"
                className="flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] font-medium text-muted-foreground hover:border-primary/40 hover:text-primary transition-colors">
                <ExternalLink className="size-3" aria-hidden />{label}
              </a>
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function EventPage({ params }: PageProps) {
  const { slug } = await params

  // Fetch event + live registration counter in parallel
  const [event, counter] = await Promise.all([
    getEventBySlug(slug),
    getRegistrationCounter(slug),
  ])
  if (!event) notFound()

  // Draft and archived events are hidden from the public
  if (event.lifecycleStatus === 'archived' || event.lifecycleStatus === 'draft') notFound()

  const ls = event.lifecycleStatus

  const ed      = event.eventDetails as unknown as EventDetailsDraft
  const pricing = event.pricing as Record<string, unknown> | null

  // ── Registration window check ─────────────────────────────────────────────
  // Returns { open, message } — message shown when registrations are closed.
  const { registrationOpen, regClosedMessage } = (() => {
    if (ls === 'cancelled')           return { registrationOpen: false, regClosedMessage: 'This event has been cancelled.' }
    if (ls !== 'published')           return { registrationOpen: false, regClosedMessage: 'Registrations are closed.' }

    const schedule    = ed.schedule
    const tz          = (schedule?.timezone as string | undefined)?.trim() || 'UTC'
    const todayStr    = (() => {
      try {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())
      } catch {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())
      }
    })()

    const endDate        = (schedule?.endDate as string | undefined) || ''
    const regOpenDate    = (pricing?.registrationOpenDate  as string | undefined) || ''
    const regEndDate     = (pricing?.registrationEndDate   as string | undefined) || ''

    if (endDate && todayStr > endDate)  return { registrationOpen: false, regClosedMessage: 'This event has already ended.' }
    if (regOpenDate && todayStr < regOpenDate) {
      const fmt = new Date(regOpenDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
      return { registrationOpen: false, regClosedMessage: `Registration opens on ${fmt}.` }
    }
    if (regEndDate && todayStr > regEndDate)  return { registrationOpen: false, regClosedMessage: 'Registration for this event has closed.' }

    return { registrationOpen: true, regClosedMessage: '' }
  })()

  // ── Core fields ──────────────────────────────────────────────────────────
  const title      = ed.info?.name?.trim()    || 'Untitled Event'
  const tagline    = ed.info?.tagline?.trim() || ''
  const fullDesc   = ed.info?.fullDesc?.trim() || ''
  const shortDesc  = ed.info?.shortDesc?.trim() || ''
  const description = fullDesc || shortDesc

  // ── Media ────────────────────────────────────────────────────────────────
  const bannerUrl  = ed.media?.coverBanner?.value?.trim() || ''
  const logoUrl    = ed.media?.logo?.value?.trim()        || ''
  const gallery    = (ed.media?.galleryImages ?? []).filter(img => img.value?.trim())

  // ── Schedule ─────────────────────────────────────────────────────────────
  const startDate  = ed.schedule?.startDate || ''
  const startTime  = ed.schedule?.startTime || ''
  const endDate    = ed.schedule?.endDate   || ''
  const endTime    = ed.schedule?.endTime   || ''
  const agenda     = (ed.schedule?.agenda ?? []).filter(s => s.title?.trim())

  // ── Venue ─────────────────────────────────────────────────────────────────
  const venueType  = ed.venue?.type       ?? 'physical'
  const physical   = ed.venue?.physical
  const online     = ed.venue?.online
  const venueName  = venueLabel(venueType, physical, online)
  const mapsLink   = physical?.mapsLink?.trim() || ''

  // ── Organizer ────────────────────────────────────────────────────────────
  const organizer  = ed.organizer

  // ── Type-specific ─────────────────────────────────────────────────────────
  const typeDetails = ed.typeDetails as Record<string, unknown> | null
  const speakers    = extractSpeakers(typeDetails)
  const sponsors    = extractSponsors(typeDetails)

  // ── Visibility toggles ────────────────────────────────────────────────────
  const pp           = ed.publicPage
  const showOrg      = pp?.showOrganizerInfo !== false
  const showSpeakers = pp?.showSpeakers      !== false
  const showSponsors = pp?.showSponsors      !== false
  const showAgenda   = pp?.showAgenda        !== false
  const showGallery  = pp?.showGallery       !== false
  const showSocial   = pp?.showSocialLinks   !== false

  // ── Passes ───────────────────────────────────────────────────────────────
  const isFreeEvent = pricing?.eventType === 'free'
  const passes: PassPublic[] = (
    Array.isArray(pricing?.passes) ? (pricing!.passes as PassPublic[]) : []
  ).filter(p => p.name?.trim())

  // ── Real-time availability ────────────────────────────────────────────────
  const availability = computeEventAvailability(
    passes,
    (event.capacityPlan ?? 'free') as CapacityPlan,
    counter,
  )

  // ── JSON-LD ───────────────────────────────────────────────────────────────
  const jsonLd = buildJsonLd(slug, ed, passes)

  // ── Venue address string ──────────────────────────────────────────────────
  const physicalAddress = [
    physical?.addressLine1,
    physical?.city,
    physical?.state,
    physical?.pincode,
  ].filter(Boolean).join(', ')

  return (
    <>
      {/* JSON-LD structured data */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          // Escape '<' so "</script>" sequences inside JSON string values
          // cannot terminate this script block and inject arbitrary HTML.
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />

      <div className="min-h-screen bg-background font-sans">
        <Navbar />

        {/* ── Lifecycle state banners ────────────────────────────────── */}
        {ls === 'cancelled' && (
          <div className="border-b border-red-200 bg-red-50 px-4 py-3">
            <Container>
              <div className="flex items-start gap-3">
                <XCircle className="mt-0.5 size-5 shrink-0 text-red-500" aria-hidden />
                <div>
                  <p className="text-[14px] font-bold text-red-700">This event has been cancelled</p>
                  {event.cancelReason && (
                    <p className="mt-0.5 text-[13px] text-red-600">{event.cancelReason}</p>
                  )}
                </div>
              </div>
            </Container>
          </div>
        )}

        {ls === 'completed' && (
          <div className="border-b border-sky-200 bg-sky-50 px-4 py-3">
            <Container>
              <div className="flex items-center gap-3">
                <CheckCircle className="size-5 shrink-0 text-sky-500" aria-hidden />
                <p className="text-[13px] font-semibold text-sky-700">This event has ended. Thank you to all who attended!</p>
              </div>
            </Container>
          </div>
        )}

        {ls === 'registration_closed' && (
          <div className="border-b border-amber-200 bg-amber-50 px-4 py-3">
            <Container>
              <div className="flex items-center gap-3">
                <Lock className="size-5 shrink-0 text-amber-500" aria-hidden />
                <p className="text-[13px] font-semibold text-amber-700">Registrations are currently closed for this event.</p>
              </div>
            </Container>
          </div>
        )}

        {/* ── Hero ──────────────────────────────────────────────────────── */}
        <section className="relative overflow-hidden" aria-label="Event hero">
          {/* Banner image or gradient placeholder */}
          <div className="relative h-[380px] w-full sm:h-[480px] lg:h-[540px]">
            {bannerUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={bannerUrl}
                alt={`${title} cover`}
                className="absolute inset-0 h-full w-full object-cover"
                priority-fetch="high"
              />
            ) : (
              <div className="absolute inset-0 bg-gradient-to-br from-primary-from via-primary to-primary-to" />
            )}

            {/* Dark gradient overlay for text legibility */}
            <div className="absolute inset-0 bg-gradient-to-t from-black/85 via-black/40 to-transparent" />

            {/* Subtle top bar darkening for Navbar contrast */}
            <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/40 to-transparent" />
          </div>

          {/* Hero content — positioned over banner */}
          <Container className="absolute bottom-0 left-0 right-0 pb-8 sm:pb-10">
            <div className="flex items-end gap-4">

              {/* Logo badge */}
              {logoUrl && (
                <div className="mb-1 shrink-0">
                  <div className="size-[68px] overflow-hidden rounded-2xl border-2 border-white/25 bg-white/10 shadow-xl backdrop-blur-sm sm:size-20">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={logoUrl} alt={`${title} logo`}
                      className="h-full w-full object-contain p-1" />
                  </div>
                </div>
              )}

              <div className="min-w-0 flex-1 pb-1">
                {/* Event type badge */}
                {event.eventType && (
                  <span className="mb-2 inline-block rounded-full bg-white/15 px-3 py-1 text-[10.5px] font-bold uppercase tracking-wider text-white backdrop-blur-sm">
                    {event.eventType}{event.eventSubtype ? ` · ${event.eventSubtype}` : ''}
                  </span>
                )}

                {/* Title */}
                <h1 className="text-[1.6rem] font-extrabold leading-tight tracking-tight text-white drop-shadow sm:text-[2rem] lg:text-[2.4rem]">
                  {title}
                </h1>

                {/* Tagline */}
                {tagline && (
                  <p className="mt-1.5 text-sm font-medium text-white/80 sm:text-base line-clamp-2">
                    {tagline}
                  </p>
                )}

                {/* Meta pills */}
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {startDate && (
                    <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm">
                      <Calendar className="size-3.5 shrink-0" aria-hidden />
                      {formatDateRange(startDate, startTime, endDate, endTime)}
                    </span>
                  )}

                  {venueName && (
                    <span className="flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-[12px] font-medium text-white backdrop-blur-sm">
                      {venueType === 'online'
                        ? <Globe className="size-3.5 shrink-0" aria-hidden />
                        : <MapPin className="size-3.5 shrink-0" aria-hidden />
                      }
                      {venueName}
                    </span>
                  )}
                </div>

                {/* Mobile CTA — shown only on small screens when registration is open */}
                {registrationOpen && passes.length > 0 && (
                  <div className="mt-4 flex items-center gap-3 lg:hidden">
                    <Link
                      href={`#tickets`}
                      className={cn(buttonVariants({ variant: 'primary', size: 'md' }), 'gap-2 shadow-lg')}
                    >
                      <Ticket className="size-4" aria-hidden />
                      {isFreeEvent ? 'Register Free' : 'Get Tickets'}
                    </Link>
                    <span className="text-sm font-semibold text-white/90">
                      {isFreeEvent ? 'Free entry' : `From ${formatINR(Math.min(...passes.map(p => p.price ?? 0)))}`}
                    </span>
                  </div>
                )}
              </div>
            </div>
          </Container>
        </section>

        {/* ── Body ──────────────────────────────────────────────────────── */}
        <Container className="py-8 sm:py-10">
          <div className="lg:grid lg:grid-cols-[1fr_360px] lg:items-start lg:gap-8">

            {/* ── Left: Content sections ─────────────────────────────── */}
            <div className="flex flex-col gap-10">

              {/* Passes panel — mobile position (above content, below hero) */}
              <div id="tickets" className="lg:hidden">
                <PassesPanel passes={passes} isFreeEvent={isFreeEvent} slug={slug} availability={availability} registrationOpen={registrationOpen} closedMessage={regClosedMessage} />
              </div>

              {/* Venue detail card (physical or hybrid) */}
              {(venueType === 'physical' || venueType === 'hybrid') && physical?.name && (
                <section aria-label="Venue">
                  <SectionHeader icon={<MapPin className="size-4" aria-hidden />} title="Venue" />
                  <div className="rounded-xl border border-border bg-card p-5">
                    <p className="font-semibold text-foreground">{physical.name}</p>
                    {physicalAddress && (
                      <p className="mt-1 text-sm text-muted-foreground">{physicalAddress}</p>
                    )}
                    {physical.instructions && (
                      <p className="mt-3 text-[13px] text-muted-foreground">{physical.instructions}</p>
                    )}
                    {mapsLink && (
                      <a
                        href={mapsLink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'mt-4 gap-1.5')}
                      >
                        <ExternalLink className="size-3.5" aria-hidden />
                        Open in Maps
                      </a>
                    )}
                  </div>
                </section>
              )}

              {/* Online venue info */}
              {(venueType === 'online' || venueType === 'hybrid') && online?.platform && (
                <section aria-label="Online access">
                  <SectionHeader icon={<Globe className="size-4" aria-hidden />} title="Online Access" />
                  <div className="rounded-xl border border-border bg-card p-5">
                    <p className="font-semibold text-foreground">
                      {ONLINE_PLATFORM_LABELS[online.platform] ?? online.platform}
                      {online.platformCustomName && ` · ${online.platformCustomName}`}
                    </p>
                    {online.revealAfterRegistration ? (
                      <p className="mt-2 text-sm text-muted-foreground">
                        Meeting link will be shared after registration.
                      </p>
                    ) : online.joinInstructions ? (
                      <p className="mt-2 text-sm text-muted-foreground">{online.joinInstructions}</p>
                    ) : null}
                  </div>
                </section>
              )}

              {/* Description */}
              {description && <DescriptionSection description={description} />}

              {/* Agenda */}
              {showAgenda && agenda.length > 0 && <AgendaSection agenda={agenda} />}

              {/* Speakers */}
              {showSpeakers && speakers.length > 0 && <SpeakersSection speakers={speakers} />}

              {/* Sponsors */}
              {showSponsors && sponsors.length > 0 && <SponsorsSection sponsors={sponsors} />}

              {/* Gallery */}
              {showGallery && gallery.length > 0 && <GallerySection gallery={gallery} />}

              {/* Organizer */}
              {showOrg && organizer?.name && (
                <OrganizerSection organizer={organizer} showSocial={showSocial} />
              )}
            </div>

            {/* ── Right: Sticky passes panel (desktop) ───────────────── */}
            <div className="hidden lg:block">
              <div className="sticky top-24 flex flex-col gap-4">
                {/* Quick info card */}
                <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
                  <div className="divide-y divide-border/40">
                    {startDate && (
                      <div className="flex items-start gap-3 px-5 py-4">
                        <Calendar className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">Date &amp; Time</p>
                          <p className="mt-0.5 text-[13px] font-medium text-foreground">
                            {formatDate(startDate)}
                          </p>
                          {startTime && (
                            <p className="text-[12px] text-muted-foreground">
                              {formatTime(startTime)}{endTime ? ` – ${formatTime(endTime)}` : ''}
                            </p>
                          )}
                        </div>
                      </div>
                    )}

                    {venueName && (
                      <div className="flex items-start gap-3 px-5 py-4">
                        {venueType === 'online'
                          ? <Globe className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                          : <MapPin className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
                        }
                        <div>
                          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
                            {venueType === 'online' ? 'Platform' : 'Location'}
                          </p>
                          <p className="mt-0.5 text-[13px] font-medium text-foreground">{venueName}</p>
                          {physical?.city && venueType !== 'online' && (
                            <p className="text-[12px] text-muted-foreground">
                              {[physical.city, physical.state].filter(Boolean).join(', ')}
                            </p>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                {/* Passes */}
                <PassesPanel passes={passes} isFreeEvent={isFreeEvent} slug={slug} availability={availability} registrationOpen={registrationOpen} closedMessage={regClosedMessage} />
              </div>
            </div>

          </div>
        </Container>
      </div>
    </>
  )
}

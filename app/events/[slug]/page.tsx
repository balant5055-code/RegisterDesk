import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { adminDb }                  from '@/lib/firebase/admin'
import { getEventBySlug }           from '@/lib/firebase/firestore/events'
import { canExposePublicEvent }     from '@/lib/events/publicVisibility'
import { isContentTakenDown }       from '@/lib/admin/moderation'
import ReportButton                  from '@/components/report/ReportButton'
import { getRegistrationCounter }   from '@/lib/firebase/firestore/registrationCounters'
import { getCampaignBySlug, getCampaignCounter } from '@/lib/firebase/firestore/campaigns'
import { computeEventAvailability } from '@/lib/registrations/availability'
import type { PassAvailability, CapacityPlan } from '@/lib/registrations/types'
import type {
  EventDetailsDraft,
  VenueType, PhysicalVenueConfig, OnlineVenueConfig,
  Speaker, Sponsor,
} from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import { TemplateRouter } from '@/components/event-templates/TemplateRouter'
import type { PassPublic } from '@/components/event-templates/types'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://registerdesk.in'

export const revalidate = 60

// ─── Helpers ──────────────────────────────────────────────────────────────────

function venueLabel(
  type:     VenueType,
  physical: PhysicalVenueConfig | undefined,
  online:   OnlineVenueConfig   | undefined,
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
  // judges is used by the Awards type; speakers/trainers/artists by others.
  const lists = [typeDetails.speakers, typeDetails.trainers, typeDetails.artists, typeDetails.judges]
  return lists
    .filter(Array.isArray)
    .flatMap(l => l as Speaker[])
    .filter(s => s.name?.trim())
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function extractSponsors(ed: EventDetailsDraft, typeDetails: Record<string, unknown> | null): Sponsor[] {
  let list: Sponsor[]
  // Try the new top-level sponsors field first.
  if (Array.isArray(ed.sponsors) && ed.sponsors.length > 0) {
    list = (ed.sponsors as Sponsor[]).filter(s => s.name?.trim())
  } else if (typeDetails && Array.isArray(typeDetails.sponsors)) {
    // Backward-compat: old Conference events stored sponsors inside typeDetails.sponsors.
    list = (typeDetails.sponsors as Sponsor[]).filter(s => s.name?.trim())
  } else {
    return []
  }
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

// ─── generateMetadata ─────────────────────────────────────────────────────────

type PageProps = { params: Promise<{ slug: string }> }

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params
  // Runtime-editable platform identity (this route is already dynamic/ISR).
  const { platformName, baseUrl } = await getBrandingConfig()
  const event = await getEventBySlug(slug)
  if (!event) return { title: `Event Not Found – ${platformName}` }

  const ed       = event.eventDetails as unknown as EventDetailsDraft
  const title    = ed.seo?.metaTitle?.trim()       || ed.info?.name?.trim()      || 'Event'
  const desc     = ed.seo?.metaDescription?.trim() || ed.info?.shortDesc?.trim() || ''
  const image    = ed.media?.coverBanner?.value?.trim() || ed.media?.logo?.value?.trim() || ''
  const keywords = (ed.seo?.keywords ?? []).join(', ')
  const url      = `${baseUrl}/events/${slug}`

  return {
    title:       `${title} – ${platformName}`,
    description: desc,
    keywords:    keywords || undefined,
    metadataBase: new URL(baseUrl),
    alternates:  { canonical: url },
    openGraph: {
      type:        'website',
      url,
      title,
      description: desc,
      images:      image ? [{ url: image, width: 1200, height: 630, alt: title }] : [],
      siteName:    platformName,
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
  slug:   string,
  ed:     EventDetailsDraft,
  passes: PassPublic[],
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
          name:    physical?.name || 'TBA',
          address: {
            '@type':         'PostalAddress',
            streetAddress:   physical?.addressLine1 || '',
            addressLocality: physical?.city         || '',
            addressRegion:   physical?.state        || '',
            postalCode:      physical?.pincode      || '',
            addressCountry:  physical?.country      || 'IN',
          },
        }

  return {
    '@context': 'https://schema.org',
    '@type':    'Event',
    name:        ed.info?.name      || 'Event',
    description: ed.info?.shortDesc || ed.info?.fullDesc || '',
    image:       ed.media?.coverBanner?.value || ed.media?.logo?.value || '',
    url:         `${BASE_URL}/events/${slug}`,
    startDate: ed.schedule?.startDate
      ? `${ed.schedule.startDate}T${ed.schedule.startTime || '00:00'}:00`
      : undefined,
    endDate: ed.schedule?.endDate
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

// ─── Page ─────────────────────────────────────────────────────────────────────

export default async function EventPage({ params }: PageProps) {
  const { slug } = await params

  const [event, counter] = await Promise.all([
    getEventBySlug(slug),
    getRegistrationCounter(slug),
  ])
  if (!event) notFound()
  // Public visibility is a single ALLOW-LIST (canExposePublicEvent). Any lifecycle
  // state that is not explicitly publicly-visible — including future states — 404s.
  if (!canExposePublicEvent(event.lifecycleStatus)) notFound()
  // Admin moderation — a taken-down event is not publicly viewable.
  if (isContentTakenDown(event.moderationStatus)) notFound()

  // Load linked donation campaign for event_plus_donation events
  const linkedCampaign = await (async () => {
    if (!event.linkedCampaignSlug) return null
    const [campaign, donCounter] = await Promise.all([
      getCampaignBySlug(event.linkedCampaignSlug),
      getCampaignCounter(event.linkedCampaignSlug),
    ])
    if (!campaign) return null
    const cd = campaign.campaignDetails
    return {
      slug:               campaign.slug,
      title:              cd.basics.title,
      story:              cd.basics.story,
      targetAmountRupees: cd.goal.targetAmountRupees,
      showGoalAmount:     cd.goal.showGoalAmount,
      endDate:            cd.goal.endDate,
      totalRaisedPaise:   donCounter?.totalRaisedPaise ?? 0,
      donorCount:         donCounter?.donorCount       ?? 0,
    }
  })()

  // Load registered exhibitors for exhibition public directory
  const exhibitorDirectory = await (async () => {
    if (event.eventType !== 'exhibition') return []
    try {
      const snap = await adminDb
        .collection('registrations')
        .where('eventSlug', '==', slug)
        .where('status',    '==', 'confirmed')
        .limit(200)
        .get()
      const out: { companyName: string; website: string | null }[] = []
      for (const doc of snap.docs) {
        const r = doc.data() as Record<string, unknown>
        const passName = (r.passName as string | undefined ?? '').toLowerCase()
        if (!passName.includes('exhibitor')) continue
        const cn = (r.companyName as string | null | undefined)?.trim()
        if (!cn) continue
        out.push({ companyName: cn, website: (r.website as string | null | undefined)?.trim() || null })
      }
      return out
    } catch {
      return []
    }
  })()

  const ls      = event.lifecycleStatus
  const ed      = event.eventDetails as unknown as EventDetailsDraft
  const pricing = event.pricing as Record<string, unknown> | null

  // ── Registration window ────────────────────────────────────────────────────
  const { registrationOpen, regClosedMessage } = (() => {
    if (ls === 'cancelled') return { registrationOpen: false, regClosedMessage: 'This event has been cancelled.' }
    if (ls !== 'published') return { registrationOpen: false, regClosedMessage: 'Registrations are closed.' }

    const schedule = ed.schedule
    const tz       = (schedule?.timezone as string | undefined)?.trim() || 'UTC'
    const todayStr = (() => {
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

    const endDate     = (schedule?.endDate              as string | undefined) || ''
    const regOpenDate = (pricing?.registrationOpenDate  as string | undefined) || ''
    const regEndDate  = (pricing?.registrationEndDate   as string | undefined) || ''

    if (endDate && todayStr > endDate)
      return { registrationOpen: false, regClosedMessage: 'This event has already ended.' }
    if (regOpenDate && todayStr < regOpenDate) {
      const fmt = new Date(regOpenDate).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
      return { registrationOpen: false, regClosedMessage: `Registration opens on ${fmt}.` }
    }
    if (regEndDate && todayStr > regEndDate)
      return { registrationOpen: false, regClosedMessage: 'Registration for this event has closed.' }

    return { registrationOpen: true, regClosedMessage: '' }
  })()

  // ── Core ───────────────────────────────────────────────────────────────────
  const title       = ed.info?.name?.trim()     || 'Untitled Event'
  const tagline     = ed.info?.tagline?.trim()  || ''
  const fullDesc    = ed.info?.fullDesc?.trim()  || ''
  const shortDesc   = ed.info?.shortDesc?.trim() || ''
  const description = fullDesc || shortDesc

  // ── Media ──────────────────────────────────────────────────────────────────
  const bannerUrl = ed.media?.coverBanner?.value?.trim() || ''
  const logoUrl   = ed.media?.logo?.value?.trim()        || ''
  const gallery   = (ed.media?.galleryImages ?? []).filter(img => img.value?.trim())

  // ── Schedule ───────────────────────────────────────────────────────────────
  const startDate = ed.schedule?.startDate || ''
  const startTime = ed.schedule?.startTime || ''
  const endDate   = ed.schedule?.endDate   || ''
  const endTime   = ed.schedule?.endTime   || ''
  const agenda    = (ed.schedule?.agenda ?? []).filter(s => s.title?.trim())

  // ── Venue ──────────────────────────────────────────────────────────────────
  const venueType      = ed.venue?.type ?? 'physical'
  const physical       = ed.venue?.physical
  const online         = ed.venue?.online
  const venueName      = venueLabel(venueType, physical, online)
  const mapsLink  = physical?.mapsLink?.trim() || ''
  const venueMaps = physical?.maps?.layoutImageUrl?.trim() ||
    physical?.maps?.parkingMapUrl?.trim() ||
    physical?.maps?.entryGateMapUrl?.trim()
    ? physical!.maps
    : null

  // ── Additional info ────────────────────────────────────────────────────────
  const promoVideoUrl    = ed.media?.promoVideoUrl?.trim()       || ''
  const doorsOpenTime    = ed.schedule?.doorsOpenTime?.trim()    || ''

  // ── Organizer ──────────────────────────────────────────────────────────────
  const organizer = ed.organizer

  // ── Type-specific ──────────────────────────────────────────────────────────
  const typeDetails = ed.typeDetails as Record<string, unknown> | null
  const speakers    = extractSpeakers(typeDetails)
  const sponsors    = extractSponsors(ed, typeDetails)
  const experience  = Array.isArray(ed.experience) ? ed.experience : []
  const timeline    = Array.isArray(ed.timeline) ? ed.timeline : []
  const galleryMedia = Array.isArray(ed.gallery) ? ed.gallery : []
  const faq          = Array.isArray(ed.faq) ? ed.faq : []

  // ── Visibility toggles ─────────────────────────────────────────────────────
  const pp           = ed.publicPage
  const showOrg           = pp?.showOrganizerInfo !== false
  const showSpeakers      = pp?.showSpeakers      !== false
  const showSponsors      = pp?.showSponsors      !== false
  const showVenueMap      = pp?.showVenueMap      !== false
  const showAgenda        = pp?.showAgenda        !== false
  const showGallery       = pp?.showGallery       !== false
  const showSocial        = pp?.showSocialLinks   !== false
  const showAttendeeCount = pp?.showAttendeeCount === true

  // ── Applications ───────────────────────────────────────────────────────────
  const appsCfg = ed.applications as unknown as Record<string, unknown> | null | undefined
  const speakerApplicationsOpen = ls === 'published' &&
    (appsCfg?.speaker as Record<string, unknown> | null)?.enabled === true
  const sponsorApplicationsOpen = ls === 'published' &&
    (appsCfg?.sponsor as Record<string, unknown> | null)?.enabled === true

  // ── Passes ─────────────────────────────────────────────────────────────────
  const isFreeEvent = pricing?.eventType === 'free'
  const rawPasses   = Array.isArray(pricing?.passes) ? (pricing!.passes as PassPublic[]) : []
  const passes: PassPublic[] = rawPasses.filter(
    p => !!(p.name?.trim()) && p.visibility !== 'private' && p.visibility !== 'invite_only',
  )

  // ── Availability ───────────────────────────────────────────────────────────
  const availability = computeEventAvailability(
    passes,
    (event.capacityPlan ?? 'free') as CapacityPlan,
    counter,
  )
  const availabilityRecord: Record<string, PassAvailability> = Object.fromEntries(availability)

  // ── Event info ─────────────────────────────────────────────────────────────
  const language  = ed.info?.language?.trim()  || ''
  const dressCode = ed.info?.dressCode?.trim() || ''

  // ── Support ────────────────────────────────────────────────────────────────
  const faqUrl          = ed.support?.faqUrl?.trim()             || ''
  const supportEmail    = ed.support?.supportEmail?.trim()       || ''
  const supportPhone    = ed.support?.supportPhone?.trim()       || ''
  const termsUrl        = ed.support?.termsUrl?.trim()           || ''
  const refundPolicyUrl = ed.support?.refundPolicyUrl?.trim()    || ''
  const privacyPolicyUrl = ed.support?.privacyPolicyUrl?.trim()  || ''

  // ── JSON-LD ────────────────────────────────────────────────────────────────
  const jsonLd = buildJsonLd(slug, ed, passes)

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          // Escape '<' to prevent '</script>' injection inside JSON string values.
          __html: JSON.stringify(jsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <TemplateRouter
        slug={slug}
        lifecycleStatus={ls}
        cancelReason={event.cancelReason ?? undefined}
        eventType={event.eventType ?? undefined}
        eventSubtype={event.eventSubtype ?? undefined}
        registrationOpen={registrationOpen}
        regClosedMessage={regClosedMessage}
        title={title}
        tagline={tagline}
        description={description}
        bannerUrl={bannerUrl}
        logoUrl={logoUrl}
        gallery={gallery}
        promoVideoUrl={promoVideoUrl}
        startDate={startDate}
        startTime={startTime}
        endDate={endDate}
        endTime={endTime}
        doorsOpenTime={doorsOpenTime}
        agenda={agenda}
        venueType={venueType}
        physical={physical}
        online={online}
        venueName={venueName}
        mapsLink={mapsLink}
        venueMaps={venueMaps}
        organizer={organizer}
        showOrg={showOrg}
        showSocial={showSocial}
        showVenueMap={showVenueMap}
        isFreeEvent={isFreeEvent}
        passes={passes}
        availability={availabilityRecord}
        speakers={speakers}
        sponsors={sponsors}
        showSpeakers={showSpeakers}
        showSponsors={showSponsors}
        showAgenda={showAgenda}
        showGallery={showGallery}
        showAttendeeCount={showAttendeeCount}
        typeDetails={typeDetails}
        experience={experience}
        timeline={timeline}
        galleryMedia={galleryMedia}
        faq={faq}
        language={language}
        dressCode={dressCode}
        faqUrl={faqUrl}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
        linkedCampaign={linkedCampaign}
        exhibitorDirectory={exhibitorDirectory}
        speakerApplicationsOpen={speakerApplicationsOpen}
        sponsorApplicationsOpen={sponsorApplicationsOpen}
      />
      <div className="mx-auto max-w-3xl px-4 py-8 text-center">
        <ReportButton targetType="event" targetId={slug} label="Report this event" />
      </div>
    </>
  )
}

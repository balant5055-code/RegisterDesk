'use client'

import { motion } from 'framer-motion'
import {
  XCircle, CheckCircle, Lock, Clock3,
  Calendar, MapPin, Globe, Ticket, Clock, AlarmClock, Languages, Shirt,
} from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import { EventPageLayout }     from '@/components/event-templates/shared/ui/EventPageLayout'
import { AddToCalendarButton } from '@/components/event-templates/shared/ui/AddToCalendarButton'
import type { CommunityDetails } from '@/components/wizard/eventDetailsConfig'
import { StickyMobileCTA }   from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { PromoVideoSection } from '@/components/event-templates/shared/media/PromoVideoSection'
import { SpeakersSection }   from '@/components/event-templates/shared/people/SpeakersSection'
import { ConferenceSponsors } from '@/components/event-templates/conference/ConferenceSponsors'
import { CommunityFAQ }      from './CommunityFAQ'
import { CommunityHero }           from './CommunityHero'
import { CommunityImpactNumbers }  from './CommunityImpactNumbers'
import { CommunityProblemSection } from './CommunityProblemSection'
import { CommunityMasonry }        from './CommunityMasonry'
import { CommunityActionCards }    from './CommunityActionCards'
import { CommunityEventJourney }   from './CommunityEventJourney'
import { CommunityRegistration }   from './CommunityRegistration'
import { CommunityVenue }          from './CommunityVenue'
import { CommunityOrganizer }      from './CommunityOrganizer'

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${(m ?? 0).toString().padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

export function CommunityTemplate(props: EventDetailProps) {
  const {
    slug, lifecycleStatus: ls, cancelReason,
    registrationOpen, regClosedMessage,
    title, description,
    bannerUrl, gallery,
    startDate, startTime, endDate,
    agenda,
    venueType, physical, online, venueName, mapsLink, venueMaps,
    showVenueMap,
    organizer, showOrg, showSocial,
    isFreeEvent, passes, availability,
    speakers, sponsors,
    showSpeakers, showSponsors, showAgenda, showGallery, showAttendeeCount,
    typeDetails,
    promoVideoUrl, doorsOpenTime, language, dressCode,
    faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
  } = props

  const totalAttendees = Object.values(availability)[0]?.eventTotalCount ?? 0

  const td                    = typeDetails as CommunityDetails | null
  const causeInfo             = td?.causeInfo             ?? ''
  const impactGoal            = td?.impactGoal            ?? ''
  const campaignInfo          = td?.campaignInfo          ?? ''
  const volunteerInstructions = td?.volunteerInstructions ?? ''

  const activePasses  = passes.filter(p => p.status !== 'inactive')
  const minPrice      = activePasses.length > 0 ? Math.min(...activePasses.map(p => p.price)) : 0
  const locationLabel = venueType === 'online'
    ? 'Online Event'
    : physical?.city ? `${venueName}, ${physical.city}` : venueName
  const venueLabel    = venueType === 'physical' ? 'In-person'
    : venueType === 'online' ? 'Online'
    : 'Hybrid'

  const hasCauseContent = causeInfo || campaignInfo || impactGoal || volunteerInstructions

  return (
    <EventPageLayout eventType={props.eventType} title={props.title}>

      {/* ── Lifecycle banners ──────────────────────────────────────────────── */}
      {ls === 'cancelled' && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center gap-2.5">
            <XCircle className="size-4 shrink-0 text-red-500" aria-hidden />
            <p className="text-xs font-bold text-red-700">
              This event has been cancelled.{cancelReason && ` ${cancelReason}`}
            </p>
          </div>
        </div>
      )}
      {ls === 'completed' && (
        <div className="border-b border-sky-200 bg-sky-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center gap-2.5">
            <CheckCircle className="size-4 shrink-0 text-sky-500" aria-hidden />
            <p className="text-xs font-semibold text-sky-700">
              This event has ended. Thank you to everyone who participated!
            </p>
          </div>
        </div>
      )}
      {ls === 'registration_closed' && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center gap-2.5">
            <Lock className="size-4 shrink-0 text-amber-500" aria-hidden />
            <p className="text-xs font-semibold text-amber-700">
              Registrations are currently closed for this event.
            </p>
          </div>
        </div>
      )}
      {ls === 'postponed' && (
        <div className="border-b border-orange-200 bg-orange-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-5xl items-center gap-2.5">
            <Clock3 className="size-4 shrink-0 text-orange-500" aria-hidden />
            <p className="text-xs font-semibold text-orange-700">
              This event has been postponed.
            </p>
          </div>
        </div>
      )}

      {/* ── 1. Hero — full-bleed cinematic image + overlay ────────────────── */}
      <CommunityHero
        title={props.title}
        tagline={props.tagline}
        eventSubtype={props.eventSubtype}
        bannerUrl={bannerUrl}
        startDate={startDate}
        startTime={startTime}
        endDate={endDate}
        venueName={venueName}
        venueType={venueType}
        physical={physical}
        registrationOpen={registrationOpen}
        isFreeEvent={isFreeEvent}
        passes={passes}
        totalAttendees={totalAttendees}
        showAttendeeCount={showAttendeeCount}
      />

      {/* ── 2. Quick facts strip ───────────────────────────────────────────── */}
      <div className="border-b border-gray-100 bg-white">
        <div className="mx-auto max-w-5xl px-5 sm:px-10">
          <div className="flex flex-wrap items-center gap-y-2 py-3">
            {[
              { Icon: Calendar, label: `${fmtDate(startDate)}${startTime ? ` · ${fmtTime(startTime)}` : ''}` },
              { Icon: MapPin,   label: locationLabel },
              { Icon: Globe,    label: venueLabel    },
              { Icon: Ticket,   label: isFreeEvent ? 'Free Entry' : `From ₹${minPrice.toLocaleString('en-IN')}` },
              ...(endDate && endDate !== startDate ? [{ Icon: Clock, label: `Until ${fmtDate(endDate)}` }] : []),
              ...(doorsOpenTime ? [{ Icon: AlarmClock, label: `Doors open ${fmtTime(doorsOpenTime)}` }] : []),
              ...(language && language !== 'en' ? [{ Icon: Languages, label: language }] : []),
              ...(dressCode ? [{ Icon: Shirt, label: dressCode }] : []),
            ].map(({ Icon, label }, i, arr) => (
              <span key={i} className="flex items-center">
                <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-gray-500">
                  <Icon className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                  {label}
                </span>
                {i < arr.length - 1 && (
                  <span className="mx-4 text-gray-200" aria-hidden>·</span>
                )}
              </span>
            ))}
            <span className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.6875rem] font-bold tracking-wide ${
              registrationOpen
                ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200'
                : 'bg-gray-50 text-gray-500 ring-1 ring-gray-200'
            }`}>
              <span className={`size-1.5 rounded-full ${registrationOpen ? 'bg-emerald-500' : 'bg-gray-400'}`} aria-hidden />
              {registrationOpen ? 'Registration Open' : 'Closed'}
            </span>
            {startDate && (
              <span className="ml-auto">
                <AddToCalendarButton
                  title={props.title}
                  startDate={startDate}
                  endDate={endDate || startDate}
                  startTime={startTime}
                  endTime={props.endTime}
                  location={locationLabel}
                  description={props.description}
                  slug={slug}
                />
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── 2b. Promo Video ────────────────────────────────────────────────── */}
      <PromoVideoSection promoVideoUrl={promoVideoUrl} className="bg-white py-8 sm:py-10" />

      {/* ── 3. Organiser — trust before the ask ───────────────────────────── */}
      {showOrg && organizer?.name && (
        <CommunityOrganizer organizer={organizer} showSocial={showSocial} />
      )}

      {/* ── 4. Impact Numbers — proof of scale ────────────────────────────── */}
      <CommunityImpactNumbers
        totalAttendees={totalAttendees}
        showAttendeeCount={showAttendeeCount}
        impactGoal={impactGoal}
        causeInfo={causeInfo}
        campaignInfo={campaignInfo}
      />

      {/* ── 5. The Challenge — cause, warm cream editorial ────────────────── */}
      {hasCauseContent && (
        <CommunityProblemSection
          causeInfo={causeInfo}
          campaignInfo={campaignInfo}
          impactGoal={impactGoal}
          volunteerInstructions={volunteerInstructions}
        />
      )}

      {/* ── 6. About This Event ───────────────────────────────────────────── */}
      {description?.trim() && (
        <section className="bg-white py-10 sm:py-12">
          <div className="mx-auto max-w-5xl px-5 sm:px-10">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.1 }}
              transition={{ duration: 0.55 }}
              className="grid gap-8 lg:grid-cols-[200px_1fr]"
            >
              <div className="lg:pt-1">
                <div className="mb-3 h-0.5 w-8" style={{ backgroundImage: 'var(--primary-gradient)' }} />
                <h2 className="text-[1.125rem] font-black leading-tight text-gray-900 sm:text-[1.375rem]">
                  About This Event
                </h2>
              </div>
              <p className="whitespace-pre-line text-[0.9375rem] leading-[1.75] text-gray-600 lg:pt-0.5">
                {description}
              </p>
            </motion.div>
          </div>
        </section>
      )}

      {/* ── 7. How You Can Help — participation paths ─────────────────────── */}
      <CommunityActionCards
        typeDetails={typeDetails}
        organizer={organizer}
        isFreeEvent={isFreeEvent}
        registrationOpen={registrationOpen}
        passes={passes}
      />

      {/* ── 8. Schedule ───────────────────────────────────────────────────── */}
      {showAgenda && agenda.length > 0 && (
        <CommunityEventJourney agenda={agenda} speakers={speakers} />
      )}

      {/* ── 9. Gallery — full-bleed after schedule ────────────────────────── */}
      {showGallery && gallery.length > 0 && (
        <CommunityMasonry gallery={gallery} />
      )}

      {/* ── 10. Speakers ─────────────────────────────────────────────────── */}
      {showSpeakers && speakers.length > 0 && (
        <section className="bg-slate-50 py-8 sm:py-10">
          <div className="mx-auto max-w-5xl px-5 sm:px-10">
            <SpeakersSection speakers={speakers} />
          </div>
        </section>
      )}

      {/* ── 11. Sponsors ─────────────────────────────────────────────────── */}
      {showSponsors && sponsors.length > 0 && (
        <ConferenceSponsors sponsors={sponsors} />
      )}

      {/* ── 12. Join the Movement — registration ──────────────────────────── */}
      <CommunityRegistration
        passes={passes}
        isFreeEvent={isFreeEvent}
        slug={slug}
        availability={availability}
        registrationOpen={registrationOpen}
        closedMessage={regClosedMessage}
      />

      {/* ── 13. Location ─────────────────────────────────────────────────── */}
      <CommunityVenue
        venueType={venueType}
        physical={physical}
        online={online}
        mapsLink={mapsLink}
        venueMaps={showVenueMap ? venueMaps : null}
      />

      {/* ── 14. FAQ ──────────────────────────────────────────────────────── */}
      <CommunityFAQ
        faqUrl={faqUrl}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
      />

      {/* ── Sticky mobile CTA ─────────────────────────────────────────────── */}
      <StickyMobileCTA
        visible={true}
        title={title}
        isFreeEvent={isFreeEvent}
        passes={passes}
        registrationOpen={registrationOpen}
      />
    </EventPageLayout>
  )
}

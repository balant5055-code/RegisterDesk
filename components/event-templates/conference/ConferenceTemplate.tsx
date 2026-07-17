'use client'

import { motion } from 'framer-motion'
import { XCircle, CheckCircle, Lock, Clock3, Calendar, MapPin, Globe, Ticket, Clock, AlarmClock, Languages, Shirt } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import type { ConferenceDetails } from '@/components/wizard/eventDetailsConfig'
import { EventPageLayout }       from '@/components/event-templates/shared/ui/EventPageLayout'
import { StickyMobileCTA }       from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { AddToCalendarButton }   from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { ConferenceHero }        from './ConferenceHero'
import { ConferenceHighlights }  from './ConferenceHighlights'
import { ConferenceSpeakers }    from './ConferenceSpeakers'
import { ConferenceNetworking }  from './ConferenceNetworking'
import { ConferenceAgenda }      from './ConferenceAgenda'
import { ConferenceTickets }     from './ConferenceTickets'
import { ConferenceSponsors }    from './ConferenceSponsors'
import { ConferenceVenue }       from './ConferenceVenue'
import { ConferenceOrganizer }   from './ConferenceOrganizer'
import { ConferenceFAQ }         from './ConferenceFAQ'
import { PromoVideoSection }     from '@/components/event-templates/shared/media/PromoVideoSection'
import { SharedGallery }        from '@/components/event-templates/shared/media/SharedGallery'

// ─── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(d: string) {
  if (!d) return ''
  const [y, mo, day] = d.split('-').map(Number)
  return new Date(y!, mo! - 1, day!).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function fmtTime(t: string) {
  if (!t) return ''
  const [h, m] = t.split(':').map(Number)
  return `${h! % 12 || 12}:${String(m ?? 0).padStart(2, '0')} ${h! < 12 ? 'AM' : 'PM'}`
}

function fmtINR(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n)
}

// ─── Template ──────────────────────────────────────────────────────────────────

export function ConferenceTemplate(props: EventDetailProps) {
  const {
    slug, lifecycleStatus: ls, cancelReason,
    registrationOpen, regClosedMessage,
    title, tagline, description,
    bannerUrl, promoVideoUrl,
    startDate, startTime, endDate, doorsOpenTime,
    venueType, physical, online, venueName, mapsLink, venueMaps,
    showVenueMap,
    organizer, showOrg, showSocial,
    isFreeEvent, passes, availability,
    speakers, sponsors,
    gallery,
    showSpeakers, showSponsors, showAgenda, showGallery, showAttendeeCount,
    agenda,
    typeDetails,
    language, dressCode,
    faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
  } = props

  const td     = typeDetails as ConferenceDetails | null
  const tracks = td?.tracks ?? []

  const activePasses   = passes.filter(p => p.status !== 'inactive')
  const minPrice       = activePasses.length > 0 ? Math.min(...activePasses.map(p => p.price)) : 0
  const totalAttendees = Object.values(availability)[0]?.eventTotalCount ?? 0

  const locationLabel = venueType === 'online'
    ? 'Online Event'
    : physical?.city ? `${venueName}, ${physical.city}` : venueName
  const venueLabel    = venueType === 'physical' ? 'In-person'
    : venueType === 'online' ? 'Online' : 'Hybrid'

  return (
    <EventPageLayout eventType={props.eventType} title={props.title}>

      {/* ── Lifecycle banners ──────────────────────────────────────────────── */}
      {ls === 'cancelled' && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <XCircle className="size-4 shrink-0 text-red-500" aria-hidden />
            <p className="text-xs font-bold text-red-700">
              This event has been cancelled.{cancelReason && ` ${cancelReason}`}
            </p>
          </div>
        </div>
      )}
      {ls === 'completed' && (
        <div className="border-b border-sky-200 bg-sky-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <CheckCircle className="size-4 shrink-0 text-sky-500" aria-hidden />
            <p className="text-xs font-semibold text-sky-700">
              This event has concluded. Thank you to all our attendees!
            </p>
          </div>
        </div>
      )}
      {ls === 'registration_closed' && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Lock className="size-4 shrink-0 text-amber-500" aria-hidden />
            <p className="text-xs font-semibold text-amber-700">
              Registrations are currently closed for this event.
            </p>
          </div>
        </div>
      )}
      {ls === 'postponed' && (
        <div className="border-b border-orange-200 bg-orange-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Clock3 className="size-4 shrink-0 text-orange-500" aria-hidden />
            <p className="text-xs font-semibold text-orange-700">
              This event has been postponed.
            </p>
          </div>
        </div>
      )}

      {/* ── 1. Hero ─────────────────────────────────────────────────────────── */}
      <ConferenceHero
        title={title}
        tagline={tagline}
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
        speakers={speakers}
        agenda={agenda}
        tracks={tracks}
        totalAttendees={totalAttendees}
        showAttendeeCount={showAttendeeCount}
      />

      {/* ── 2. Quick facts strip ────────────────────────────────────────────── */}
      <div className="border-b border-gray-100 bg-gray-50">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex flex-wrap items-center gap-y-2.5 py-3.5">
            {[
              { Icon: Calendar, label: `${fmtDate(startDate)}${startTime ? ` · ${fmtTime(startTime)}` : ''}` },
              { Icon: MapPin,   label: locationLabel },
              { Icon: Globe,    label: venueLabel    },
              { Icon: Ticket,   label: isFreeEvent ? 'Free Entry' : `From ${fmtINR(minPrice)}` },
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
                : 'bg-gray-100 text-gray-500 ring-1 ring-gray-200'
            }`}>
              <span className={`size-1.5 rounded-full ${registrationOpen ? 'bg-emerald-500' : 'bg-gray-400'}`} aria-hidden />
              {registrationOpen ? 'Registration Open' : 'Closed'}
            </span>
            {startDate && (
              <span className="ml-auto">
                <AddToCalendarButton
                  title={title}
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

      {/* ── 3. Conference Highlights ────────────────────────────────────────── */}
      <ConferenceHighlights
        speakerCount={speakers.length}
        sessionCount={agenda.filter(s => !s.isBreak).length}
        trackCount={tracks.length}
        attendeeCount={totalAttendees}
        showAttendees={showAttendeeCount}
      />

      {/* ── 3b. Promo Video ─────────────────────────────────────────────────── */}
      <PromoVideoSection promoVideoUrl={promoVideoUrl} className="bg-white py-8 sm:py-10" />

      {/* ── 4. About ────────────────────────────────────────────────────────── */}
      {description?.trim() && (
        <section className="bg-white py-16 sm:py-20">
          <div className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8">
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.1 }}
              transition={{ duration: 0.5, ease: [0.25, 0, 0, 1] }}
            >
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.22em] text-primary">About</p>
              <h2 className="mb-6 text-2xl font-black tracking-tight text-gray-950 sm:text-[2rem]">
                About This Conference
              </h2>
              <p className="whitespace-pre-line text-[1.0625rem] leading-[1.8] text-gray-600">
                {description}
              </p>
            </motion.div>
          </div>
        </section>
      )}

      {/* ── 5. Speakers ─────────────────────────────────────────────────────── */}
      {showSpeakers && speakers.length > 0 && (
        <ConferenceSpeakers speakers={speakers} agenda={agenda} />
      )}

      {/* ── 6. Agenda ───────────────────────────────────────────────────────── */}
      {showAgenda && agenda.length > 0 && (
        <ConferenceAgenda agenda={agenda} speakers={speakers} tracks={tracks} />
      )}

      {/* ── 7. Networking ───────────────────────────────────────────────────── */}
      <ConferenceNetworking />

      {/* ── 8. Tickets ──────────────────────────────────────────────────────── */}
      <ConferenceTickets
        passes={passes}
        isFreeEvent={isFreeEvent}
        slug={slug}
        availability={availability}
        registrationOpen={registrationOpen}
        closedMessage={regClosedMessage}
      />

      {/* ── 9. Sponsors ─────────────────────────────────────────────────────── */}
      {showSponsors && sponsors.length > 0 && (
        <ConferenceSponsors sponsors={sponsors} />
      )}

      {/* ── 9b. Gallery ─────────────────────────────────────────────────────── */}
      {showGallery && gallery.length > 0 && (
        <SharedGallery gallery={gallery} title="Event Highlights" accentColor="#7c3aed" />
      )}

      {/* ── 10. Venue ───────────────────────────────────────────────────────── */}
      <ConferenceVenue
        venueType={venueType}
        venueName={venueName}
        physical={physical}
        online={online}
        mapsLink={mapsLink}
        venueMaps={showVenueMap ? venueMaps : null}
      />

      {/* ── 11. Organiser ───────────────────────────────────────────────────── */}
      {showOrg && organizer?.name && (
        <ConferenceOrganizer organizer={organizer} showSocial={showSocial} />
      )}

      {/* ── 12. FAQ ─────────────────────────────────────────────────────────── */}
      <ConferenceFAQ
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

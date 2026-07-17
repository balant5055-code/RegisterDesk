'use client'

import { XCircle, CheckCircle, Lock, Clock3, AlarmClock, Languages, Shirt } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import type { CulturalDetails } from '@/components/wizard/eventDetailsConfig'
import { EventPageLayout }         from '@/components/event-templates/shared/ui/EventPageLayout'
import { StickyMobileCTA }         from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { AddToCalendarButton }     from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { CulturalHero }            from './CulturalHero'
import { CulturalPerformers }      from './CulturalPerformers'
import { CulturalLineup }          from './CulturalLineup'
import { CulturalHighlights }      from './CulturalHighlights'
import { CulturalGallery }         from './CulturalGallery'
import { CulturalExperienceZones } from './CulturalExperienceZones'
import { CulturalSchedule }        from './CulturalSchedule'
import { CulturalTickets }         from './CulturalTickets'
import { CulturalSponsors }        from './CulturalSponsors'
import { CulturalVenue }           from './CulturalVenue'
import { CulturalFAQ }             from './CulturalFAQ'
import { CulturalOrganizer }       from './CulturalOrganizer'
import { PromoVideoSection }        from '@/components/event-templates/shared/media/PromoVideoSection'

// ─── Template ──────────────────────────────────────────────────────────────────

export function CulturalTemplate(props: EventDetailProps) {
  const {
    slug, lifecycleStatus: ls, cancelReason,
    registrationOpen, regClosedMessage,
    title, tagline, description,
    bannerUrl, gallery, promoVideoUrl,
    startDate, endDate, doorsOpenTime,
    physical, venueName, venueMaps, showVenueMap,
    isFreeEvent, passes, availability,
    sponsors,
    showSpeakers, showSponsors, showAgenda, showGallery, showAttendeeCount: _sa,
    agenda,
    organizer, showOrg, showSocial,
    language, dressCode,
    typeDetails,
    faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
  } = props

  const td = typeDetails as CulturalDetails | null

  // Prefer td.artists, fall back to props.speakers
  const artists        = td?.artists?.filter(a => a.name?.trim()) ?? []
  const performers     = artists.length > 0 ? artists : props.speakers.filter(s => s.name?.trim())
  const highlights     = td?.highlights      ?? []
  const experienceZones= td?.experienceZones ?? []

  const hasLineup      = showAgenda && agenda.some(s => !s.isBreak)
  const hasSchedule    = showAgenda && agenda.length > 0
  const hasGallery     = showGallery && gallery.length > 0
  const activePasses   = passes.filter(p => p.status !== 'inactive')

  return (
    <EventPageLayout eventType={props.eventType} title={title}>

      {/* ── Lifecycle banners ────────────────────────────────────────────────── */}
      {ls === 'cancelled' && (
        <div className="border-b border-red-700/50 bg-red-950/60 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <XCircle className="size-4 shrink-0 text-red-400" aria-hidden />
            <p className="text-xs font-bold text-red-300">
              This event has been cancelled.{cancelReason && ` ${cancelReason}`}
            </p>
          </div>
        </div>
      )}
      {ls === 'completed' && (
        <div className="border-b border-sky-700/40 bg-sky-950/50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <CheckCircle className="size-4 shrink-0 text-sky-400" aria-hidden />
            <p className="text-xs font-semibold text-sky-300">
              This festival has concluded. Thank you for celebrating with us!
            </p>
          </div>
        </div>
      )}
      {ls === 'registration_closed' && (
        <div className="border-b border-amber-700/40 bg-amber-950/50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Lock className="size-4 shrink-0 text-amber-400" aria-hidden />
            <p className="text-xs font-semibold text-amber-300">
              Ticket sales are currently closed for this festival.
            </p>
          </div>
        </div>
      )}
      {ls === 'postponed' && (
        <div className="border-b border-orange-700/40 bg-orange-950/50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Clock3 className="size-4 shrink-0 text-orange-400" aria-hidden />
            <p className="text-xs font-semibold text-orange-300">
              This festival has been postponed.
            </p>
          </div>
        </div>
      )}

      {/* ── 1. Hero ─────────────────────────────────────────────────────────── */}
      <CulturalHero
        title={title}
        tagline={tagline}
        eventSubtype={props.eventSubtype}
        bannerUrl={bannerUrl}
        startDate={startDate}
        endDate={endDate}
        venueName={venueName}
        physical={physical}
        registrationOpen={registrationOpen}
        isFreeEvent={isFreeEvent}
        passes={passes}
        slug={slug}
        performerCount={performers.length}
      />

      {/* ── 1b. Add to Calendar ─────────────────────────────────────────────── */}
      {startDate && (
        <div className="border-b border-white/5 bg-gray-900 px-5 py-2">
          <div className="mx-auto flex max-w-7xl items-center justify-end">
            <AddToCalendarButton
              title={props.title}
              startDate={startDate}
              endDate={endDate || startDate}
              startTime={props.startTime}
              endTime={props.endTime}
              location={props.physical?.city ? `${props.venueName}, ${props.physical.city}` : props.venueName}
              description={props.description}
              slug={props.slug}
              variant="dark"
            />
          </div>
        </div>
      )}

      {/* ── 1c. Metadata chips ──────────────────────────────────────────────── */}
      {(doorsOpenTime || (language && language !== 'en') || dressCode) && (
        <div className="border-b border-white/5 bg-gray-900 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1.5">
            {doorsOpenTime && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-white/50">
                <AlarmClock className="size-3.5 shrink-0 text-amber-400/70" aria-hidden />
                Doors open {doorsOpenTime}
              </span>
            )}
            {language && language !== 'en' && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-white/50">
                <Languages className="size-3.5 shrink-0 text-amber-400/70" aria-hidden />
                {language}
              </span>
            )}
            {dressCode && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-white/50">
                <Shirt className="size-3.5 shrink-0 text-amber-400/70" aria-hidden />
                {dressCode}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 1c. Promo Video ─────────────────────────────────────────────────── */}
      <PromoVideoSection promoVideoUrl={promoVideoUrl} className="bg-gray-950 py-8 sm:py-10" />

      {/* ── 2. About (description) ──────────────────────────────────────────── */}
      {description?.trim() && (
        <section className="border-b border-white/5 bg-gray-900 py-8 sm:py-10">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <p className="whitespace-pre-line text-[0.9375rem] leading-[1.9] text-white/50">
              {description}
            </p>
          </div>
        </section>
      )}

      {/* ── 3. Featured Performers ──────────────────────────────────────────── */}
      {showSpeakers && performers.length > 0 && (
        <CulturalPerformers performers={performers} />
      )}

      {/* ── 4. Stage Lineup ─────────────────────────────────────────────────── */}
      {hasLineup && (
        <CulturalLineup agenda={agenda} />
      )}

      {/* ── 4b. Program Schedule ────────────────────────────────────────────── */}
      {td?.programSchedule?.trim() && (
        <section className="bg-white py-12 sm:py-16">
          <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
            <h2 className="mb-4 text-xl font-bold tracking-tight text-gray-900 sm:text-2xl">Program Schedule</h2>
            <p className="whitespace-pre-line text-[0.9375rem] leading-relaxed text-gray-600">{td.programSchedule}</p>
          </div>
        </section>
      )}

      {/* ── 5. Festival Highlights ──────────────────────────────────────────── */}
      <CulturalHighlights highlights={highlights} />

      {/* ── 6. Photo Gallery ────────────────────────────────────────────────── */}
      {hasGallery && (
        <CulturalGallery gallery={gallery} />
      )}

      {/* ── 7. Experience Zones ─────────────────────────────────────────────── */}
      <CulturalExperienceZones experienceZones={experienceZones} />

      {/* ── 8. Full Schedule ────────────────────────────────────────────────── */}
      {hasSchedule && (
        <CulturalSchedule agenda={agenda} />
      )}

      {/* ── 9. Tickets ──────────────────────────────────────────────────────── */}
      {activePasses.length > 0 && (
        <CulturalTickets
          passes={passes}
          isFreeEvent={isFreeEvent}
          slug={slug}
          availability={availability}
          registrationOpen={registrationOpen}
          closedMessage={regClosedMessage}
        />
      )}

      {/* ── 10. Sponsors ────────────────────────────────────────────────────── */}
      {showSponsors && sponsors.length > 0 && (
        <CulturalSponsors sponsors={sponsors} />
      )}

      {/* ── 11. Venue ───────────────────────────────────────────────────────── */}
      <CulturalVenue
        venueName={venueName}
        physical={physical}
        venueMaps={showVenueMap ? venueMaps : null}
      />

      {/* ── 12. FAQ ─────────────────────────────────────────────────────────── */}
      <CulturalFAQ
        entryRules={td?.entryRules}
        ageRestriction={td?.ageRestriction}
        faqUrl={faqUrl}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
      />

      {/* ── 13. Organiser ───────────────────────────────────────────────────── */}
      {showOrg && organizer?.name && (
        <CulturalOrganizer organizer={organizer} showSocial={showSocial} />
      )}

      {/* ── Sticky mobile CTA ────────────────────────────────────────────────── */}
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

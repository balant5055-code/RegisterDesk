'use client'

import { XCircle, CheckCircle, Lock, Clock3, Calendar, MapPin, AlarmClock, Languages, Shirt } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import type { AwardsDetails } from '@/components/wizard/eventDetailsConfig'
import { EventPageLayout }     from '@/components/event-templates/shared/ui/EventPageLayout'
import { StickyMobileCTA }     from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { AwardsHero }          from './AwardsHero'
import { AwardCategories }     from './AwardCategories'
import { AwardsNominees }      from './AwardsNominees'
import { AwardsJudges }        from './AwardsJudges'
import { AwardsHallOfFame }    from './AwardsHallOfFame'
import { AwardsCeremony }      from './AwardsCeremony'
import { AwardsHighlights }    from './AwardsHighlights'
import { AwardsTickets }       from './AwardsTickets'
import { AwardsSponsors }      from './AwardsSponsors'
import { AwardsVenue }         from './AwardsVenue'
import { AwardsFAQ }           from './AwardsFAQ'
import { AwardsOrganizer }     from './AwardsOrganizer'
import { AwardsNominationForm }  from './AwardsNominationForm'
import { AddToCalendarButton }   from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { PromoVideoSection }     from '@/components/event-templates/shared/media/PromoVideoSection'
import { SharedGallery }       from '@/components/event-templates/shared/media/SharedGallery'

// ─── Template ──────────────────────────────────────────────────────────────────

export function AwardsTemplate(props: EventDetailProps) {
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

  const td = typeDetails as AwardsDetails | null

  const categories     = td?.categories?.filter(c => c.name?.trim()) ?? []
  const judges         = props.speakers.filter(s => s.name?.trim())
  const activePasses   = passes.filter(p => p.status !== 'inactive')

  const hasNominees    = !!(td?.nominationRules?.trim() || td?.judgingProcess?.trim())
  const hasSchedule    = showAgenda && agenda.length > 0
  const hasCeremony    = hasSchedule || !!td?.ceremonyFormat?.trim()

  return (
    <EventPageLayout eventType={props.eventType} title={title}>

      {/* ── Lifecycle banners ────────────────────────────────────────────────── */}
      {ls === 'cancelled' && (
        <div className="border-b border-red-700/30 bg-red-950/40 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <XCircle className="size-4 shrink-0 text-red-400" aria-hidden />
            <p className="text-xs font-bold text-red-300">
              This event has been cancelled.{cancelReason && ` ${cancelReason}`}
            </p>
          </div>
        </div>
      )}
      {ls === 'completed' && (
        <div className="border-b border-sky-700/30 bg-sky-950/40 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <CheckCircle className="size-4 shrink-0 text-sky-400" aria-hidden />
            <p className="text-xs font-semibold text-sky-300">
              This awards ceremony has concluded. Congratulations to all winners!
            </p>
          </div>
        </div>
      )}
      {ls === 'registration_closed' && (
        <div className="border-b border-yellow-700/30 bg-yellow-950/40 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Lock className="size-4 shrink-0 text-yellow-400" aria-hidden />
            <p className="text-xs font-semibold text-yellow-300">
              Ticket sales are currently closed for this ceremony.
            </p>
          </div>
        </div>
      )}
      {ls === 'postponed' && (
        <div className="border-b border-orange-700/30 bg-orange-950/40 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Clock3 className="size-4 shrink-0 text-orange-400" aria-hidden />
            <p className="text-xs font-semibold text-orange-300">
              This ceremony has been postponed.
            </p>
          </div>
        </div>
      )}

      {/* ── 1. Hero ─────────────────────────────────────────────────────────── */}
      <AwardsHero
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
        categoryCount={categories.length}
        judgesCount={judges.length}
      />

      {/* ── 1b. Add to Calendar ─────────────────────────────────────────────── */}
      {startDate && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center justify-end">
            <AddToCalendarButton
              title={title}
              startDate={startDate}
              endDate={endDate || startDate}
              startTime={props.startTime}
              endTime={props.endTime}
              location={physical?.city ? `${venueName}, ${physical.city}` : venueName}
              description={description}
              slug={slug}
              variant="dark"
            />
          </div>
        </div>
      )}

      {/* ── 1c. Metadata chips ──────────────────────────────────────────────── */}
      {(doorsOpenTime || (language && language !== 'en') || dressCode) && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1.5">
            {doorsOpenTime && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-zinc-400">
                <AlarmClock className="size-3.5 shrink-0 text-yellow-400/70" aria-hidden />
                Doors open {doorsOpenTime}
              </span>
            )}
            {language && language !== 'en' && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-zinc-400">
                <Languages className="size-3.5 shrink-0 text-yellow-400/70" aria-hidden />
                {language}
              </span>
            )}
            {dressCode && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-zinc-400">
                <Shirt className="size-3.5 shrink-0 text-yellow-400/70" aria-hidden />
                {dressCode}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 1c. Promo Video ─────────────────────────────────────────────────── */}
      <PromoVideoSection promoVideoUrl={promoVideoUrl} className="bg-zinc-950 py-8 sm:py-10" />

      {/* ── 2. About ────────────────────────────────────────────────────────── */}
      {description?.trim() && (
        <section className="border-b border-zinc-800/60 bg-zinc-900 py-8 sm:py-10">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <p className="whitespace-pre-line text-[0.9375rem] leading-[1.85] text-zinc-400">
              {description}
            </p>
          </div>
        </section>
      )}

      {/* ── 3. Award Categories ─────────────────────────────────────────────── */}
      <AwardCategories categories={categories} />

      {/* ── 3b. Nomination Form ─────────────────────────────────────────────── */}
      <AwardsNominationForm slug={slug} categories={categories} />

      {/* ── 4. Nomination & Judging Process ─────────────────────────────────── */}
      {hasNominees && (
        <AwardsNominees
          nominationRules={td?.nominationRules}
          judgingProcess={td?.judgingProcess}
        />
      )}

      {/* ── 5. Judges Panel ─────────────────────────────────────────────────── */}
      {showSpeakers && judges.length > 0 && (
        <AwardsJudges judges={judges} />
      )}

      {/* ── 6. Hall of Fame ─────────────────────────────────────────────────── */}
      <AwardsHallOfFame pastWinners={td?.pastWinners ?? []} />

      {/* ── 7. Ceremony Schedule ────────────────────────────────────────────── */}
      {hasCeremony && (
        <AwardsCeremony
          agenda={showAgenda ? agenda : []}
          ceremonyFormat={td?.ceremonyFormat}
        />
      )}

      {/* ── 8. Event Highlights ─────────────────────────────────────────────── */}
      <AwardsHighlights
        categoryCount={categories.length}
        judgesCount={judges.length}
        totalPasses={activePasses.length}
        sponsorCount={sponsors.length}
      />

      {/* ── 9. Tickets ──────────────────────────────────────────────────────── */}
      {activePasses.length > 0 && (
        <AwardsTickets
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
        <AwardsSponsors sponsors={sponsors} />
      )}

      {/* ── 10b. Gallery ────────────────────────────────────────────────────── */}
      {showGallery && gallery.length > 0 && (
        <SharedGallery gallery={gallery} title="Ceremony Highlights" accentColor="#facc15" variant="dark" />
      )}

      {/* ── 11. Venue ───────────────────────────────────────────────────────── */}
      <AwardsVenue
        venueName={venueName}
        physical={physical}
        venueMaps={showVenueMap ? venueMaps : null}
      />

      {/* ── 12. FAQ ─────────────────────────────────────────────────────────── */}
      <AwardsFAQ
        nominationRules={td?.nominationRules}
        judgingProcess={td?.judgingProcess}
        faqUrl={faqUrl}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
      />

      {/* ── 13. Organiser ───────────────────────────────────────────────────── */}
      {showOrg && organizer?.name && (
        <AwardsOrganizer organizer={organizer} showSocial={showSocial} />
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

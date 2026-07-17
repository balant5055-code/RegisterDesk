'use client'

import { XCircle, CheckCircle, Lock, Clock3, AlarmClock, Languages, Shirt, Building2, ExternalLink } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import type { ExhibitionDetails } from '@/components/wizard/eventDetailsConfig'
import { EventPageLayout }          from '@/components/event-templates/shared/ui/EventPageLayout'
import { StickyMobileCTA }          from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { AddToCalendarButton }      from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { ExhibitionHero }           from './ExhibitionHero'
import { ExhibitionExhibitors }     from './ExhibitionExhibitors'
import { ExhibitionFloorPlan }      from './ExhibitionFloorPlan'
import { ExhibitionCategories }     from './ExhibitionCategories'
import { ExhibitionVisitorInfo }    from './ExhibitionVisitorInfo'
import { ExhibitionSchedule }       from './ExhibitionSchedule'
import { ExhibitionWhyAttend }      from './ExhibitionWhyAttend'
import { ExhibitionPasses }         from './ExhibitionPasses'
import { ExhibitionSponsors }       from './ExhibitionSponsors'
import { ExhibitionVenue }          from './ExhibitionVenue'
import { ExhibitionFAQ }            from './ExhibitionFAQ'
import { ExhibitionOrganizer }      from './ExhibitionOrganizer'
import { PromoVideoSection }         from '@/components/event-templates/shared/media/PromoVideoSection'
import { SharedGallery }             from '@/components/event-templates/shared/media/SharedGallery'

// ─── Template ──────────────────────────────────────────────────────────────────

export function ExhibitionTemplate(props: EventDetailProps) {
  const {
    slug, lifecycleStatus: ls, cancelReason,
    registrationOpen, regClosedMessage,
    title, tagline, description,
    bannerUrl, gallery, promoVideoUrl,
    startDate, startTime: _st, endDate, doorsOpenTime,
    physical, venueName, venueMaps, showVenueMap,
    isFreeEvent, passes, availability,
    sponsors,
    showSponsors, showAgenda, showGallery, showAttendeeCount,
    agenda,
    organizer, showOrg, showSocial,
    language, dressCode,
    typeDetails,
    faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
    exhibitorDirectory,
  } = props

  const td = typeDetails as ExhibitionDetails | null

  const exhibitors           = (td?.exhibitors           ?? []).filter(e => e.name?.trim())
  const exhibitionCategories = (td?.exhibitionCategories ?? []).filter(c => c.label?.trim())
  const totalAttendees  = Object.values(availability)[0]?.eventTotalCount ?? 0
  const exhibitorCount  = exhibitors.length || sponsors.length

  const hasFloorPlan    = !!(td?.floorPlanUrl?.trim() || td?.boothInfoUrl?.trim())
  const hasVisitorInfo  = !!(td?.visitorInstructions?.trim() || td?.parkingInfo?.trim())
  const hasSchedule     = showAgenda && agenda.length > 0
  const hasActivePasses = passes.filter(p => p.status !== 'inactive').length > 0

  return (
    <EventPageLayout eventType={props.eventType} title={title}>

      {/* ── Lifecycle banners ────────────────────────────────────────────────── */}
      {ls === 'cancelled' && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <XCircle className="size-4 shrink-0 text-red-500" aria-hidden />
            <p className="text-xs font-bold text-red-700">
              This exhibition has been cancelled.{cancelReason && ` ${cancelReason}`}
            </p>
          </div>
        </div>
      )}
      {ls === 'completed' && (
        <div className="border-b border-sky-200 bg-sky-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <CheckCircle className="size-4 shrink-0 text-sky-500" aria-hidden />
            <p className="text-xs font-semibold text-sky-700">
              This exhibition has concluded. Thank you for visiting!
            </p>
          </div>
        </div>
      )}
      {ls === 'registration_closed' && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Lock className="size-4 shrink-0 text-amber-500" aria-hidden />
            <p className="text-xs font-semibold text-amber-700">
              Visitor registration is currently closed for this exhibition.
            </p>
          </div>
        </div>
      )}
      {ls === 'postponed' && (
        <div className="border-b border-orange-200 bg-orange-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Clock3 className="size-4 shrink-0 text-orange-500" aria-hidden />
            <p className="text-xs font-semibold text-orange-700">
              This exhibition has been postponed.
            </p>
          </div>
        </div>
      )}

      {/* ── 1. Hero ─────────────────────────────────────────────────────────── */}
      <ExhibitionHero
        title={title}
        tagline={tagline}
        eventSubtype={props.eventSubtype}
        bannerUrl={bannerUrl}
        startDate={startDate}
        endDate={endDate}
        venueName={venueName}
        physical={physical}
        exhibitorCount={exhibitorCount}
        totalAttendees={totalAttendees}
        showAttendeeCount={showAttendeeCount}
        registrationOpen={registrationOpen}
        isFreeEvent={isFreeEvent}
        passes={passes}
        slug={slug}
      />

      {/* ── 1b. Add to Calendar ─────────────────────────────────────────────── */}
      {startDate && (
        <div className="border-b border-gray-100 bg-gray-50 px-5 py-2">
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
            />
          </div>
        </div>
      )}

      {/* ── 1c. Metadata chips ──────────────────────────────────────────────── */}
      {(doorsOpenTime || (language && language !== 'en') || dressCode) && (
        <div className="border-b border-gray-100 bg-gray-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-1.5">
            {doorsOpenTime && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-gray-500">
                <AlarmClock className="size-3.5 shrink-0 text-teal-500" aria-hidden />
                Doors open {doorsOpenTime}
              </span>
            )}
            {language && language !== 'en' && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-gray-500">
                <Languages className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                {language}
              </span>
            )}
            {dressCode && (
              <span className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-gray-500">
                <Shirt className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                {dressCode}
              </span>
            )}
          </div>
        </div>
      )}

      {/* ── 1c. Promo Video ─────────────────────────────────────────────────── */}
      <PromoVideoSection promoVideoUrl={promoVideoUrl} className="bg-white py-8 sm:py-10" />

      {/* ── 2. About ────────────────────────────────────────────────────────── */}
      {description?.trim() && (
        <section className="border-b border-gray-100 bg-gray-50 py-8 sm:py-10">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <p className="whitespace-pre-line text-[0.9375rem] leading-[1.85] text-gray-600">
              {description}
            </p>
          </div>
        </section>
      )}

      {/* ── 3. Featured Exhibitors ──────────────────────────────────────────── */}
      <ExhibitionExhibitors exhibitors={exhibitors} />

      {/* ── 3b. Registered Exhibitor Directory ─────────────────────────────── */}
      {exhibitorDirectory && exhibitorDirectory.length > 0 && (
        <section className="border-b border-gray-100 py-10 sm:py-14">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-6 flex items-center gap-3">
              <div className="flex size-8 items-center justify-center rounded-lg bg-teal-100">
                <Building2 className="size-4 text-teal-600" aria-hidden />
              </div>
              <div>
                <h2 className="text-[1.1rem] font-bold text-gray-900 sm:text-[1.25rem]">
                  Exhibitor Directory
                </h2>
                <p className="text-[0.8125rem] text-gray-500">{exhibitorDirectory.length} registered exhibitor{exhibitorDirectory.length !== 1 ? 's' : ''}</p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {exhibitorDirectory.map((ex, i) => (
                <div key={i} className="flex items-center gap-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm transition-shadow hover:shadow-md">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-teal-100 text-[14px] font-bold text-teal-700">
                    {ex.companyName.charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-gray-900">{ex.companyName}</p>
                    {ex.website && (
                      <a
                        href={ex.website.startsWith('http') ? ex.website : `https://${ex.website}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-1 text-[11px] text-teal-600 hover:underline"
                      >
                        <ExternalLink className="size-2.5 shrink-0" aria-hidden />
                        {ex.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                      </a>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* ── 4. Floor Plan ───────────────────────────────────────────────────── */}
      {hasFloorPlan && (
        <ExhibitionFloorPlan
          floorPlanUrl={td?.floorPlanUrl}
          boothInfoUrl={td?.boothInfoUrl}
        />
      )}

      {/* ── 5. Product & Industry Categories ───────────────────────────────── */}
      <ExhibitionCategories exhibitionCategories={exhibitionCategories} />

      {/* ── 6. Visitor Information ──────────────────────────────────────────── */}
      {hasVisitorInfo && (
        <ExhibitionVisitorInfo
          visitorInstructions={td?.visitorInstructions}
          parkingInfo={td?.parkingInfo}
          startTime={props.startTime}
          endTime={props.endTime}
        />
      )}

      {/* ── 7. Event Schedule ───────────────────────────────────────────────── */}
      {hasSchedule && (
        <ExhibitionSchedule agenda={agenda} />
      )}

      {/* ── 8. Why Attend ───────────────────────────────────────────────────── */}
      <ExhibitionWhyAttend />

      {/* ── 9. Visitor Registration (Passes) ───────────────────────────────── */}
      {hasActivePasses && (
        <ExhibitionPasses
          passes={passes}
          isFreeEvent={isFreeEvent}
          slug={slug}
          availability={availability}
          registrationOpen={registrationOpen}
          closedMessage={regClosedMessage}
        />
      )}

      {/* ── 10. Sponsors & Partners ─────────────────────────────────────────── */}
      {showSponsors && sponsors.length > 0 && (
        <ExhibitionSponsors sponsors={sponsors} />
      )}

      {/* ── 10b. Gallery ────────────────────────────────────────────────────── */}
      {showGallery && gallery.length > 0 && (
        <SharedGallery gallery={gallery} title="Exhibition Gallery" accentColor="#0d9488" />
      )}

      {/* ── 11. Venue & Getting There ───────────────────────────────────────── */}
      <ExhibitionVenue
        venueName={venueName}
        physical={physical}
        venueMaps={showVenueMap ? venueMaps : null}
      />

      {/* ── 12. FAQ ─────────────────────────────────────────────────────────── */}
      <ExhibitionFAQ
        faqUrl={faqUrl}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
      />

      {/* ── 13. Organiser ───────────────────────────────────────────────────── */}
      {showOrg && organizer?.name && (
        <ExhibitionOrganizer organizer={organizer} showSocial={showSocial} />
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

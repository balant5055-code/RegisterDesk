'use client'

import { XCircle, CheckCircle, Lock, Clock3, AlarmClock, Languages, Shirt } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import type { WorkshopDetails as WorkshopDetailsData } from '@/components/wizard/eventDetailsConfig'
import { EventPageLayout }      from '@/components/event-templates/shared/ui/EventPageLayout'
import { StickyMobileCTA }      from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { AddToCalendarButton }  from '@/components/event-templates/shared/ui/AddToCalendarButton'
import { WorkshopHero }         from './WorkshopHero'
import { WorkshopInstructor }   from './WorkshopInstructor'
import { WorkshopLearning }     from './WorkshopLearning'
import { WorkshopCurriculum }   from './WorkshopCurriculum'
import { WorkshopDetails }      from './WorkshopDetails'
import { WorkshopAudience }     from './WorkshopAudience'
import { WorkshopCertificate }  from './WorkshopCertificate'
import { WorkshopFAQ }          from './WorkshopFAQ'
import { WorkshopEnrollment }   from './WorkshopEnrollment'
import { WorkshopOrganizer }    from './WorkshopOrganizer'
import { PromoVideoSection }    from '@/components/event-templates/shared/media/PromoVideoSection'
import { VenueSection }         from '@/components/event-templates/shared/venue/VenueSection'
import { ConferenceSponsors }   from '@/components/event-templates/conference/ConferenceSponsors'
import { SharedGallery }        from '@/components/event-templates/shared/media/SharedGallery'

// ─── Template ──────────────────────────────────────────────────────────────────

export function WorkshopTemplate(props: EventDetailProps) {
  const {
    slug, lifecycleStatus: ls, cancelReason,
    registrationOpen, regClosedMessage,
    title, tagline, description,
    bannerUrl, gallery, promoVideoUrl,
    startDate, endDate, doorsOpenTime,
    venueType, physical, online, venueName, mapsLink, venueMaps, showVenueMap,
    organizer, showOrg, showSocial,
    isFreeEvent, passes, availability,
    sponsors, showSponsors,
    showSpeakers, showAgenda, showGallery, showAttendeeCount,
    agenda,
    language, dressCode,
    typeDetails,
    faqUrl, supportEmail, supportPhone, termsUrl, refundPolicyUrl, privacyPolicyUrl,
  } = props

  const td = typeDetails as WorkshopDetailsData | null

  // Prefer trainers from WorkshopDetails, fall back to event speakers
  const trainers       = td?.trainers?.filter(t => t.name?.trim()) ?? []
  const effectiveTrainers = trainers.length > 0 ? trainers : props.speakers.filter(s => s.name?.trim())
  const leadInstructor = effectiveTrainers[0] ?? undefined

  const learningOutcomes = td?.learningOutcomes?.filter(o => o?.trim()) ?? []
  const hasCurriculum    = showAgenda && agenda.length > 0
  const hasLearning      = learningOutcomes.length > 0 || td?.prerequisites?.trim() || td?.materialsIncluded?.trim() || td?.softwareRequired?.trim()

  return (
    <EventPageLayout eventType={props.eventType} title={title}>

      {/* ── Lifecycle banners ────────────────────────────────────────────────── */}
      {ls === 'cancelled' && (
        <div className="border-b border-red-200 bg-red-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <XCircle className="size-4 shrink-0 text-red-500" aria-hidden />
            <p className="text-xs font-bold text-red-700">
              This workshop has been cancelled.{cancelReason && ` ${cancelReason}`}
            </p>
          </div>
        </div>
      )}
      {ls === 'completed' && (
        <div className="border-b border-sky-200 bg-sky-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <CheckCircle className="size-4 shrink-0 text-sky-500" aria-hidden />
            <p className="text-xs font-semibold text-sky-700">
              This workshop has concluded. Thank you for participating!
            </p>
          </div>
        </div>
      )}
      {ls === 'registration_closed' && (
        <div className="border-b border-amber-200 bg-amber-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Lock className="size-4 shrink-0 text-amber-500" aria-hidden />
            <p className="text-xs font-semibold text-amber-700">
              Enrollment is currently closed for this workshop.
            </p>
          </div>
        </div>
      )}
      {ls === 'postponed' && (
        <div className="border-b border-orange-200 bg-orange-50 px-5 py-2.5">
          <div className="mx-auto flex max-w-7xl items-center gap-2.5">
            <Clock3 className="size-4 shrink-0 text-orange-500" aria-hidden />
            <p className="text-xs font-semibold text-orange-700">
              This workshop has been postponed.
            </p>
          </div>
        </div>
      )}

      {/* ── 1. Hero ─────────────────────────────────────────────────────────── */}
      <WorkshopHero
        title={title}
        tagline={tagline}
        eventSubtype={props.eventSubtype}
        bannerUrl={bannerUrl}
        startDate={startDate}
        endDate={endDate}
        venueType={venueType}
        registrationOpen={registrationOpen}
        isFreeEvent={isFreeEvent}
        passes={passes}
        slug={slug}
        leadInstructor={leadInstructor}
        batchSize={td?.batchSize}
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
                <AlarmClock className="size-3.5 shrink-0 text-primary/70" aria-hidden />
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

      {/* ── 2. About ─────────────────────────────────────────────────────────── */}
      {description?.trim() && (
        <section className="border-b border-gray-100 bg-gray-50 py-8 sm:py-10">
          <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8">
            <p className="whitespace-pre-line text-[0.9375rem] leading-[1.85] text-gray-600">
              {description}
            </p>
          </div>
        </section>
      )}

      {/* ── 3. Instructor ───────────────────────────────────────────────────── */}
      {showSpeakers && effectiveTrainers.length > 0 && (
        <WorkshopInstructor trainers={effectiveTrainers} />
      )}

      {/* ── 4. What You'll Learn ─────────────────────────────────────────────── */}
      {hasLearning && (
        <WorkshopLearning
          learningOutcomes={learningOutcomes}
          prerequisites={td?.prerequisites}
          materialsIncluded={td?.materialsIncluded}
          softwareRequired={td?.softwareRequired}
        />
      )}

      {/* ── 5. Curriculum ────────────────────────────────────────────────────── */}
      {hasCurriculum && (
        <WorkshopCurriculum agenda={agenda} />
      )}

      {/* ── 6. Workshop Details ──────────────────────────────────────────────── */}
      <WorkshopDetails
        startDate={startDate}
        endDate={endDate}
        venueType={venueType}
        batchSize={td?.batchSize}
        materialsIncluded={td?.materialsIncluded}
        softwareRequired={td?.softwareRequired}
        eventSubtype={props.eventSubtype}
      />

      {/* ── 7. Who Should Attend ─────────────────────────────────────────────── */}
      <WorkshopAudience prerequisites={td?.prerequisites} />

      {/* ── 8. Certificate ───────────────────────────────────────────────────── */}
      {td?.hasCertificate && <WorkshopCertificate eventTitle={title} />}

      {/* ── 8b. Venue ────────────────────────────────────────────────────────── */}
      <VenueSection
        venueType={venueType}
        physical={physical}
        online={online}
        mapsLink={mapsLink}
        venueMaps={showVenueMap ? venueMaps : null}
      />

      {/* ── 9. Enrollment ────────────────────────────────────────────────────── */}
      <WorkshopEnrollment
        passes={passes}
        isFreeEvent={isFreeEvent}
        slug={slug}
        availability={availability}
        registrationOpen={registrationOpen}
        closedMessage={regClosedMessage}
      />

      {/* ── 10. Organiser ───────────────────────────────────────────────────── */}
      {showOrg && organizer?.name && (
        <WorkshopOrganizer organizer={organizer} showSocial={showSocial} />
      )}

      {/* ── 10b. Sponsors ────────────────────────────────────────────────────── */}
      {showSponsors && sponsors.length > 0 && (
        <ConferenceSponsors sponsors={sponsors} />
      )}

      {/* ── 10c. Gallery ─────────────────────────────────────────────────────── */}
      {showGallery && gallery.length > 0 && (
        <SharedGallery gallery={gallery} title="Workshop Gallery" accentColor="#2563eb" />
      )}

      {/* ── 11. FAQ ──────────────────────────────────────────────────────────── */}
      <WorkshopFAQ
        faqUrl={faqUrl}
        supportEmail={supportEmail}
        supportPhone={supportPhone}
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
      />

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

'use client'

import type { LucideIcon } from 'lucide-react'
import { XCircle, CheckCircle, Lock, Clock3, Shield } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import type { SportsRunningDetails, RaceCategory, TimelineItem, FaqItem } from '@/components/wizard/eventDetailsConfig'
import { MarketingNavbar }       from '@/components/marketing/navigation/MarketingNavbar'
import { MarketingFooter }       from '@/components/marketing/footer/MarketingFooter'
import { StickyMobileCTA }       from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { SectionShell, SectionHeader } from '@/components/event-templates/shared/ui/framework'
import { LegalStrip }            from '@/components/event-templates/shared/ui/LegalStrip'
import { SportsHero }            from './SportsHero'
import { SportsRouteMap }        from './SportsRouteMap'
import { SportsRaceKit }         from './SportsRaceKit'
import { ChallengeSelectionSection, passesToChallenges } from '@/components/event-templates/shared/registration/ChallengeSelectionSection'
import { ExperienceSection }     from '@/components/event-templates/shared/experience/ExperienceSection'
import { JourneySection, agendaToTimeline } from '@/components/event-templates/shared/journey/JourneySection'
import { PromoVideoSection }     from '@/components/event-templates/shared/media/PromoVideoSection'
import { VenueShowcase }         from '@/components/event-templates/shared/venue/VenueShowcase'
import { OrganizerShowcase }     from '@/components/event-templates/shared/people/OrganizerShowcase'
import { SpeakersSection }       from '@/components/event-templates/shared/people/SpeakersSection'
import { GalleryShowcase, mediaToGallery } from '@/components/event-templates/shared/media/GalleryShowcase'
import { FAQShowcase, legacyFaqToItems } from '@/components/event-templates/shared/faq/FAQShowcase'
import { SponsorsShowcase }      from '@/components/event-templates/shared/sponsors/SponsorsShowcase'

// Tokenised slim status band (one design language for every lifecycle state).
function StatusBar({ icon: Icon, children }: { icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="border-b border-border/60 bg-muted/40">
      <div className="mx-auto flex max-w-6xl items-center gap-2.5 px-4 py-2.5 sm:px-6 lg:px-8">
        <Icon className="size-4 shrink-0 text-primary" aria-hidden />
        <p className="text-[12.5px] font-semibold text-foreground">{children}</p>
      </div>
    </div>
  )
}

// ─── Template ──────────────────────────────────────────────────────────────────

export function SportsTemplate(props: EventDetailProps) {
  const {
    slug, lifecycleStatus: ls, cancelReason,
    registrationOpen, regClosedMessage,
    title, tagline, description,
    bannerUrl, gallery, promoVideoUrl,
    startDate, startTime, endDate, endTime, doorsOpenTime,
    venueType, physical, online, venueName, mapsLink, venueMaps, showVenueMap,
    isFreeEvent, passes, availability,
    sponsors,
    organizer, showOrg, showSocial,
    speakers,
    showSponsors, showAgenda, showGallery, showSpeakers,
    agenda,
    language, dressCode,
    typeDetails,
    supportEmail, termsUrl, refundPolicyUrl, privacyPolicyUrl,
  } = props

  const td = typeDetails as SportsRunningDetails | null

  const raceCategories: RaceCategory[] = Array.isArray(td?.raceCategories) ? td!.raceCategories : []

  // Challenge Studio — passes carry the commerce truth; race categories enrich distance.
  const challenges = passesToChallenges(passes, availability, {
    categories: raceCategories.map(c => ({ name: c.name, distance: c.distance })),
  })

  // Event Journey — organiser timeline[] (fallback: legacy agenda). Doors-open (a loose
  // scalar field) is surfaced here, its natural home, as the first moment.
  const baseJourney = props.timeline?.length
    ? props.timeline
    : (showAgenda ? agendaToTimeline(agenda, speakers) : [])
  const journeyItems: TimelineItem[] = doorsOpenTime?.trim()
    ? [{ id: 'doors-open', title: 'Doors Open', description: `Gates open at ${doorsOpenTime.trim()}.`, enabled: true, displayOrder: -1 }, ...baseJourney]
    : baseJourney

  // FAQ — organiser faq[] (fallback: legacy). Dress code lands here, its natural home.
  const baseFaq = props.faq?.length ? props.faq : legacyFaqToItems(td?.faqItems)
  const faqItems: FaqItem[] = dressCode?.trim()
    ? [...baseFaq, { id: 'dress-code', question: 'Is there a dress code?', answer: dressCode.trim(), enabled: true }]
    : baseFaq

  const hasRouteInfo = !!(td?.routeMapUrl?.trim() || td?.hydrationPoints?.trim() || td?.medicalSupportInfo?.trim() || td?.rulesUrl?.trim())
  const hasRaceKit   = !!(td?.kitCollectionInfo?.trim() || td?.kitCollectionDate?.trim() || td?.bagDepositInfo?.trim())

  return (
    <>
      <MarketingNavbar />
      <main>

        {/* ── Lifecycle status ── */}
        {ls === 'cancelled'           && <StatusBar icon={XCircle}>This event has been cancelled.{cancelReason && ` ${cancelReason}`}</StatusBar>}
        {ls === 'completed'           && <StatusBar icon={CheckCircle}>This event has concluded. Thank you to all our participants!</StatusBar>}
        {ls === 'registration_closed' && <StatusBar icon={Lock}>Registrations are currently closed for this event.</StatusBar>}
        {ls === 'postponed'           && <StatusBar icon={Clock3}>This event has been postponed.</StatusBar>}

        {/* 1 · Hero — what is this? */}
        <SportsHero
          title={title}
          tagline={tagline}
          discipline={td?.disciplineLabel ?? props.eventSubtype}
          bannerUrl={bannerUrl}
          slug={slug}
          startDate={startDate}
          startTime={startTime}
          endDate={endDate}
          endTime={endTime}
          venueType={venueType}
          venueName={venueName}
          city={physical?.city}
          lifecycleStatus={ls}
          registrationOpen={registrationOpen}
          isFreeEvent={isFreeEvent}
          passes={passes}
          organizerVerified={Boolean((organizer as { verified?: boolean } | null | undefined)?.verified)}
          hasRefundPolicy={!!refundPolicyUrl}
          ctaLabel={td?.ctaLabel}
          countdownLabel={td?.countdownLabel}
        />

        {/* 2 · Challenge Studio — can I join? */}
        <ChallengeSelectionSection
          slug={slug}
          challenges={challenges}
          registrationOpen={registrationOpen}
          closedMessage={regClosedMessage}
          hasRefundPolicy={!!refundPolicyUrl}
          eyebrow="Choose Your Challenge"
          title="Find Your Perfect Distance"
          subtitle="Every distance offers a different experience. Choose the challenge that matches your goal, fitness level and race ambition."
          panelTitle="Challenge Overview"
          ctaLabel={td?.ctaLabel ?? 'Register'}
        />

        {/* Waiver — registration consent (tokenised) */}
        {td?.requireWaiver && (
          <div className="border-b border-border/60 bg-muted/30">
            <div className="mx-auto flex max-w-6xl items-start gap-3 px-4 py-4 sm:px-6 lg:px-8">
              <Shield className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <div>
                <p className="text-[13px] font-semibold text-foreground">Waiver required for participation</p>
                <p className="mt-0.5 text-[13px] text-muted-foreground">
                  By registering, you agree to the event waiver and release of liability.
                  {td.waiverText?.trim() ? ' Please read the full waiver during registration.' : ''}
                </p>
              </div>
            </div>
          </div>
        )}

        {/* 3 · What Awaits You — what do I get? */}
        <ExperienceSection
          items={props.experience ?? []}
          eyebrow="The Experience"
          title="What Awaits You"
          subtitle="Everything included with your entry."
        />

        {/* 4 · Race Day Journey — what happens? */}
        <JourneySection
          items={journeyItems}
          eventType="sports"
          eyebrow="Race Day"
          subtitle="Your morning, minute by minute."
        />

        {/* 5 · Our Story — why does this event exist? */}
        {description?.trim() && (
          <SectionShell id="story" maxW="3xl" bg="muted">
            <SectionHeader eyebrow="Our Story" title="About the Event" />
            <p className="whitespace-pre-line text-[15px] leading-relaxed text-muted-foreground">{description}</p>
            {language && language !== 'en' && (
              <p className="mt-4 text-[13px] font-medium text-muted-foreground">Conducted in {language}.</p>
            )}
          </SectionShell>
        )}

        {/* 6 · Promo Video */}
        <PromoVideoSection promoVideoUrl={promoVideoUrl} className="border-b border-border/60 bg-white py-14 sm:py-16" />

        {/* 7 · Course / Route — where do I go? */}
        {hasRouteInfo && (
          <SportsRouteMap
            routeMapUrl={td?.routeMapUrl}
            hydrationPoints={td?.hydrationPoints}
            medicalSupport={td?.medicalSupportInfo}
            rulesUrl={td?.rulesUrl}
            eyebrow={td?.routeEyebrow}
            sectionTitle={td?.routeSectionTitle}
            sectionSubtitle={td?.routeSectionSubtitle}
            hydrationLabel={td?.hydrationLabel}
          />
        )}

        {/* 8 · Race Kit — what do I need? */}
        {hasRaceKit && (
          <SportsRaceKit
            kitCollectionInfo={td?.kitCollectionInfo}
            kitCollectionDate={td?.kitCollectionDate}
            bagDepositInfo={td?.bagDepositInfo}
          />
        )}

        {/* 9 · Venue — where is it? */}
        <VenueShowcase
          venueType={venueType}
          venueName={venueName}
          physical={physical}
          online={online}
          mapsLink={mapsLink}
          maps={showVenueMap ? venueMaps : null}
          note={td?.startLineInfo}
          noteLabel="Start Line"
        />

        {/* 10 · Organizer — who runs it? */}
        {showOrg && organizer?.name && (
          <OrganizerShowcase organizer={organizer} showSocial={showSocial} />
        )}

        {/* 11 · Race Leadership — the people behind it (sports never says "Speakers") */}
        {showSpeakers && speakers.length > 0 && (
          <SpeakersSection speakers={speakers} title="Race Leadership" subtitle="Meet the people behind the event." />
        )}

        {/* 12 · Gallery — can I see previous editions? */}
        {showGallery && (
          <GalleryShowcase items={props.galleryMedia?.length ? props.galleryMedia : mediaToGallery(gallery)} />
        )}

        {/* 13 · FAQ — still have questions? */}
        <FAQShowcase
          items={faqItems}
          title={td?.faqSectionTitle?.trim() || undefined}
          subtitle={td?.faqSectionSubtitle?.trim() || undefined}
          contactHref={supportEmail?.trim() ? `mailto:${supportEmail}` : '#organizer'}
        />

        {/* 14 · Sponsors — who supports it? */}
        {showSponsors && <SponsorsShowcase items={sponsors} />}

        {/* 15 · Legal — the permanent home for policy links */}
        <LegalStrip
          termsUrl={termsUrl}
          refundPolicyUrl={refundPolicyUrl}
          privacyPolicyUrl={privacyPolicyUrl}
          contactHref={supportEmail?.trim() ? `mailto:${supportEmail}` : '#organizer'}
        />

        {/* Persistent mobile CTA */}
        <StickyMobileCTA
          visible={true}
          title={title}
          isFreeEvent={isFreeEvent}
          passes={passes}
          registrationOpen={registrationOpen}
        />

      </main>
      <MarketingFooter />
    </>
  )
}

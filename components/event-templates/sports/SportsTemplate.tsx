// SportsTemplate (running) — now a CONSUMER of the ONE Event Details architecture.
//
// RD-ST4.3 Phase 1 (ST42-T01 · ST41-ARCH01 · ST41-I01):
//
//  • It used to hand-roll its own orchestration — its own MarketingNavbar/<main>/
//    MarketingFooter shell, its own StatusBar (a byte-for-byte duplicate of the
//    framework's StandardBar) and its own StickyMobileCTA placement — making it the
//    only one of the nine templates outside EventDetailsFramework. All of that is gone:
//    the framework owns the shell, the lifecycle banner and the sticky CTA, exactly as
//    it does for the other eight templates. There is now ONE architecture.
//
//  • It supplies its SECTION LIST as `children` (SHELL mode), so the Sports visual
//    language — poster hero, Challenge Studio, Experience, Race Day Journey, Route,
//    Race Kit, Legal strip — is preserved verbatim. Section order is unchanged.
//
//  • No 'use client'. This module has no hooks and no state, so it is a Server
//    Component; only the genuinely interactive sections below remain client islands.
//    The four data adapters (passesToChallenges / agendaToTimeline / legacyFaqToItems /
//    mediaToGallery) are imported from their directive-free *Model modules — importing
//    them from a 'use client' module would yield a client reference that cannot be
//    invoked on the server.
//
// NO visual change: same sections, same order, same props, same copy.

import { Shield } from 'lucide-react'
import type { EventDetailProps } from '@/components/event-templates/types'
import { EventDetailsFramework } from '@/components/event-templates/EventDetailsFramework'
import { EventInfoSection } from '@/components/event-templates/shared/ui/EventInfoSection'
import { LinkedCampaignSection } from '@/components/event-templates/shared/donation/LinkedCampaignSection'
import type { SportsRunningDetails, RaceCategory, TimelineItem, FaqItem } from '@/components/wizard/eventDetailsConfig'
import { cn } from '@/lib/utils/cn'
import {
  SectionShell, EventSectionHeader, EVENT_CONTAINER, BAND_PY, TYPE,
} from '@/components/event-templates/shared/ui/framework'
import { LegalStrip }            from '@/components/event-templates/shared/ui/LegalStrip'
import { SportsHero }            from './SportsHero'
import { SportsRouteMap }        from './SportsRouteMap'
import { SportsRaceKit }         from './SportsRaceKit'
import { ChallengeSelectionSection } from '@/components/event-templates/shared/registration/ChallengeSelectionSection'
import { passesToChallenges }    from '@/components/event-templates/shared/registration/challengeModel'
import { ExperienceSection }     from '@/components/event-templates/shared/experience/ExperienceSection'
import { JourneySection }        from '@/components/event-templates/shared/journey/JourneySection'
import { agendaToTimeline }      from '@/components/event-templates/shared/journey/journeyModel'
import { PromoVideoSection }     from '@/components/event-templates/shared/media/PromoVideoSection'
import { VenueShowcase }         from '@/components/event-templates/shared/venue/VenueShowcase'
import { OrganizerShowcase }     from '@/components/event-templates/shared/people/OrganizerShowcase'
import { resolveOrganizerContact } from '@/components/event-templates/shared/people/contactModel'
import { SpeakersSection }       from '@/components/event-templates/shared/people/SpeakersSection'
import { GalleryShowcase }       from '@/components/event-templates/shared/media/GalleryShowcase'
import { mediaToGallery }        from '@/components/event-templates/shared/media/galleryModel'
import { FAQShowcase }           from '@/components/event-templates/shared/faq/FAQShowcase'
import { legacyFaqToItems }      from '@/components/event-templates/shared/faq/faqModel'
import { SponsorsShowcase }      from '@/components/event-templates/shared/sponsors/SponsorsShowcase'

// ─── Template ──────────────────────────────────────────────────────────────────

export function SportsTemplate(props: EventDetailProps) {
  const {
    slug,
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

  const ls = props.lifecycleStatus

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

  // RD-ST15.0: ONE contact target for the whole page. Organizer, FAQ and Policies all
  // resolved "Contact Organizer" independently — the first from organizer.email, the
  // other two from supportEmail — so one label could point at two different addresses.
  const contact = resolveOrganizerContact({
    supportEmail,
    organizerEmail: organizer?.email,
    organizerPhone: organizer?.phone,
  })

  const hasRouteInfo = !!(td?.routeMapUrl?.trim() || td?.hydrationPoints?.trim() || td?.medicalSupportInfo?.trim() || td?.rulesUrl?.trim())
  const hasRaceKit   = !!(td?.kitCollectionInfo?.trim() || td?.kitCollectionDate?.trim() || td?.bagDepositInfo?.trim())

  return (
    <EventDetailsFramework
      props={props}
      shell="marketing"
      lifecycleTone="standard"
      completedMessage="This event has concluded. Thank you to all our participants!"
      registrationTargetId="register"
      // The Challenge section owns a selection-aware full-width sticky bar, so the
      // framework's floating mini-CTA would be a second, less informed action.
      showStickyCta={false}
    >

      {/* 1 · Hero — what is this? */}
      <SportsHero
        title={title}
        tagline={tagline}
        shortDesc={props.shortDesc}
        discipline={td?.disciplineLabel ?? props.eventSubtype}
        bannerUrl={bannerUrl}
        slug={slug}
        startDate={startDate}
        startTime={startTime}
        endDate={endDate}
        endTime={endTime}
        venueType={venueType}
        venueName={venueName}
        lifecycleStatus={ls}
        registrationOpen={registrationOpen}
        isFreeEvent={isFreeEvent}
        passes={passes}
        hasRefundPolicy={!!refundPolicyUrl}
        ctaLabel={td?.ctaLabel}
        countdownLabel={td?.countdownLabel}
        // Hero-only wiring. Every value already exists on the page's props — nothing
        // extra is fetched, computed server-side, or added to the schema.
        organizer={organizer}
        availability={availability}
        distances={raceCategories.map(c => c.distance).filter(Boolean)}
        showAttendeeCount={props.showAttendeeCount}
        showSocial={showSocial}
        physical={physical}
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
          <div className={cn(EVENT_CONTAINER, BAND_PY, 'flex items-start gap-3')}>
            <Shield className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div>
              <p className="text-fs-sm font-semibold text-foreground">Waiver required for participation</p>
              <p className="mt-0.5 text-fs-sm text-muted-foreground">
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
        eyebrow="The Experience"
        subtitle="Everything you’ll experience from registration to the finish line."
      />

      {/* 5 · Our Story — why does this event exist? */}
      {description?.trim() && (
        <SectionShell id="story" measure="prose" bg="muted">
          <EventSectionHeader eyebrow="Our Story" title="About the Event" />
          <p className={cn('whitespace-pre-line', TYPE.sectionDesc)}>{description}</p>
          {language && language !== 'en' && (
            <p className={cn('mt-4 font-medium', TYPE.cardBody)}>Conducted in {language}.</p>
          )}
        </SectionShell>
      )}

      {/* 6 · Promo Video */}
      <PromoVideoSection promoVideoUrl={promoVideoUrl} />

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
        subtitle="Everything you need to reach the event with confidence."
      />

      {/* ═══ RD-ST5.2 P0.2 · BACKGROUND CADENCE ═════════════════════════════════
          Sections 10–17 used to be EIGHT consecutive white bands, because each
          section chose its own background and none could see the sequence it sat
          in. The back half of the page had no rhythm signal beyond a hairline
          border.

          The template is the only file that can see the order, so the cadence is
          set here. Muted lands on Organizer, Gallery and Policies — spaced so that
          no run of identical bands exceeds two in EITHER direction:

            full   Venue·w  Org·m  Speakers·w  Gallery·m  FAQ·w  Sponsors·w  Policies·m  Essentials·w
            sparse Venue·w  ───    ───         ───        FAQ·w  ───         Policies·m  Essentials·w

          That second row matters: every section here self-hides, so a cadence
          that only works on a fully-populated event is not a cadence. These three
          positions survive the minimal case as well as the full one. */}

      {/* 10 · Organizer — who runs it? */}
      {showOrg && organizer?.name && (
        <OrganizerShowcase organizer={organizer} showSocial={showSocial} contactHref={contact.href} bg="muted" />
      )}

      {/* 11 · Race Leadership — the people behind it (sports never says "Speakers") */}
      {showSpeakers && speakers.length > 0 && (
        <SpeakersSection speakers={speakers} title="Race Leadership" subtitle="Meet the people behind the event." />
      )}

      {/* 12 · Gallery — can I see previous editions? */}
      {showGallery && (
        <GalleryShowcase items={props.galleryMedia?.length ? props.galleryMedia : mediaToGallery(gallery)} bg="muted" />
      )}

      {/* 13 · FAQ — still have questions? */}
      <FAQShowcase
        items={faqItems}
        title={td?.faqSectionTitle?.trim() || undefined}
        subtitle={td?.faqSectionSubtitle?.trim() || undefined}
        contactHref={contact.href || '#organizer'}
      />

      {/* 14 · Sponsors — who supports it? */}
      {showSponsors && <SponsorsShowcase items={sponsors} />}

      {/* 15 · Legal — the permanent home for policy links */}
      <LegalStrip
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
        contactHref={contact.href || '#organizer'}
        bg="muted"
      />

      {/* RD-ST13.0: refundPolicyUrl is deliberately NOT passed. The LegalStrip above
          already renders it as "Refund Policy"; passing it here would print the same
          link twice. The structured refundWindow is unique to this section, so it
          still comes through. */}
      <EventInfoSection
        language={props.language}
        dressCode={props.dressCode}
        timezone={props.timezone}
        refundWindow={props.refundWindow}
      />

      {props.linkedCampaign && (
        <LinkedCampaignSection campaign={props.linkedCampaign} eventSlug={slug} />
      )}

    </EventDetailsFramework>
  )
}

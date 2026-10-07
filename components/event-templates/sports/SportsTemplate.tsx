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
//    language — editorial cover (sports/editorial/SportsCover), Challenge Studio, Experience,
//    Race Day Journey, Route,
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
import { LinkedCampaignSection } from '@/components/event-templates/shared/donation/LinkedCampaignSection'
import type { SportsRunningDetails, RaceCategory, TimelineItem, FaqItem } from '@/components/wizard/eventDetailsConfig'
import { LANGUAGE_OPTIONS } from '@/components/wizard/eventDetailsConfig'
import { cn } from '@/lib/utils/cn'
import { EVENT_CONTAINER, BAND_PY } from '@/components/event-templates/shared/ui/framework'
import { LegalStrip }            from '@/components/event-templates/shared/ui/LegalStrip'
import { SportsCover }           from './editorial/SportsCover'
import { SportsSectionNav, type SportsSectionNavItem } from './editorial/SportsSectionNav'
import { SportsSection } from './editorial/primitives'
import { SportsChallenges }      from './editorial/SportsChallenges'
import { SportsJourney }         from './editorial/SportsJourney'
import { SportsStory }           from './editorial/SportsStory'
import { SportsCourse }          from './editorial/SportsCourse'
import { SportsRaceKit }         from './editorial/SportsRaceKit'
import { SportsVenue }           from './editorial/SportsVenue'
import { SportsOrganizer }       from './editorial/SportsOrganizer'
import { SportsSponsors }        from './editorial/SportsSponsors'
import { SportsGoodToKnow }      from './editorial/SportsGoodToKnow'
import { passesToChallenges }    from '@/components/event-templates/shared/registration/challengeModel'
import { ExperienceSection }     from '@/components/event-templates/shared/experience/ExperienceSection'
import { agendaToTimeline }      from '@/components/event-templates/shared/journey/journeyModel'
import { PromoVideoSection }     from '@/components/event-templates/shared/media/PromoVideoSection'
import { resolveOrganizerContact } from '@/components/event-templates/shared/people/contactModel'
import { SpeakersSection }       from '@/components/event-templates/shared/people/SpeakersSection'
import { GalleryShowcase }       from '@/components/event-templates/shared/media/GalleryShowcase'
import { mediaToGallery }        from '@/components/event-templates/shared/media/galleryModel'
import { FAQShowcase }           from '@/components/event-templates/shared/faq/FAQShowcase'
import { legacyFaqToItems }      from '@/components/event-templates/shared/faq/faqModel'

/** "ta" → "Tamil". The same lookup EventInfoSection uses; an unknown code falls through as-is. */
const languageLabel = (id: string) => LANGUAGE_OPTIONS.find(o => o.id === id)?.label ?? id

// ─── Template ──────────────────────────────────────────────────────────────────

export function SportsTemplate(props: EventDetailProps) {
  const {
    slug,
    registrationOpen,
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

  // Course — the distances that actually exist on this race, in pass order. The
  // challenge model already resolved each one (a linked race category first, then the
  // pass's own race details), so the cover, the index and the course section all name
  // the race identically and no third derivation appears on the page.
  const courseDistances = [...new Set(challenges.map(c => c.distance?.trim()).filter(Boolean) as string[])]
  const hasRouteInfo = !!(td?.routeMapUrl?.trim() || td?.hydrationPoints?.trim() || td?.medicalSupportInfo?.trim()
    || td?.rulesUrl?.trim() || td?.startLineInfo?.trim() || courseDistances.length > 0)

  // Race kit — what a runner collects. The inclusions are the pass benefits, already
  // resolved to display labels by passesToChallenges, de-duplicated across distances
  // in first-seen order. Nothing is added to the list that an organiser did not attach.
  const kitInclusions = [...new Set(challenges.flatMap(c => c.benefits))]
  const hasRaceKit   = !!(td?.kitCollectionInfo?.trim() || td?.kitCollectionDate?.trim()
    || td?.bagDepositInfo?.trim() || kitInclusions.length > 0)

  // The organizer and sponsor blocks share one two-column band when both exist.
  const hasOrganizerBlock = !!(showOrg && organizer?.name?.trim())
  const hasSponsorBlock   = !!(showSponsors && (sponsors ?? []).some(sp => sp && sp.enabled !== false && sp.name?.trim()))

  // Section navigation — the sections this template renders, in page order, keyed by the
  // ids the sections already carry. Sections that self-hide on empty data (Journey,
  // Sponsors, Venue, Good to Know) are reconciled against the DOM by the nav itself.
  const navItems: SportsSectionNavItem[] = [
    { id: 'overview',   label: 'Overview' },
    { id: 'register',   label: 'Challenges' },
    journeyItems.length > 0 && { id: 'journey', label: 'Journey' },
    hasRouteInfo            && { id: 'route',   label: 'Course' },
    description?.trim()     && { id: 'story',   label: 'Story' },
    { id: 'venue',      label: 'Venue' },
    hasRaceKit              && { id: 'kit',     label: 'Race Kit' },
    showOrg && organizer?.name && { id: 'organizer', label: 'Organizer' },
    showSponsors && (sponsors ?? []).length > 0 && { id: 'sponsors', label: 'Sponsors' },
    { id: 'event-info', label: 'Good to Know' },
  ].filter(Boolean) as SportsSectionNavItem[]

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
      <SportsCover
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
        distances={courseDistances}
        showAttendeeCount={props.showAttendeeCount}
        showSocial={showSocial}
        physical={physical}
      />

      {/* 1b · Section navigation — one hairline of in-page links under the cover */}
      <SportsSectionNav items={navItems} />

      {/* ═══ THE TWO-COLUMN BODY (2026-09-25, owner) ═══════════════════════════
             From lg: a wide reading column (the distances, the running order, the
             story, the course) and a narrow STICKY rail beside it holding the venue
             and the race kit as compact panels, so where and what-to-collect stay in
             view while the programme scrolls. Below lg it is one column, in the same
             reading order as before (the rail follows the course).

             The reading column's bands are full-bleed sections with their own page
             container; inside the column that container's gutter would double, so
             `[&>section>div]:px-0` zeroes it for the column's direct bands only. */}
      {/* Below lg (owner, 2026-09-25): the venue + kit rail follows the DISTANCES, not the
          end of the reading column — the reading column's wrapper dissolves (contents)
          and flex order places: distances (0) → rail (1) → everything else (2). */}
      <div className={cn(EVENT_CONTAINER, 'max-lg:flex max-lg:flex-col lg:grid lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-x-12 xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-x-16')}>
        <div className="min-w-0 max-lg:contents [&>div>div]:px-0 [&>section>div]:px-0 max-lg:[&>*]:order-2 max-lg:[&>#register]:order-none">

      {/* 2 · The distance index + the selected challenge — can I join?
          (The lifecycle banner above the cover already carries regClosedMessage; the
          section states registration as small type beside its heading instead.) */}
      <SportsChallenges
        slug={slug}
        challenges={challenges}
        registrationOpen={registrationOpen}
        eyebrow="Choose Your Challenge"
        title="Find Your Perfect Distance"
        subtitle="Every distance offers a different experience. Choose the challenge that matches your goal, fitness level and race ambition."
        ctaLabel={td?.ctaLabel ?? 'Register'}
      />

      {/* Waiver — registration consent (tokenised) */}
      {td?.requireWaiver && (
        <div className="border-b border-border/60 bg-muted/30">
          <div className={cn(EVENT_CONTAINER, BAND_PY, 'flex items-start gap-3')}>
            <Shield className="mt-0.5 size-4 shrink-0 text-action" aria-hidden />
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

      {/* 4 · The running order — what happens, and when? */}
      <SportsJourney
        items={journeyItems}
        eyebrow="Race Day"
        title="The Running Order"
        subtitle="Everything you’ll experience from the start line to the finish."
      />

      {/* 5 · Course / Route — where do I go? (before the story, owner 2026-09-25) */}
      <SportsCourse
        routeMapUrl={td?.routeMapUrl}
        hydrationPoints={td?.hydrationPoints}
        medicalSupport={td?.medicalSupportInfo}
        rulesUrl={td?.rulesUrl}
        startLineInfo={td?.startLineInfo}
        distances={courseDistances}
        eyebrow={td?.routeEyebrow}
        sectionTitle={td?.routeSectionTitle}
        sectionSubtitle={td?.routeSectionSubtitle}
        hydrationLabel={td?.hydrationLabel}
      />

      {/* 6 · Our Story — why does this event exist? */}
      {description?.trim() && (
        <SportsStory
          description={description}
          languageNote={language && language !== 'en' ? `Conducted in ${languageLabel(language)}.` : undefined}
        />
      )}

      {/* 7 · Promo Video */}
      <PromoVideoSection promoVideoUrl={promoVideoUrl} />

        </div>

        {/* 8 · The rail — where is it (venue), and what do I collect (race kit)? */}
        <aside aria-label="Venue and race kit" className="min-w-0 border-b border-border/60 py-10 max-lg:order-1 sm:py-12 lg:border-b-0 lg:py-16">
          <div className="flex flex-col gap-4 lg:sticky lg:top-[calc(var(--disc-nav-h,4.5rem)+1.5rem)] lg:max-h-[calc(100dvh-var(--disc-nav-h,4.5rem)-2.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:[scrollbar-width:thin]">
            <SportsVenue
              layout="rail"
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
            <SportsRaceKit
              layout="rail"
              kitCollectionInfo={td?.kitCollectionInfo}
              kitCollectionDate={td?.kitCollectionDate}
              bagDepositInfo={td?.bagDepositInfo}
              inclusions={kitInclusions}
            />
          </div>
        </aside>
      </div>

      {/* 10 · Who runs it, and who backs it — ONE band, two columns (owner, 2026-09-25):
          Hosted By on the left, Proudly Supported By on the right, a hairline between.
          When only one of the two exists it keeps the full-width band on its own, so the
          page never shows a half-empty row. */}
      {hasOrganizerBlock && hasSponsorBlock ? (
        <SportsSection id="behind-the-race" containerClassName="grid gap-12 lg:grid-cols-2 lg:gap-0 lg:divide-x lg:divide-border/60">
          <div className="min-w-0 lg:pr-12">
            <SportsOrganizer layout="column" organizer={organizer!} showSocial={showSocial} contactHref={contact.href} />
          </div>
          <div className="min-w-0 border-t border-border/60 pt-10 lg:border-t-0 lg:pl-12 lg:pt-0">
            <SportsSponsors layout="column" items={sponsors} />
          </div>
        </SportsSection>
      ) : hasOrganizerBlock ? (
        <SportsOrganizer organizer={organizer!} showSocial={showSocial} contactHref={contact.href} />
      ) : null}

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

      {/* 14 · Sponsors on their own — only when there is no organizer block to pair with. */}
      {hasSponsorBlock && !hasOrganizerBlock && <SportsSponsors items={sponsors} />}

      {/* 15 · Legal — the permanent home for policy links */}
      <LegalStrip
        termsUrl={termsUrl}
        refundPolicyUrl={refundPolicyUrl}
        privacyPolicyUrl={privacyPolicyUrl}
        contactHref={contact.href || '#organizer'}
        bg="muted"
      />

      {/* 16 · Essentials — the colophon. refundPolicyUrl is deliberately NOT passed:
          the LegalStrip above already renders it, and the structured refundWindow is
          the only fact unique to this section. */}
      <SportsGoodToKnow
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
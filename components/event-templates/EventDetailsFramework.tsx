'use client'

// RD-ATTENDEE-01 Phase 2 / 2B — the ONE shared Event Details FRAMEWORK.
//
// It owns the page chrome (shell), the lifecycle banner, the sticky CTA, and — for the
// showcase templates — the full standard section composition + ordering. Two modes:
//
//   • COMPOSED (default): no `children`. The framework composes the standard shared
//     sections from props (used by Meetup, Team Sports). Chrome = MarketingNavbar+Footer.
//   • SHELL: `children` provided. The template supplies its own bespoke hero + sections
//     (used by the legacy templates that keep their distinct look); the framework still
//     owns the shell (EventPageLayout), the lifecycle banner and the sticky CTA. This
//     removes the duplicated scaffold WITHOUT changing any template's appearance —
//     bespoke content passes through verbatim; the lifecycle banner is reproduced
//     byte-for-byte via `lifecycleTone` (or left in the children via 'none').
//
// This file introduces NO new visual design. It only relocates duplicated orchestration.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { XCircle, CheckCircle, Lock, Clock3 } from 'lucide-react'
import type { EventDetailProps } from '@/app/events/[slug]/EventDetailClient'
import { LinkedCampaignSection } from '@/app/events/[slug]/EventDetailClient'
import { EventInfoSection } from '@/components/event-templates/shared/ui/EventInfoSection'
import { MarketingNavbar } from '@/components/marketing/navigation/MarketingNavbar'
import { MarketingFooter } from '@/components/marketing/footer/MarketingFooter'
import { EventPageLayout } from '@/components/event-templates/shared/ui/EventPageLayout'
import { StickyMobileCTA } from '@/components/event-templates/shared/registration/StickyMobileCTA'
import { SectionShell, SectionHeader } from '@/components/event-templates/shared/ui/framework'
import { EventHero } from '@/components/event-templates/shared/hero/EventHero'
import { TicketSection } from '@/components/event-templates/shared/registration/TicketSection'
import { VenueShowcase } from '@/components/event-templates/shared/venue/VenueShowcase'
import { OrganizerShowcase } from '@/components/event-templates/shared/people/OrganizerShowcase'
import { SpeakersSection } from '@/components/event-templates/shared/people/SpeakersSection'
import { GalleryShowcase, mediaToGallery } from '@/components/event-templates/shared/media/GalleryShowcase'
import { FAQShowcase, legacyFaqToItems } from '@/components/event-templates/shared/faq/FAQShowcase'
import { SponsorsShowcase } from '@/components/event-templates/shared/sponsors/SponsorsShowcase'
import { PromoVideoSection } from '@/components/event-templates/shared/media/PromoVideoSection'
import { JourneySection, agendaToTimeline } from '@/components/event-templates/shared/journey/JourneySection'

// ─── Lifecycle banner ───────────────────────────────────────────────────────────
// 'standard' = the tokenised slim band used by the composed showcase templates.
// 'light'    = byte-for-byte reproduction of the legacy EventPageLayout templates'
//              banner (conference/workshop/exhibition/community share this exactly).
// 'none'     = render nothing (the dark cultural/awards templates keep their own
//              bespoke banner inline in their children).
export type LifecycleTone = 'standard' | 'light' | 'none'

function StandardBar({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className="border-b border-border/60 bg-muted/40">
      <div className="mx-auto flex max-w-6xl items-center gap-2.5 px-4 py-2.5 sm:px-6 lg:px-8">
        <Icon className="size-4 shrink-0 text-primary" aria-hidden />
        <p className="text-[12.5px] font-semibold text-foreground">{children}</p>
      </div>
    </div>
  )
}

function LightBar({ icon: Icon, border, bg, dot, text, bold, children }: {
  icon: LucideIcon; border: string; bg: string; dot: string; text: string; bold?: boolean; children: ReactNode
}) {
  return (
    <div className={`border-b ${border} ${bg} px-5 py-2.5`}>
      <div className="mx-auto flex max-w-7xl items-center gap-2.5">
        <Icon className={`size-4 shrink-0 ${dot}`} aria-hidden />
        <p className={`text-xs ${bold ? 'font-bold' : 'font-semibold'} ${text}`}>{children}</p>
      </div>
    </div>
  )
}

function LifecycleBanner({
  status, cancelReason, tone,
  cancelledMessage, completedMessage, registrationClosedMessage, postponedMessage,
}: {
  status?: string; cancelReason?: string; tone: LifecycleTone
  cancelledMessage: string; completedMessage: string
  registrationClosedMessage: string; postponedMessage: string
}) {
  if (tone === 'none' || !status) return null
  const cancelled = <>{cancelledMessage}{cancelReason && ` ${cancelReason}`}</>
  if (tone === 'light') {
    if (status === 'cancelled')            return <LightBar icon={XCircle}     border="border-red-200"    bg="bg-red-50"    dot="text-red-500"    text="text-red-700"    bold>{cancelled}</LightBar>
    if (status === 'completed')            return <LightBar icon={CheckCircle} border="border-sky-200"    bg="bg-sky-50"    dot="text-sky-500"    text="text-sky-700">{completedMessage}</LightBar>
    if (status === 'registration_closed')  return <LightBar icon={Lock}        border="border-amber-200"  bg="bg-amber-50"  dot="text-amber-500"  text="text-amber-700">{registrationClosedMessage}</LightBar>
    if (status === 'postponed')            return <LightBar icon={Clock3}      border="border-orange-200" bg="bg-orange-50" dot="text-orange-500" text="text-orange-700">{postponedMessage}</LightBar>
    return null
  }
  if (status === 'cancelled')           return <StandardBar icon={XCircle}>{cancelled}</StandardBar>
  if (status === 'completed')           return <StandardBar icon={CheckCircle}>{completedMessage}</StandardBar>
  if (status === 'registration_closed') return <StandardBar icon={Lock}>{registrationClosedMessage}</StandardBar>
  if (status === 'postponed')           return <StandardBar icon={Clock3}>{postponedMessage}</StandardBar>
  return null
}

// Type-specific sections a COMPOSED template injects into the standard order.
export interface EventFrameworkSlots {
  beforeRegistration?: ReactNode
  afterAbout?: ReactNode
}

export interface EventDetailsFrameworkProps {
  props:                 EventDetailProps
  /** Drives the composed hero/journey. Optional in shell mode (template owns its hero). */
  eventType?:            string | null
  /** 'marketing' (navbar + footer) or 'page-layout' (navbar + breadcrumb, no footer). */
  shell?:                'marketing' | 'page-layout'
  lifecycleTone?:        LifecycleTone
  cancelledMessage?:          string
  completedMessage?:          string
  registrationClosedMessage?: string
  postponedMessage?:          string
  registrationTargetId?: string
  /** SHELL mode: the template's own bespoke hero + sections. Omit for COMPOSED mode. */
  children?:             ReactNode
  // COMPOSED-mode config (ignored in shell mode):
  heroKicker?:           string
  aboutEyebrow?:         string
  aboutTitle?:           string
  scheduleEyebrow?:      string
  scheduleTitle?:        string
  scheduleSubtitle?:     string
  slots?:                EventFrameworkSlots
}

// The standard shared section composition (COMPOSED mode).
function ComposedBody({
  props, eventType: eventTypeIn, heroKicker, aboutEyebrow = 'About', aboutTitle = 'About',
  scheduleEyebrow = 'Schedule', scheduleTitle = "What's happening", scheduleSubtitle,
  registrationTargetId = 'tickets', slots,
}: EventDetailsFrameworkProps) {
  const eventType = eventTypeIn ?? ''
  const {
    slug, registrationOpen, regClosedMessage,
    title, tagline, description, bannerUrl, gallery, promoVideoUrl,
    startDate, startTime, endDate, endTime,
    venueType, physical, online, venueName, mapsLink, venueMaps, showVenueMap,
    isFreeEvent, passes, availability,
    sponsors, organizer, showOrg, showSocial, speakers,
    showSponsors, showAgenda, showGallery, showSpeakers,
    agenda, supportEmail, lifecycleStatus: ls,
  } = props

  const faqItems     = props.faq?.length ? props.faq : legacyFaqToItems(undefined)
  const journeyItems = showAgenda ? agendaToTimeline(agenda, speakers) : []

  return (
    <>
      <EventHero
        eventType={eventType}
        kicker={heroKicker}
        title={title}
        tagline={tagline}
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
        registerHref={`#${registrationTargetId}`}
      />

      {slots?.beforeRegistration}

      <TicketSection
        passes={passes}
        isFreeEvent={isFreeEvent}
        slug={slug}
        availability={availability}
        registrationOpen={registrationOpen}
        closedMessage={regClosedMessage}
      />

      {props.linkedCampaign && (
        <LinkedCampaignSection campaign={props.linkedCampaign} eventSlug={slug} />
      )}

      {description?.trim() && (
        <SectionShell id="about" maxW="3xl" bg="muted">
          <SectionHeader eyebrow={aboutEyebrow} title={aboutTitle} />
          <p className="whitespace-pre-line text-[15px] leading-relaxed text-muted-foreground">{description}</p>
        </SectionShell>
      )}

      {slots?.afterAbout}

      <PromoVideoSection promoVideoUrl={promoVideoUrl} className="border-b border-border/60 bg-white py-14 sm:py-16" />

      {journeyItems.length > 0 && (
        <JourneySection items={journeyItems} eventType={eventType} eyebrow={scheduleEyebrow} title={scheduleTitle} subtitle={scheduleSubtitle} />
      )}

      {showSpeakers && speakers.length > 0 && (
        <SpeakersSection speakers={speakers} />
      )}

      <VenueShowcase
        venueType={venueType}
        venueName={venueName}
        physical={physical}
        online={online}
        mapsLink={mapsLink}
        maps={showVenueMap ? venueMaps : null}
      />

      {showOrg && organizer?.name && (
        <OrganizerShowcase organizer={organizer} showSocial={showSocial} />
      )}

      {showGallery && (
        <GalleryShowcase items={props.galleryMedia?.length ? props.galleryMedia : mediaToGallery(gallery)} />
      )}

      {showSponsors && <SponsorsShowcase items={sponsors} />}

      <EventInfoSection
        language={props.language}
        dressCode={props.dressCode}
        timezone={props.timezone}
        venueType={props.venueType}
        online={props.online}
        refundWindow={props.refundWindow}
        refundPolicyUrl={props.refundPolicyUrl}
      />

      <FAQShowcase
        items={faqItems}
        contactHref={supportEmail?.trim() ? `mailto:${supportEmail}` : '#organizer'}
      />
    </>
  )
}

export function EventDetailsFramework(config: EventDetailsFrameworkProps) {
  const {
    props, shell = 'marketing', lifecycleTone = 'standard',
    cancelledMessage = 'This event has been cancelled.',
    completedMessage = 'This event has concluded. Thank you to all who attended!',
    registrationClosedMessage = 'Registrations are currently closed for this event.',
    postponedMessage = 'This event has been postponed.',
    registrationTargetId = 'tickets', children,
  } = config

  const lifecycle = (
    <LifecycleBanner
      status={props.lifecycleStatus}
      cancelReason={props.cancelReason}
      tone={lifecycleTone}
      cancelledMessage={cancelledMessage}
      completedMessage={completedMessage}
      registrationClosedMessage={registrationClosedMessage}
      postponedMessage={postponedMessage}
    />
  )

  // C4 + 03B: the CTA self-gates on scroll (no overlap) and adds a persistent DESKTOP
  // quick-register pill so the buried tickets section always stays one click away.
  const sticky = (
    <StickyMobileCTA
      showDesktop
      title={props.title}
      isFreeEvent={props.isFreeEvent}
      passes={props.passes}
      registrationOpen={props.registrationOpen}
      targetId={registrationTargetId}
    />
  )

  const body = children ?? <ComposedBody {...config} />
  const content = <>{lifecycle}{body}{sticky}</>

  if (shell === 'page-layout') {
    return (
      <EventPageLayout eventType={props.eventType} title={props.title}>
        {content}
      </EventPageLayout>
    )
  }

  return (
    <>
      <MarketingNavbar />
      <main>{content}</main>
      <MarketingFooter />
    </>
  )
}

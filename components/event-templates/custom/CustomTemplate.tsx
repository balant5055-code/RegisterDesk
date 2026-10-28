// Custom Event template — "the invitation".
//
// Before this file, `eventType: 'custom'` had no template and fell through to the legacy
// EventDetailClient fallback. Fundraising and unknown types still use that fallback.
//
// ONE grid for the whole page, on the one page container:
//   hero      — identity + matted poster, inside the container (no full-bleed panels)
//   body      — main column (8/12) of uniform LuxeBlocks + a sticky registration aside
//               (4/12). On mobile the aside card comes straight after the hero.
// Every section therefore starts on the same left edge, uses the same header and the
// same rhythm — the mismatch between editorial and shared-showcase bands is gone.
//
// SHELL mode of EventDetailsFramework: the framework keeps the page chrome and the
// lifecycle banner. No hooks here, so this stays a Server Component; only the
// registration card (share) is a client island.

import type { EventDetailProps } from '@/components/event-templates/types'
import { EventDetailsFramework } from '@/components/event-templates/EventDetailsFramework'
import { LinkedCampaignSection } from '@/components/event-templates/shared/donation/LinkedCampaignSection'
import { EVENT_CONTAINER } from '@/components/event-templates/shared/ui/framework'
import { mediaToGallery } from '@/components/event-templates/shared/media/galleryModel'
import { eventSubtypeLabel } from '@/lib/events/taxonomy'
import { cn } from '@/lib/utils/cn'
import { resolveAdmissionState } from './admissionModel'
import { CustomHero } from './CustomHero'
import { CustomRegisterCard } from './CustomRegisterCard'
import { CustomAdmission } from './CustomAdmission'
import { CustomMobileBar } from './CustomMobileBar'
import {
  AboutBlock, FilmBlock, ProgrammeBlock, SpeakersBlock, VenueBlock, OrganizerBlock,
  GalleryBlock, SponsorsBlock, EssentialsBlock, FaqBlock,
} from './CustomSections'

export function CustomTemplate(props: EventDetailProps) {
  const {
    slug, title, passes, availability, registrationOpen, regClosedMessage, isFreeEvent,
    eventType, eventSubtype, physical, description, shortDesc,
    showAgenda, agenda, speakers, showSpeakers, showOrg, organizer,
    showGallery, gallery, showSponsors, sponsors, supportEmail, supportPhone, showSocial,
  } = props

  const admission = resolveAdmissionState({ slug, passes, availability, registrationOpen, regClosedMessage })

  // The organizer's own subtype if they set one, else the city. Never the raw type id —
  // "CUSTOM" is our vocabulary, not the attendee's.
  // RD-CUSTOM-PUBLIC-01: includes the free text the organizer typed in Step 1 ("Product Launch").
  const kicker = eventSubtypeLabel(eventType, eventSubtype, props.customEventSubtype) ?? (physical?.city?.trim() || null)

  // The About block would only repeat the hero lede when the long text IS the short text.
  const story = description?.trim() && description.trim() !== shortDesc?.trim() ? description : ''

  return (
    // The framework's floating CTA is off: its desktop pill would duplicate the sticky
    // aside, and on mobile CustomMobileBar is pinned permanently instead.
    <EventDetailsFramework props={props} registrationTargetId="tickets" showStickyCta={false}>
      <CustomHero props={props} kicker={kicker} />

      <div className="bg-background">
        <div className={cn(EVENT_CONTAINER, 'grid gap-8 py-8 sm:py-10 lg:grid-cols-12 lg:gap-12 lg:py-12')}>
          <aside className="min-w-0 lg:order-2 lg:col-span-4">
            <div className="lg:sticky lg:top-24">
              <CustomRegisterCard props={props} admission={admission} />
            </div>
          </aside>

          <div className="min-w-0 lg:order-1 lg:col-span-8">
            <AboutBlock description={story} />

            <CustomAdmission
              admission={admission}
              passes={passes}
              availability={availability}
              slug={slug}
              isFreeEvent={isFreeEvent}
              attendeePaysFees={props.attendeePaysFees === true}
              registrationAccess={props.registrationAccess}
              approvalRequired={props.approvalRequired === true}
              eventMilestoneAlert={props.eventMilestoneAlert}
            />

            {props.linkedCampaign && (
              <LinkedCampaignSection campaign={props.linkedCampaign} eventSlug={slug} layout="inline" />
            )}

            <FilmBlock url={props.promoVideoUrl} title={title} />

            {showAgenda && <ProgrammeBlock agenda={agenda} speakers={speakers} />}

            {showSpeakers && <SpeakersBlock speakers={speakers} />}

            <VenueBlock
              venueType={props.venueType}
              venueName={props.venueName}
              physical={physical}
              online={props.online}
              mapsLink={props.mapsLink}
              maps={props.showVenueMap ? props.venueMaps : null}
            />

            {showOrg && organizer?.name?.trim() && <OrganizerBlock organizer={organizer} supportEmail={supportEmail} supportPhone={supportPhone} showSocial={showSocial} />}

            {showGallery && (
              <GalleryBlock items={props.galleryMedia?.length ? props.galleryMedia : mediaToGallery(gallery)} />
            )}

            {showSponsors && <SponsorsBlock sponsors={sponsors} />}

            <EssentialsBlock
              language={props.language}
              dressCode={props.dressCode}
              timezone={props.timezone}
              refundWindow={props.refundWindow}
              refundPolicyUrl={props.refundPolicyUrl}
              termsUrl={props.termsUrl}
              privacyPolicyUrl={props.privacyPolicyUrl}
              faqUrl={props.faqUrl}
              supportEmail={supportEmail}
              supportPhone={supportPhone}
            />

            <FaqBlock items={props.faq ?? []} />
          </div>
        </div>
      </div>

      <CustomMobileBar admission={admission} passes={passes} availability={availability} isFreeEvent={isFreeEvent} />
    </EventDetailsFramework>
  )
}

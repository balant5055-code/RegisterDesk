// Shared types for the event-templates system.
// PassPublic is the canonical client-side pass shape — this is the authoritative definition.
// Both EventDetailClient and page.tsx import from here.
//
// RD-ST4.3 (ST42-L01): EventDetailProps and LinkedCampaign also live here now. They used
// to be declared in app/events/[slug]/EventDetailClient.tsx, which forced every template
// in the component layer to import from a Next.js ROUTE file — an inverted dependency
// that pulled the 997-line legacy client module into every template's graph. The shapes
// are unchanged; only their home moved.

import type {
  AgendaSession, Speaker, Sponsor,
  PhysicalVenueConfig, OnlineVenueConfig, OrganizerInfo,
  MediaAsset, VenueMaps,
  ExperienceItem, TimelineItem, GalleryItem, FaqItem,
  RefundWindow,
} from '@/components/wizard/eventDetailsConfig'
import type { PassAvailability } from '@/lib/registrations/types'
import type { MilestoneAlert, ResolvedMilestoneAlert } from '@/lib/events/milestoneAlerts'

export interface PassPublic {
  id:                  string
  name:                string
  description:         string
  price:               number
  quantity:            number | null
  unlimited:           boolean
  salesStartDate?:     string
  salesEndDate?:       string
  hideWhenSoldOut?:    boolean
  showRemainingSeats?: boolean
  /**
   * The milestone notice CURRENTLY showing for this pass, already resolved on the server
   * from the existing registration counter. Templates render it and nothing else — the raw
   * booking count and the organizer's full threshold configuration never cross to the client.
   * Absent ⇒ no notice, which is every pass today.
   */
  milestoneAlert?:     ResolvedMilestoneAlert | null
  /**
   * The organizer's CONFIGURED milestone notices for this pass, as stored on the event.
   * Declared here — rather than left to an inline cast at the call site — because a pass
   * projection that silently drops it produces a feature that is quietly dead while every
   * gate stays green. That already happened once: the registration page rebuilt passes as a
   * field-by-field literal, `milestoneAlerts` was not in the list, and nothing could detect
   * it because no type ever claimed the field existed.
   *
   * This is CONFIGURATION, not display data. Surfaces render `milestoneAlert` (resolved,
   * singular) — the server reads this array, decides, and hands down only the outcome.
   */
  milestoneAlerts?:    MilestoneAlert[]
  status?:             'active' | 'inactive'
  visibility?:         string
  benefits?:           string[]
  // Organizer's "featured / recommended" toggle from the pass builder. Surfaced here
  // (03B.3) so ticket cards can highlight the pass the organizer actually chose, instead
  // of guessing by position/name. Flows through page.tsx's pass projection; absent ⇒
  // each surface keeps its prior default highlight.
  featured?:           boolean
  // Early-bird pricing (optional; present on passes that opt in). The effective
  // price is resolved via lib/pricing/earlyBird.ts — do not compare these fields
  // ad hoc. `price` above always remains the regular price.
  earlyBirdEnabled?:   boolean
  earlyBirdPrice?:     number | null
  earlyBirdEndDate?:   string
  // C2: the price to DISPLAY — the early-bird price while active, else regular.
  // Resolved ONCE server-side (app/events/[slug]/page.tsx) via the canonical
  // resolveEffectivePriceRupees so every display surface shows the same amount the
  // checkout charges, with no client Date.now() (avoids SSR/hydration drift at the
  // cutoff). Read it via passDisplayPrice(); absent ⇒ fall back to `price`.
  effectivePrice?:     number
  // M2: the pass's sales-window state ('scheduled' | 'open' | 'ended'), resolved
  // server-side against the event timezone so ticket cards reflect the same window the
  // server gate enforces. Absent ⇒ treat as 'open' (backward-compatible).
  saleState?:          'scheduled' | 'open' | 'ended'
  // RD-ST6.0 — fields the pass builder ALREADY writes and page.tsx already projects
  // (pricing.passes is passed through verbatim); they were simply not declared here,
  // so the public surfaces could not read them. Declaring them is a type-level change
  // only — no Firestore write, no schema migration, no new query.
  /** Organiser free-text benefits, alongside the curated `benefits` IDs. */
  customBenefits?:     string[]
  /** Booking limit per order, from the pass builder. */
  maxPurchase?:        number
  /** Pass policy flags the builder already writes. */
  advancedSettings?: {
    transferable?:  boolean
    refundable?:    boolean
    waitlist?:      boolean
    groupBooking?:  boolean
  } | null
  /** Race category + age eligibility, from the pass builder's Race Details block. */
  raceDetails?: {
    category?:       string
    customCategory?: string
    minAge?:         number | null
    maxAge?:         number | null
  } | null
}

// ─── Linked donation campaign ──────────────────────────────────────────────────
// Present for event_plus_donation events only. Projected by app/events/[slug]/page.tsx.
export interface LinkedCampaign {
  slug:               string
  title:              string
  story:              string
  targetAmountRupees: number | null
  showGoalAmount:     boolean
  endDate:            string
  totalRaisedPaise:   number
  donorCount:         number
}

// ─── The ONE Event Details contract ────────────────────────────────────────────
// Every template (and the legacy EventDetailClient fallback) consumes this exact shape,
// projected once by app/events/[slug]/page.tsx.
export interface EventDetailProps {
  slug:              string
  lifecycleStatus:   string
  cancelReason?:     string
  eventType?:        string
  eventSubtype?:     string
  registrationOpen: boolean
  regClosedMessage: string
  title:            string
  tagline:          string
  /** info.fullDesc || info.shortDesc — the long-form body the Story section renders. */
  description:      string
  /** info.shortDesc on its own. RD-ST5.0: the hero needs the SHORT blurb; before this
   *  it could only reach `description`, which is the full body — so a hero that showed a
   *  summary was really showing a truncated copy of the About section. */
  shortDesc:        string
  bannerUrl:        string
  logoUrl:          string
  gallery:          MediaAsset[]
  promoVideoUrl:    string
  startDate:        string
  startTime:        string
  endDate:          string
  endTime:          string
  doorsOpenTime:    string
  agenda:           AgendaSession[]
  venueType:        'physical' | 'online' | 'hybrid'
  physical?:        PhysicalVenueConfig
  online?:          OnlineVenueConfig
  venueName:        string
  mapsLink:         string
  venueMaps:        VenueMaps | null
  organizer?:       OrganizerInfo
  showOrg:          boolean
  showSocial:       boolean
  showVenueMap:     boolean
  isFreeEvent:      boolean
  passes:           PassPublic[]
  availability:     Record<string, PassAvailability>
  /**
   * The EVENT-TOTAL milestone notice currently showing, already resolved on the server from
   * `registrationCounters.totalCount`. Rendered once, above the pass list — it belongs to the
   * event, not to any pass, so it stays valid whichever pass the attendee is looking at.
   * Only the resolved message crosses to the client; the raw count and the organizer's
   * threshold configuration never leave the server. Absent ⇒ no notice.
   */
  eventMilestoneAlert?: ResolvedMilestoneAlert | null
  speakers:         Speaker[]
  sponsors:         Sponsor[]
  showSpeakers:      boolean
  showSponsors:      boolean
  showAgenda:        boolean
  showGallery:       boolean
  showAttendeeCount: boolean
  typeDetails:       Record<string, unknown> | null
  experience?:       ExperienceItem[]
  timeline?:         TimelineItem[]
  galleryMedia?:     GalleryItem[]
  faq?:              FaqItem[]
  language:         string
  dressCode:        string
  timezone?:        string
  refundWindow?:    RefundWindow | null
  faqUrl:           string
  supportEmail:     string
  supportPhone:     string
  termsUrl:         string
  refundPolicyUrl:  string
  privacyPolicyUrl: string
  // Linked donation campaign — present for event_plus_donation events only
  linkedCampaign?: LinkedCampaign | null
  // Registered exhibitors for the public directory — exhibition events only
  exhibitorDirectory?: { companyName: string; website: string | null }[]
  // Applications CTAs — shown when organiser enables them
  speakerApplicationsOpen?: boolean
  sponsorApplicationsOpen?: boolean
}

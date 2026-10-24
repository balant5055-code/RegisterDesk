// Server-only. THE mapping from an events/{slug} document to the props every public event
// template renders (components/event-templates/TemplateRouter).
//
// ═══ WHY THIS IS SHARED ══════════════════════════════════════════════════════
// The public page (app/events/[slug]/page.tsx) and the Super Admin pre-approval preview
// (GET /api/admin/events/[slug]/preview → /admin/preview/events/[slug]) must render the SAME
// page. Before this module the projection lived inline in the public page, and the only
// "preview" anywhere was a hand-built approximation in the organizer wizard — an admin
// could not see what approval was about to publish. Both callers now go through
// loadEventPageData + buildEventPageProps, so there is exactly one mapping to drift.
//
// The code below was MOVED, not rewritten, from app/events/[slug]/page.tsx.
//
// Two deliberate differences between the callers, both explicit parameters here:
//   • `displayLifecycle` — the preview renders a pending event AS IT WILL LOOK once approved
//     ('published'), so the registration window, CTAs and application links are the ones
//     the public will get. The public page passes nothing and uses the stored state.
//   • `includeUnapprovedCampaign` — the public page shows a linked donation campaign only
//     while its event may raise money (lib/campaigns/linkedEventGate); the preview shows it
//     regardless, because reviewing it is the point.

import { adminDb } from '@/lib/firebase/admin'
import { getRegistrationCounter } from '@/lib/firebase/firestore/registrationCounters'
import { getCampaignBySlug, getCampaignCounter } from '@/lib/firebase/firestore/campaigns'
import { computeEventAvailability } from '@/lib/registrations/availability'
import { deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import { resolveMilestoneAlertsByPass, resolveMilestoneAlert } from '@/lib/events/milestoneAlerts'
import type { MilestoneAlert } from '@/lib/events/milestoneAlerts'
import { resolveEffectivePriceRupees } from '@/lib/pricing/earlyBird'
import { nowLocalInTz, resolvePassSaleState } from '@/lib/registrations/salesWindow'
import type { PassAvailability } from '@/lib/registrations/types'
import type {
  EventDetailsDraft,
  VenueType, PhysicalVenueConfig, OnlineVenueConfig,
  Speaker, Sponsor,
} from '@/components/wizard/eventDetailsConfig'
import { ONLINE_PLATFORM_LABELS } from '@/components/wizard/eventDetailsConfig'
import type { EventDetailProps, PassPublic } from '@/components/event-templates/types'
import type { PublishedEvent } from '@/lib/firebase/firestore/events'
import type { EventLifecycleStatus } from '@/types/events'
import { linkedEventAllowsCampaign } from '@/lib/campaigns/linkedEventGate'

type RegistrationCounter = Awaited<ReturnType<typeof getRegistrationCounter>>

// ─── Helpers ──────────────────────────────────────────────────────────────────

function venueLabel(
  type:     VenueType,
  physical: PhysicalVenueConfig | undefined,
  online:   OnlineVenueConfig   | undefined,
): string {
  if (type === 'online' || type === 'hybrid') {
    const platform = online?.platform
    return platform ? ONLINE_PLATFORM_LABELS[platform] ?? 'Online' : 'Online'
  }
  const city = physical?.city?.trim()
  const name = physical?.name?.trim()
  return city ? (name ? `${name}, ${city}` : city) : (name ?? 'Venue TBA')
}

function extractSpeakers(typeDetails: Record<string, unknown> | null): Speaker[] {
  if (!typeDetails) return []
  // judges is used by the Awards type; speakers/trainers/artists by others.
  const lists = [typeDetails.speakers, typeDetails.trainers, typeDetails.artists, typeDetails.judges]
  return lists
    .filter(Array.isArray)
    .flatMap(l => l as Speaker[])
    .filter(s => s.name?.trim())
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

function extractSponsors(ed: EventDetailsDraft, typeDetails: Record<string, unknown> | null): Sponsor[] {
  let list: Sponsor[]
  // Try the new top-level sponsors field first.
  if (Array.isArray(ed.sponsors) && ed.sponsors.length > 0) {
    list = (ed.sponsors as Sponsor[]).filter(s => s.name?.trim())
  } else if (typeDetails && Array.isArray(typeDetails.sponsors)) {
    // Backward-compat: old Conference events stored sponsors inside typeDetails.sponsors.
    list = (typeDetails.sponsors as Sponsor[]).filter(s => s.name?.trim())
  } else {
    return []
  }
  return list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

// C2 + M2: stamp each public pass with (a) its effective early-bird display price and
// (b) its sales-window state, both resolved via the ONE canonical resolver at a single
// `now`/`today`. Lives outside the render body (like extractPasses on the register page)
// so the impure Date.now()/new Date() reads aren't evaluated during component render.
// `price` stays the regular price; display surfaces read `effectivePrice` / `saleState`.
function withEffectivePrices(passes: PassPublic[], tz: string): PassPublic[] {
  const now      = Date.now()
  // RD-CE-FIX (sales window) — local date-TIME in the event timezone (shared with the gate).
  const nowLocal = nowLocalInTz(tz)
  return passes.map(p => ({
    ...p,
    effectivePrice: resolveEffectivePriceRupees(
      {
        price:            typeof p.price === 'number' ? p.price : 0,
        earlyBirdEnabled: p.earlyBirdEnabled === true,
        earlyBirdPrice:   typeof p.earlyBirdPrice === 'number' ? p.earlyBirdPrice : null,
        earlyBirdEndDate: typeof p.earlyBirdEndDate === 'string' ? p.earlyBirdEndDate : undefined,
      },
      now,
      tz,
    ),
    saleState: resolvePassSaleState(p, nowLocal),
  }))
}

// ─── Data ─────────────────────────────────────────────────────────────────────

export interface EventPageData {
  counter:            RegistrationCounter
  linkedCampaign:     EventDetailProps['linkedCampaign']
  exhibitorDirectory: { companyName: string; website: string | null }[]
}

/** The reads the template needs beyond the event document itself. */
export async function loadEventPageData(
  slug:  string,
  event: PublishedEvent,
  opts:  { includeUnapprovedCampaign?: boolean } = {},
): Promise<EventPageData> {
  const counterP = getRegistrationCounter(slug)

  // Load linked donation campaign for event_plus_donation events
  const linkedCampaignP = (async () => {
    if (!event.linkedCampaignSlug) return null
    // The donation panel appears only while this event may raise money — the rule the
    // campaign page and donation orders enforce (lib/campaigns/linkedEventGate). The admin
    // preview opts out so the panel can be reviewed before approval.
    if (!opts.includeUnapprovedCampaign && !linkedEventAllowsCampaign(event)) return null
    const [campaign, donCounter] = await Promise.all([
      getCampaignBySlug(event.linkedCampaignSlug),
      getCampaignCounter(event.linkedCampaignSlug),
    ])
    if (!campaign) return null
    const cd = campaign.campaignDetails
    return {
      slug:               campaign.slug,
      title:              cd.basics.title,
      story:              cd.basics.story,
      targetAmountRupees: cd.goal.targetAmountRupees,
      showGoalAmount:     cd.goal.showGoalAmount,
      endDate:            cd.goal.endDate,
      totalRaisedPaise:   donCounter?.totalRaisedPaise ?? 0,
      donorCount:         donCounter?.donorCount       ?? 0,
    }
  })()

  // Load registered exhibitors for exhibition public directory
  const exhibitorDirectoryP = (async () => {
    if (event.eventType !== 'exhibition') return []
    try {
      const snap = await adminDb
        .collection('registrations')
        .where('eventSlug', '==', slug)
        .where('status',    '==', 'confirmed')
        .limit(200)
        .get()
      const out: { companyName: string; website: string | null }[] = []
      for (const doc of snap.docs) {
        const r = doc.data() as Record<string, unknown>
        const passName = (r.passName as string | undefined ?? '').toLowerCase()
        if (!passName.includes('exhibitor')) continue
        const cn = (r.companyName as string | null | undefined)?.trim()
        if (!cn) continue
        out.push({ companyName: cn, website: (r.website as string | null | undefined)?.trim() || null })
      }
      return out
    } catch {
      return []
    }
  })()

  const [counter, linkedCampaign, exhibitorDirectory] = await Promise.all([counterP, linkedCampaignP, exhibitorDirectoryP])
  return { counter, linkedCampaign, exhibitorDirectory }
}

// ─── Mapping ──────────────────────────────────────────────────────────────────

export interface BuiltEventPage {
  props:  EventDetailProps
  /** The public (visible-ticket) passes, for the page's JSON-LD offers. */
  passes: PassPublic[]
}

/**
 * PURE apart from the clock: event document + loaded data → template props.
 * `displayLifecycle` overrides the STORED lifecycle for display only (admin preview).
 */
export function buildEventPageProps(
  slug:  string,
  event: PublishedEvent,
  data:  EventPageData,
  opts:  { displayLifecycle?: EventLifecycleStatus } = {},
): BuiltEventPage {
  const { counter, linkedCampaign, exhibitorDirectory } = data
  const ls      = opts.displayLifecycle ?? event.lifecycleStatus
  const ed      = event.eventDetails as unknown as EventDetailsDraft
  const pricing = event.pricing as Record<string, unknown> | null

  // ── Registration window ────────────────────────────────────────────────────
  const { registrationOpen, regClosedMessage } = (() => {
    if (ls === 'cancelled') return { registrationOpen: false, regClosedMessage: 'This event has been cancelled.' }
    if (ls !== 'published') return { registrationOpen: false, regClosedMessage: 'Registrations are closed.' }

    const schedule = ed.schedule
    const tz       = (schedule?.timezone as string | undefined)?.trim() || 'UTC'
    const todayStr = (() => {
      try {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())
      } catch {
        return new Intl.DateTimeFormat('en-CA', {
          timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
        }).format(new Date())
      }
    })()

    const endDate     = (schedule?.endDate              as string | undefined) || ''
    const regOpenDate = (pricing?.registrationOpenDate  as string | undefined) || ''
    const regEndDate  = (pricing?.registrationEndDate   as string | undefined) || ''

    if (endDate && todayStr > endDate)
      return { registrationOpen: false, regClosedMessage: 'This event has already ended.' }
    if (regOpenDate && todayStr < regOpenDate) {
      const fmt = new Date(regOpenDate).toLocaleDateString('en-IN', {
        day: 'numeric', month: 'short', year: 'numeric',
      })
      return { registrationOpen: false, regClosedMessage: `Registration opens on ${fmt}.` }
    }
    if (regEndDate && todayStr > regEndDate)
      return { registrationOpen: false, regClosedMessage: 'Registration for this event has closed.' }

    return { registrationOpen: true, regClosedMessage: '' }
  })()

  // ── Core ───────────────────────────────────────────────────────────────────
  const title       = ed.info?.name?.trim()     || 'Untitled Event'
  const tagline     = ed.info?.tagline?.trim()  || ''
  const fullDesc    = ed.info?.fullDesc?.trim()  || ''
  const shortDesc   = ed.info?.shortDesc?.trim() || ''
  const description = fullDesc || shortDesc

  // ── Media ──────────────────────────────────────────────────────────────────
  const bannerUrl = ed.media?.coverBanner?.value?.trim() || ''
  const logoUrl   = ed.media?.logo?.value?.trim()        || ''
  const gallery   = (ed.media?.galleryImages ?? []).filter(img => img.value?.trim())

  // ── Schedule ───────────────────────────────────────────────────────────────
  const startDate = ed.schedule?.startDate || ''
  const startTime = ed.schedule?.startTime || ''
  const endDate   = ed.schedule?.endDate   || ''
  const endTime   = ed.schedule?.endTime   || ''
  const agenda    = (ed.schedule?.agenda ?? []).filter(s => s.title?.trim())

  // ── Venue ──────────────────────────────────────────────────────────────────
  const venueType      = ed.venue?.type ?? 'physical'
  const physical       = ed.venue?.physical
  const online         = ed.venue?.online
  const venueName      = venueLabel(venueType, physical, online)
  const mapsLink  = physical?.mapsLink?.trim() || ''
  const venueMaps = physical?.maps?.layoutImageUrl?.trim() ||
    physical?.maps?.parkingMapUrl?.trim() ||
    physical?.maps?.entryGateMapUrl?.trim()
    ? physical!.maps
    : null

  // ── Additional info ────────────────────────────────────────────────────────
  const promoVideoUrl    = ed.media?.promoVideoUrl?.trim()       || ''
  const doorsOpenTime    = ed.schedule?.doorsOpenTime?.trim()    || ''
  const timezone         = (ed.schedule?.timezone as string | undefined)?.trim() || ''

  // ── Organizer ──────────────────────────────────────────────────────────────
  const organizer = ed.organizer

  // ── Type-specific ──────────────────────────────────────────────────────────
  const typeDetails = ed.typeDetails as Record<string, unknown> | null
  const speakers    = extractSpeakers(typeDetails)
  const sponsors    = extractSponsors(ed, typeDetails)
  const experience  = Array.isArray(ed.experience) ? ed.experience : []
  const timeline    = Array.isArray(ed.timeline) ? ed.timeline : []
  const galleryMedia = Array.isArray(ed.gallery) ? ed.gallery : []
  const faq          = Array.isArray(ed.faq) ? ed.faq : []

  // ── Visibility toggles ─────────────────────────────────────────────────────
  const pp           = ed.publicPage
  const showOrg           = pp?.showOrganizerInfo !== false
  const showSpeakers      = pp?.showSpeakers      !== false
  const showSponsors      = pp?.showSponsors      !== false
  const showVenueMap      = pp?.showVenueMap      !== false
  const showAgenda        = pp?.showAgenda        !== false
  const showGallery       = pp?.showGallery       !== false
  const showSocial        = pp?.showSocialLinks   !== false
  const showAttendeeCount = pp?.showAttendeeCount === true

  // ── Applications ───────────────────────────────────────────────────────────
  const appsCfg = ed.applications as unknown as Record<string, unknown> | null | undefined
  const speakerApplicationsOpen = ls === 'published' &&
    (appsCfg?.speaker as Record<string, unknown> | null)?.enabled === true
  const sponsorApplicationsOpen = ls === 'published' &&
    (appsCfg?.sponsor as Record<string, unknown> | null)?.enabled === true

  // ── Passes ─────────────────────────────────────────────────────────────────
  const isFreeEvent = pricing?.eventType === 'free'
  const rawPasses   = Array.isArray(pricing?.passes) ? (pricing!.passes as PassPublic[]) : []
  // C2: resolve the effective (early-bird-aware) display price ONCE, server-side (in
  // withEffectivePrices), so every event-details surface shows the same amount the
  // checkout charges (create-order uses the same canonical resolver). Baked into the
  // payload — no client Date.now() — so there's no hydration drift at the cutoff.
  const eventTz = (ed.schedule?.timezone as string | undefined)?.trim() || 'UTC'
  const passes: PassPublic[] = withEffectivePrices(
    rawPasses.filter(p => !!(p.name?.trim()) && p.visibility !== 'private' && p.visibility !== 'invite_only'),
    eventTz,
  )

  // ── Availability ───────────────────────────────────────────────────────────
  // RD-CAPACITY-02 · the EFFECTIVE capacity, not the legacy bucket. `capacityPlan` rounds UP
  // (437 is stamped `pack_500`), so passing it here advertised seats that the registration gate
  // would then refuse. `deriveStoredEventCapacity` is the derivation the gate itself uses.
  const availability = computeEventAvailability(
    passes,
    deriveStoredEventCapacity(event as Parameters<typeof deriveStoredEventCapacity>[0]),
    counter,
  )
  const availabilityRecord: Record<string, PassAvailability> = Object.fromEntries(availability)

  // ── Booking Milestone Alerts ───────────────────────────────────────────────
  // Resolved ONCE here, server-side, from the counter this page already loaded — so the
  // feature costs ZERO additional Firestore reads and every template renders the same
  // answer. Only the resolved message crosses to the client: the raw booking count and the
  // organizer's threshold configuration stay on the server.
  //
  // PRESENTATION ONLY. This runs AFTER availability is computed and feeds nothing back into
  // it, so a milestone can never influence capacity, price or whether a pass is sellable.
  const milestoneAlerts = resolveMilestoneAlertsByPass(passes, counter?.passCounts)
  const passesWithAlerts: PassPublic[] = passes.map(p =>
    milestoneAlerts[p.id] ? { ...p, milestoneAlert: milestoneAlerts[p.id] } : p,
  )

  // ── Event-TOTAL milestone ──────────────────────────────────────────────────
  // Keyed to the WHOLE event's confirmed bookings, so 1,500 + 700 across two passes fires a
  // 2,000 event milestone that neither pass reaches alone. Uses `counter.totalCount` — the
  // authoritative event-level count this page ALREADY loaded and the same number capacity
  // enforces — never a re-sum of passCounts, which would be both redundant and, on events
  // predating the historical per-pass counter defect, wrong.
  //
  // Resolved AFTER availability above and feeding nothing back into it: like the per-pass
  // notice this is presentation only and can never influence capacity, price or sellability.
  // Independent of the per-pass alerts — both may resolve, neither suppresses the other.
  const eventMilestoneAlert = resolveMilestoneAlert(
    pricing?.eventMilestoneAlerts as MilestoneAlert[] | undefined,
    counter?.totalCount,
  )

  // ── Event info ─────────────────────────────────────────────────────────────
  const language  = ed.info?.language?.trim()  || ''
  const dressCode = ed.info?.dressCode?.trim() || ''

  // ── Support ────────────────────────────────────────────────────────────────
  const faqUrl          = ed.support?.faqUrl?.trim()             || ''
  const supportEmail    = ed.support?.supportEmail?.trim()       || ''
  const supportPhone    = ed.support?.supportPhone?.trim()       || ''
  const termsUrl        = ed.support?.termsUrl?.trim()           || ''
  const refundPolicyUrl = ed.support?.refundPolicyUrl?.trim()    || ''
  const privacyPolicyUrl = ed.support?.privacyPolicyUrl?.trim()  || ''
  const refundWindow     = ed.support?.refundWindow ?? null

  return {
    passes,
    props: {
      slug,
      lifecycleStatus:  ls,
      cancelReason:     event.cancelReason ?? undefined,
      eventType:        event.eventType ?? undefined,
      eventSubtype:     event.eventSubtype ?? undefined,
      registrationOpen,
      regClosedMessage,
      title,
      tagline,
      description,
      shortDesc,
      bannerUrl,
      logoUrl,
      gallery,
      promoVideoUrl,
      startDate,
      startTime,
      endDate,
      endTime,
      doorsOpenTime,
      agenda,
      venueType,
      physical,
      online,
      venueName,
      mapsLink,
      venueMaps,
      organizer,
      showOrg,
      showSocial,
      showVenueMap,
      isFreeEvent,
      passes:           passesWithAlerts,
      availability:     availabilityRecord,
      eventMilestoneAlert,
      speakers,
      sponsors,
      showSpeakers,
      showSponsors,
      showAgenda,
      showGallery,
      showAttendeeCount,
      typeDetails,
      experience,
      timeline,
      galleryMedia,
      faq,
      language,
      dressCode,
      faqUrl,
      supportEmail,
      supportPhone,
      termsUrl,
      refundPolicyUrl,
      privacyPolicyUrl,
      timezone,
      refundWindow,
      linkedCampaign,
      exhibitorDirectory,
      speakerApplicationsOpen,
      sponsorApplicationsOpen,
    },
  }
}

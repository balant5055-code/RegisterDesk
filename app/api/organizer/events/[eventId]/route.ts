// GET /api/organizer/events/[eventId]
//
// Returns the full event detail for the manage-event page.
// eventId is the Firestore draft document ID under users/{uid}/eventDrafts.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { getEventStats, sumConfirmedRevenueFromLedgerChecked } from '@/lib/firebase/firestore/registrationCounters'
import { evaluatePublishRequirements, severityOf } from '@/lib/events/publishRequirements'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { deriveLifecycleStatus, isArchivedEvent } from '@/lib/events/lifecycle'
import { isReviewClosed }            from '@/lib/events/lifecycleStateMachine'
import { runEventDeletion }          from '@/lib/events/eventDeletion'
import { revenueStateFrom, toConfirmedRevenueFields } from '@/lib/finance/revenueState'
import { resolveIdentifierConfig }   from '@/lib/identifiers/config'
import { resolveLiveEventRef, resolveOwnedEventSlug } from '@/lib/events/liveEventRef'
import { deriveStoredEventCapacity, resolveEventCapacitySummary } from '@/lib/registrations/capacity'
import type { EventLifecycleStatus } from '@/types/events'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * One publish requirement and whether it is currently satisfied — the full roll-call,
 * passed and failing alike.
 *
 * RD-EVENT-04 · This exists so the Setup Center can render "Ready" from the SAME
 * evaluator that decides whether the event can actually publish. Before it, Setup
 * derived its own answers from the draft, which is how a card could read "Ready" for
 * an event the platform would refuse to publish.
 */
export interface EventPublishCheck {
  id:          string
  title:       string
  description: string
  stepName:    string
  /** Wizard step to jump to when fixing it. */
  stepIndex:   number
  severity:    'critical' | 'warning' | 'suggestion'
  passed:      boolean
}

/** One unmet publish requirement, projected for the overview's attention list. */
export interface EventSetupIssue {
  id:       string
  title:    string
  /** 'critical' blocks publishing; 'warning' does not. Suggestions are counted, not listed. */
  severity: 'critical' | 'warning'
  /** The setup step that fixes it — used to deep-link into the existing setup flow. */
  stepName: string
}

export interface PassDetail {
  id:            string
  name:          string
  description:   string | null
  price:         number        // paise; 0 = free
  unlimited:     boolean
  capacity:      number | null
  sold:          number
  status:        string
  salesStartDate: string | null
  salesEndDate:   string | null

  // ─── RD-EVENT-13, all additive ────────────────────────────────────────────
  //
  // Read from the SAME draft document the fields above come from, so every one of
  // these costs zero additional reads. They exist because an organizer configures
  // twenty-seven fields per pass in the builder and could then see none of them: the
  // Passes tab showed a name, a price and three numbers, so "why is this pass not
  // appearing on my registration page?" had no answer anywhere in the workspace.

  /** The code printed on tickets. Null when the organizer left it blank. */
  code:          string | null
  /** 'paid' | 'free' | 'complimentary' | 'invite_only' — the pass's own kind. */
  type:          string | null
  /** 'public' | 'private' | 'invite_only'. A private pass is why it is not listed. */
  visibility:    string | null
  /** Promoted on the public page. */
  featured:      boolean
  /** Disappears from the page once it sells out, rather than showing as sold out. */
  hideWhenSoldOut: boolean
  /** Shows the remaining count publicly. */
  showRemainingSeats: boolean
  /** Per-order limits, when the organizer set them away from the defaults. */
  minPurchase:   number | null
  maxPurchase:   number | null
  /** Early-bird pricing, when configured. `price` remains the standard price. */
  earlyBirdPrice:   number | null
  earlyBirdEndDate: string | null
  /** How many inclusions this pass lists — the detail itself lives in the builder. */
  benefitsCount: number
}

export interface SpeakerDetail {
  id:       string
  name:     string
  title:    string
  company:  string
  bio:      string
  photoUrl: string
  order:    number
}

export interface SponsorDetail {
  id:      string
  name:    string
  logoUrl: string
  website: string
  tier:    string
  order:   number
}

export interface EventDetailResponse {
  draftId:          string
  status:           'draft' | 'published'
  lifecycleStatus:  EventLifecycleStatus
  // RD-EMAIL-PROVIDER — the email transport is INTENTIONALLY not exposed here. It is an
  // admin-only setting; the organizer surface must not see, display or round-trip it.
  // Admins read it from GET /api/admin/events/[slug]/360.
  // Cancellation metadata — present when lifecycleStatus = 'cancelled'
  cancelReason?:    string
  cancelledAt?:     string | null
  // Basic info
  name:             string
  tagline:          string | null
  shortDesc:        string | null
  fullDesc:         string | null
  slug:             string | null
  // Schedule
  startDate:        string | null
  startTime:        string | null
  endDate:          string | null
  endTime:          string | null
  timezone:         string | null
  // Media
  bannerUrl:        string | null
  logoUrl:          string | null
  // Classification (locked)
  eventType:        string | null
  eventSubtype:     string | null
  campaignType:     string | null
  visibility:       string | null
  // Venue
  venueType:        string | null
  venueName:        string | null
  venueCity:        string | null
  venueAddress:     string | null
  onlinePlatform:   string | null
  onlineMeetingUrl: string | null
  // Metrics
  totalCapacity:    number | null
  /**
   * RD-EVENT-COMMERCE-01 · D2 — the capacity the registration gate ENFORCES: `events/{slug}`
   * read through `deriveStoredEventCapacity`, the same derivation the registration transaction
   * uses. `null` = unlimited. ABSENT when the event has no readable live document (unpublished,
   * or the read failed) — a money surface must then show 'unavailable', never guess a number.
   * `totalCapacity` above is a display estimate from the draft's passes and is NOT enforced.
   */
  enforcedCapacity?: number | null
  totalRegistrations: number
  checkedInCount:   number
  /**
   * RD-ANALYTICS-12-19 · THE CANONICAL NAME for this figure.
   *
   * Canonical confirmed ticket revenue in integer PAISE, refund-stable. Identical in
   * definition, unit, permission and source-resolution to the sibling LIST route, whose
   * declaration carries the full reasoning — including why the same name in
   * `EventAnalytics.financial` is a `MaybeMoney` and not this shape.
   *
   * Three states, none collapsible: `number` measured · `number` + `revenueUnavailable`
   * unreadable · `null` the caller lacks `transactions`.
   */
  confirmedRevenuePaise: number | null
  isFreeEvent:      boolean
  passes:           PassDetail[]
  publishedAt:      string | null
  updatedAt:        string

  // ── RD-EVENT-03 · ADDITIVE. Fifteen surfaces consume this payload; every field
  //    below is optional and no existing field changed name, type or meaning. ──

  /** `totalRegistrations` / `checkedInCount` / `passes[].sold` could not be read.
   *  The numbers are still 0 for wire compatibility — this flag says not to believe them. */
  statsUnavailable?:   boolean
  /** `confirmedRevenuePaise` could not be resolved. Absent/false ⇒ the figure is real. */
  revenueUnavailable?: boolean

  /** Admin review outcome, same field and semantics as the events LIST payload.
   *  Lets the overview say "Changes requested" instead of rendering the event as a Draft. */
  reviewStatus?:    'rejected' | 'changes_requested' | null
  rejectionReason?: string | null
  changesComment?:  string | null

  /** Unmet publish requirements, from `evaluatePublishRequirements` — the platform's
   *  existing evaluator, which is PURE over the draft this handler already read. No
   *  extra query, no second setup-health definition. Critical + warning only. */
  setupIssues?: EventSetupIssue[]
  /** Total unmet requirements including suggestions, so the UI can say "+3 more"
   *  without being sent every one of them. */
  setupIssueCount?: number

  /** Every publish requirement with its pass/fail state — the Setup Center reads this
   *  instead of re-deriving readiness from the draft. Additive and optional. */
  publishChecks?: EventPublishCheck[]

  /**
   * RD-BIB-UX-04 · the event's configured identifier name — "BIB Number",
   * "Delegate Number", "Badge Number" — so the workspace tab can be labelled in the
   * organizer's own vocabulary rather than the generic "Identifiers".
   *
   * NULL when the event has never configured one, and null on any read failure: the
   * tab then keeps its existing generic label, so this can only ever improve the
   * wording and never break the bar. Additive and optional.
   */
  identifierLabel?: string | null
  // Organizer info
  organizerName:     string | null
  organizerEmail:    string | null
  organizerPhone:    string | null
  organizerWebsite:  string | null
  // Content arrays
  speakers:         SpeakerDetail[]
  sponsors:         SponsorDetail[]
  galleryImages:    string[]
  /**
   * RD-EVENT-16 · `eventDetails.applications` — whether this event invites speaker or
   * sponsor applications.
   *
   * The PUBLIC event page already gates its forms on exactly this (`applications.speaker
   * .enabled === true`); exposing it here lets the Event Command Center hide the tabs that
   * REVIEW those submissions when the event never asks for them. Read from the same draft
   * document as every other field — zero additional Firestore reads.
   */
  applications:     { speaker: { enabled: boolean }; sponsor: { enabled: boolean } } | null
  // SEO (slug is locked)
  metaTitle:        string | null
  metaDescription:  string | null
  keywords:         string[]
  // Raw blobs
  registrationRules: Record<string, unknown> | null
  pricing:           Record<string, unknown> | null
  // Linked donation campaign fields — populated for event_plus_donation only
  linkedCampaignSlug: string | null
  donationTotalPaise: number
  donorCount:         number
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function toIso(val: unknown): string | null {
  if (!val) return null
  if (typeof val === 'object' && 'toDate' in (val as object)) {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function str(val: unknown): string | null {
  return typeof val === 'string' && val ? val : null
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const { eventId } = await context.params

  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  /**
   * RD-ANALYTICS-12-17 · the financial boundary, declared before the reads it gates.
   *
   * The event LIST and this route expose the same canonical revenue figure, so gating only
   * the list would have moved the gap rather than closed it. `events` (above) is event
   * authority and is unchanged; `transactions` is financial authority and is what decides
   * whether this caller is told the number.
   */
  const financeAllowed = authz.permissions.includes('transactions')

  // ── Load draft ─────────────────────────────────────────────────────────────
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  }

  const d          = draftSnap.data() as Record<string, unknown>
  const details    = (d.eventDetails    as Record<string, unknown>) ?? {}
  const info       = (details.info      as Record<string, unknown>) ?? {}
  const seo        = (details.seo       as Record<string, unknown>) ?? {}
  const sched      = (details.schedule  as Record<string, unknown>) ?? {}
  const media      = (details.media     as Record<string, unknown>) ?? {}
  const venue      = (details.venue     as Record<string, unknown>) ?? {}
  const phys       = (venue.physical    as Record<string, unknown>) ?? {}
  const online     = (venue.online      as Record<string, unknown>) ?? {}
  const orgInfo    = (details.organizer as Record<string, unknown>) ?? {}
  const typeDet    = (details.typeDetails as Record<string, unknown>) ?? {}
  const regForm    = (d.registrationForm as Record<string, unknown>) ?? {}
  const pricing    = (d.pricing as Record<string, unknown>) ?? {}
  const coverBanner = (media.coverBanner as Record<string, unknown>) ?? {}
  const logoAsset   = (media.logo        as Record<string, unknown>) ?? {}

  // RD-CE-FIX C1 · the draft's urlSlug is client-writable: every counter, revenue, donation and
  // identifier read below is keyed by slug with no owner filter, so only a slug the live document
  // proves is THIS workspace's event is used. One read, reused for the enforced capacity.
  const live    = str(seo.urlSlug) ? await resolveLiveEventRef(eventId, d, uid).catch(() => null) : null
  const slug    = live?.ok ? live.slug : null
  const isFree  = pricing?.eventType === 'free'

  // ── RD-EVENT-03 · counters, revenue and donations, isolated and parallel ────
  //
  // These three reads share only `slug`, which the draft above already produced, so
  // they were queueing behind each other for no reason: five serial waves where three
  // do. They also had NO error handling — one unreadable attendance shard rejected the
  // whole handler and the organizer got a full-page error instead of an event page
  // with one unavailable metric.
  //
  // Each now settles independently and reports whether it actually ran. `0` stays on
  // the wire for the fifteen existing consumers of this payload; the FLAGS are what
  // let a caller tell "nobody registered" from "we could not read it".
  interface EventCounterView {
    totalCount: number; passCounts: Record<string, number>; checkedInCount: number
  }
  interface StatsResult {
    counter: EventCounterView | null
    revenuePaise: number
    statsUnavailable: boolean
    revenueUnavailable: boolean
  }

  const loadStats = async (): Promise<StatsResult> => {
    const none: StatsResult = {
      counter: null, revenuePaise: 0, statsUnavailable: false, revenueUnavailable: false,
    }
    if (!slug) return none                  // unpublished: no counter exists, zeros are real

    const stats = await getEventStats(slug).then(
      value => ({ ok: true as const, value }),
      ()    => ({ ok: false as const, value: null }),
    )
    if (!stats.ok || !stats.value) {
      return { ...none, statsUnavailable: true, revenueUnavailable: true }
    }

    const { counter: cd, complete } = stats.value
    const view: EventCounterView | null = cd
      ? {
          totalCount:     cd.totalCount     ?? 0,
          passCounts:     cd.passCounts     ?? {},
          checkedInCount: cd.checkedInCount ?? 0,
        }
      : null

    if (complete) return { ...none, counter: view, revenuePaise: cd?.revenuePaise ?? 0 }

    /**
     * RD-ANALYTICS-12-17 · not issued for a caller who may not see money.
     *
     * `getEventStats` above stays: it carries the registration counts, which are not
     * financial. This aggregate is purely the money fallback, so an unauthorized caller
     * neither receives the figure nor costs the workspace the read. The counter view is
     * still returned, so counts are unaffected.
     */
    if (!financeAllowed) return { ...none, counter: view }

    // Not yet backfilled: the SAME ledger sum, via the variant that distinguishes a real
    // zero from a failed aggregate. The revenue DEFINITION is untouched.
    const sum = await sumConfirmedRevenueFromLedgerChecked(slug).catch(() => ({ value: 0, ok: false }))
    return sum.ok
      ? { ...none, counter: view, revenuePaise: sum.value }
      : { ...none, counter: view, revenueUnavailable: true }
  }

  const linkedCampaignSlug = d.campaignType === 'event_plus_donation' ? slug : null
  const loadDonations = async (): Promise<{ totalRaisedPaise: number; donorCount: number }> => {
    if (!linkedCampaignSlug) return { totalRaisedPaise: 0, donorCount: 0 }
    const snap = await adminDb.collection('donationCounters').doc(linkedCampaignSlug).get()
      .catch(() => null)
    if (!snap?.exists) return { totalRaisedPaise: 0, donorCount: 0 }
    const dc = snap.data() as { totalRaisedPaise?: number; donorCount?: number }
    return { totalRaisedPaise: dc.totalRaisedPaise ?? 0, donorCount: dc.donorCount ?? 0 }
  }

  // RD-BIB-UX-04 · the event's configured identifier name, so the workspace tab can
  // read "BIB Numbers" / "Delegate Numbers" instead of the generic "Identifiers".
  //
  // ═══ WHY THIS READ EXISTS ════════════════════════════════════════════════════
  // The label lives in `identifierConfigs/{slug}`, which the shell deliberately
  // never read — the tab is listed in UNGATED_BY_DESIGN precisely to avoid one.
  // There is no cheaper source: it is not on the draft, and fetching the whole
  // `/identifiers` endpoint from the shell would run every capacity aggregate to
  // obtain one string.
  //
  // So this is ONE document read, issued in parallel with reads the route already
  // makes, exposed as an ADDITIVE optional field. It fails safe: any error, or an
  // event with no configuration, yields null and the tab keeps its generic label.
  // Nothing is written, no schema changed, and no existing field moved.
  const [stats, donations, identifierLabel, enforcedCapacity] = await Promise.all([
    loadStats(),
    loadDonations(),
    slug
      ? resolveIdentifierConfig(slug).then(r => r.isStored ? r.config.label : null).catch(() => null)
      : Promise.resolve(null),
    // RD-EVENT-COMMERCE-01 · D2 — one read of the live doc (reverse-pointer checked).
    Promise.resolve(live?.ok ? deriveStoredEventCapacity(live.snap.data() ?? null) : undefined),
  ])

  const counter            = stats.counter
  const revenuePaise       = stats.revenuePaise
  const statsUnavailable   = stats.statsUnavailable
  const revenueUnavailable = stats.revenueUnavailable
  const donationTotalPaise = donations.totalRaisedPaise
  const donorCount         = donations.donorCount

  // ── Build passes ───────────────────────────────────────────────────────────
  const rawPasses = (pricing?.passes as unknown[]) ?? []
  const passes: PassDetail[] = rawPasses.map((p: unknown) => {
    const pass = p as Record<string, unknown>
    const id   = str(pass.id) ?? ''
    return {
      id,
      name:          str(pass.name)        ?? 'Pass',
      description:   str(pass.description),
      price:         typeof pass.price    === 'number'  ? pass.price    : 0,
      unlimited:     pass.unlimited === true,
      capacity:      pass.unlimited ? null : (typeof pass.quantity === 'number' ? pass.quantity : null),
      // 0 for wire compatibility ONLY. `statsUnavailable` above says whether to believe
      // it; every consumer must check that flag before treating this as a measurement.
      sold:          counter?.passCounts?.[id] ?? 0,
      status:        str(pass.status) ?? 'active',
      salesStartDate: str(pass.salesStartDate),
      salesEndDate:   str(pass.salesEndDate),

      // RD-EVENT-13 · additive; same document, no extra read.
      code:          str(pass.code),
      type:          str(pass.type),
      visibility:    str(pass.visibility),
      featured:           pass.featured === true,
      hideWhenSoldOut:    pass.hideWhenSoldOut === true,
      showRemainingSeats: pass.showRemainingSeats === true,
      minPurchase:   typeof pass.minPurchase === 'number' ? pass.minPurchase : null,
      maxPurchase:   typeof pass.maxPurchase === 'number' ? pass.maxPurchase : null,
      earlyBirdPrice: pass.earlyBirdEnabled === true && typeof pass.earlyBirdPrice === 'number'
        ? pass.earlyBirdPrice
        : null,
      earlyBirdEndDate: pass.earlyBirdEnabled === true ? str(pass.earlyBirdEndDate) : null,
      benefitsCount: (Array.isArray(pass.benefits) ? pass.benefits.length : 0)
        + (Array.isArray(pass.customBenefits) ? pass.customBenefits.length : 0),
    }
  })

  // Revenue is resolved canonically above (revenuePaise); no Σ(pass.price × pass.sold).

  // ── Speakers — live at eventDetails.typeDetails.speakers ─────────────────────
  const rawSpeakers = Array.isArray(typeDet.speakers)
    ? (typeDet.speakers as Record<string, unknown>[])
    : Array.isArray(typeDet.trainers)   // workshop fallback
      ? (typeDet.trainers as Record<string, unknown>[])
      : Array.isArray(typeDet.artists)  // cultural fallback
        ? (typeDet.artists as Record<string, unknown>[])
        : []

  const speakers: SpeakerDetail[] = rawSpeakers.map((s, i) => ({
    id:       str(s.id)      ?? `spk_${i}`,
    name:     str(s.name)    ?? '',
    title:    str(s.title)   ?? '',
    company:  str(s.company) ?? '',
    bio:      str(s.bio)     ?? '',
    photoUrl: str(s.photoUrl) ?? '',
    order:    typeof s.order === 'number' ? s.order : i,
  }))

  // ── Applications ───────────────────────────────────────────────────────────
  // RD-EVENT-16 · read from `eventDetails.applications`, the same place the public event
  // page reads before offering either form. `enabled === true` is the whole contract:
  // anything else — absent, null, a string — is not an invitation to apply.
  const rawApps = details.applications as Record<string, unknown> | null | undefined
  const applications = rawApps && typeof rawApps === 'object'
    ? {
        speaker: { enabled: (rawApps.speaker as Record<string, unknown> | null)?.enabled === true },
        sponsor: { enabled: (rawApps.sponsor as Record<string, unknown> | null)?.enabled === true },
      }
    : null

  // ── Sponsors ───────────────────────────────────────────────────────────────
  const rawSponsors = Array.isArray(typeDet.sponsors)
    ? (typeDet.sponsors as Record<string, unknown>[])
    : []

  const sponsors: SponsorDetail[] = rawSponsors.map((s, i) => ({
    id:      str(s.id)      ?? `spo_${i}`,
    name:    str(s.name)    ?? '',
    logoUrl: str(s.logoUrl) ?? '',
    website: str(s.website) ?? '',
    tier:    str(s.tier)    ?? 'bronze',
    order:   typeof s.order === 'number' ? s.order : i,
  }))

  // ── Gallery images ─────────────────────────────────────────────────────────
  const rawGallery = Array.isArray(media.galleryImages)
    ? (media.galleryImages as Record<string, unknown>[])
    : []
  const galleryImages = rawGallery
    .map(g => str(g.value) ?? '')
    .filter(Boolean)

  // ── RD-EVENT-03 · setup health, at zero read cost ──────────────────────────
  // `evaluatePublishRequirements` is the platform's existing publish evaluator and is
  // PURE over the draft document — the same one the dashboard's Attention Center runs.
  // Every field it needs was already read above, so this adds no query and introduces
  // no second definition of "is this event ready".
  //
  // Only critical and warning issues are serialised; suggestions are counted so the UI
  // can say how many remain without carrying all of them over the wire.
  // RD-EVENT-04 · `evaluatePublishRequirements` returns EVERY requirement carrying a
  // `passed` flag — not just the failing ones. RD-EVENT-03 read the whole array as the
  // issue list, so a fully configured draft reported ten "issues" and a count of twelve.
  // `.filter(r => !r.passed)` is what every other consumer does (the dashboard's
  // `publishedGaps`, `hasIncompletePublishRequirements`); this now matches them.
  const requirements = evaluatePublishRequirements({
    eventDetails:     d.eventDetails     as Record<string, unknown> | null,
    pricing:          d.pricing          as Record<string, unknown> | null,
    registrationForm: d.registrationForm as Record<string, unknown> | null,
  })
  const unmet = requirements.filter(r => !r.passed)
  const setupIssues: EventSetupIssue[] = unmet
    .filter(r => severityOf(r) !== 'suggestion')
    .map(r => ({
      id: r.id, title: r.title, stepName: r.stepName,
      severity: severityOf(r) as 'critical' | 'warning',
    }))
  const setupIssueCount = unmet.length

  // The full requirement roll-call, so the Setup Center can show what is READY as well
  // as what is missing without re-deriving any of it. Same evaluator, same ids, one
  // definition — Setup and the publish flow can no longer disagree.
  const publishChecks: EventPublishCheck[] = requirements.map(r => ({
    id: r.id, title: r.title, description: r.description,
    stepName: r.stepName, stepIndex: r.stepIndex,
    severity: severityOf(r),
    passed:   r.passed,
  }))

  const result: EventDetailResponse = {
    draftId:          draftSnap.id,
    status:           (d.status as 'draft' | 'published') ?? 'draft',
    lifecycleStatus:  isArchivedEvent(d) ? 'archived' : deriveLifecycleStatus(d),
    cancelReason:     str(d.cancelReason) ?? undefined,
    cancelledAt:      toIso(d.cancelledAt),
    name:             str(info.name)     ?? 'Untitled Event',
    tagline:          str(info.tagline),
    shortDesc:        str(info.shortDesc),
    fullDesc:         str(info.fullDesc),
    slug,
    startDate:        str(sched.startDate),
    startTime:        str(sched.startTime),
    endDate:          str(sched.endDate),
    endTime:          str(sched.endTime),
    timezone:         str(sched.timezone),
    // Fix: coverBanner and logo are MediaAsset objects {source, value, originalFileName}
    bannerUrl:        str(coverBanner.value),
    logoUrl:          str(logoAsset.value),
    eventType:        str(d.eventType    as unknown),
    eventSubtype:     str(d.eventSubtype as unknown),
    campaignType:     str(d.campaignType as unknown),
    visibility:       str(d.visibility   as unknown),
    venueType:        str(venue.type),
    venueName:        str(phys.name),
    venueCity:        str(phys.city),
    venueAddress:     str(phys.addressLine1),
    onlinePlatform:   str(online.platform),
    onlineMeetingUrl: str(online.meetingUrl),
    // RD-EVENT-03 · FIXED. A paid event always reported `null` here, i.e. "unlimited",
    // even with finite pass capacities — while the events LIST computed the real number
    // from the same passes. The same event therefore showed "2,295 / 5,000" on one page
    // and "Unlimited capacity" on the next.
    //
    // This is not a new definition: the expression below is the LIST route's existing
    // formula verbatim (capacity is known only when EVERY pass is capped; one unlimited
    // pass makes the event uncapped). The proof it was always intended is
    // EventCommandHeader's `!event.isFreeEvent && event.totalCapacity` fill-rate branch,
    // which could never once have executed.
    // RD-EVENT-COMMERCE-04/04A — a free event's capacity is the ENFORCED value on its live doc
    // (null there = unlimited, kept as null). With no live doc yet (a draft) it is the capacity
    // the organizer SELECTED on the draft, else unknown (null) — never the retired Free tier's
    // 200, which the 04 change still used as the draft fallback.
    // RD-FIN-02 · ONE capacity for free AND paid events: the enforced value of the live doc
    // (lib/registrations/capacity.ts resolveEventCapacitySummary). Paid events used to show the
    // client-writable DRAFT pass sums. With no live doc yet, the draft's selected capacity.
    totalCapacity:    resolveEventCapacitySummary({
      eventDoc:    live?.ok ? (live.snap.data() ?? null) : null,
      counter:     counter ?? null,
      draftIntent: d.registrationCapacity,
    }).total,
    ...(enforcedCapacity !== undefined ? { enforcedCapacity } : {}),
    totalRegistrations: counter?.totalCount ?? 0,
    checkedInCount:   counter?.checkedInCount ?? 0,
    /**
     * RD-ANALYTICS-12-17 · null without `transactions`. The calculation above is untouched;
     * this decides only whether the caller is told the answer.
     *
     * RD-ANALYTICS-12-22 · the figure and its flag are now DERIVED from one `RevenueState`
     * through the shared serializer, so this route cannot emit the contradictory pair
     * (unavailable with the flag false) that the dashboard shipped as F1.
     */
    ...toConfirmedRevenueFields(revenueStateFrom({ financeAllowed, unavailable: revenueUnavailable, paise: revenuePaise })),
    isFreeEvent:      isFree,
    passes,
    publishedAt:      toIso(d.publishedAt),
    statsUnavailable,
    // `revenueUnavailable` is emitted by the spread above, from the same state as the figure.
    // It is deliberately NOT repeated here: a later key would silently win over the
    // serializer and reopen the drift this consolidation exists to close.
    reviewStatus:     d.reviewStatus === 'rejected' || d.reviewStatus === 'changes_requested'
      ? d.reviewStatus : null,
    rejectionReason:  str(d.rejectionReason),
    changesComment:   str(d.changesComment),
    setupIssues,
    setupIssueCount,
    publishChecks,
    identifierLabel,
    updatedAt:        toIso(d.updatedAt) ?? new Date().toISOString(),
    organizerName:    str(orgInfo.name),
    organizerEmail:   str(orgInfo.email),
    organizerPhone:   str(orgInfo.phone),
    organizerWebsite: str(orgInfo.website),
    speakers,
    sponsors,
    galleryImages,
    applications,
    metaTitle:        str(seo.metaTitle),
    metaDescription:  str(seo.metaDescription),
    keywords:         Array.isArray(seo.keywords)
      ? (seo.keywords as unknown[]).map(k => String(k)).filter(Boolean)
      : [],
    registrationRules:  (regForm.registrationRules as Record<string, unknown>) ?? null,
    pricing:            Object.keys(pricing).length ? pricing : null,
    linkedCampaignSlug,
    donationTotalPaise,
    donorCount,
  }

  return NextResponse.json(result)
}

// ─── DELETE /api/organizer/events/[eventId] ───────────────────────────────────
//
// RD-EVENT-DELETE — permanently deletes an ARCHIVED event and its event-specific
// OPERATIONAL data. Financial and audit records are retained by design; see
// lib/events/eventDeletion.ts for the manifest and the reasoning.
//
// EVERY gate is server-side. The client sends only an eventId, which is a lookup key and
// never authority:
//   • authorizeWorkspace  — authenticated, and scoped to the 'events' capability
//   • the draft is read from users/{workspaceUid}/eventDrafts/{eventId}, so another
//     organizer's event is simply not found — cross-organizer deletion is impossible by
//     construction rather than by a check that could be forgotten
//   • lifecycleStatus MUST be 'archived' — an active, published, draft or pending event is
//     refused with 409 no matter what the UI offered
//
// Idempotent: a second call finds no draft and reports success with `alreadyDeleted`, so a
// retried request or a double-click cannot produce an error the operator has to interpret.

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { eventId } = await params

  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) {
    // Already gone (or never this organizer's). Idempotent success — never a 404 the UI has
    // to explain after a retry.
    return NextResponse.json({ success: true, alreadyDeleted: true, deleted: 0, failures: [] })
  }

  const draft = draftSnap.data() as Record<string, unknown>
  // Same predicate as the restore guard and the list payload above. Using the bare
  // derivation here would refuse a LEGACY archived event that the UI now correctly shows as
  // archived — offering an action the server rejects. The rule is unchanged and no weaker:
  // still archived-only, still server-side, still 409 for anything else.
  if (!isArchivedEvent(draft)) {
    return NextResponse.json(
      { error: 'Only archived events can be permanently deleted. Archive this event first.' },
      { status: 409 },
    )
  }
  // RD-REVIEW-02 — a review-closed event keeps its record and review history (runEventDeletion
  // would erase reviewHistory). Removing one needs a Super Admin decision, not an organizer delete.
  if (isReviewClosed(draft)) {
    return NextResponse.json(
      { error: 'This event was closed during review. Its record and review history are kept, so it cannot be permanently deleted. Contact RegisterDesk support if it must be removed.', code: 'REVIEW_CLOSED' },
      { status: 409 },
    )
  }

  // RD-CE-FIX C1 · deletion is keyed by slug with no owner filter downstream, so the slug MUST be
  // proven to be this workspace's live event — never taken from the client-writable draft pointer.
  const slug    = (await resolveOwnedEventSlug(uid, eventId, draft)) ?? ''
  if (!slug) {
    return NextResponse.json(
      { error: 'This event has no resolvable slug, so its data cannot be located safely.' },
      { status: 409 },
    )
  }

  const { summary, finished } = await runEventDeletion({ eventSlug: slug, eventId, organizerUid: uid })

  // Partial work is NEVER reported as success: the operator must be able to trust that a
  // green result means the event is gone.
  if (!summary.ok || !finished) {
    return NextResponse.json({
      success: false,
      finished,
      deleted:  summary.deleted,
      failures: summary.failures.slice(0, 20),
      error:    finished
        ? 'Some data could not be deleted. The event was partially removed — retry to continue.'
        : 'Deletion is taking longer than one request allows. Retry to continue where it stopped.',
    }, { status: 500 })
  }

  return NextResponse.json({ success: true, deleted: summary.deleted, failures: [] })
}

// GET /api/organizer/events/[eventId]
//
// Returns the full event detail for the manage-event page.
// eventId is the Firestore draft document ID under users/{uid}/eventDrafts.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { getEventStats, sumConfirmedRevenueFromLedger } from '@/lib/firebase/firestore/registrationCounters'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { deriveLifecycleStatus, isArchivedEvent } from '@/lib/events/lifecycle'
import { runEventDeletion }          from '@/lib/events/eventDeletion'
import { getFreeEventCapacity }      from '@/lib/licensing/resolveCatalog'
import type { EventLifecycleStatus } from '@/types/events'

// ─── Types ────────────────────────────────────────────────────────────────────

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
  totalRegistrations: number
  checkedInCount:   number
  estimatedRevenue: number   // paise — CANONICAL confirmed revenue (registrationCounters.revenuePaise / ledger fallback); field name kept for contract stability
  isFreeEvent:      boolean
  passes:           PassDetail[]
  publishedAt:      string | null
  updatedAt:        string
  // Organizer info
  organizerName:     string | null
  organizerEmail:    string | null
  organizerPhone:    string | null
  organizerWebsite:  string | null
  // Content arrays
  speakers:         SpeakerDetail[]
  sponsors:         SponsorDetail[]
  galleryImages:    string[]
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

  const slug    = str(seo.urlSlug)
  const isFree  = pricing?.eventType === 'free'
  // Free-event capacity = the effective Starter registration limit (SSOT), not a literal.
  const freeCapacity = await getFreeEventCapacity()

  // ── Load registration counter + canonical revenue (RD-EVENTS-01 Phase 1 / H1) ──
  // getEventStats folds attendance shards (checkedInCount) AND exposes the `complete`
  // gate. Revenue = refund-stable registrationCounters.revenuePaise when complete, else
  // the source-of-truth ledger sum — the SAME resolver/pattern the Dashboard uses,
  // replacing the former Σ(pass.price × pass.sold) estimate.
  let counter: { totalCount: number; passCounts: Record<string, number>; checkedInCount: number } | null = null
  let revenuePaise = 0
  if (slug) {
    const { counter: cd, complete } = await getEventStats(slug)
    if (cd) {
      counter = {
        totalCount:     cd.totalCount     ?? 0,
        passCounts:     cd.passCounts      ?? {},
        checkedInCount: cd.checkedInCount ?? 0,
      }
    }
    revenuePaise = complete ? (cd?.revenuePaise ?? 0) : await sumConfirmedRevenueFromLedger(slug)
  }

  // ── Load donation counter (event_plus_donation only) ───────────────────────
  const linkedCampaignSlug = d.campaignType === 'event_plus_donation' ? slug : null
  let donationTotalPaise = 0
  let donorCount         = 0
  if (linkedCampaignSlug) {
    const donationCounterSnap = await adminDb.collection('donationCounters').doc(linkedCampaignSlug).get()
    if (donationCounterSnap.exists) {
      const dc = donationCounterSnap.data() as { totalRaisedPaise?: number; donorCount?: number }
      donationTotalPaise = dc.totalRaisedPaise ?? 0
      donorCount         = dc.donorCount       ?? 0
    }
  }

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
      sold:          counter?.passCounts?.[id] ?? 0,
      status:        str(pass.status) ?? 'active',
      salesStartDate: str(pass.salesStartDate),
      salesEndDate:   str(pass.salesEndDate),
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
    totalCapacity:    isFree ? freeCapacity : null,
    totalRegistrations: counter?.totalCount ?? 0,
    checkedInCount:   counter?.checkedInCount ?? 0,
    estimatedRevenue: revenuePaise,
    isFreeEvent:      isFree,
    passes,
    publishedAt:      toIso(d.publishedAt),
    updatedAt:        toIso(d.updatedAt) ?? new Date().toISOString(),
    organizerName:    str(orgInfo.name),
    organizerEmail:   str(orgInfo.email),
    organizerPhone:   str(orgInfo.phone),
    organizerWebsite: str(orgInfo.website),
    speakers,
    sponsors,
    galleryImages,
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

  const details = (draft.eventDetails as Record<string, unknown>) ?? {}
  const seo     = (details.seo as Record<string, unknown>) ?? {}
  const slug    = typeof seo.urlSlug === 'string' ? seo.urlSlug : ''
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

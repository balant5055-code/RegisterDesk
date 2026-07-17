// GET /api/organizer/events/[eventId]
//
// Returns the full event detail for the manage-event page.
// eventId is the Firestore draft document ID under users/{uid}/eventDrafts.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { getRegistrationCounter }    from '@/lib/firebase/firestore/registrationCounters'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { deriveLifecycleStatus }     from '@/lib/events/lifecycle'
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
  estimatedRevenue: number
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

  // ── Load registration counter (GA-5 S3: summing reader folds attendance shards) ──
  let counter: { totalCount: number; passCounts: Record<string, number>; checkedInCount: number } | null = null
  if (slug) {
    const cd = await getRegistrationCounter(slug)
    if (cd) {
      counter = {
        totalCount:     cd.totalCount     ?? 0,
        passCounts:     cd.passCounts      ?? {},
        checkedInCount: cd.checkedInCount ?? 0,
      }
    }
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

  const estimatedRevenue = passes.reduce((sum, p) => sum + p.price * p.sold, 0)

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
    lifecycleStatus:  deriveLifecycleStatus(d),
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
    estimatedRevenue,
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

// Server-only — uses Firebase Admin SDK. Never import this directly from client components.
// Use `import type { PublicEventCard, PlatformStats }` for type-only imports in client code.

import { adminDb } from '@/lib/firebase/admin'
import { isContentTakenDown } from '@/lib/admin/moderation'
import type { ModerationStatus } from '@/lib/admin/moderation'

// ─── Exported types (safe to `import type` from client components) ────────────

export interface PublicEventCard {
  id:            string        // === slug
  slug:          string
  name:          string
  tagline:       string
  startDate:     string | null // YYYY-MM-DD
  endDate:       string | null
  startTime:     string | null // HH:mm
  city:          string | null
  state:         string | null
  venueType:     'physical' | 'online' | 'hybrid'
  eventType:     string | null
  bannerUrl:     string | null
  logoUrl:       string | null
  isFreeEvent:   boolean
  minPrice:      number        // rupees
  totalCapacity: number | null
  totalCount:    number        // registered
  organizerName: string | null
  organizerLogo: string | null
  approvalMode:  'auto' | 'manual'
  publishedAt:   string | null // ISO
}

export interface PlatformStats {
  totalEvents:        number
  totalRegistrations: number
  totalCities:        number
}

export interface DiscoveryData {
  events: PublicEventCard[]
  stats:  PlatformStats
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function str(obj: unknown, key: string): string | null {
  if (!obj || typeof obj !== 'object') return null
  const v = (obj as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function rec(obj: unknown, key: string): Record<string, unknown> {
  if (!obj || typeof obj !== 'object') return {}
  const v = (obj as Record<string, unknown>)[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

// ─── Main fetch ───────────────────────────────────────────────────────────────

export async function listPublishedEvents(limit = 48): Promise<DiscoveryData> {
  const snap = await adminDb
    .collection('events')
    .where('lifecycleStatus', '==', 'published')
    .limit(limit)
    .get()

  if (snap.empty) {
    return { events: [], stats: { totalEvents: 0, totalRegistrations: 0, totalCities: 0 } }
  }

  const slugs       = snap.docs.map(d => d.id)
  const counterRefs = slugs.map(s => adminDb.collection('registrationCounters').doc(s))
  const counterSnaps = await adminDb.getAll(...counterRefs)

  const counterMap = new Map<string, number>()
  for (const cs of counterSnaps) {
    if (cs.exists) {
      counterMap.set(cs.id, ((cs.data() as Record<string, unknown>).totalCount as number | undefined) ?? 0)
    }
  }

  const events: PublicEventCard[] = []
  const citySet = new Set<string>()
  let   totalRegistrations = 0

  for (const doc of snap.docs) {
    const raw     = doc.data() as Record<string, unknown>
    // Exclude admin-taken-down events from public discovery (lifecycleStatus
    // stays 'published'; moderation is a separate axis).
    if (isContentTakenDown(raw.moderationStatus as ModerationStatus | undefined)) continue
    const ed      = rec(raw, 'eventDetails')
    const info    = rec(ed,  'info')
    const sched   = rec(ed,  'schedule')
    const venue   = rec(ed,  'venue')
    const media   = rec(ed,  'media')
    const org     = rec(ed,  'organizer')
    const pricing = raw.pricing && typeof raw.pricing === 'object' ? raw.pricing as Record<string, unknown> : null
    const physical = rec(venue, 'physical')

    const slug       = doc.id
    const totalCount = counterMap.get(slug) ?? 0
    totalRegistrations += totalCount

    const city = str(physical, 'city')
    if (city) citySet.add(city)

    const isFreeEvent = pricing?.eventType === 'free'
    const passes = Array.isArray(pricing?.passes) ? (pricing!.passes as Array<Record<string, unknown>>) : []
    const prices  = passes
      .filter(p => p.status !== 'inactive' && p.name)
      .map(p => Number(p.price ?? 0))
      .filter(n => n > 0)
    const minPrice = isFreeEvent ? 0 : (prices.length ? Math.min(...prices) : 0)

    const formSettings = rec(raw.registrationForm as unknown, 'settings')
    const approvalMode = (formSettings.approvalMode as 'auto' | 'manual' | undefined) ?? 'auto'

    let publishedAt: string | null = null
    const pts = raw.publishedAt as { _seconds?: number; toDate?: () => Date } | null | undefined
    if (pts) {
      try {
        const d = typeof pts.toDate === 'function' ? pts.toDate() : new Date((pts._seconds ?? 0) * 1000)
        publishedAt = d.toISOString()
      } catch { /* ignore */ }
    }

    events.push({
      id:            slug,
      slug,
      name:          str(info, 'name') ?? 'Untitled Event',
      tagline:       str(info, 'tagline') ?? '',
      startDate:     str(sched, 'startDate'),
      endDate:       str(sched, 'endDate'),
      startTime:     str(sched, 'startTime'),
      city,
      state:         str(physical, 'state'),
      venueType:     (str(venue, 'type') as 'physical' | 'online' | 'hybrid' | null) ?? 'physical',
      eventType:     str(raw, 'eventType'),
      bannerUrl:     str(rec(media, 'coverBanner'), 'value'),
      logoUrl:       str(rec(media, 'logo'), 'value'),
      isFreeEvent,
      minPrice,
      totalCapacity: typeof raw.totalCapacity === 'number' ? raw.totalCapacity : null,
      totalCount,
      organizerName: str(org, 'name'),
      organizerLogo: str(org, 'logoUrl'),
      approvalMode,
      publishedAt,
    })
  }

  // Sort: upcoming first, then chronologically
  const today = new Date().toISOString().slice(0, 10)
  events.sort((a, b) => {
    const ad = a.startDate ?? '9999-12-31'
    const bd = b.startDate ?? '9999-12-31'
    const af = ad >= today
    const bf = bd >= today
    if (af !== bf) return af ? -1 : 1
    return ad < bd ? -1 : ad > bd ? 1 : 0
  })

  return {
    events,
    stats: {
      totalEvents:        events.length,
      totalRegistrations,
      totalCities:        citySet.size,
    },
  }
}

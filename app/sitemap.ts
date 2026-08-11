import type { MetadataRoute } from 'next'
import { adminDb } from '@/lib/firebase/admin'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'
import { isContentTakenDown } from '@/lib/admin/moderation'
import type { ModerationStatus } from '@/lib/admin/moderation'

// LS1: sitemap.xml (was missing) — static marketing/discovery routes plus every
// published event and active donation campaign. Regenerated hourly (ISR). If
// Firestore is unavailable (e.g. build phase), the static entries are still served.
export const revalidate = 3600

// RD-SEO-01 · <lastmod> is emitted ONLY from a real stored timestamp.
//
// The former version fell back to `new Date()`, which meant (a) every static page and
// (b) any event missing publishedAt/updatedAt advertised "changed just now" on every
// hourly ISR regeneration. Google explicitly discounts lastmod for the WHOLE site once
// it catches the value being inaccurate, so a fabricated date is worse than none.
// Returning undefined omits the element, which the sitemap protocol allows.
function tsToDate(...candidates: unknown[]): Date | undefined {
  for (const ts of candidates) {
    if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
      const d = (ts as { toDate: () => Date }).toDate()
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d
    }
  }
  return undefined
}

// `visibility` is 'public' | 'private'; documents published before the field existed
// store null. Only an EXPLICIT 'private' is withheld, so legacy events keep their entry.
function isPrivate(visibility: unknown): boolean {
  return visibility === 'private'
}

const STATIC_PATHS: Array<[string, number]> = [
  ['',                       1.0],
  ['/events',                0.9],
  // RD-RESULTS-PUBLIC-FIX-01 · the results index. The per-race URLs below are dynamic.
  ['/results',               0.8],
  ['/causes',                0.8],
  ['/pricing',               0.7],
  ['/platform',              0.7],
  ['/support',               0.6],
  ['/about',                 0.5],
  ['/contact',               0.5],
  ['/resources',             0.5],
  ['/security',              0.4],
  ['/privacy',               0.3],
  ['/terms',                 0.3],
  ['/refund-policy',         0.3],
  ['/cookie-policy',         0.3],
  ['/platform/api',          0.4],
  ['/platform/payments',     0.4],
  ['/platform/registration', 0.4],
  ['/platform/check-in',     0.4],
  ['/platform/certificates', 0.4],
  ['/platform/crm',          0.4],
  ['/platform/finance',      0.4],
  ['/platform/identifiers',  0.4],
  ['/platform/participants', 0.4],
  ['/platform/security',     0.4],
  ['/solutions/conferences', 0.4],
  ['/solutions/corporate',   0.4],
  ['/solutions/fundraisers', 0.4],
  ['/solutions/schools',     0.4],
  ['/solutions/sports',      0.4],
]

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  // Runtime-editable base URL (this route is already dynamic/ISR).
  const { baseUrl: BASE_URL } = await getBrandingConfig()

  // No lastModified: these pages change on redeploy, and this route regenerates hourly,
  // so any date emitted here would be invented rather than observed (see tsToDate).
  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map(([path, priority]) => ({
    url: `${BASE_URL}${path}`,
    changeFrequency: 'weekly',
    priority,
  }))

  const dynamicEntries: MetadataRoute.Sitemap = []
  try {
    const [events, campaigns] = await Promise.all([
      // Visibility and moderation are filtered IN MEMORY, exactly as listPublishedEvents
      // does: 'active' moderation is the ABSENCE of the field so it cannot be queried, and
      // keeping one equality filter means this needs no composite index.
      adminDb.collection('events')
        .where('lifecycleStatus', '==', 'published')
        .select('publishedAt', 'updatedAt', 'visibility', 'moderationStatus').limit(5000).get(),
      // Mirrors the canonical /causes gate (listCampaigns): active + publicly visible.
      // Served by the existing (status, visibility, publishedAt) composite index.
      //
      // Isolated with .catch: under Promise.all a campaigns failure (a dropped index, a
      // permission change) would reject the whole settlement and silently cost us EVERY
      // event URL — the entries that matter most. Campaigns degrade on their own instead.
      adminDb.collection('donationCampaigns')
        .where('status', '==', 'active')
        .where('visibility', '==', 'public')
        .select('updatedAt', 'publishedAt', 'moderationStatus').limit(5000).get()
        .catch(() => null),
    ])
    for (const d of events.docs) {
      const data = d.data() as {
        updatedAt?: unknown; publishedAt?: unknown
        visibility?: unknown; moderationStatus?: ModerationStatus
      }
      // A PRIVATE event stays reachable by its link (that is the product), but it is an
      // invite-only page — it must never be advertised to a crawler.
      if (isPrivate(data.visibility)) continue
      // An admin-taken-down event 404s on its own page, so listing it would publish a
      // URL that is guaranteed to be a soft-404 to Google.
      if (isContentTakenDown(data.moderationStatus)) continue
      dynamicEntries.push({
        url: `${BASE_URL}/events/${d.id}`,
        lastModified: tsToDate(data.updatedAt, data.publishedAt),
        changeFrequency: 'daily',
        priority: 0.8,
      })
    }
    // ═══ RD-RESULTS-PUBLIC-FIX-01 · published race results ═══════════════
    // Read from the SNAPSHOT collection filtered on `status == "live"` — the same gate
    // every public results page applies. A draft, a superseded version and a cancelled
    // import therefore cannot reach the sitemap, and no second rule decides it.
    //
    // Both URL shapes are emitted from ONE read: the snapshot carries the event slug and
    // the race slug, so the event-level page and its races come from the same document.
    // Event URLs are de-duplicated because an event with four races has four snapshots.
    const snapshots = await adminDb.collection('raceResultSnapshots')
      .where('status', '==', 'live')
      .select('eventSlug', 'passSlug', 'publishedAt')
      .limit(5000)
      .get()

    const seenEvents = new Set()
    for (const d of snapshots.docs) {
      const data = d.data()
      const eventSlug = typeof data.eventSlug === 'string' ? data.eventSlug : ''
      const passSlug  = typeof data.passSlug  === 'string' ? data.passSlug  : ''
      if (!eventSlug || !passSlug) continue

      const lastModified = tsToDate(data.publishedAt)

      if (!seenEvents.has(eventSlug)) {
        seenEvents.add(eventSlug)
        dynamicEntries.push({
          url: `${BASE_URL}/results/${eventSlug}`,
          lastModified,
          // Results stop changing once published — a correction is rare, unlike an event
          // page whose details move until race day.
          changeFrequency: 'monthly',
          priority: 0.7,
        })
      }

      dynamicEntries.push({
        url: `${BASE_URL}/results/${eventSlug}/${passSlug}`,
        lastModified,
        changeFrequency: 'monthly',
        priority: 0.7,
      })
    }

    for (const d of campaigns?.docs ?? []) {
      const data = d.data() as {
        updatedAt?: unknown; publishedAt?: unknown; moderationStatus?: ModerationStatus
      }
      // Same moderation axis as the events above — status stays 'active' on takedown.
      if (isContentTakenDown(data.moderationStatus)) continue
      dynamicEntries.push({
        url: `${BASE_URL}/campaign/${d.id}`,
        lastModified: tsToDate(data.updatedAt, data.publishedAt),
        changeFrequency: 'daily',
        priority: 0.6,
      })
    }
  } catch {
    // Firestore unavailable (e.g. during build) — serve the static sitemap only.
  }

  // A sitemap must not repeat a <loc>. Every producer above is already unique by
  // construction (doc ids are unique; event results are de-duplicated by slug), so this
  // is a guarantee rather than a fix — it keeps that property true if a future producer
  // is added, and costs one pass over a few thousand strings.
  const seenUrls = new Set<string>()
  return [...staticEntries, ...dynamicEntries].filter(entry => {
    if (seenUrls.has(entry.url)) return false
    seenUrls.add(entry.url)
    return true
  })
}

import type { MetadataRoute } from 'next'
import { adminDb } from '@/lib/firebase/admin'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'

// LS1: sitemap.xml (was missing) — static marketing/discovery routes plus every
// published event and active donation campaign. Regenerated hourly (ISR). If
// Firestore is unavailable (e.g. build phase), the static entries are still served.
export const revalidate = 3600

function tsToDate(ts: unknown): Date {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate()
  }
  return new Date()
}

const STATIC_PATHS: Array<[string, number]> = [
  ['',                       1.0],
  ['/events',                0.9],
  ['/causes',                0.8],
  ['/pricing',               0.7],
  ['/platform',              0.7],
  ['/about',                 0.5],
  ['/contact',               0.5],
  ['/resources',             0.5],
  ['/security',              0.4],
  ['/privacy',               0.3],
  ['/terms',                 0.3],
  ['/refund-policy',         0.3],
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
  const now = new Date()
  // Runtime-editable base URL (this route is already dynamic/ISR).
  const { baseUrl: BASE_URL } = await getBrandingConfig()

  const staticEntries: MetadataRoute.Sitemap = STATIC_PATHS.map(([path, priority]) => ({
    url: `${BASE_URL}${path}`,
    lastModified: now,
    changeFrequency: 'weekly',
    priority,
  }))

  const dynamicEntries: MetadataRoute.Sitemap = []
  try {
    const [events, campaigns] = await Promise.all([
      adminDb.collection('events')
        .where('lifecycleStatus', '==', 'published')
        .select('publishedAt', 'updatedAt').limit(5000).get(),
      adminDb.collection('donationCampaigns')
        .where('status', '==', 'active')
        .select('updatedAt').limit(5000).get(),
    ])
    for (const d of events.docs) {
      const data = d.data() as { updatedAt?: unknown; publishedAt?: unknown }
      dynamicEntries.push({
        url: `${BASE_URL}/events/${d.id}`,
        lastModified: tsToDate(data.updatedAt ?? data.publishedAt),
        changeFrequency: 'daily',
        priority: 0.8,
      })
    }
    for (const d of campaigns.docs) {
      const data = d.data() as { updatedAt?: unknown }
      dynamicEntries.push({
        url: `${BASE_URL}/campaign/${d.id}`,
        lastModified: tsToDate(data.updatedAt),
        changeFrequency: 'daily',
        priority: 0.6,
      })
    }
  } catch {
    // Firestore unavailable (e.g. during build) — serve the static sitemap only.
  }

  return [...staticEntries, ...dynamicEntries]
}

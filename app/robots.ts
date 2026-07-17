import type { MetadataRoute } from 'next'
import { getBrandingConfig } from '@/lib/config/resolveBrandingConfig'

// LS1: robots.txt (was missing). Allows crawling of public marketing/discovery
// pages; disallows authenticated dashboards, admin, API, and auth flows.
// RD-CONF-10: base URL now comes from the runtime-editable branding config.
// Regenerated hourly (ISR) so a config change is picked up without a redeploy.
export const revalidate = 3600

export default async function robots(): Promise<MetadataRoute.Robots> {
  const { baseUrl: BASE_URL } = await getBrandingConfig()
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: [
        '/dashboard/',
        '/admin/',
        '/api/',
        '/attendee/',
        '/login',
        '/forgot-password',
        '/verify-email',
        '/welcome',
      ],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  }
}

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
      // RD-SEO-01 · robots.txt matches by literal PREFIX, so a trailing slash excluded
      // the section root itself: '/dashboard/' left the real /dashboard page crawlable
      // (likewise /admin, which middleware redirects to /admin/dashboard). Dropping the
      // slash covers the root AND everything beneath it.
      //
      // Only surfaces that carry NO useful content for a crawler are listed here. Pages
      // that already answer with `robots: { index: false }` in their metadata are
      // deliberately left crawlable — /tickets, /verify/certificate, /donations/receipt,
      // /events/*/photos, /events/*/certificates, /events/*/register/success. Blocking
      // those here would stop Google fetching the page and therefore stop it ever READING
      // the noindex, which is what actually keeps a URL out of the index.
      disallow: [
        '/dashboard',
        '/admin',
        '/api/',
        '/attendee',
        '/login',
        '/forgot-password',
        '/verify-email',
        '/welcome',
        // Single-use token in the URL, no indexable content behind either.
        '/team/accept',
        '/unsubscribe',
      ],
    },
    sitemap: `${BASE_URL}/sitemap.xml`,
    host: BASE_URL,
  }
}

// Phase P.2.2A — Platform page SEO helpers (reuse seo.ts; no duplication).

import type { Metadata } from 'next'
import { buildMetadata, organizationJsonLd, softwareAppJsonLd, breadcrumbJsonLd } from '@/lib/marketing/seo'
import type { PlatformPageConfig } from './types'

export function platformPath(slug: string): string {
  return `/platform/${slug}`
}

/** Standard metadata (title/description/canonical/OG/Twitter/robots) for a page. */
export function buildPlatformMetadata(config: PlatformPageConfig): Metadata {
  return buildMetadata({
    title:       config.seo.title,
    description: config.seo.description,
    path:        platformPath(config.slug),
  })
}

/** Organization + SoftwareApplication + Breadcrumb JSON-LD for a platform page. */
export function platformJsonLd(config: PlatformPageConfig): Record<string, unknown>[] {
  return [
    organizationJsonLd(),
    softwareAppJsonLd(),
    breadcrumbJsonLd([
      { name: 'Home',     path: '/' },
      { name: 'Platform', path: '/platform' },
      { name: config.breadcrumbLabel, path: platformPath(config.slug) },
    ]),
  ]
}

// Phase P.1.3 — Marketing SEO helpers.
//
// Shared metadata + structured-data builders (no page metadata here — pages call
// these in later phases). Pure functions; presentation/SEO config only.

import type { Metadata } from 'next'
import { BUSINESS_CONFIG_DEFAULTS } from '@/lib/config/businessConfig'

// RD-CONF-10: platform identity (name/tagline/ogImage/currency) is sourced from the
// branding code default — one source of truth. These marketing helpers feed STATIC
// `export const metadata`, so they must stay synchronous and cannot read Firestore;
// they reflect the code default (runtime overrides apply to dynamic/client surfaces).
// baseUrl is env-seeded inside the branding default, so there is no separate copy.
const BRAND = BUSINESS_CONFIG_DEFAULTS.branding

export const SITE = {
  name:    BRAND.platformName,
  baseUrl: BRAND.baseUrl,
  tagline: BRAND.platformTagline,
  ogImage: { url: BRAND.ogImageUrl, width: 1200, height: 630 },
} as const

/** Absolute canonical URL for a path. */
export function canonical(path: string): string {
  return new URL(path.startsWith('/') ? path : `/${path}`, SITE.baseUrl).toString()
}

export interface BuildMetadataInput {
  title:       string
  description: string
  path:        string
  ogImage?:    string
  noIndex?:    boolean
}

/** Standard marketing-page metadata (title/description/canonical/OG/Twitter/robots). */
export function buildMetadata(input: BuildMetadataInput): Metadata {
  const url   = canonical(input.path)
  const image = input.ogImage ?? SITE.ogImage.url
  return {
    title:       input.title,
    description: input.description,
    alternates:  { canonical: url },
    openGraph: {
      title: input.title, description: input.description, url,
      siteName: SITE.name, type: 'website', locale: 'en_IN',
      images: [{ url: image, width: SITE.ogImage.width, height: SITE.ogImage.height }],
    },
    twitter: {
      card: 'summary_large_image', title: input.title, description: input.description, images: [image],
    },
    robots: input.noIndex ? { index: false, follow: false } : { index: true, follow: true },
  }
}

// ─── JSON-LD builders (plain objects; pages embed via a ld+json script) ─────────

export function organizationJsonLd(): Record<string, unknown> {
  return { '@context': 'https://schema.org', '@type': 'Organization', name: SITE.name, url: SITE.baseUrl, slogan: SITE.tagline }
}

export function softwareAppJsonLd(): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    name: SITE.name, applicationCategory: 'BusinessApplication', operatingSystem: 'Web',
    url: SITE.baseUrl, offers: { '@type': 'Offer', price: '0', priceCurrency: BRAND.defaultCurrency },
  }
}

export function faqJsonLd(items: { question: string; answer: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: items.map(i => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: i.answer } })),
  }
}

export function breadcrumbJsonLd(items: { name: string; path: string }[]): Record<string, unknown> {
  return {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: canonical(it.path) })),
  }
}

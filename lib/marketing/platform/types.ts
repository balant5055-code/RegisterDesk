// Phase P.2 (product-page architecture) — Platform Page Framework types.
//
// Platform pages are PRODUCT pages. Their section kinds are product-only —
// the renderer no longer knows about workflow / features / benefits / faq.
// Those marketing/storytelling section types belong ONLY to the homepage.

import type { MarketingIconKey } from '@/lib/marketing/icons'
import type { CtaKey } from '@/lib/marketing/cta'

export interface PlatformHeroConfig {
  eyebrow?:      string
  headline:      string
  subheadline:   string
  primaryCta:    CtaKey
  secondaryCta:  CtaKey
  /** id into the screenshot registry — never an inline/fake screenshot. */
  screenshotId?: string
}

// ─── Product section item shapes ────────────────────────────────────────────

/**
 * `status` is OPTIONAL and defaults to shipped. It exists for one reason: /security lists a
 * roadmap section beside its shipped controls, and the two were rendering identically.
 * SECURITY_FUTURE already carried `status: 'coming_soon'`, but the field died here — the
 * projection into this type dropped it — so SSO, 2FA, SCIM, enterprise compliance and BYOK
 * appeared as cards indistinguishable from the nine controls that actually exist. On a page
 * whose entire job is being trustworthy, that is the worst possible place for a silent
 * downgrade. Omit it and a card reads as available, which is what every other page means.
 */
export interface PlatformCapabilityItem  { iconKey: MarketingIconKey; title: string; description: string; status?: 'coming_soon' }
export interface PlatformHighlightItem   { iconKey?: MarketingIconKey; title: string; description: string }
export interface PlatformIntegrationItem { iconKey: MarketingIconKey; title: string; description: string }
export interface PlatformUseCaseItem     { title: string; description: string }

interface SectionBase {
  id:        string
  eyebrow?:  string
  title:     string
  subtitle?: string
}

/**
 * PRODUCT section kinds ONLY. No `workflow` / `features` / `benefits` / `faq`
 * — those are homepage-only. The renderer's dispatch is exhaustive over this set.
 */
export type PlatformSectionConfig =
  | (SectionBase & { kind: 'product_showcase';   screenshotId: string; highlights?: PlatformHighlightItem[] })
  | (SectionBase & { kind: 'dashboard_preview';  screenshotId: string })
  | (SectionBase & { kind: 'ui_gallery';         screenshotIds: string[] })
  | (SectionBase & { kind: 'capability_grid';    items: PlatformCapabilityItem[] })
  | (SectionBase & { kind: 'feature_highlights'; items: PlatformHighlightItem[] })
  | (SectionBase & { kind: 'integrations';       items: PlatformIntegrationItem[] })
  | (SectionBase & { kind: 'use_cases';          items: PlatformUseCaseItem[] })

export interface PlatformCtaConfig {
  headline:     string
  subheadline?: string
  primaryCta:   CtaKey
  secondaryCta: CtaKey
}

export interface PlatformSeoConfig {
  title:       string
  description: string
}

export interface PlatformPageConfig {
  /** slug under /platform — e.g. 'registration' → /platform/registration. */
  slug:            string
  breadcrumbLabel: string
  seo:             PlatformSeoConfig
  hero:            PlatformHeroConfig
  sections:        PlatformSectionConfig[]
  cta:             PlatformCtaConfig
}

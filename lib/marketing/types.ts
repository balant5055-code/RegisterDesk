// Phase P.1.3 — Marketing content types.
//
// Shared, strongly-typed shapes for the content registries. Content is DATA
// (no JSX, no business logic) so components render it without hardcoding copy.
// SDK-free.

import type { MarketingIconKey } from './icons'
import type { CtaKey } from './cta'
import type { SurfaceBand } from './theme'

export interface FeatureItem  { iconKey: MarketingIconKey; title: string; description: string }
export interface ModuleItem   { iconKey: MarketingIconKey; title: string; description: string; bullets: string[] }
export interface JourneyStep  { iconKey: MarketingIconKey; title: string; description: string }
export interface SolutionItem { slug: string; iconKey: MarketingIconKey; title: string; summary: string; outcomes: string[] }
export interface FaqItem      { question: string; answer: string; category: string; order: number; href?: string; id?: string }
export interface SecurityItem { iconKey: MarketingIconKey; title: string; description: string }

export interface PricingTier {
  id:          string
  name:        string
  priceLabel:  string          // e.g. "Free", "₹999", "Custom"
  period:      string | null   // e.g. "/month", null for free/custom
  tagline:     string
  highlighted: boolean
  ctaKey:      CtaKey
  features:    string[]
}

export interface HeroContent {
  eyebrow:      string
  headline:     string
  subhead:      string
  primaryCta:   CtaKey
  secondaryCta: CtaKey
  trustLine:    string
}

// ─── Screenshots ────────────────────────────────────────────────────────────

export type ScreenshotState        = 'available' | 'pending'
export type ScreenshotFrameVariant = 'browser' | 'dashboard' | 'desktop' | 'tablet' | 'mobile'

export interface ScreenshotDef {
  id:          string
  title:       string
  description: string
  imagePath:   string | null     // null until a REAL capture exists
  alt:         string
  status:      ScreenshotState
  frame:       ScreenshotFrameVariant
  width?:      number
  height?:     number
}

// ─── Homepage section registry ──────────────────────────────────────────────

export type HomeSectionKey =
  | 'hero' | 'trust' | 'journey' | 'platform' | 'modules' | 'solutions'
  | 'workspace' | 'participant' | 'security' | 'integrations' | 'pricing' | 'faq' | 'cta'

export interface HomeSection {
  key:        HomeSectionKey
  background: SurfaceBand
  enabled:    boolean
}

// ─── Navigation (P.1.4 — data-driven shell, no JSX) ─────────────────────────

export type NavVisibility = 'always' | 'desktop-only' | 'mobile-only'

export interface NavLeaf {
  id:           string
  title:        string
  description?: string
  iconKey?:     MarketingIconKey
  href:         string
  badge?:       string
  visibility?:  NavVisibility
}

export interface NavGroup {
  id:     string
  title?: string
  items:  NavLeaf[]
}

export interface NavMenu {
  id:           string
  title:        string
  /** Direct link (no mega menu) when set and `groups` is absent — e.g. Pricing. */
  href?:        string
  description?: string
  groups?:      NavGroup[]
  /** Optional featured / promo card inside the mega menu. */
  featured?:    NavLeaf
  visibility?:  NavVisibility
}

export interface BreadcrumbItem {
  label: string
  href:  string
}

// ─── Footer (P.1.5 — data-driven, no JSX) ───────────────────────────────────

export interface FooterLink {
  label:       string
  href:        string
  external?:   boolean
  badge?:      string
  comingSoon?: boolean
}

export interface FooterColumn {
  id:    string
  title: string
  links: FooterLink[]
}

export interface SocialLink {
  id:      string
  label:   string
  href:    string
  iconKey: MarketingIconKey
}

export interface FooterTrustItem {
  iconKey: MarketingIconKey
  label:   string
}

// ─── Hero (P.1.6.1 — data-driven) ───────────────────────────────────────────

export interface HeroAnnouncement {
  label: string
  href?: string
}

export interface HeroTrustLabel {
  label:    string
  iconKey?: MarketingIconKey
}

export interface HeroSectionContent {
  eyebrow:      string
  headline:     string
  description:  string
  primaryCta:   CtaKey
  secondaryCta: CtaKey
  /** Short, honest reassurances — NOT metrics or customer counts. */
  trustPoints:  string[]
}

// ─── Event Journey (P.1.6.2 — data-driven; real lifecycle only) ─────────────

export type JourneyStatus = 'available' | 'beta' | 'coming_soon'

export interface JourneyStepDef {
  id:          string
  title:       string
  description: string
  iconKey:     MarketingIconKey
  /** The platform module this step belongs to (shown as a chip). */
  module:      string
  /** Deep link into the approved Platform IA. */
  href:        string
  status:      JourneyStatus
}

// ─── Platform Overview (P.1.6.3 — grouped, shipped capabilities only) ───────

export type PlatformStatus = 'available' | 'beta' | 'coming_soon'

export interface PlatformModuleDef {
  id:      string
  label:   string
  iconKey: MarketingIconKey
  /** Deep link into the approved Platform IA. */
  href:    string
  status:  PlatformStatus
}

export interface PlatformGroupDef {
  id:          string
  title:       string
  description: string
  iconKey:     MarketingIconKey
  /** The group's Platform IA page. */
  href:        string
  modules:     PlatformModuleDef[]
  status:      PlatformStatus
}

// ─── Organizer Workspace (P.1.6.4 — real workspaces only) ───────────────────

export type WorkspaceStatus = 'available' | 'beta' | 'coming_soon'

export interface WorkspaceItemDef {
  id:          string
  title:       string
  description: string
  iconKey:     MarketingIconKey
  /** Deep link into the approved Platform IA. */
  href:        string
  /** id into the screenshot registry — never an inline/fake screenshot. */
  screenshotId: string
  status:      WorkspaceStatus
}

// ─── Participant Experience (P.1.6.5 — real attendee lifecycle only) ────────

export type ParticipantStatus = 'available' | 'beta' | 'coming_soon'

export interface ParticipantStepDef {
  id:          string
  title:       string
  description: string
  iconKey:     MarketingIconKey
  /** Deep link into the approved Platform IA. */
  href:        string
  /** id into the screenshot registry — never an inline/fake screenshot. */
  screenshotId: string
  status:      ParticipantStatus
}

// ─── Why RegisterDesk (P.1.6.6 — philosophy & real advantages) ──────────────

export type AdvantageStatus = 'available' | 'beta' | 'coming_soon'

export interface WhyPillarDef {
  id:          string
  title:       string
  description: string
  iconKey:     MarketingIconKey
  /** Deep link into the approved IA backing this advantage. */
  href:        string
  status:      AdvantageStatus
}

// ─── Integrations & Extensibility (P.1.6.7 — real today + labeled future) ───

export type IntegrationStatus = 'available' | 'coming_soon'

export interface IntegrationCategoryDef {
  id:           string
  label:        string
  description?: string
}

export interface IntegrationDef {
  id:          string
  title:       string
  description: string
  iconKey:     MarketingIconKey
  /** Category id this integration belongs to. */
  category:    string
  status:      IntegrationStatus
  /** Deep link into the approved IA (or /roadmap for future-ready items). */
  href:        string
}

// ─── Security & Reliability (P.1.6.8 — real controls only; no certifications) ─

export type SecurityStatus = 'available' | 'beta' | 'coming_soon'

export interface SecurityCapabilityDef {
  id:          string
  title:       string
  description: string
  iconKey:     MarketingIconKey
  status:      SecurityStatus
  /** Deep link into the approved IA backing this control. */
  href:        string
}

// ─── Final CTA (P.1.6.11 — conversion close; CTA registry only) ─────────────

export interface FinalCtaContent {
  headline:     string
  subheadline:  string
  primaryCta:   CtaKey
  secondaryCta: CtaKey
  /** Section surface band (white-first; reuses the marketing surfaces). */
  background:   SurfaceBand
  /** Small reassurance line under the actions. */
  supportText:  string
  /** Organizer-type trust labels — no logos, no statistics. */
  trustLabels:  string[]
}

// Phase P.2.1 — /platform page content (PAGE-SPECIFIC ONLY).
//
// Holds only the platform page's hero + philosophy copy. Module/group cards are
// NOT redefined here — the page reuses the Platform Overview registry/component
// and the Organizer Workspace, Integrations, and Security sections. No
// duplication.

import type { CtaKey } from '@/lib/marketing/cta'

export interface PlatformHeroContent {
  eyebrow:      string
  headline:     string
  subheadline:  string
  primaryCta:   CtaKey
  secondaryCta: CtaKey
  /** id into the screenshot registry — never an inline/fake screenshot. */
  screenshotId: string
}

export interface PlatformPhilosophyContent {
  eyebrow: string
  title:   string
  body:    string[]
}

export const PLATFORM_HERO: PlatformHeroContent = {
  eyebrow:      'Platform',
  headline:     'One platform for the entire event operation',
  subheadline:  'RegisterDesk is an integrated event operations platform — not just registration. Plan, register, operate, and settle every event in one connected system.',
  primaryCta:   'startFree',
  secondaryCta: 'bookDemo',
  screenshotId: 'dashboard-home',
}

export const PLATFORM_PHILOSOPHY: PlatformPhilosophyContent = {
  eyebrow: 'One system',
  title:   'Built as one system, not a bundle of tools',
  body: [
    'Most teams stitch together a registration form, a payment tool, a spreadsheet, and a check-in app. RegisterDesk replaces that with one platform where every capability shares the same data.',
    'Registrations flow into participants, participants carry identifiers, identifiers drive check-in, and every payment is tracked through to payout — with no exports or re-keying between steps.',
  ],
}

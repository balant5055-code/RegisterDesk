// Phase P.1.6.1 — Hero content registry.
//
// All hero copy/config comes from here. Positioning reflects the ACTUAL product:
// an operations platform, not a registration form. No exaggerated claims, no fake
// statistics, no customer logos. Trust points are honest reassurances. The
// product-showcase slide data lives in components/marketing/hero/hero.data.ts.

import type { HeroSectionContent } from '@/lib/marketing/types'

export const HERO: HeroSectionContent = {
  eyebrow:     'Event Operations Platform',
  headline:    'Run every event from registration to settlement.',
  description:
    'RegisterDesk connects registration, payments, participants, check-in, certificates, and payouts in one system — so your data flows end to end with no exports or re-keying between steps.',
  primaryCta:   'startFree',
  secondaryCta: 'bookDemo',
  trustPoints: ['No setup fees', 'Cancel anytime', 'Built for organizers'],
}

// Phase P.1.6.11 — Homepage Final CTA content registry.
//
// Outcome-focused conversion close that reinforces the WHOLE platform (not just
// registration). CTA keys reference the central CTA registry (never hardcoded
// buttons). Trust labels are organizer types — no customer logos, no statistics.
// No fake urgency, no countdowns, no "limited offer", no testimonials.

import type { FinalCtaContent } from '@/lib/marketing/types'

export const FINAL_CTA: FinalCtaContent = {
  headline:     'Run every event from one platform.',
  subheadline:  'Registration, payments, identifiers, check-in, certificates, and settlements — all connected, all in one place.',
  primaryCta:   'startFree',
  secondaryCta: 'bookDemo',
  background:   'muted',
  supportText:  'Start free and upgrade as you grow.',
  trustLabels:  ['Sports', 'Schools', 'Corporate', 'Communities', 'NGOs', 'Conferences'],
}

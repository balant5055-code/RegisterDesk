// Phase P.1.3 — Homepage content registry (real content only; no fake stats).

import type { HeroContent, JourneyStep, FeatureItem } from '@/lib/marketing/types'

export const HOME_HERO: HeroContent = {
  eyebrow:      'Event Operations Platform',
  headline:     'Run your entire event business from one platform',
  subhead:      'RegisterDesk handles registration, payments, identifiers, check-in, certificates, and settlements — for marathons, conferences, fundraisers, and more.',
  primaryCta:   'startFree',
  secondaryCta: 'bookDemo',
  trustLine:    'Payments via Razorpay · Offline QR check-in · Instant certificates',
}

export const HOME_JOURNEY: JourneyStep[] = [
  { iconKey: 'registration', title: 'Register', description: 'Publish an event and take registrations with custom forms and passes.' },
  { iconKey: 'payments',     title: 'Get paid',  description: 'Collect payments online — coupons, waitlists, and capacity handled for you.' },
  { iconKey: 'identifier',   title: 'Identify',  description: 'Assign bibs, badges, or any participant identifier from one engine.' },
  { iconKey: 'checkin',      title: 'Check in',  description: 'Fast QR check-in at the gate — it keeps working when the network drops.' },
  { iconKey: 'certificates', title: 'Certify',   description: 'Generate and email verifiable certificates in bulk.' },
  { iconKey: 'settlements',  title: 'Settle',    description: 'Track revenue and receive payouts to your bank account or UPI.' },
]

export const HOME_VALUE_PROPS: FeatureItem[] = [
  { iconKey: 'workspace', title: 'One operations workspace', description: 'Every event tool in a single command center — no spreadsheets, no scattered tabs.' },
  { iconKey: 'reuse',     title: 'Works for every event type', description: 'Marathons, conferences, expos, awards, fundraisers, school and corporate events.' },
  { iconKey: 'security',  title: 'Built for trust', description: 'Role-based team access, immutable audit logs, and reconciled finances.' },
]

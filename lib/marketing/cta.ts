// Phase P.1.3 — Marketing CTA registry.
//
// Every call-to-action is defined ONCE here and referenced by key, so pages never
// hardcode labels/links. Targets point at real app routes (via ROUTES) where they
// exist; the rest point at the approved P.1.1 information architecture (marketing
// pages built in later phases). No business logic.

import { ROUTES } from '@/config/navigation'

export type CtaVariant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'gradient'

export interface Cta {
  label:    string
  href:     string
  variant:  CtaVariant
  external?: boolean
}

export const CTAS = {
  startFree:    { label: 'Start free',          href: ROUTES.NEW_EVENT, variant: 'primary' },
  createEvent:  { label: 'Create your event',   href: ROUTES.NEW_EVENT, variant: 'primary' },
  bookDemo:     { label: 'Book a demo',         href: '/contact',       variant: 'outline' },
  contactSales: { label: 'Contact sales',       href: '/contact',       variant: 'outline' },
  viewPricing:  { label: 'See pricing',         href: '/pricing',       variant: 'outline' },
  exploreEvents:{ label: 'Discover events',     href: ROUTES.EVENTS,    variant: 'ghost'   },
  readDocs:     { label: 'Read the docs',       href: '/resources',     variant: 'ghost'   },
  login:        { label: 'Log in',              href: ROUTES.LOGIN,     variant: 'ghost'   },
} as const satisfies Record<string, Cta>

export type CtaKey = keyof typeof CTAS

export function getCta(key: CtaKey): Cta {
  return CTAS[key]
}

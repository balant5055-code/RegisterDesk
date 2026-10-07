// Phase P.1.5 — Footer registry (data-driven, no JSX).
//
// The footer renders entirely from this registry. Navigation columns are DERIVED
// from the navigation registry (single source of truth — no duplicated links).
// Legal links, trust items, brand, and social are footer-specific. Social is
// EMPTY because no official profiles are verified — the component hides it rather
// than invent links. No fabricated statistics; contact email comes from env (if
// configured) else falls back to the real /contact page.

import type { FooterColumn, FooterLink, SocialLink, FooterTrustItem } from '@/lib/marketing/types'
import { PRIMARY_NAV } from './navigation'

// iconKey is carried straight through from the nav registry — the footer shows the
// SAME icon the mega-menu shows for that destination, and never picks its own.
function navColumn(menuId: string): FooterColumn {
  const menu = PRIMARY_NAV.find(m => m.id === menuId)
  const links: FooterLink[] = (menu?.groups ?? [])
    .flatMap(g => g.items)
    .map(it => ({ label: it.title, href: it.href, iconKey: it.iconKey }))
  return { id: menuId, title: menu?.title ?? menuId, links }
}

// The first column was Platform — navColumn('platform') with Pricing appended. When the
// public Platform section was retired that menu left the registry, and navColumn's
// fallbacks would have rendered the column anyway: an empty link list under the heading
// 'platform', lower-cased, because the title falls back to the menu ID. Pricing would have
// been its only entry.
//
// It is replaced by Discover rather than dropped, so Pricing keeps a home and the band
// keeps three columns instead of leaving a gap. The composition mirrors HomeFooter, which
// already made this exact column out of the flat top-level entries for the same reason —
// every link here is a destination that footer has listed all along, resolved from the
// registry rather than typed.
const DISCOVER_IDS = ['events', 'causes', 'pricing', 'contact'] as const
// Typed from FooterLink rather than as strings: the icon keys are a closed union, so a
// typo here is a compile error instead of a silently missing glyph.
const DISCOVER_ICONS: Record<string, NonNullable<FooterLink['iconKey']>> = {
  events: 'sessions', causes: 'fundraiser', pricing: 'invoice', contact: 'communications',
}
const discoverColumn: FooterColumn = {
  id: 'discover', title: 'Discover',
  links: DISCOVER_IDS
    .map((id): FooterLink | null => {
      const menu = PRIMARY_NAV.find(m => m.id === id)
      const href = menu?.href ?? menu?.featured?.href
      return href ? { label: menu!.title, href, iconKey: DISCOVER_ICONS[id] } : null
    })
    .filter((l): l is FooterLink => l !== null),
}

// Phase V1.0.A — footer keeps only Solutions, Company, Legal alongside Discover. Company
// is explicit (About/Contact/Security are now top-level nav, not a dropdown).
const companyColumn: FooterColumn = {
  id: 'company', title: 'Company',
  links: [
    { label: 'About',    href: '/about',    iconKey: 'corporate' },
    { label: 'Contact',  href: '/contact',  iconKey: 'communications' },
    { label: 'Support',  href: '/support',  iconKey: 'support' },
    { label: 'Security', href: '/security', iconKey: 'security' },
  ],
}

export const FOOTER_COLUMNS: FooterColumn[] = [
  discoverColumn,
  navColumn('solutions'),
  companyColumn,
]

// No verified official profiles → empty → the social block is hidden.
export const FOOTER_SOCIAL: SocialLink[] = []

// Only REAL, shipped capabilities.
export const FOOTER_TRUST: FooterTrustItem[] = [
  { iconKey: 'payments', label: 'Secure payments' },
  { iconKey: 'lock',     label: 'Role-based access' },
  { iconKey: 'verify',   label: 'Audit logs' },
  { iconKey: 'security', label: 'Workspace isolation' },
]

export const FOOTER_LEGAL: FooterLink[] = [
  { label: 'Privacy',       href: '/privacy' },
  { label: 'Terms',         href: '/terms' },
  { label: 'Refund Policy', href: '/refund-policy' },
  { label: 'Cookie Policy', href: '/cookie-policy' },
]

// No ctaKey / secondaryCtaKey: the footer no longer repeats "Start free" and
// "Book a demo". Those are the navbar's permanent job on every page, so the footer
// copies bought nothing — and they were the only reason the brand zone needed to be
// a card. Removed here rather than left unread, so the registry has no dead fields.
export const FOOTER_BRAND = {
  description: 'The complete Event Operations Platform for registrations, payments, check-in, certificates and attendee management.',
  contactHref: '/contact',
  contactEmail: process.env.NEXT_PUBLIC_SUPPORT_EMAIL ?? null,
} as const

/** Version placeholder — shown only when configured. */
export const APP_VERSION: string | null = process.env.NEXT_PUBLIC_APP_VERSION ?? null

/** Newsletter is reserved (component renders nothing until a backend exists). */
export const NEWSLETTER_ENABLED: boolean = false

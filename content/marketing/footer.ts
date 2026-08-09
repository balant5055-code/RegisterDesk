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

const platformColumn = navColumn('platform')
// Pricing is a top-level nav entry with no icon of its own, so the key is stated here.
platformColumn.links.push({ label: 'Pricing', href: '/pricing', iconKey: 'invoice' })

// Phase V1.0.A — footer keeps only Platform, Solutions, Company, Legal. Company
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
  platformColumn,
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

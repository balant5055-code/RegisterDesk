// Phase V1.0.A — Navigation registry (Version 1 scope, data-driven, no JSX).
//
// Solo-founder V1 launch: navigation is intentionally reduced. The navbar lists
// ONLY pages that exist and are in scope — every link resolves to a real page, so
// nothing reachable from the nav 404s. Removed for V1: Resources, Support, the
// Company dropdown, Blog, Docs, Roadmap, Status, Customers, Careers, Help,
// Integrations, and Cookies. Solutions are listed explicitly to
// match the built /solutions/* pages (the SOLUTIONS registry uses different slugs).
//
// The public API was on that removed list and has come back — deliberately, and only after
// the page it points at was made truthful. /platform/api describes three key-gated read
// endpoints, HMAC-signed webhooks and hashed API keys, all shipped; the metadata-platform
// and "API reference" claims it used to carry were removed first, because they were not
// deliverable. The V1 rule is unchanged and is the reason for that order: a nav entry may
// only point at a page that keeps its promises.
//
// Marketing Nav Update (Phase 1): the discovery surfaces (Home, Discover Events,
// Discover Causes) are now exposed at the top level so the event/cause marketplace
// is reachable from the marketing shell. Security and About were removed from the
// top nav (the pages still exist and remain linked from the footer's Company
// column) — registry-only change; the navbar/mega-menu/drawer are untouched.

import type { NavMenu } from '@/lib/marketing/types'

export const PRIMARY_NAV: NavMenu[] = [
  { id: 'home',   title: 'Home',            href: '/' },
  { id: 'events', title: 'Events', href: '/events' },
  { id: 'causes', title: 'Causes', href: '/causes' },
  {
    id: 'solutions', title: 'Solutions', description: 'Built for every event type.',
    groups: [{ id: 'verticals', items: [
      { id: 'sports',      title: 'Sports & Marathons', description: 'Bibs, check-in, finisher certificates', iconKey: 'sports',     href: '/solutions/sports' },
      { id: 'conferences', title: 'Conferences',        description: 'Sessions, delegates, attendance',       iconKey: 'sessions',   href: '/solutions/conferences' },
      { id: 'schools',     title: 'Schools & Colleges', description: 'Campus events, fests, certificates',    iconKey: 'education',   href: '/solutions/schools' },
      { id: 'corporate',   title: 'Corporate Events',   description: 'Private events, controlled access',     iconKey: 'corporate',  href: '/solutions/corporate' },
      { id: 'fundraisers', title: 'Fundraisers & NGOs', description: 'Donations, 80G receipts, donor CRM',    iconKey: 'fundraiser', href: '/solutions/fundraisers' },
    ] }],
  },
  { id: 'pricing',  title: 'Pricing',  href: '/pricing' },
  { id: 'contact',  title: 'Contact',  href: '/contact' },
]

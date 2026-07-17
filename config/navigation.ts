import type { LucideIcon } from 'lucide-react'
import {
  Home, CalendarDays, Users, CreditCard,
  LayoutDashboard, Activity, Building2, Wallet, BarChart3,
  AlertTriangle, ClipboardCheck, ShieldAlert, PlusCircle, Undo2,
  Globe, SlidersHorizontal, ArrowRightLeft, ScrollText, KeyRound, Bell, Radio,
  Gauge, LifeBuoy, Search, Boxes, FileText,
} from 'lucide-react'

// ─── Route constants ─────────────────────────────────────────────────────────
// Single place to manage every path in the app. Import ROUTES wherever you
// need a href — never hardcode strings in components.

export const ROUTES = {
  // Public
  HOME:           '/',
  EVENTS:         '/events',
  CAUSES:         '/causes',
  CAMPAIGN:       '/campaign',
  FOR_ORGANIZERS: '/platform',        // LS1: /for-organizers did not exist
  PRICING:        '/pricing',

  // Auth
  LOGIN:           '/login',
  FORGOT_PASSWORD: '/forgot-password',
  VERIFY_EMAIL:    '/verify-email',
  WELCOME:         '/welcome',

  // Platform Admin
  ADMIN_LOGIN:                 '/admin/login',
  ADMIN_DASHBOARD:             '/admin/dashboard',
  ADMIN_OPERATIONS:            '/admin/operations',
  ADMIN_INCIDENTS:             '/admin/incidents',
  ADMIN_FINANCE:               '/admin/finance',
  ADMIN_FINANCE_REPORTS:       '/admin/finance-reports',
  ADMIN_ORGANIZERS:            '/admin/organizers',
  ADMIN_MODERATION:            '/admin/moderation',
  ADMIN_EVENT_APPROVALS:       '/admin/event-approvals',
  ADMIN_WALLET_TOPUPS:         '/admin/wallet-topups',
  ADMIN_CLAWBACKS:             '/admin/clawbacks',
  ADMIN_LICENSES:              '/admin/licenses',
  ADMIN_REMINDERS:             '/admin/reminders',
  ADMIN_ANALYTICS:             '/admin/analytics',
  ADMIN_COMMUNICATIONS:        '/admin/communications',
  ADMIN_DOMAINS:               '/admin/domains',
  ADMIN_BUSINESS_CONFIG:       '/admin/business-configuration',
  ADMIN_IDENTIFIER_MIGRATION:  '/admin/identifier-migration',
  ADMIN_AUDIT:                 '/admin/audit',
  // GA-2 command centers + support (added to grouped nav in GA-2 S7)
  ADMIN_OPERATIONS_CENTER:     '/admin/operations-center',
  ADMIN_PLATFORM_MONITOR:      '/admin/platform-monitor',
  ADMIN_LICENSE_CENTER:        '/admin/license-center',
  ADMIN_SEARCH:                '/admin/search',
  ADMIN_SUPPORT:               '/admin/support',

  // Dashboard
  DASHBOARD:                  '/dashboard',
  DASHBOARD_EVENTS:           '/dashboard/events',
  DASHBOARD_REGISTRATIONS:    '/dashboard/registrations',
  DASHBOARD_ATTENDEES:        '/dashboard/registrations',  // legacy alias
  DASHBOARD_CHECK_IN:         '/dashboard/check-in',
  DASHBOARD_REPORTS:          '/dashboard/reports',
  DASHBOARD_COMMUNICATIONS:   '/dashboard/communications',
  DASHBOARD_CERTIFICATES:     '/dashboard/communications/certificates',
  DASHBOARD_SETTINGS:         '/dashboard/settings',
  DASHBOARD_FINANCE:                  '/dashboard/finance',
  DASHBOARD_FINANCE_PAYOUT_PROFILE:  '/dashboard/finance/payout-profile',
  NEW_EVENT:                         '/dashboard/events/new/visibility',
} as const

export type AppRoute = (typeof ROUTES)[keyof typeof ROUTES]

// ─── Nav items ────────────────────────────────────────────────────────────────
// Add, remove, or reorder items here — the Navbar reads this array directly.

export interface NavItem {
  label: string
  href:  string
  icon:  LucideIcon
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Home',           href: ROUTES.HOME,           icon: Home         },
  { label: 'Events',         href: ROUTES.EVENTS,         icon: CalendarDays },
  { label: 'For Organizers', href: ROUTES.FOR_ORGANIZERS, icon: Users        },
  { label: 'Pricing',        href: ROUTES.PRICING,        icon: CreditCard   },
]

// ─── Platform Admin navigation registry ────────────────────────────────────────
// Single source of truth for the admin shell's top bar. The `(admin)` layout
// reads these arrays directly — nothing about the navigation is hardcoded in the
// header. Primary items render inline; everything else is grouped under "More ▼"
// on desktop and expanded in the mobile drawer. Add / reorder items here only.

export interface AdminNavItem {
  label: string
  href:  string
  icon:  LucideIcon
  /** When true the active state matches the exact path only (no prefix match). */
  exact?: boolean
}

export interface AdminNavGroup {
  /** Section heading shown in the More menu and the mobile drawer. */
  label: string
  items: AdminNavItem[]
}

/** Compact primary navigation — always-visible hero links in the top bar (md+).
 *  High-traffic destinations; the full grouped IA lives under "More ▼" below. */
export const ADMIN_PRIMARY_NAV: AdminNavItem[] = [
  { label: 'Dashboard',  href: ROUTES.ADMIN_DASHBOARD,        icon: LayoutDashboard, exact: true },
  { label: 'Operations', href: ROUTES.ADMIN_OPERATIONS_CENTER, icon: Boxes },
  { label: 'Organizers', href: ROUTES.ADMIN_ORGANIZERS,       icon: Building2 },
  { label: 'Finance',    href: ROUTES.ADMIN_FINANCE,          icon: Wallet, exact: true },
  { label: 'Support',    href: ROUTES.ADMIN_SUPPORT,          icon: LifeBuoy },
]

/**
 * Enterprise grouped navigation (GA-2 S7 consolidation). Replaces the ad-hoc
 * "More" groups with one coherent Information Architecture. Every item is an
 * EXISTING page — nothing is invented. Deep-link-only destinations (Organizer 360,
 * Event 360, Participant 360) are intentionally NOT listed here: they have no list
 * route and are reached from Organizers / Global Search / the Support workspace.
 */
export const ADMIN_MORE_NAV: AdminNavGroup[] = [
  {
    label: 'Operations',
    items: [
      { label: 'Operations Center', href: ROUTES.ADMIN_OPERATIONS_CENTER, icon: Boxes },
      { label: 'Platform Monitor',  href: ROUTES.ADMIN_PLATFORM_MONITOR,  icon: Gauge },
      { label: 'Operations Health', href: ROUTES.ADMIN_OPERATIONS,        icon: Activity },
      { label: 'Analytics',         href: ROUTES.ADMIN_ANALYTICS,         icon: BarChart3 },
      { label: 'Reports',           href: ROUTES.ADMIN_FINANCE_REPORTS,   icon: FileText },
    ],
  },
  {
    label: 'Organizations',
    items: [
      { label: 'Organizers', href: ROUTES.ADMIN_ORGANIZERS, icon: Building2 },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { label: 'Finance',        href: ROUTES.ADMIN_FINANCE,         icon: Wallet, exact: true },
      { label: 'License Center', href: ROUTES.ADMIN_LICENSE_CENTER,  icon: KeyRound },
      { label: 'Licenses',       href: ROUTES.ADMIN_LICENSES,        icon: KeyRound },
      { label: 'Top-ups',        href: ROUTES.ADMIN_WALLET_TOPUPS,   icon: PlusCircle },
      { label: 'Clawbacks',      href: ROUTES.ADMIN_CLAWBACKS,       icon: Undo2 },
    ],
  },
  {
    label: 'Governance',
    items: [
      { label: 'Approvals',  href: ROUTES.ADMIN_EVENT_APPROVALS, icon: ClipboardCheck },
      { label: 'Moderation', href: ROUTES.ADMIN_MODERATION,      icon: ShieldAlert },
      { label: 'Audit Log',  href: ROUTES.ADMIN_AUDIT,           icon: ScrollText },
      { label: 'Incidents',  href: ROUTES.ADMIN_INCIDENTS,       icon: AlertTriangle },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Communications', href: ROUTES.ADMIN_COMMUNICATIONS,       icon: Radio },
      { label: 'Reminders',      href: ROUTES.ADMIN_REMINDERS,            icon: Bell },
      { label: 'Domains',        href: ROUTES.ADMIN_DOMAINS,              icon: Globe },
      { label: 'Configuration',  href: ROUTES.ADMIN_BUSINESS_CONFIG,      icon: SlidersHorizontal },
      { label: 'ID Migration',   href: ROUTES.ADMIN_IDENTIFIER_MIGRATION, icon: ArrowRightLeft },
    ],
  },
  {
    label: 'Support',
    items: [
      { label: 'Support Workspace', href: ROUTES.ADMIN_SUPPORT, icon: LifeBuoy },
      { label: 'Global Search',     href: ROUTES.ADMIN_SEARCH,  icon: Search },
    ],
  },
]

/** Flat, de-duplicated list of every admin destination (by href) — for active-state
 *  lookups. Hero links intentionally repeat inside their groups for quick access, so
 *  this helper collapses them to one entry per unique route. */
export const ADMIN_ALL_NAV: AdminNavItem[] = (() => {
  const seen = new Set<string>()
  return [...ADMIN_PRIMARY_NAV, ...ADMIN_MORE_NAV.flatMap(g => g.items)]
    .filter(item => (seen.has(item.href) ? false : (seen.add(item.href), true)))
})()

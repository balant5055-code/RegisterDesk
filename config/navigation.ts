import type { LucideIcon } from 'lucide-react'
import {
  Coins,
  Home, CalendarDays, Users, CreditCard,
  LayoutDashboard, Activity, Building2, Wallet, BarChart3,
  AlertTriangle, ClipboardCheck, ShieldAlert, PlusCircle, Undo2,
  Globe, SlidersHorizontal, ArrowRightLeft, ScrollText, KeyRound, Bell, Radio,
  Gauge, LifeBuoy, Search, Boxes, FileText, Receipt,
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
  /** RD-ADMIN-CLOSURE-01 · the list that makes `/admin/events/{slug}` (Event 360) reachable. */
  ADMIN_EVENTS:                '/admin/events',
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
  /** MC-08.1 — Media Credits operations console. */
  ADMIN_MEDIA_CREDITS:         '/admin/media-credits',
  ADMIN_IDENTIFIER_MIGRATION:  '/admin/identifier-migration',
  ADMIN_AUDIT:                 '/admin/audit',
  // GA-2 command centers + support (added to grouped nav in GA-2 S7)
  ADMIN_OPERATIONS_CENTER:     '/admin/operations-center',
  ADMIN_PLATFORM_MONITOR:      '/admin/platform-monitor',
  ADMIN_COMMUNICATION_CENTER:  '/admin/communication-center',
  ADMIN_LICENSE_CENTER:        '/admin/license-center',
  ADMIN_PRICING_OPS:           '/admin/pricing-ops',
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

  // Race Operations (RD-RACEOPS-01). Certificates are intentionally absent here —
  // the module LINKS to the existing DASHBOARD_CERTIFICATES route above rather than
  // owning a certificates destination of its own.
  RACE_OPS:                  '/dashboard/race-operations',
  RACE_OPS_PUBLISH_RESULTS:  '/dashboard/race-operations/publish-results',
  RACE_OPS_HISTORY:          '/dashboard/race-operations/history',
  RACE_OPS_BADGES:           '/dashboard/race-operations/finisher-badges',

  // Media Studio (RD-MEDIA-01) — a PLATFORM module, not a Race Operations feature.
  MEDIA_STUDIO:            '/dashboard/media-studio',
  MEDIA_STUDIO_IMPORT:     '/dashboard/media-studio/import',
  MEDIA_STUDIO_GALLERIES:  '/dashboard/media-studio/galleries',
  MEDIA_STUDIO_ALBUMS:     '/dashboard/media-studio/albums',
  MEDIA_STUDIO_PROCESSING: '/dashboard/media-studio/processing',
  MEDIA_STUDIO_STORAGE:    '/dashboard/media-studio/storage',
  // RD-PHOTO-01 — event photo branding. Not a licensing feature; every organizer.
  MEDIA_STUDIO_BRANDING:   '/dashboard/media-studio/branding',
  MEDIA_STUDIO_SETTINGS:   '/dashboard/media-studio/settings',
  /** MC-08.1 — the destination for every "Buy credits" action. */
  MEDIA_STUDIO_CREDITS:    '/dashboard/media-studio/credits',
  // RD-MEDIA-05 — manual maintenance. Platform-admin only, enforced by its API.
  MEDIA_STUDIO_MAINTENANCE: '/dashboard/media-studio/maintenance',
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
  /**
   * RD-ADMIN-CLOSURE-01 · one line explaining the destination.
   *
   * Shown as the subtitle in the command palette and on Global Search. It lives HERE rather
   * than in those components because they used to keep their own parallel list of admin
   * destinations, which drifted: 11 of 26 pages — Media Credits among them — were missing
   * from ⌘K entirely. One array now feeds the sidebar, the palette and search.
   */
  description?: string
  /**
   * Extra search terms, space separated. Never shown.
   *
   * For the words an admin would actually type that are not in the label — "noc", "cron",
   * "refund", "payout". Optional: a label that already contains the obvious search term
   * needs none.
   */
  keywords?: string
}

export interface AdminNavGroup {
  /** Section heading shown in the More menu and the mobile drawer. */
  label: string
  items: AdminNavItem[]
}

/**
 * RD-ADMIN-01 — Enterprise admin sidebar Information Architecture. THE single source
 * of truth for the admin shell's left sidebar. One coherent, collapsible-group IA that
 * scales to 100+ pages: every existing admin LIST page belongs to exactly one group,
 * appears exactly once (no hero duplication), and nothing is orphaned. Add / reorder
 * admin destinations here only — the layout renders these groups directly.
 *
 * Every item is an EXISTING page. Deep-link-only destinations (Organizer 360
 * `/admin/organizers/[uid]`, Event 360 `/admin/events/[slug]`) are intentionally NOT
 * listed — they are dynamic detail routes with no list index, reached from Organizers /
 * Global Search / the Support workspace. `/admin/login` is an unauthenticated auth page,
 * correctly excluded from the authenticated shell.
 */
export const ADMIN_SIDEBAR_NAV: AdminNavGroup[] = [
  {
    label: 'Overview',
    items: [
      { label: 'Dashboard', href: ROUTES.ADMIN_DASHBOARD, icon: LayoutDashboard, exact: true,
        description: "Platform overview", keywords: "home overview stats" },
      { label: 'Analytics', href: ROUTES.ADMIN_ANALYTICS,  icon: BarChart3,
        description: "Revenue, growth and platform charts", keywords: "charts revenue growth" },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Background Jobs',   href: ROUTES.ADMIN_OPERATIONS_CENTER, icon: Boxes,
        description: "Run and investigate background jobs", keywords: "noc jobs queue print certificate import export bulk" },
      { label: 'Platform Monitor',  href: ROUTES.ADMIN_PLATFORM_MONITOR,  icon: Gauge,
        description: "Platform health dashboard", keywords: "health monitor infrastructure services uptime" },
      // RD-ADMIN-CLOSURE-01 · `exact` is REQUIRED here, not cosmetic.
      //
      // Active state is `pathname.startsWith(item.href)` unless `exact`. `/admin/operations`
      // is a PREFIX of `/admin/operations-center`, so without this the Operations Center page
      // highlighted two sidebar items at once and the admin could not tell which page they
      // were on. `Finance` below already carries `exact` for exactly this reason against
      // `/admin/finance-reports`; this was the missed sibling case.
      { label: 'Cron & Recovery',   href: ROUTES.ADMIN_OPERATIONS,        icon: Activity, exact: true,
        description: "Cron schedules, recovery and runbooks", keywords: "cron recovery health alerts runbook scheduler" },
    ],
  },
  {
    label: 'Commerce',
    items: [
      { label: 'License Center',      href: ROUTES.ADMIN_LICENSE_CENTER, icon: KeyRound,
        description: "Licences, coupons, orders and expiry", keywords: "license coupon orders expiry override promotion" },
      { label: 'Licenses',            href: ROUTES.ADMIN_LICENSES,       icon: KeyRound,
        description: "Per-event licence console", keywords: "license grant upgrade downgrade reissue" },
      { label: 'Pricing Operations',  href: ROUTES.ADMIN_PRICING_OPS,    icon: Receipt,
        description: "Pricing operations and overrides", keywords: "pricing price override tier" },
    ],
  },
  {
    label: 'Finance',
    items: [
      { label: 'Finance',         href: ROUTES.ADMIN_FINANCE,         icon: Wallet, exact: true,
        description: "Settlements, payouts and transactions", keywords: "settlement payout revenue release transaction" },
      { label: 'Finance Reports', href: ROUTES.ADMIN_FINANCE_REPORTS, icon: FileText,
        description: "Financial reporting and exports", keywords: "report export gst tax statement" },
      { label: 'Top-ups',         href: ROUTES.ADMIN_WALLET_TOPUPS,   icon: PlusCircle,
        description: "Organizer wallet top-ups", keywords: "wallet topup credit balance" },
      { label: 'Clawbacks',       href: ROUTES.ADMIN_CLAWBACKS,       icon: Undo2,
        description: "Recover funds already released", keywords: "clawback recover reverse chargeback" },
      // MC-08.1 · Media Credits sits in Finance rather than Commerce: its primary figures
      // are outstanding liability, refund payouts and reconciliation debt — money owed,
      // not products sold.
      { label: 'Media Credits',   href: ROUTES.ADMIN_MEDIA_CREDITS,   icon: Coins,
        description: "Photo credit wallets, refunds and reconciliation", keywords: "media credits refund grant ledger photo purchase reconciliation session" },
    ],
  },
  {
    label: 'Organizers',
    items: [
      { label: 'Organizers', href: ROUTES.ADMIN_ORGANIZERS, icon: Building2,
        description: "Organizer accounts", keywords: "organizer users accounts suspend ban" },
    ],
  },
  {
    label: 'Governance',
    items: [
      // RD-ADMIN-CLOSURE-01 · Events leads the group for the same reason Organizers leads
      // its own: it is the BROWSE entry, and the queues below it are subsets of it.
      //
      // Deliberately NOT `exact`. `/admin/events/{slug}` (Event 360) is a child of this
      // list, so `startsWith` highlights Events while the console is open — which is what
      // `/admin/organizers` already does for Organizer 360. Marking it exact would leave
      // Event 360 with no highlighted item, the very defect RD-ADMIN-IA-01 recorded.
      { label: 'Events',     href: ROUTES.ADMIN_EVENTS,          icon: CalendarDays,
        description: "Every published event", keywords: "event 360 console published" },
      { label: 'Approvals',  href: ROUTES.ADMIN_EVENT_APPROVALS, icon: ClipboardCheck,
        description: "Events awaiting review", keywords: "approve review pending queue" },
      { label: 'Moderation', href: ROUTES.ADMIN_MODERATION,      icon: ShieldAlert,
        description: "Events and campaigns", keywords: "moderation takedown report abuse" },
      { label: 'Incidents',  href: ROUTES.ADMIN_INCIDENTS,       icon: AlertTriangle,
        description: "Platform incidents and alerts", keywords: "incident alert outage severity" },
      { label: 'Audit Log',  href: ROUTES.ADMIN_AUDIT,           icon: ScrollText,
        description: "Administrative action trail", keywords: "audit security actions log history" },
    ],
  },
  {
    label: 'Platform',
    items: [
      { label: 'Channel Health',       href: ROUTES.ADMIN_COMMUNICATION_CENTER, icon: Radio,
        description: "Channel health and providers", keywords: "provider health email whatsapp sms push status" },
      { label: 'Comms Usage',          href: ROUTES.ADMIN_COMMUNICATIONS,       icon: Radio,
        description: "Usage, failures, costs and broadcasts", keywords: "email whatsapp broadcast usage cost failure" },
      { label: 'Reminders',            href: ROUTES.ADMIN_REMINDERS,            icon: Bell,
        description: "Scheduled reminder campaigns", keywords: "reminder schedule campaign" },
      { label: 'Domains',              href: ROUTES.ADMIN_DOMAINS,              icon: Globe,
        description: "Custom domains", keywords: "domain dns custom cname" },
    ],
  },
  {
    label: 'System',
    items: [
      { label: 'Configuration', href: ROUTES.ADMIN_BUSINESS_CONFIG,      icon: SlidersHorizontal,
        description: "Runtime platform settings", keywords: "config settings fees licensing media storage pricing compression visibility branding" },
      { label: 'ID Migration',  href: ROUTES.ADMIN_IDENTIFIER_MIGRATION, icon: ArrowRightLeft,
        description: "Identifier migration tooling", keywords: "migration identifier id rename" },
    ],
  },
  {
    label: 'Support',
    items: [
      { label: 'Support Workspace', href: ROUTES.ADMIN_SUPPORT, icon: LifeBuoy,
        description: "Support workspace", keywords: "support ticket help customer" },
      { label: 'Global Search',     href: ROUTES.ADMIN_SEARCH,  icon: Search,
        description: "Search across the platform", keywords: "search find lookup global" },
    ],
  },
]

/** Flat, de-duplicated list of every admin destination (by href) — for active-state
 *  lookups and command-palette style enumeration. Derived from the ONE sidebar IA above. */
export const ADMIN_ALL_NAV: AdminNavItem[] = (() => {
  const seen = new Set<string>()
  return ADMIN_SIDEBAR_NAV.flatMap(g => g.items)
    .filter(item => (seen.has(item.href) ? false : (seen.add(item.href), true)))
})()

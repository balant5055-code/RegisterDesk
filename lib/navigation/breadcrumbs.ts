// RD-ORG-FOUNDATION · Breadcrumb resolution — pure, and driven by the nav SSOT.
//
// ═══ WHAT WAS WRONG BEFORE ═══════════════════════════════════════════════════
// The old trail was built by splitting the pathname and title-casing each segment
// against a hand-maintained label map. Three consequences, all visible in product:
//
//   • Raw ids leaked. A 20-char Firestore id was matched by a length heuristic
//     (`seg.length >= 16`) and labelled from a parent lookup — so an event showed as
//     "Manage Event", never its name, and anything the heuristic missed rendered the
//     raw id to the organizer.
//   • The trail described the URL, not the product. `/dashboard/communications/
//     email-logs` read "Dashboard / Communications / Email Logs" — three levels for
//     what the IA calls one module.
//   • It could contradict the sidebar. Two label sources, two answers.
//
// This resolver derives the trail from `WORKSPACE_NAV` — the same array the sidebar
// renders — so the sidebar, the breadcrumb and the page title cannot disagree about
// where you are. Ids are never rendered: an id resolves to its event name, or the
// crumb is omitted.

import { WORKSPACE_NAV, navItemForLocation, resolveNavHref, type WorkspaceNavItem } from '@/config/workspaceNav'

export interface Crumb {
  label: string
  /** null = not navigable (the current page, or a grouping with no index route). */
  href:  string | null
}

export interface BreadcrumbInput {
  pathname: string
  /** `?tab=` on the event workspace, so the trail names the tab you are on. */
  tab:      string | null
  /** Selected event id, for building event-carrying hrefs. */
  selectedEventId: string | null
  /** Resolved event NAME. Never an id — omitted entirely when unresolved. */
  eventName: string | null
  /** Labels for known leaf routes that sit under a canonical module. */
  leafLabel?: string | null
}

/** Section label that owns a nav item, for the top of the trail. */
function sectionFor(item: WorkspaceNavItem): string | null {
  const section = WORKSPACE_NAV.find(s => s.items.some(i => i.key === item.key))
  if (!section) return null
  // "Overview" is its own section AND its own item — one crumb, not two.
  return section.sectionLabel === item.label ? null : section.sectionLabel
}

/**
 * Builds the trail.
 *
 * Shape, deliberately shallow — the IA is two levels deep, so the trail is too:
 *
 *   Overview                                        (global root)
 *   Events                                          (global module)
 *   Events / Noyyal Marathon                        (event workspace)
 *   Events / Noyyal Marathon / Registrations        (event tab)
 *   Registrations · Noyyal Marathon                 (event-scoped module — see below)
 *
 * An event-scoped module does NOT nest under Events. It is reached from the sidebar,
 * not by drilling through the events list, and a trail that claims otherwise offers a
 * "parent" the organizer never came from. The event is expressed as a sibling context
 * crumb instead, which is also what the page header shows.
 */
export function buildBreadcrumbs(input: BreadcrumbInput): Crumb[] {
  const { pathname, tab, selectedEventId, eventName, leafLabel } = input

  // Root of the workspace. Always present, always navigable except on itself.
  const isRoot = pathname === '/dashboard'
  if (isRoot) return [{ label: 'Overview', href: null }]

  const crumbs: Crumb[] = [{ label: 'Overview', href: '/dashboard' }]

  // ── Create Event: /dashboard/events/new[/…] ────────────────────────────────
  // RD-WIZARD-01 · `new` is a route, not an event id. It used to match the workspace pattern
  // below, so the wizard's trail named whichever event the selector held — an EXISTING event —
  // while the organizer was creating a different one.
  if (pathname === '/dashboard/events/new' || pathname.startsWith('/dashboard/events/new/')) {
    return [...crumbs, { label: 'Events', href: '/dashboard/events' }, { label: 'New event', href: null }]
  }

  // ── The event workspace: /dashboard/events/{id} ────────────────────────────
  const onEventWorkspace = /^\/dashboard\/events\/[^/]+$/.test(pathname)
  if (onEventWorkspace) {
    crumbs.push({ label: 'Events', href: '/dashboard/events' })
    // No name yet (still loading, or an event this caller cannot reach): stop here
    // rather than render an id or a placeholder that looks like a name.
    if (!eventName) return crumbs.map((c, i, a) => (i === a.length - 1 ? { ...c, href: null } : c))

    const tabItem = tab ? navItemForLocation(pathname, tab) : null
    const tabOwnsRow = Boolean(tabItem?.eventTab)

    crumbs.push({
      label: eventName,
      href:  tabOwnsRow && selectedEventId ? `/dashboard/events/${encodeURIComponent(selectedEventId)}` : null,
    })
    if (tabOwnsRow && tabItem) crumbs.push({ label: tabItem.label, href: null })
    return crumbs
  }

  // ── RD-INTEG · the event-wise Wallet and the communication-balance ledger ───
  // Neither has a nav row of its own, so the trail used to stop at a bare "Overview" — and for
  // the two ledger pages it disagreed with the page header ("Communication balance / …"). They
  // belong to the communication balance, which lives on Communications → Billing.
  if (pathname === '/dashboard/wallet') return [...crumbs, { label: 'Event Wallet', href: null }]
  if (pathname === '/dashboard/wallet/transactions' || pathname === '/dashboard/wallet/usage') {
    return [
      ...crumbs,
      { label: 'Communications', href: '/dashboard/communications' },
      // RD-COMMS-P1 — these are the LEGACY communication-balance ledgers (read-only history).
      { label: 'Legacy balance', href: '/dashboard/communications?tab=usage' },
      { label: pathname.endsWith('/usage') ? 'Communication Usage' : 'Transaction History', href: null },
    ]
  }

  // ── Everything else resolves through the nav SSOT ──────────────────────────
  const item = navItemForLocation(pathname, tab)
  if (!item) {
    /**
     * An organizer route with no nav owner — a detail page under a module
     * (/dashboard/crm/{contactId}), or a route the navigation has moved away from.
     *
     * RD-ANALYTICS-12-13: a KNOWN leaf label is now honoured here. Previously this branch
     * returned before reaching the leaf, so `LEAF_LABELS` entries for un-owned paths were
     * unreachable code that looked like working configuration — `/dashboard/analytics`
     * carried 'Event Insights' for two phases and never once rendered it.
     *
     * It matters again now: `/dashboard/reports` keeps working and keeps its bookmarks, but
     * the Analytics row points at `/dashboard/analytics`, so nothing owns it. Without this
     * the trail there would be a bare "Overview" — the page would stop naming itself.
     */
    return leafLabel ? [...crumbs, { label: leafLabel, href: null }] : crumbs
  }

  const section = sectionFor(item)
  if (section) crumbs.push({ label: section, href: null })

  const isLeaf = pathname === item.href || (item.exact && pathname === item.href)
  const href   = resolveNavHref(item, selectedEventId)

  crumbs.push({ label: item.label, href: isLeaf && !leafLabel ? null : href })

  // A named sub-surface inside the module (Ledger, Settlements, Payout Profile …).
  if (leafLabel) crumbs.push({ label: leafLabel, href: null })

  // Event context is shown by the page header and the selector, not repeated as a
  // crumb — repeating it here made the trail read "Registrations / Noyyal Marathon"
  // as though the event were a child of the module.
  return crumbs
}

/**
 * Human label for a sub-route under a canonical module.
 *
 * Only routes that genuinely exist are listed. Anything absent falls back to no leaf
 * crumb at all, which is correct: an unlisted path is a detail view whose own header
 * names it, and inventing a title-cased slug is how "Whatsapp Logs" happens.
 */
export const LEAF_LABELS: Record<string, string> = {
  '/dashboard/finance/ledger':          'Wallet Ledger',
  '/dashboard/finance/settlements':     'Settlements',
  '/dashboard/finance/payout-profile':  'Payment & Payouts',
  '/dashboard/finance/payment-issues':  'Payment Issues',
  // RD-ANALYTICS-12-13 · '/dashboard/finance/reports' no longer has a leaf.
  //
  // It read 'Finance Reports', which was accurate while the page's only owner was the
  // Finance row. Reports is now its own nav row whose href IS this path, so the row's label
  // is already the last crumb and a leaf could only append "Reports / Finance Reports".
  //
  // It is also the label the approved IA deliberately avoids: all eight catalogue kinds are
  // `category: 'financial'` today, so "Financial Reports" describes the whole product rather
  // than distinguishing anything — and it becomes wrong the moment a non-financial kind is
  // registered. The URL still lives under /dashboard/finance; the IA no longer says so.
  '/dashboard/communications/broadcasts':      'Broadcasts',
  '/dashboard/communications/email-templates': 'Templates',
  '/dashboard/communications/email-logs':      'Email Logs',
  '/dashboard/communications/whatsapp-logs':   'WhatsApp Logs',
  '/dashboard/communications/reminders':       'Reminders',
  '/dashboard/communications/notifications':   'Notifications',
  '/dashboard/check-in/operations':     'Operations Center',
  '/dashboard/print-assets/operations': 'Operations Center',
  '/dashboard/media-studio/import':     'Import Media',
  '/dashboard/media-studio/galleries':  'Galleries',
  '/dashboard/media-studio/albums':     'Albums',
  '/dashboard/media-studio/processing': 'Processing Jobs',
  '/dashboard/media-studio/branding':   'Photo Branding',
  '/dashboard/media-studio/storage':    'Storage Usage',
  '/dashboard/media-studio/credits':    'Credits',
  '/dashboard/media-studio/settings':   'Settings',
  '/dashboard/media-studio/maintenance':'Maintenance',
  '/dashboard/settings/branding':       'Branding',
  '/dashboard/settings/billing':        'Billing',
  '/dashboard/settings/integrations':   'Integrations',
  '/dashboard/settings/email-branding': 'Email Branding',
  // RD-FEATURE-REQ-01 · reached from the top bar, not the sidebar, so it names itself here.
  '/dashboard/feature-requests':        'Feature Requests',
  '/dashboard/race-operations/publish-results': 'Publish Results',
  '/dashboard/race-operations/finisher-badges': 'Finisher Badges',
  '/dashboard/race-operations/history':         'History',
  '/dashboard/wallet/transactions':     'Transaction History',
  '/dashboard/wallet/usage':            'Communication Usage',

  // ─── RD-ANALYTICS-12-13 · Analytics and Reports ────────────────────────────
  //
  // `/dashboard/reports` had an entry here reading 'Analytics'. RD-ANALYTICS-04 added it so
  // the path would stop title-casing itself "Reports" and contradicting the sidebar — a
  // correct fix with a side effect nobody could see, because the nav row's own label is ALSO
  // "Analytics": `buildBreadcrumbs` pushes the item label and then the leaf, so the trail
  // rendered "Overview / Analytics / Analytics". The 12-12 audit found it by executing the
  // resolver rather than reading it.
  //
  // The entry is gone rather than renamed. The nav row that owns this path already supplies
  // "Analytics", so a leaf can only ever repeat it — and the row's `href` no longer points
  // here anyway, which is the second half of why this line had become wrong.
  //
  // The five module routes get leaves so each names itself instead of stopping at the
  // module. `/dashboard/analytics` needs none: it IS the nav row's href, so the row's label
  // is the last crumb, which is exactly right for a landing page.
  // The compatibility route. No nav row points here any more, so the branch above renders
  // this leaf directly: "Overview / Analytics", which is what the page is.
  '/dashboard/reports':                  'Analytics',
  '/dashboard/analytics/insights':       'Insights',
  '/dashboard/analytics/overview':       'Overview',
  '/dashboard/analytics/registrations':  'Registrations',
  '/dashboard/analytics/revenue':        'Revenue',
  '/dashboard/analytics/operations':     'Operations',
  '/dashboard/analytics/communications': 'Communications',
  '/dashboard/analytics/participants':   'Participants',
}

export function leafLabelFor(pathname: string): string | null {
  return LEAF_LABELS[pathname] ?? null
}

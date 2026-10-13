// RD-ORG-FOUNDATION — Organizer workspace information architecture.
//
// THE single source of truth for organizer navigation. Read by:
//   • components/dashboard/Sidebar.tsx      (desktop, collapsed and mobile — one array)
//   • lib/commandPalette/registry.ts        (⌘K navigation commands)
//   • lib/navigation/breadcrumbs.ts         (trail labels + parents)
//
// ═══ THE THREE RULES THIS FILE ENFORCES ══════════════════════════════════════
//
// 1. ONE CAPABILITY = ONE LOCATION. Every capability appears exactly once. There is
//    no second entry for a sub-feature: broadcasts, templates and delivery logs are
//    Communications; transactions, settlements and payouts are Finance. Sub-features
//    live INSIDE their canonical module, never beside it in the sidebar.
//
// 2. SCOPE IS DECLARED, NOT INFERRED. Every item states whether it operates on the
//    whole workspace or on the selected event. The shell uses this to decide whether
//    to carry `?event=` — previously each link guessed, which is how a page could end
//    up showing Event A's numbers under Event B's header.
//
// 3. PERMISSION IS ADVISORY UI ONLY. `permission` mirrors the permission the ROUTE
//    already enforces server-side. It exists so an organizer is not shown a door that
//    will slam; it grants nothing. The server re-checks every request through
//    authorizeWorkspace. This is the same contract lib/commandPalette/registry.ts
//    has used since H.4.2 — the sidebar simply adopts it instead of ignoring it.

import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, CalendarDays, Ticket, Contact, ScanLine, IdCard, Flag,
  Tag, ListChecks, Megaphone, Award, Camera, Printer, BarChart3, Wallet, WalletCards,
  UserCog, Settings, LifeBuoy, FileText, Inbox,
} from 'lucide-react'
import { ROUTES } from '@/config/navigation'
import { EVENT_PARAM, type EventSummary } from '@/lib/events/eventContext'
import { isRaceOperationsAvailable } from '@/lib/events/eventCapabilities'
import type { TeamPermission } from '@/lib/team/types'
import type { FeatureFlagsConfig } from '@/lib/config/businessConfig'

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Workspace-level or event-level.
 *
 *   'global' → operates across every event the caller can reach (Overview, Events,
 *              Team, Workspace Settings). Never carries `?event=`.
 *   'event'  → operates on the SELECTED event only. The shell appends `?event=<id>`
 *              and the module reads it. With no event selected these render as
 *              disabled with an explanatory empty state rather than silently
 *              showing workspace-wide data.
 */
export type NavScope = 'global' | 'event'

export interface WorkspaceNavItem {
  key:         string
  label:       string
  icon:        LucideIcon
  href:        string
  scope:       NavScope
  /** Mirrors the server permission for this route. Advisory UI gate only. */
  permission?: TeamPermission
  /** Opens outside the workspace (support links). */
  newTab?:     boolean
  /** Match this href exactly rather than by prefix (index routes). */
  exact?:      boolean
  /**
   * This capability's canonical implementation is a tab of the event workspace
   * (`/dashboard/events/{id}?tab=<key>`) rather than a standalone route.
   *
   * ═══ WHY THIS EXISTS RATHER THAN A NEW PAGE ═══════════════════════════════
   * Passes, Waitlist and Identifier management are implemented ONLY as tabs today
   * (verified: no `/dashboard/passes`, `/dashboard/waitlist`, `/dashboard/identifiers`
   * route exists). There were two wrong ways to honour the canonical IA here:
   * link to routes that do not exist (dead links), or stand up new pages that
   * re-implement the tabs (a second implementation of the same capability — the
   * exact duplication this file forbids).
   *
   * So the sidebar links to where the capability ACTUALLY lives. One capability,
   * one location, reachable from the canonical navigation. When each module gets
   * its own audited phase it graduates to a standalone route and this field is
   * dropped — the sidebar entry, its key and its position never move.
   */
  eventTab?:   string
  /**
   * RD-ANALYTICS-12-13 · hide this row from gate-only roles (checkin_staff / checkin_lead).
   *
   * ═══ WHY A FLAG RATHER THAN A PERMISSION ═════════════════════════════════════
   * The server's exclusion is not expressed as a permission either: `authorizeAnyWorkspace`
   * refuses a caller whose entire grant is `checkin`, via `isCheckinOnlyRole`. There is no
   * permission to mirror here, so a row that needs the same boundary has to say so — and
   * `permission: undefined` currently means "everyone", which is how the Analytics row came
   * to be offered to accounts the API refuses with 403.
   *
   * Advisory UI only, exactly like `permission`. `CheckinStaffGuard` already redirects these
   * operators to their own console, but it is client-side and asynchronous, so the sidebar
   * renders first — its own comment calls it "a routing hint, not a control".
   */
  hideFromGateRoles?: true
  /**
   * RD-RACEOPS-02B · this row exists only for events that hold a capability.
   *
   * `permission` answers "may this PERSON use it"; this answers "does this EVENT have
   * it". Both must pass, and they are evaluated independently. The value names the
   * capability, and the rule itself lives with the rest of the event capability model
   * (`lib/events/eventCapabilities`) — see `navItemAvailableForEvent`. Advisory UI like
   * the two flags above it: every Race Operations route re-applies the same rule.
   */
  eventCapability?: 'raceOperations'
}

export interface WorkspaceNavSection {
  sectionLabel: string
  items:        WorkspaceNavItem[]
}

// ─── The canonical IA ─────────────────────────────────────────────────────────

export const WORKSPACE_NAV: WorkspaceNavSection[] = [
  {
    sectionLabel: 'Overview',
    items: [
      { key: 'overview', label: 'Overview', icon: LayoutDashboard, href: '/dashboard', scope: 'global', exact: true },
    ],
  },
  {
    // WhatsApp Inbox (Phase 1b) — attendee replies to RegisterDesk WhatsApp messages. Its OWN
    // section, deliberately not a Communications surface: Communications is what the
    // organizer SENDS, the Inbox is what attendees send back. Section label equals the item
    // label (as Finance does), so the breadcrumb reads "Overview / Inbox", not a doubled crumb.
    //
    // Global, not event-scoped: one inbox across events, filterable by event inside. Shown to
    // `broadcasts` holders (owner + admin) — the permission lib/whatsapp-inbox/authz.ts enforces.
    //
    // Deliberately NOT hidden by the `whatsappInbox` flag (navHrefEnabled has no Inbox rule):
    // the row is how an owner/admin reaches the page, which explains that the Inbox is not
    // switched on yet. The flag still gates everything that holds data — every Inbox API
    // answers 404 while it is off — so a visible row exposes nothing.
    sectionLabel: 'Inbox',
    items: [
      { key: 'inbox', label: 'Inbox', icon: Inbox, href: '/dashboard/inbox', scope: 'global', permission: 'broadcasts' },
    ],
  },
  {
    sectionLabel: 'Event Management',
    items: [
      { key: 'events', label: 'Events', icon: CalendarDays, href: '/dashboard/events', scope: 'global', permission: 'events' },
    ],
  },
  {
    sectionLabel: 'People',
    items: [
      { key: 'registrations', label: 'Registrations', icon: Ticket,  href: '/dashboard/registrations', scope: 'event', permission: 'registrations' },
      // NOTE — "Participants" is deliberately ABSENT.
      // The requested IA lists it, but the codebase has no participant capability
      // distinct from Registrations: there is no /dashboard/participants route, no
      // participants API, and no participant tab. Adding the row would either dead-link
      // or point at Registrations — making one capability appear in two places, which
      // rule 1 forbids and which is precisely the confusion this IA exists to remove.
      // Whether Participants is a real product concept (attendance identity, distinct
      // from the booking record) is a product decision; see the report.
      // `hideFromGateRoles` and no `permission`: CRM's access model is role-TIERED
      // (lib/crm/access.ts — owner/admin/manager full, finance donations-only, gate roles
      // denied), so it cannot be expressed as a single TeamPermission. Without the flag this
      // row was offered to gate operators whose every CRM request answers 403 — the same
      // "door that slams" Reports and Analytics carry the flag to avoid.
      { key: 'crm',           label: 'CRM',           icon: Contact, href: '/dashboard/crm',           scope: 'global', hideFromGateRoles: true },
    ],
  },
  {
    sectionLabel: 'Operations',
    items: [
      { key: 'checkin',     label: 'Check-in',            icon: ScanLine,   href: '/dashboard/check-in', scope: 'event', permission: 'checkin'      },
      // RD-BIB-01 · was "BIB & Identifiers". This item appears in the sidebar of every
      // event category, so a conference organizer was shown a running-race word for a
      // screen that issues their delegate numbers. The event tab beside it has always
      // said "Identifiers"; these two now agree.
      { key: 'identifiers', label: 'Identifiers',         icon: IdCard,     href: '/dashboard/events',   scope: 'event', permission: 'participants',  eventTab: 'sports'   },
      { key: 'race-ops',    label: 'Race Operations',     icon: Flag,       href: ROUTES.RACE_OPS,       scope: 'event', permission: 'events',        eventCapability: 'raceOperations' },
      { key: 'passes',      label: 'Passes & Categories', icon: Tag,        href: '/dashboard/events',   scope: 'event', permission: 'events',        eventTab: 'passes'   },
      { key: 'waitlist',    label: 'Waitlist',            icon: ListChecks, href: '/dashboard/events',   scope: 'event', permission: 'registrations', eventTab: 'waitlist' },
    ],
  },
  {
    sectionLabel: 'Communications',
    items: [
      // ONE entry. Broadcasts, templates, email logs, WhatsApp logs, reminders and
      // notifications are all surfaces INSIDE this module — they were five separate
      // sidebar rows before, which made "where do I send an email?" ambiguous.
      { key: 'communications', label: 'Communications', icon: Megaphone, href: '/dashboard/communications', scope: 'event', permission: 'broadcasts' },
    ],
  },
  {
    sectionLabel: 'Content & Documents',
    items: [
      { key: 'certificates',  label: 'Certificates',  icon: Award,   href: ROUTES.DASHBOARD_CERTIFICATES, scope: 'event', permission: 'certificates' },
      { key: 'media-studio',  label: 'Media Studio',  icon: Camera,  href: ROUTES.MEDIA_STUDIO,           scope: 'event', permission: 'events'       },
      // RD-PRINT-P0 — `certificates`, the permission every print API requires; with
      // `events` a manager saw the row and was refused by every request behind it.
      { key: 'print-assets',  label: 'Print & Assets', icon: Printer, href: '/dashboard/print-assets',    scope: 'event', permission: 'certificates' },
    ],
  },
  {
    sectionLabel: 'Analytics',
    items: [
      // RD-ANALYTICS-04 corrected the LABEL of this row; RD-ANALYTICS-12-13 corrects its
      // DESTINATION. It pointed at /dashboard/reports — a route named "reports", labelled
      // "Analytics", containing an analytics dashboard. Meanwhile the actual Analytics
      // workspace built across RD-ANALYTICS-06→11 sat under /dashboard/analytics with, as the
      // 12-12 audit measured, ZERO navigable references anywhere in the product: five
      // shipped modules reachable only by typing a URL.
      //
      // ═══ THIS IS NOT THE ROUTE MIGRATION ═══════════════════════════════════════
      // /dashboard/reports is untouched and still resolves; no redirect was added and no
      // bookmark breaks. `lib/analytics/routes.ts` still owns the migration, whose step 1
      // (absorb Event Insights) remains undone. This row simply stops pointing at the older
      // surface and points at the canonical one.
      //
      // ═══ WHY THERE IS NO `permission` HERE (RD-ANALYTICS-12-15) ════════════════
      // RD-ANALYTICS-12-13 gave this row `permission: 'events'` to mirror the server, which
      // is the only job that field has. RD-ANALYTICS-12-15 then reconciled the server: the
      // analytics routes now authorize with `authorizeAnyWorkspace`, because `events` means
      // "may CHANGE an event" and was only ever standing in for "is an organizer, not a gate
      // operator". So the mirror follows, and the row carries no permission again.
      //
      // `hideFromGateRoles` is what now expresses the boundary, and it is the SAME rule the
      // route applies — `isCheckinOnlyRole`, derived from the permission matrix. Without it
      // a row with no permission would be offered to gate operators the API refuses.
      //
      // The visible consequence: `finance` sees Analytics again. That is not navigation
      // granting access — the server grants it, and this row stopped hiding it. Money inside
      // Analytics is still decided by `transactions`, which finance holds and admin and
      // manager do not.
      { key: 'analytics', label: 'Analytics', icon: BarChart3, href: '/dashboard/analytics', scope: 'event', hideFromGateRoles: true },
    ],
  },
  {
    sectionLabel: 'Reports',
    items: [
      // RD-ANALYTICS-12-13 · the report generator becomes findable.
      //
      // Everything built across RD-ANALYTICS-12-02→12-11 — eight catalogue kinds, sync and
      // async export, cancellation, expiring signed downloads, and History — had exactly ONE
      // in-product link: a card on /dashboard/finance. Not in the sidebar, not in ⌘K. A
      // finance user asked for a settlement report had no navigational path to it.
      //
      // ═══ WHY THIS DOES NOT BREAK "ONE CAPABILITY, ONE LOCATION" ════════════════
      // Rule 1 forbids a SECOND entry for a capability that already has one. Reports had
      // none. `lib/analytics/routes.ts` step 4 deferred this row on the grounds that adding
      // it "would put one capability in two places" — that reasoning assumed Reports was
      // already reachable from Finance's own row, which it is not: Finance is a different
      // capability whose page happens to link here.
      //
      // ═══ WHY THE ROUTE DID NOT MOVE ════════════════════════════════════════════
      // /dashboard/finance/reports is the canonical Reports URL and stays. It is where the
      // export-ready notification points (lib/notifications/inbox/notify.ts), and moving it
      // would break that link and every bookmark for no user benefit. A row in the sidebar
      // is not a claim about the URL's shape.
      //
      // ═══ WHY NO `permission` ═══════════════════════════════════════════════════
      // No single permission describes this page. The catalogue's eight kinds span
      // `transactions`, `settlements` and `wallet`, and the page already filters itself to
      // what the caller holds (RD-ANALYTICS-12-10), showing a truthful empty state when that
      // is nothing. Declaring any one of the three would HIDE Reports from a role holding
      // only the other two, while the server continued to serve them.
      //
      // `scope: 'global'` because reports are workspace-wide: the event field on the page is
      // a FILTER, not a scope, and History spans the workspace. An event-scoped row would be
      // rendered disabled until an event was selected, for a page that never needed one.
      { key: 'reports', label: 'Reports', icon: FileText, href: '/dashboard/finance/reports', scope: 'global', hideFromGateRoles: true },
    ],
  },
  {
    sectionLabel: 'Finance',
    items: [
      // Transactions, ledger, settlements, payout profile, payment issues and finance
      // reports are all inside Finance. Wallet was a sibling row; it is a Finance
      // surface and belongs under it.
      { key: 'finance', label: 'Finance', icon: Wallet, href: '/dashboard/finance', scope: 'global', permission: 'transactions' },
      // RD-CLOSE — the Event Wallet (ONE canonical page, /dashboard/wallet) was reachable only
      // through Finance's header button, the Setup Center and a transactions back-link: users
      // had to know it existed. It is per EVENT (what the event bought, used, can refund), so the
      // row is event-scoped — it follows the Event Selector as `?eventId=` (resolveNavHref),
      // which is exactly how the page already reads its event. `wallet` mirrors the routes'
      // authorizeWorkspace(req, 'wallet').
      { key: 'wallet', label: 'Event Wallet', icon: WalletCards, href: '/dashboard/wallet', scope: 'event', permission: 'wallet' },
    ],
  },
  {
    sectionLabel: 'Workspace',
    items: [
      { key: 'team',     label: 'Team',               icon: UserCog,  href: '/dashboard/settings/team', scope: 'global' },
      { key: 'settings', label: 'Workspace Settings', icon: Settings, href: '/dashboard/settings',      scope: 'global', exact: true },
    ],
  },
  {
    sectionLabel: 'Support',
    items: [
      { key: 'support', label: 'Help & Support', icon: LifeBuoy, href: '/contact', scope: 'global', newTab: true },
    ],
  },
]

// ─── Derived lookups ──────────────────────────────────────────────────────────

/** Flat list, in sidebar order. */
export const WORKSPACE_NAV_ITEMS: WorkspaceNavItem[] = WORKSPACE_NAV.flatMap(s => s.items)

/**
 * Internal hrefs of every EVENT-SCOPED destination, longest-first.
 *
 * Longest-first matters: `/dashboard/settings/team` must win over
 * `/dashboard/settings` when matching a pathname by prefix, otherwise the Team page
 * would light up the Settings row.
 */
export const EVENT_SCOPED_PREFIXES: readonly string[] = WORKSPACE_NAV_ITEMS
  .filter(i => i.scope === 'event' && !i.newTab)
  .map(i => i.href)
  .sort((a, b) => b.length - a.length)

/**
 * Resolves the nav item that owns a pathname.
 *
 * Exact items match only themselves; everything else matches by path prefix, longest
 * first. `/dashboard` is exact precisely because every other route starts with it.
 *
 * `eventTab` items are excluded from path matching: they all share the
 * `/dashboard/events` href, so matching on it would make Passes, Waitlist and
 * Identifiers all claim the Events page. The event workspace resolves its own
 * active row from `?tab=` instead — see `navItemForLocation`.
 */
export function navItemForPath(pathname: string): WorkspaceNavItem | null {
  const candidates = WORKSPACE_NAV_ITEMS
    .filter(i => !i.newTab && !i.eventTab)
    .sort((a, b) => b.href.length - a.href.length)

  for (const item of candidates) {
    if (item.exact) { if (pathname === item.href) return item }
    else if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return item
  }
  return null
}

/**
 * Path + `?tab=` → the owning nav item. The complete active-row rule.
 *
 * On the event workspace a `?tab=` value that a sidebar row owns wins, so opening
 * BIB & Identifiers highlights BIB & Identifiers rather than Events. Every other tab
 * of the event workspace (home, setup, reports, …) belongs to Events, which is
 * correct: those are the event's own surfaces, reached from its overview.
 */
export function navItemForLocation(pathname: string, tab: string | null): WorkspaceNavItem | null {
  if (tab && /^\/dashboard\/events\/[^/]+$/.test(pathname)) {
    const owned = WORKSPACE_NAV_ITEMS.find(i => i.eventTab === tab)
    if (owned) return owned
  }
  return navItemForPath(pathname)
}

/**
 * THE one place a nav item becomes a URL.
 *
 * Three cases, and every consumer (sidebar, mobile drawer, command palette,
 * breadcrumbs) goes through this so they can never disagree about where a row points:
 *
 *   • global item          → href unchanged, never carries an event
 *   • event tab item       → /dashboard/events/{id}?tab=<key>
 *   • event-scoped route   → href + ?event=<id>
 *
 * Returns `null` when the item needs an event and none is selected. A null href is
 * the signal to render the row DISABLED rather than to link somewhere plausible —
 * a link that silently drops its event scope is how cross-event data confusion
 * starts, and it is the failure this whole context exists to prevent.
 */
export function resolveNavHref(item: WorkspaceNavItem, selectedEventId: string | null): string | null {
  if (item.scope === 'global') return item.href
  if (!selectedEventId) return null
  if (item.eventTab) {
    return `/dashboard/events/${encodeURIComponent(selectedEventId)}?tab=${encodeURIComponent(item.eventTab)}`
  }
  const sep = item.href.includes('?') ? '&' : '?'
  return `${item.href}${sep}${EVENT_PARAM}=${encodeURIComponent(selectedEventId)}`
}

/**
 * Is this destination switched on for this workspace?
 *
 * RD-EVENT-03 · moved here from inside Sidebar.tsx, unchanged. It was private to that
 * component, so the Event Overview — which offers the SAME destinations — had no way to
 * apply it and linked to modules the workspace has turned off. Copying it would have
 * given the two surfaces two answers to one question; this file already owns the other
 * half of the resolution (`resolveNavHref`), so it owns this half too.
 *
 * Advisory UI only, exactly like `permission` above: the route enforces each feature
 * server-side regardless of what the navigation chooses to show.
 */
/**
 * RD-RACEOPS-02B · does the CURRENT EVENT SELECTION admit this row?
 *
 * PURE, so the sidebar's decision is unit-testable without React. A row with no
 * `eventCapability` is always admitted here (its other gates still apply). For a row that
 * has one:
 *
 *   • an event is selected  → that event's type decides, and nothing else. Switching from
 *                             a marathon to a conference removes the row; switching back
 *                             restores it. No memory of the previous event.
 *   • "All events" / none    → admitted only if at least one listed event would admit it,
 *                             so a workspace that has never run a sports event does not
 *                             carry a permanently disabled Race Operations row. The row
 *                             stays disabled (href null) until an event is chosen, exactly
 *                             like every other event-scoped row.
 */
export function navItemAvailableForEvent(
  item:          Pick<WorkspaceNavItem, 'eventCapability'>,
  selectedEvent: Pick<EventSummary, 'eventType'> | null,
  events:        readonly Pick<EventSummary, 'eventType'>[],
): boolean {
  if (item.eventCapability !== 'raceOperations') return true
  if (selectedEvent) return isRaceOperationsAvailable(selectedEvent.eventType)
  return events.some(e => isRaceOperationsAvailable(e.eventType))
}

export function navHrefEnabled(href: string, flags: FeatureFlagsConfig): boolean {
  if (href.startsWith('/dashboard/crm'))            return flags.crm
  if (href.startsWith('/dashboard/communications')) return flags.broadcast
  if (href.includes('/certificates'))               return flags.certificates
  if (href.includes('/campaigns'))                  return flags.donations
  return true
}

// Convenience re-exports used by headers, empty states and the selector CTA.
export const CREATE_EVENT_HREF = '/dashboard/events/new/visibility'
export const ALL_EVENTS_HREF   = '/dashboard/events'

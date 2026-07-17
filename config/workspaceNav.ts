// Phase H.2.2 — Organizer Workspace Information Architecture (professional SaaS IA).
//
// Single source of truth for the workspace navigation hierarchy. Presentation
// only: every internal href points at an ALREADY-EXISTING route — this file
// introduces no new pages, APIs, or business logic. Routes are never renamed,
// only regrouped.
//
// Deferred (recommended-IA items with no route yet — intentionally NOT linked to
// avoid dead ends): global Sessions (lives in the per-event Conference tab),
// standalone Donations (lives in Campaigns), standalone Settlements (lives in
// Finance), Domains (admin-only today). These are documented for a later phase.
//
// Support items are H.3 navigation hooks: they reuse the existing public-site
// route convention (/docs, /contact — same as the marketing footer) and open in
// a new tab so the workspace is never disrupted. No support pages are created
// here (that is Phase H.3).

import type { LucideIcon } from 'lucide-react'
import {
  Home, CalendarDays, Plus, Ticket, ScanLine, Award, Megaphone, FileText,
  Mail, Users, Heart, DollarSign, Wallet, BarChart3, UserCog, Palette, Plug,
  ReceiptText, Settings, BookOpen, LifeBuoy, Bug, IdCard, CalendarClock, Wrench, Printer, Images,
} from 'lucide-react'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkspaceNavChild {
  label:        string
  href:         string
  matchParams?: Record<string, string | null>
  /** Open in a new tab (used for H.3 support hooks that leave the workspace). */
  newTab?:      boolean
}

export interface WorkspaceNavGroup {
  key:      string
  label:    string
  icon:     LucideIcon
  href:     string
  children: WorkspaceNavChild[]
}

export interface WorkspaceNavSection {
  sectionLabel: string
  groups:       WorkspaceNavGroup[]
}

// ─── Global workspace navigation (the sidebar) ──────────────────────────────

export const WORKSPACE_NAV: WorkspaceNavSection[] = [
  {
    sectionLabel: 'Dashboard',
    groups: [
      {
        key: 'dashboard', label: 'Dashboard', icon: Home, href: '/dashboard',
        children: [{ label: 'Overview', href: '/dashboard' }],
      },
    ],
  },
  {
    sectionLabel: 'Events',
    groups: [
      {
        key: 'events', label: 'Events', icon: CalendarDays, href: '/dashboard/events',
        children: [
          { label: 'All Events',   href: '/dashboard/events' },
          { label: 'Create Event', href: '/dashboard/events/new/visibility' },
        ],
      },
      {
        key: 'certificates', label: 'Certificates', icon: Award, href: '/dashboard/communications/certificates',
        children: [{ label: 'Certificates', href: '/dashboard/communications/certificates' }],
      },
    ],
  },
  {
    sectionLabel: 'People',
    groups: [
      {
        key: 'registrations', label: 'Participants', icon: Ticket, href: '/dashboard/registrations',
        children: [
          { label: 'All Participants', href: '/dashboard/registrations',                 matchParams: { status: null        } },
          { label: 'Confirmed',        href: '/dashboard/registrations?status=confirmed', matchParams: { status: 'confirmed' } },
          { label: 'Pending',          href: '/dashboard/registrations?status=pending',   matchParams: { status: 'pending'   } },
          { label: 'Cancelled',        href: '/dashboard/registrations?status=cancelled', matchParams: { status: 'cancelled' } },
        ],
      },
      {
        key: 'crm', label: 'CRM', icon: Users, href: '/dashboard/crm',
        children: [{ label: 'Contacts', href: '/dashboard/crm' }],
      },
    ],
  },
  {
    sectionLabel: 'Finance',
    groups: [
      {
        key: 'finance', label: 'Finance', icon: DollarSign, href: '/dashboard/finance',
        children: [
          { label: 'Overview',       href: '/dashboard/finance',            matchParams: { filter: null  } },
          { label: 'Transactions',   href: '/dashboard/finance?filter=all', matchParams: { filter: 'all' } },
          { label: 'Wallet Ledger',  href: '/dashboard/finance/ledger' },
          { label: 'Settlements',    href: '/dashboard/finance/settlements' },
          { label: 'Payout Profile', href: '/dashboard/finance/payout-profile' },
        ],
      },
      {
        key: 'wallet', label: 'Wallet', icon: Wallet, href: '/dashboard/wallet',
        children: [
          { label: 'Overview',     href: '/dashboard/wallet' },
          { label: 'Transactions', href: '/dashboard/wallet/transactions' },
          { label: 'Usage',        href: '/dashboard/wallet/usage' },
        ],
      },
      {
        key: 'reports', label: 'Reports', icon: BarChart3, href: '/dashboard/reports',
        children: [
          { label: 'Analytics',       href: '/dashboard/reports' },
          { label: 'Event Insights',  href: '/dashboard/analytics' },
          { label: 'Finance Reports', href: '/dashboard/finance/reports' },
        ],
      },
    ],
  },
  {
    sectionLabel: 'Marketing',
    groups: [
      {
        key: 'communications', label: 'Communications', icon: Mail, href: '/dashboard/communications',
        children: [
          { label: 'Hub',        href: '/dashboard/communications' },
          { label: 'Broadcasts', href: '/dashboard/communications/broadcasts' },
          { label: 'Templates',  href: '/dashboard/communications/email-templates' },
          { label: 'Email Logs', href: '/dashboard/communications/email-logs' },
        ],
      },
      {
        key: 'campaigns', label: 'Campaigns', icon: Heart, href: '/dashboard/campaigns',
        children: [{ label: 'Donation Campaigns', href: '/dashboard/campaigns' }],
      },
    ],
  },
  {
    sectionLabel: 'Operations',
    groups: [
      {
        key: 'checkin', label: 'Check-in', icon: ScanLine, href: '/dashboard/check-in',
        children: [
          { label: 'Check-in Hub', href: '/dashboard/check-in' },
          { label: 'Operations Center', href: '/dashboard/check-in/operations' },
        ],
      },
      {
        key: 'print-assets', label: 'Print Assets', icon: Printer, href: '/dashboard/print-assets',
        children: [
          { label: 'Templates', href: '/dashboard/print-assets' },
          { label: 'Operations Center', href: '/dashboard/print-assets/operations' },
        ],
      },
      {
        key: 'assets', label: 'Asset Library', icon: Images, href: '/dashboard/assets',
        children: [{ label: 'Library', href: '/dashboard/assets' }],
      },
      {
        key: 'integrations', label: 'Integrations', icon: Plug, href: '/dashboard/settings/integrations',
        children: [{ label: 'API Keys & Webhooks', href: '/dashboard/settings/integrations' }],
      },
    ],
  },
  {
    sectionLabel: 'Settings',
    groups: [
      {
        key: 'settings', label: 'Settings', icon: Settings, href: '/dashboard/settings',
        children: [{ label: 'General', href: '/dashboard/settings' }],
      },
      {
        key: 'branding', label: 'Branding', icon: Palette, href: '/dashboard/settings/branding',
        children: [{ label: 'Logo & Theme', href: '/dashboard/settings/branding' }],
      },
      {
        key: 'team', label: 'Team', icon: UserCog, href: '/dashboard/settings/team',
        children: [{ label: 'Members & Roles', href: '/dashboard/settings/team' }],
      },
      {
        key: 'billing', label: 'Billing', icon: ReceiptText, href: '/dashboard/settings/billing',
        children: [{ label: 'Licenses & Invoices', href: '/dashboard/settings/billing' }],
      },
    ],
  },
  {
    sectionLabel: 'Support',
    groups: [
      {
        key: 'support', label: 'Support', icon: LifeBuoy, href: '/contact',
        children: [
          { label: 'Documentation',        href: '/resources', newTab: true },
          { label: 'Contact RegisterDesk', href: '/contact',   newTab: true },
          { label: 'Report Issue',         href: '/contact', newTab: true },
        ],
      },
    ],
  },
]

// Operations-group icon is also exported for headers/menus that group by area.
export { Wrench as OperationsIcon }

// ─── Per-event context navigation (tabs inside an event workspace) ──────────
//
// Reached by selecting an event in the Event Switcher. These map to the tabs
// already implemented in /dashboard/events/[eventId] (ManageEventClient) — they
// are listed here for IA completeness and to drive the switcher's deep links.

export interface EventContextItem {
  key:   string
  label: string
  icon:  LucideIcon
  tab:   string
}

export const EVENT_CONTEXT_NAV: EventContextItem[] = [
  { key: 'overview',     label: 'Overview',              icon: Home,           tab: 'overview'       },
  { key: 'participants', label: 'Participants',          icon: Ticket,         tab: 'registrations'  },
  { key: 'identifiers',  label: 'Identifier Management',  icon: IdCard,         tab: 'sports'         },
  { key: 'checkin',      label: 'Check-in',              icon: ScanLine,       tab: 'attendance'     },
  { key: 'sessions',     label: 'Sessions',              icon: CalendarClock,  tab: 'conference'     },
  { key: 'certificates', label: 'Certificates',          icon: Award,          tab: 'certificates'   },
  { key: 'broadcasts',   label: 'Broadcasts',            icon: Megaphone,      tab: 'communications' },
  { key: 'reports',      label: 'Reports',               icon: BarChart3,      tab: 'reports'        },
  { key: 'settings',     label: 'Settings',              icon: Settings,       tab: 'settings'       },
]

// Support documentation hooks (Phase H.3 will build the destinations). Reuses the
// existing public-site route convention; surfaced so other UI can link to them.
export const SUPPORT_LINKS = {
  documentation: '/resources',   // LS1: /docs did not exist
  contact:       '/contact',
  reportIssue:   '/contact',
} as const

// Convenience: the "create event" CTA target, reused by header + empty states.
export const CREATE_EVENT_HREF = '/dashboard/events/new/visibility'
export { Plus as CreateEventIcon, FileText as TemplateIcon, BookOpen as DocsIcon, Bug as ReportIcon }

import type { LucideIcon } from 'lucide-react'
import { Home, CalendarDays, Users, CreditCard } from 'lucide-react'

// ─── Route constants ─────────────────────────────────────────────────────────
// Single place to manage every path in the app. Import ROUTES wherever you
// need a href — never hardcode strings in components.

export const ROUTES = {
  // Public
  HOME:           '/',
  EVENTS:         '/events',
  FOR_ORGANIZERS: '/for-organizers',
  PRICING:        '/pricing',

  // Auth
  LOGIN:        '/login',
  VERIFY_EMAIL: '/verify-email',
  WELCOME:      '/welcome',

  // Dashboard
  DASHBOARD:                  '/dashboard',
  DASHBOARD_EVENTS:           '/dashboard/events',
  DASHBOARD_REGISTRATIONS:    '/dashboard/registrations',
  DASHBOARD_ATTENDEES:        '/dashboard/registrations',  // legacy alias
  DASHBOARD_CHECK_IN:         '/dashboard/check-in',
  DASHBOARD_REPORTS:          '/dashboard/reports',
  DASHBOARD_COMMUNICATIONS:   '/dashboard/communications',
  DASHBOARD_CERTIFICATES:     '/dashboard/certificates',
  DASHBOARD_SETTINGS:         '/dashboard/settings',
  NEW_EVENT:                  '/dashboard/events/new/visibility',
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

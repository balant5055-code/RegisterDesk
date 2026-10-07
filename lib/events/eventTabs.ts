// Canonical event-workspace tab list (Phase H.4.2).
//
// Single source of truth for the tabs rendered by ManageEventClient AND the tabs
// the Global Command Palette can deep-link to. Previously the list lived inline
// in ManageEventClient; it is lifted here so the palette reuses the exact same
// keys/labels/gates instead of duplicating them. Presentation metadata only — no
// business logic, no data access — so it is safe to import from anywhere.

import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Wrench, ScanLine, Ticket, Tag, Percent, ListChecks,
  CalendarClock, IdCard, Boxes, Trophy, Mic, Handshake, Megaphone, BarChart3,
  Award, Settings,
} from 'lucide-react'

export type EventTabKey =
  | 'setup' | 'attendance' | 'registrations' | 'passes'
  | 'coupons' | 'waitlist' | 'conference' | 'sports' | 'exhibition' | 'nominations'
  | 'speaker-applications' | 'sponsor-applications' | 'communications' | 'reports'
  | 'certificates' | 'settings'

export interface EventTabDef {
  key:             EventTabKey
  label:           string
  icon:            LucideIcon
  /** Conditional visibility gates — mirror the event-type gates already in ManageEventClient. */
  sportsOnly?:     boolean
  exhibitionOnly?: boolean
  awardsOnly?:     boolean
}

/**
 * RD-BIB-UX-04 · the workspace tab, renamed to the event's own vocabulary.
 *
 * ═══ THE PROBLEM ═════════════════════════════════════════════════════════════
 * The shell said "Identifiers" while the workspace behind it said "BIB Number",
 * so the organizer met two names for one thing before they had clicked anything.
 *
 * ═══ WHY IT IS A FUNCTION AND NOT A NEW CONSTANT ═════════════════════════════
 * `EVENT_TABS` is the canonical list, shared with the Global Command Palette,
 * which has no event in hand — it must keep the generic word. So the rename is
 * applied per-event, at the point the bar is built, and the constant stays
 * event-type neutral. No "bib", "marathon" or "runner" enters this file: the noun
 * arrives as data from `identifierConfigs/{slug}`.
 *
 * A null/blank label leaves the list exactly as it was, so an unconfigured event
 * and a failed read both keep the generic tab.
 */
export function applyIdentifierLabel(
  tabs: readonly EventTabDef[], label: string | null | undefined,
): EventTabDef[] {
  const noun = (label ?? '').trim()
  if (!noun) return [...tabs]
  // "BIB Number" → "BIB Numbers"; a label that is already plural is left alone.
  const plural = /s$/i.test(noun) ? noun : `${noun}s`
  return tabs.map(t => (t.key === 'sports' ? { ...t, label: plural } : t))
}

export const EVENT_TABS: EventTabDef[] = [
  { key: 'setup',                 label: 'Setup',          icon: Wrench        },
  { key: 'attendance',            label: 'Attendance',     icon: ScanLine      },
  { key: 'registrations',         label: 'Registrations',  icon: Ticket        },
  { key: 'passes',                label: 'Passes',         icon: Tag           },
  { key: 'coupons',               label: 'Coupons',        icon: Percent       },
  { key: 'waitlist',              label: 'Waitlist',       icon: ListChecks    },
  { key: 'conference',            label: 'Conference',     icon: CalendarClock },
  { key: 'sports',                label: 'Identifiers',    icon: IdCard        },
  { key: 'exhibition',            label: 'Exhibition',     icon: Boxes,        exhibitionOnly: true },
  { key: 'nominations',           label: 'Nominations',    icon: Trophy,       awardsOnly: true     },
  { key: 'speaker-applications',  label: 'Speakers',       icon: Mic           },
  { key: 'sponsor-applications',  label: 'Sponsors',       icon: Handshake     },
  { key: 'communications',        label: 'Communications', icon: Megaphone     },
  { key: 'reports',               label: 'Reports',        icon: BarChart3     },
  { key: 'certificates',          label: 'Certificates',   icon: Award         },
  { key: 'settings',              label: 'Settings',       icon: Settings      },
]

/**
 * The event ROOT — the Event Command Center.
 *
 * RD-EVENT-09 · Deliberately NOT an `EventTabKey` and NOT a member of `EVENT_TABS`: it
 * has no `?tab=` value, because it *is* `/dashboard/events/{eventId}`. It is described
 * here anyway so the tab bar and the Command Palette label the workspace's front door
 * identically instead of each inventing a name for it.
 */
export const EVENT_ROOT_TAB = {
  label: 'Command Center',
  icon:  LayoutDashboard as LucideIcon,
} as const

const TAB_KEYS = new Set<string>(EVENT_TABS.map(t => t.key))

export function isValidEventTab(value: string | null | undefined): value is EventTabKey {
  return typeof value === 'string' && TAB_KEYS.has(value)
}

/**
 * Tabs that no longer exist, and where they went.
 *
 * RD-EVENT-09 · `home` and `overview` were two views of one question — "how is this
 * event doing and what should I do next" — and the root event route was a THIRD. All
 * three consolidated into the Event Command Center, which is now the root route itself.
 *
 * Their URLs are kept working rather than broken: a bookmark, an old link in an email,
 * or a stale browser history entry lands on the command center instead of a dead tab.
 * `null` means "the root event route".
 */
export const RETIRED_EVENT_TABS: Record<string, null> = {
  home:     null,
  overview: null,
}

export function isRetiredEventTab(value: string | null | undefined): boolean {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RETIRED_EVENT_TABS, value)
}

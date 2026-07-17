// Canonical event-workspace tab list (Phase H.4.2).
//
// Single source of truth for the tabs rendered by ManageEventClient AND the tabs
// the Global Command Palette can deep-link to. Previously the list lived inline
// in ManageEventClient; it is lifted here so the palette reuses the exact same
// keys/labels/gates instead of duplicating them. Presentation metadata only — no
// business logic, no data access — so it is safe to import from anywhere.

import type { LucideIcon } from 'lucide-react'
import {
  Home, Wrench, LayoutGrid, ScanLine, Ticket, Tag, Percent, ListChecks,
  CalendarClock, IdCard, Boxes, Trophy, Mic, Handshake, Megaphone, BarChart3,
  Award, Settings,
} from 'lucide-react'

export type EventTabKey =
  | 'home' | 'setup' | 'overview' | 'attendance' | 'registrations' | 'passes'
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

export const EVENT_TABS: EventTabDef[] = [
  { key: 'home',                  label: 'Home',           icon: Home          },
  { key: 'setup',                 label: 'Setup',          icon: Wrench        },
  { key: 'overview',              label: 'Overview',       icon: LayoutGrid    },
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

const TAB_KEYS = new Set<string>(EVENT_TABS.map(t => t.key))

export function isValidEventTab(value: string | null | undefined): value is EventTabKey {
  return typeof value === 'string' && TAB_KEYS.has(value)
}

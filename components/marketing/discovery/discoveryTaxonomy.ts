// ─── /events discovery — the ONE catalog the discovery UI reads ──────────────
//
// Categories are the REAL event-type ids the event builder writes to
// `events/{slug}.eventType` (components/event-builder/steps/Step1View.tsx → EVENT_TYPES).
// They are duplicated here rather than imported because Step1View is a heavy client
// component in the organizer portal; importing it into a public marketing page would drag
// the whole builder into the discovery bundle. The ids are the contract — if a type is ever
// added there, add it here.
//
// THE BUG THIS REPLACES: the previous chips filtered on `marathon`, `startup`, `education`,
// `ngo` and `networking`. None of those are event-type ids, so every one of them queried a
// value no document can hold and rendered an empty result set.

import {
  Users, Store, Trophy, GraduationCap, Coffee, HeartHandshake,
  Music, Award, Gift, Sparkles,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

export interface DiscoveryCategory {
  /** Canonical `eventType` id — the value sent as `?category=`. */
  id:    string
  /** Short label for a chip (the builder's names are too long for a rail). */
  label: string
  icon:  LucideIcon
  /** Tailwind classes for the resting (inactive) icon tile. */
  tint:  string
}

export const DISCOVERY_CATEGORIES: readonly DiscoveryCategory[] = [
  { id: 'conference',  label: 'Conferences',  icon: Users,          tint: 'bg-violet-50 text-violet-600'   },
  { id: 'sports',      label: 'Sports & Runs', icon: Trophy,        tint: 'bg-emerald-50 text-emerald-600' },
  { id: 'workshop',    label: 'Workshops',    icon: GraduationCap,  tint: 'bg-blue-50 text-blue-600'       },
  { id: 'meetup',      label: 'Meetups',      icon: Coffee,         tint: 'bg-rose-50 text-rose-600'       },
  { id: 'exhibition',  label: 'Expos',        icon: Store,          tint: 'bg-orange-50 text-orange-600'   },
  { id: 'cultural',    label: 'Culture',      icon: Music,          tint: 'bg-purple-50 text-purple-600'   },
  { id: 'community',   label: 'Community',    icon: HeartHandshake, tint: 'bg-teal-50 text-teal-600'       },
  { id: 'awards',      label: 'Awards',       icon: Award,          tint: 'bg-amber-50 text-amber-600'     },
  { id: 'fundraising', label: 'Fundraisers',  icon: Gift,           tint: 'bg-pink-50 text-pink-600'       },
  { id: 'custom',      label: 'Other',        icon: Sparkles,       tint: 'bg-slate-100 text-slate-600'    },
] as const

const CATEGORY_BY_ID = new Map(DISCOVERY_CATEGORIES.map(c => [c.id, c]))

/** Display label for a stored `eventType`. Unknown values are title-cased, never dropped. */
export function categoryLabel(eventType: string | null | undefined): string {
  const id = (eventType ?? '').trim().toLowerCase()
  if (!id) return 'Event'
  const hit = CATEGORY_BY_ID.get(id)
  if (hit) return hit.label
  return id.charAt(0).toUpperCase() + id.slice(1)
}

/**
 * eventType id → icon, as a plain record.
 *
 * A RECORD rather than a `categoryIcon(type)` helper on purpose: a function call that returns
 * a component reads as a fresh component identity on every render (and trips
 * react-hooks/static-components). A property lookup does not.
 */
export const CATEGORY_ICON: Readonly<Record<string, LucideIcon>> =
  Object.fromEntries(DISCOVERY_CATEGORIES.map(c => [c.id, c.icon]))

/** The icon used for an unknown or absent event type. */
export const FALLBACK_CATEGORY_ICON: LucideIcon = Sparkles

// ─── Date discovery ──────────────────────────────────────────────────────────
// Every key here is accepted by the server predicate (lib/firebase/firestore/publicEvents.ts
// → matchesDateRange). Nothing in this list is decorative.

export type DateKey =
  | 'today' | 'tomorrow' | 'weekend' | 'week' | 'month' | 'nextmonth' | 'custom'

export const DATE_OPTIONS: readonly { key: DateKey; label: string; hint: string }[] = [
  { key: 'today',     label: 'Today',         hint: 'Happening now'      },
  { key: 'tomorrow',  label: 'Tomorrow',      hint: 'Next day'           },
  { key: 'weekend',   label: 'This weekend',  hint: 'Sat & Sun'          },
  { key: 'week',      label: 'This week',     hint: 'Next 7 days'        },
  { key: 'month',     label: 'This month',    hint: 'Rest of the month'  },
  { key: 'nextmonth', label: 'Next month',    hint: 'The month after'    },
] as const

export const DATE_LABEL: Record<DateKey, string> = {
  today: 'Today', tomorrow: 'Tomorrow', weekend: 'This weekend',
  week: 'This week', month: 'This month', nextmonth: 'Next month', custom: 'Custom dates',
}

// ─── Sorting ─────────────────────────────────────────────────────────────────
// A view control over the loaded page(s); 'recommended' is the server's canonical order.

export type SortKey =
  | 'recommended' | 'soonest' | 'popular' | 'newest' | 'price_asc' | 'price_desc'

export const SORT_OPTIONS: readonly { key: SortKey; label: string }[] = [
  { key: 'recommended', label: 'Recommended'        },
  { key: 'soonest',     label: 'Starting soonest'   },
  { key: 'popular',     label: 'Most popular'       },
  { key: 'newest',      label: 'Newly added'        },
  { key: 'price_asc',   label: 'Price: low to high' },
  { key: 'price_desc',  label: 'Price: high to low' },
] as const

// ─── Venue mode ──────────────────────────────────────────────────────────────

export type VenueKey = 'physical' | 'online' | 'hybrid'

export const VENUE_LABEL: Record<VenueKey, string> = {
  physical: 'In person', online: 'Online', hybrid: 'Hybrid',
}

import type { BreadcrumbItem } from '@/components/ui/Breadcrumbs'

// ─── Event type → human label ─────────────────────────────────────────────────

const EVENT_TYPE_LABELS: Record<string, string> = {
  community:   'Community',
  conference:  'Conferences',
  sports:      'Sports',
  workshop:    'Workshops',
  exhibition:  'Exhibitions',
  cultural:    'Cultural',
  awards:      'Awards',
  fundraising: 'Fundraising',
  meetup:      'Meetups',
}

// ─── Helper ───────────────────────────────────────────────────────────────────

/**
 * Builds the breadcrumb trail for a public event page.
 *
 * Output shape: Home → Events → [Type Category] → [Event Title]
 *
 * Examples:
 *   community  → Home / Events / Community / Teach For Change NGO Summit 2026
 *   conference → Home / Events / Conferences / Bengaluru Tech Summit 2026
 *   sports     → Home / Events / Sports / Mumbai Marathon 2027
 */
export function buildEventBreadcrumbs(
  eventType?: string | null,
  eventTitle?: string | null,
): BreadcrumbItem[] {
  const crumbs: BreadcrumbItem[] = [
    { label: 'Home',   href: '/' },
    { label: 'Events', href: '/events' },
  ]

  const typeLabel = eventType ? EVENT_TYPE_LABELS[eventType] : undefined
  if (typeLabel && eventType) {
    crumbs.push({ label: typeLabel, href: `/events?type=${eventType}` })
  }

  if (eventTitle) {
    crumbs.push({ label: eventTitle })
  }

  return crumbs
}

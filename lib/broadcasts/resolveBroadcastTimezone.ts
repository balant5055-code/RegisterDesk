// RD-BCAST-DATE-01 · which timezone a broadcast's "today" is measured in. Server-only.
//
// Kept apart from registrationDateFilter.ts because this reads Firestore and that module
// is imported by the composer. Mixing them would drag firebase-admin into the browser
// bundle — a mistake this codebase has made and paid for before.

import { adminDb }       from '@/lib/firebase/admin'
import { businessConfig } from '@/lib/config/businessConfigService'
import { isValidTimezone } from '@/lib/registrations/zonedDayRange'

/** Last-resort default. Matches businessConfig's own code default. */
export const FALLBACK_TIMEZONE = 'Asia/Kolkata'

/**
 * Resolves the timezone for an event's registration-date filter.
 *
 * Precedence, most specific first:
 *   1. events/{slug}.eventDetails.schedule.timezone  — validated at publish
 *   2. users/{uid}.eventDefaults.timezone            — organizer default
 *   3. businessConfig.branding.defaultTimezone       — platform default, admin-editable
 *   4. 'Asia/Kolkata'
 *
 * The BROWSER timezone is never consulted. An organizer travelling, or an operator in
 * another country, must not silently change which registrations a campaign reaches.
 *
 * Every candidate is validated before it is accepted, so a corrupted stored value falls
 * through to the next source rather than reaching zonedDayRange (which rejects outright).
 */
export async function resolveBroadcastTimezone(eventSlug: string, organizerUid: string): Promise<string> {
  const pick = (v: unknown): string | null => {
    const s = typeof v === 'string' ? v.trim() : ''
    return s && isValidTimezone(s) ? s : null
  }

  // Two independent doc reads, run together. Both are single-document gets on collections
  // the broadcast flow already touches, and they happen once per request — not per recipient.
  const [eventSnap, userSnap] = await Promise.all([
    adminDb.collection('events').doc(eventSlug).get().catch(() => null),
    adminDb.collection('users').doc(organizerUid).get().catch(() => null),
  ])

  const eventDetails = eventSnap?.data()?.eventDetails as { schedule?: { timezone?: unknown } } | undefined
  const fromEvent    = pick(eventDetails?.schedule?.timezone)
  if (fromEvent) return fromEvent

  const eventDefaults = userSnap?.data()?.eventDefaults as { timezone?: unknown } | undefined
  const fromOrganizer = pick(eventDefaults?.timezone)
  if (fromOrganizer) return fromOrganizer

  const fromConfig = await businessConfig.getValue('branding', 'defaultTimezone').catch(() => null)
  return pick(fromConfig) ?? FALLBACK_TIMEZONE
}

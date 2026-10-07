// Custom Event template — the ONE read of "can an attendee register right now?".
//
// The legacy fallback answered this in two places and they disagreed: its side card said
// "Registration Open" from `registrationOpen` alone while the only pass was still
// `saleState: 'scheduled'`, so the page promised a registration it could not take.
// Every surface of this template (hero status, hero CTA, admission section, sticky CTA)
// reads this resolver instead, so they cannot contradict each other.
//
// Pure: no React, no clock. Sale windows were already resolved server-side into
// `saleState` (app/events/[slug]/page.tsx), so this only combines existing fields.

import type { PassAvailability } from '@/lib/registrations/types'
import type { PassPublic } from '@/components/event-templates/types'
import { buildRegisterHref } from '@/lib/events/registerHref'

export type AdmissionState =
  /** At least one pass can be bought now. `directHref` is set when exactly one can. */
  | { kind: 'open';    purchasable: PassPublic[]; directHref: string | null }
  /** Nothing on sale yet; `opensOn` is the earliest scheduled sales start, if known. */
  | { kind: 'opens';   opensOn: string | null }
  | { kind: 'soldout' }
  /** Registration closed by the organizer, or every sales window has ended. */
  | { kind: 'closed';  message: string }
  /** Registration is open but no pass has been published yet. */
  | { kind: 'soon' }

/** The passes an attendee may see — the exact filter TicketSection applies. */
export function visibleAdmissionPasses(
  passes: PassPublic[], availability: Record<string, PassAvailability>,
): PassPublic[] {
  return passes.filter(p => {
    if (p.status === 'inactive') return false
    if (p.hideWhenSoldOut && availability[p.id]?.status === 'sold_out') return false
    return true
  })
}

export function isPassPurchasable(p: PassPublic, availability: Record<string, PassAvailability>): boolean {
  return p.saleState !== 'scheduled' && p.saleState !== 'ended' && availability[p.id]?.status !== 'sold_out'
}

export function resolveAdmissionState({
  slug, passes, availability, registrationOpen, regClosedMessage,
}: {
  slug: string
  passes: PassPublic[]
  availability: Record<string, PassAvailability>
  registrationOpen: boolean
  regClosedMessage: string
}): AdmissionState {
  const closedMessage = regClosedMessage?.trim() || 'Registration is no longer available.'
  if (!registrationOpen) return { kind: 'closed', message: closedMessage }

  const visible = visibleAdmissionPasses(passes, availability)
  if (visible.length === 0) return { kind: 'soon' }

  const purchasable = visible.filter(p => isPassPurchasable(p, availability))
  if (purchasable.length > 0) {
    return {
      kind: 'open',
      purchasable,
      directHref: purchasable.length === 1 ? buildRegisterHref(slug, purchasable[0].id) : null,
    }
  }

  const scheduled = visible.filter(p => p.saleState === 'scheduled')
  if (scheduled.length > 0) {
    const starts = scheduled.map(p => p.salesStartDate?.trim()).filter((d): d is string => Boolean(d)).sort()
    return { kind: 'opens', opensOn: starts[0] ?? null }
  }

  if (visible.some(p => availability[p.id]?.status === 'sold_out')) return { kind: 'soldout' }
  return { kind: 'closed', message: closedMessage }
}

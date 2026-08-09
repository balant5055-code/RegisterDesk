// Challenge data model — the pure pass → challenge normalisation.
//
// RD-ST4.3 (ST41-I01): lifted verbatim out of ChallengeSelectionSection.tsx so that
// SERVER components can call it. A function exported from a 'use client' module becomes
// a client reference and throws when invoked on the server; keeping the model in this
// directive-free module is what lets SportsTemplate stay a Server Component.
// Pure + presentation-free — no JSX, no hooks, no design decisions.

import type { PassPublic } from '@/components/event-templates/types'
import type { PassAvailability } from '@/lib/registrations/types'
import { passDisplayPrice } from '@/components/event-templates/shared/utils/format'
import { formatBenefits } from '@/components/event-templates/shared/registration/benefitLabels'

export interface Challenge {
  id:          string
  name:        string
  price:       number
  isFree:      boolean
  description?: string           // organiser copy — hidden when empty
  distance?:   string            // enrichment from a linked category — optional
  benefits:    string[]          // DISPLAY labels, resolved from the stored IDs
  remaining:   number | null     // null = unlimited/unknown
  total:       number | null
  status:      'available' | 'low' | 'sold_out'
  closesOn?:   string            // sales end date (YYYY-MM-DD)
  selectable:  boolean
  /** Age eligibility from the pass builder's Race Details. Null = unrestricted. */
  minAge?:     number | null
  maxAge?:     number | null
  /** Booking / policy notes derived from fields the pass builder already writes. */
  notes:       string[]
}

/** Attendee-facing notes derived from the pass's real booking + policy flags. */
function passNotes(p: PassPublic): string[] {
  const a = p.advancedSettings
  return [
    p.maxPurchase && p.maxPurchase > 1 ? `Up to ${p.maxPurchase} entries per booking` : '',
    a?.groupBooking ? 'Group booking available' : '',
    a?.transferable ? 'Entry is transferable'   : '',
    a?.refundable   ? 'Entry is refundable'     : '',
    a?.waitlist     ? 'Waitlist available when sold out' : '',
  ].filter(Boolean) as string[]
}

/** Normalise passes (+ optional category enrichment) into challenges. */
export function passesToChallenges(
  passes: PassPublic[],
  availability: Record<string, PassAvailability>,
  opts?: { categories?: { name: string; distance?: string }[] },
): Challenge[] {
  const byName = new Map(
    (opts?.categories ?? []).map(c => [c.name.trim().toLowerCase(), c] as const),
  )
  return passes
    .filter(p => p.status !== 'inactive' && p.name?.trim())
    .map(p => {
      const av        = availability[p.id]
      const status    = av?.status ?? 'available'
      const remaining = av?.remaining ?? (p.unlimited ? null : (p.quantity ?? null))
      const cat       = byName.get(p.name.trim().toLowerCase())
      // The pass builder's own race category is a better distance source than the
      // name-matched enrichment; fall back to the enrichment when it is absent.
      const raceCat   = p.raceDetails?.customCategory?.trim() || p.raceDetails?.category?.trim()
      return {
        id:          p.id,
        name:        p.name.trim(),
        price:       passDisplayPrice(p),
        isFree:      p.price === 0,
        description: p.description?.trim() || undefined,
        distance:    cat?.distance?.trim() || raceCat || undefined,
        // Stored benefits are IDs (timing_chip, finisher_medal…). Resolve them through
        // the ONE label vocabulary so a database key can never reach the page.
        benefits:    formatBenefits(p.benefits, p.customBenefits),
        remaining,
        total:       av?.passCapacity ?? (p.unlimited ? null : (p.quantity ?? null)),
        status,
        closesOn:    p.salesEndDate?.trim() || undefined,
        selectable:  status !== 'sold_out',
        minAge:      p.raceDetails?.minAge ?? null,
        maxAge:      p.raceDetails?.maxAge ?? null,
        notes:       passNotes(p),
      }
    })
}

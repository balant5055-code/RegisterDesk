import type { PassPublic } from '@/components/event-templates/types'

// RD-ATTENDEE-03B.3 — the ONE place that decides which pass carries the
// "recommended / Most Popular" highlight.
//
// Every ticket surface previously guessed this on its own — by position (idx 0 / the
// middle pass) or a name regex — and NONE of them honoured the organizer's explicit
// `featured` toggle in the pass builder, so the organizer's choice was silently ignored.
// These helpers fix that (and remove the triplicated `detectFeatured`) WITHOUT changing
// any card design: they only decide *which* card gets the existing badge/stripe.

/**
 * The organizer's explicitly-featured pass id, or null. Callers use this to override
 * their own default highlight while preserving it when the organizer set nothing —
 * so events that never used the toggle keep their exact current appearance.
 */
export function organizerFeaturedPassId(passes: PassPublic[]): string | null {
  return passes.find(p => p.featured)?.id ?? null
}

/**
 * Full highlight resolver: the organizer's featured pass, else a value-tier name match
 * (business / vip / professional / premium), else the middle pass. Returns null when
 * there's nothing to highlight (0–1 visible passes). This is the shared replacement for
 * the previously-duplicated `detectFeatured` — behaviour is identical when no pass is
 * flagged, and now honours the flag when one is.
 */
export function resolveFeaturedPassId(passes: PassPublic[]): string | null {
  if (passes.length <= 1) return null
  return organizerFeaturedPassId(passes)
    ?? passes.find(p => /business|vip|professional|premium/i.test(p.name ?? ''))?.id
    ?? passes[Math.floor(passes.length / 2)]?.id
    ?? null
}

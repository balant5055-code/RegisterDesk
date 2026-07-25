// Shared types for the event-templates system.
// PassPublic is the canonical client-side pass shape — this is the authoritative definition.
// Both EventDetailClient and page.tsx import from here.

export interface PassPublic {
  id:                  string
  name:                string
  description:         string
  price:               number
  quantity:            number | null
  unlimited:           boolean
  salesStartDate?:     string
  salesEndDate?:       string
  hideWhenSoldOut?:    boolean
  showRemainingSeats?: boolean
  status?:             'active' | 'inactive'
  visibility?:         string
  benefits?:           string[]
  // Organizer's "featured / recommended" toggle from the pass builder. Surfaced here
  // (03B.3) so ticket cards can highlight the pass the organizer actually chose, instead
  // of guessing by position/name. Flows through page.tsx's pass projection; absent ⇒
  // each surface keeps its prior default highlight.
  featured?:           boolean
  // Early-bird pricing (optional; present on passes that opt in). The effective
  // price is resolved via lib/pricing/earlyBird.ts — do not compare these fields
  // ad hoc. `price` above always remains the regular price.
  earlyBirdEnabled?:   boolean
  earlyBirdPrice?:     number | null
  earlyBirdEndDate?:   string
  // C2: the price to DISPLAY — the early-bird price while active, else regular.
  // Resolved ONCE server-side (app/events/[slug]/page.tsx) via the canonical
  // resolveEffectivePriceRupees so every display surface shows the same amount the
  // checkout charges, with no client Date.now() (avoids SSR/hydration drift at the
  // cutoff). Read it via passDisplayPrice(); absent ⇒ fall back to `price`.
  effectivePrice?:     number
  // M2: the pass's sales-window state ('scheduled' | 'open' | 'ended'), resolved
  // server-side against the event timezone so ticket cards reflect the same window the
  // server gate enforces. Absent ⇒ treat as 'open' (backward-compatible).
  saleState?:          'scheduled' | 'open' | 'ended'
}

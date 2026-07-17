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
  // Early-bird pricing (optional; present on passes that opt in). The effective
  // price is resolved via lib/pricing/earlyBird.ts — do not compare these fields
  // ad hoc. `price` above always remains the regular price.
  earlyBirdEnabled?:   boolean
  earlyBirdPrice?:     number | null
  earlyBirdEndDate?:   string
}

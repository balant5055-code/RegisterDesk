// MC-07 · Purchase pack presentation — PURE. No React, no network.
//
// ═══ WHAT IS INVENTED HERE AND WHAT IS NOT ═══════════════════════════════════
// The backend has no concept of a "pack". It exposes ONE number: `creditUnitPricePaise`.
//
// So the QUANTITIES below are a presentation choice — round figures an organizer can pick
// between — and the "recommended" flag is a merchandising hint. Neither is a price.
//
// Every PRICE is `quantity × unitPricePaise`, taken from the server on each render. Nothing
// here hardcodes, caches or adjusts a rupee figure, and changing the admin's unit price
// changes every card immediately. That is the line: quantities are UI, money is server.
//
// Deliberately NOT volume discounts. A pack that cost less per credit would be a pricing
// rule, and pricing rules belong in businessConfig where an admin can see and change them —
// not in a component nobody would think to audit.

// RD-MC-CUSTOM-01 · the per-purchase ceiling the service already enforces. Imported rather
// than redeclared so the two cannot drift.
import { MAX_CREDITS_PER_PURCHASE } from '@/features/media-credits/utils/purchaseFlow'

export interface CreditPack {
  /** How many credits this card buys. A presentation choice, not a business rule. */
  credits: number
  /** Merchandising hint only. Carries no pricing effect. */
  recommended?: boolean
}

/**
 * The quantities offered on the dashboard.
 *
 * Chosen to span an ordinary event (a few hundred photos) to a large one (several thousand)
 * at the default 1 credit per photo. They are not tiers and they are not discounted.
 */
export const CREDIT_PACKS: readonly CreditPack[] = [
  { credits: 500 },
  { credits: 2_000, recommended: true },
  { credits: 5_000 },
] as const

export interface PricedPack extends CreditPack {
  amountPaise:      number
  /** Always equal to the server's unit price — surfaced so a card can show its basis. */
  unitPricePaise:   number
  /** Photos this pack covers at the current rate, or null when the rate is unusable. */
  photosCovered:    number | null
}

/**
 * Prices a pack from the server's unit price.
 *
 * Truncating multiplication, matching `pricingService.quote`, so the figure shown on a card
 * and the amount the purchase intent actually charges cannot differ by a paisa.
 */
export function pricePack(
  pack: CreditPack, unitPricePaise: number, creditsPerPhoto: number,
): PricedPack {
  const unit    = Math.max(0, Math.trunc(unitPricePaise))
  const credits = Math.max(0, Math.trunc(pack.credits))
  const perPhoto = Math.max(0, Math.trunc(creditsPerPhoto))
  return {
    ...pack,
    amountPaise:    credits * unit,
    unitPricePaise: unit,
    // A zero or missing rate makes "how many photos" unanswerable; say nothing rather than
    // divide by zero and render Infinity.
    photosCovered:  perPhoto > 0 ? Math.floor(credits / perPhoto) : null,
  }
}

/**
 * How many more photos the current balance covers.
 *
 * Returns null when the rate is unusable, for the same reason as above — an organizer seeing
 * "Infinity photos remaining" learns less than one seeing nothing.
 */
export function remainingCapacity(
  availableCredits: number, creditsPerPhoto: number,
): number | null {
  const perPhoto = Math.max(0, Math.trunc(creditsPerPhoto))
  if (perPhoto <= 0) return null
  return Math.floor(Math.max(0, availableCredits) / perPhoto)
}

/**
 * The smallest offered pack that clears a shortfall.
 *
 * Falls back to the largest pack when none is big enough — recommending nothing would leave
 * an organizer who needs 40,000 credits with no next step at all.
 */
export function recommendPack(
  shortfallCredits: number, packs: readonly CreditPack[] = CREDIT_PACKS,
): CreditPack | null {
  if (packs.length === 0) return null
  const ordered = [...packs].sort((a, b) => a.credits - b.credits)
  return ordered.find(p => p.credits >= shortfallCredits) ?? ordered[ordered.length - 1]
}

/** Average credits spent per photo actually uploaded, or null when nothing has been. */
export function averageCostPerUpload(
  lifetimeConsumed: number, photosUploaded: number | null,
): number | null {
  if (photosUploaded === null || photosUploaded <= 0) return null
  return Number((lifetimeConsumed / photosUploaded).toFixed(2))
}

// ─── RD-MC-CUSTOM-01 · Purchase capacity ──────────────────────────────────────

/**
 * The smallest purchase worth processing. A Razorpay order has a fixed cost to create and
 * settle, and a 1-credit order is not worth either.
 */
export const MIN_CUSTOM_PURCHASE = 10

export interface CapacityInput {
  /** The event's resolved photo ceiling. Null means unlimited. */
  maxPhotosPerEvent: number | null
  /** Photos already stored in THIS event. */
  uploadedPhotos:    number
  /** Credits the workspace already holds and has not spent. */
  walletAvailable:   number
}

export interface PurchaseCapacity {
  /** Credits the organizer could still use. Never negative. */
  remaining:   number
  /** Whether a purchase may be made at all. */
  canPurchase: boolean
  min:         number
  /** Largest permitted quantity. Equals `remaining` when purchasing is allowed. */
  max:         number
  /** True when the plan sets no ceiling — `remaining` is then not a real bound. */
  unlimited:   boolean
}

/**
 * How many credits an organizer may buy for one event.
 *
 * ═══ WHY CREDITS ALREADY HELD ARE SUBTRACTED ═════════════════════════════════
 * A credit is only useful if there is a photo slot left to spend it on. An organizer with
 * 13 slots free and 5 credits in the wallet can only ever use 8 more, so selling them 13
 * would be selling 5 they can never spend. The brief's rule — never allow an organizer to
 * buy credits they cannot use — is enforced here and re-enforced server-side.
 *
 * PURE. One definition, used by the purchase card and by `createPurchaseIntent`, so the
 * quantity the UI offers and the quantity the server accepts cannot drift.
 */
export function purchaseCapacity(input: CapacityInput): PurchaseCapacity {
  // A null ceiling is "unlimited" (config allows it explicitly). There is nothing to
  // subtract from, so the only bound left is the per-purchase ceiling the service applies.
  if (input.maxPhotosPerEvent === null) {
    return {
      remaining: MAX_CREDITS_PER_PURCHASE, canPurchase: true,
      min: MIN_CUSTOM_PURCHASE, max: MAX_CREDITS_PER_PURCHASE, unlimited: true,
    }
  }

  const limit    = safe(input.maxPhotosPerEvent)
  const uploaded = safe(input.uploadedPhotos)
  const wallet   = safe(input.walletAvailable)

  const remaining = Math.max(0, limit - uploaded - wallet)
  // Below the minimum there is nothing to sell — the organizer needs a bigger plan, not a
  // smaller order.
  const canPurchase = remaining >= MIN_CUSTOM_PURCHASE

  return {
    remaining,
    canPurchase,
    min: MIN_CUSTOM_PURCHASE,
    max: canPurchase ? remaining : 0,
    unlimited: false,
  }
}

/** Whether a requested quantity is inside the capacity. The SERVER's rule too. */
export function isWithinCapacity(credits: number, cap: PurchaseCapacity): boolean {
  if (!Number.isFinite(credits) || !Number.isInteger(credits)) return false
  if (!cap.canPurchase) return false
  return credits >= cap.min && credits <= cap.max
}

/** A stored number that cannot be trusted contributes 0 rather than NaN to the arithmetic. */
function safe(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0
}

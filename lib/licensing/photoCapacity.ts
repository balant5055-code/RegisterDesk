// RD-PHOTO-01 · EVENT PHOTO CAPACITY — the ONE business rule for photos. PURE: no Firestore, no React.
//
// ═══ THE MODEL (2026-10-06) ══════════════════════════════════════════════════
// Photos are a PAID event service. There is NO free photo allowance: an event's photo capacity is
// exactly the photo units PAID for on that event (License & Services → verified Razorpay payment →
// `eventServiceAllowances/{draftId}.media.purchased`), net of Super Admin-approved refunds and
// carry-forwards. A new event has capacity 0, and Media Studio refuses uploads until it is paid for.
//
//   capacity  = purchased + carriedIn − carriedOut − refunded        (never negative)
//   used      = photos held by the event in Media Studio: stored (`ready`) + reserved in-flight
//               uploads (`pending`) — the gate counts both so concurrent uploads cannot overshoot
//   remaining = capacity − used                                        (never negative)
//   refundable= unused PAID capacity only — used photos are never refundable
//
// The total capacity of one event can never exceed MAX_EVENT_PHOTO_CAPACITY. That is enforced on
// the SERVER at quote, at order creation, and again inside the settlement transaction; the UI's
// slider and presets only mirror it.
//
// This SUPERSEDES the base photo cap (`mediaStudio.maxPhotosPerEvent` / licence tier limits) as
// a photo entitlement and the organizer-level Media Credits wallet as a purchase path. Neither
// grants a single photo any more.

import type { ServiceLedgerLine } from './serviceAllowanceLedger'

/** The largest photo capacity one event may ever hold. */
export const MAX_EVENT_PHOTO_CAPACITY = 3000

/** Media asset statuses that occupy a unit of an event's photo capacity. */
export const PHOTO_CAPACITY_STATUSES = ['pending', 'ready'] as const

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

/** The event's paid photo capacity from its media ledger line (missing fields = 0). */
export function paidPhotoCapacity(line: Partial<ServiceLedgerLine> | undefined | null): number {
  return Math.max(0, n(line?.purchased) + n(line?.carriedIn) - n(line?.carriedOut) - n(line?.refunded))
}

/** How many more photos this event may still buy. */
export function maxAdditionalPhotos(currentCapacity: number): number {
  return Math.max(0, MAX_EVENT_PHOTO_CAPACITY - Math.max(0, Math.trunc(currentCapacity)))
}

export type PhotoPurchaseCheck =
  | { ok: true }
  | { ok: false; code: 'PHOTO_CAPACITY_EXCEEDED'; message: string; maxAdditional: number }

/** Server rule: buying `adding` photos must not take the event's capacity above the maximum. */
export function checkPhotoPurchase(currentCapacity: number, adding: number): PhotoPurchaseCheck {
  const maxAdditional = maxAdditionalPhotos(currentCapacity)
  if (adding <= maxAdditional) return { ok: true }
  return {
    ok: false, code: 'PHOTO_CAPACITY_EXCEEDED', maxAdditional,
    message: maxAdditional === 0
      ? `This event already has the maximum photo capacity of ${MAX_EVENT_PHOTO_CAPACITY.toLocaleString('en-IN')} photos.`
      : `An event can hold at most ${MAX_EVENT_PHOTO_CAPACITY.toLocaleString('en-IN')} photos — you can buy up to ${maxAdditional.toLocaleString('en-IN')} more.`,
  }
}

/** Photo units an order's service lines would add (media lines only). */
export function mediaUnitsIn(items: readonly { service: string; quantity: number }[] | undefined | null): number {
  return (items ?? []).reduce((s, i) => s + (i.service === 'media' ? Math.max(0, n(i.quantity)) : 0), 0)
}

export interface PhotoCapacityFigures {
  capacity:  number
  used:      number
  remaining: number
  max:       number
  maxAdditional: number
}

export function photoCapacityFigures(capacity: number, used: number): PhotoCapacityFigures {
  const c = Math.max(0, Math.trunc(capacity)), u = Math.max(0, Math.trunc(used))
  return { capacity: c, used: u, remaining: Math.max(0, c - u), max: MAX_EVENT_PHOTO_CAPACITY, maxAdditional: maxAdditionalPhotos(c) }
}

export const PHOTO_CAPACITY_REQUIRED_MESSAGE =
  'Purchase photo capacity for this event from License & Services before uploading photos.'

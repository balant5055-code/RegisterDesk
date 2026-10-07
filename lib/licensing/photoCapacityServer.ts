// RD-PHOTO-01 · Server-side photo-capacity checks for the License & Services purchase routes.
//
// Every route that prices media units (quote, draft purchase, published purchase, add-on) asks
// the SAME question with the SAME numbers: would these units take this event's paid photo
// capacity above MAX_EVENT_PHOTO_CAPACITY? The client's slider / presets are never trusted.

import { readServiceAllowances, type ServiceLedgerDoc } from './serviceAllowanceLedger'
import { checkPhotoPurchase, paidPhotoCapacity, type PhotoPurchaseCheck } from './photoCapacity'

export interface EventPhotoLedger {
  /** Net paid capacity (purchased + carriedIn − carriedOut − refunded). */
  capacity:  number
  /** Gross units bought on this event (the draft-mode "total" selection is compared against it). */
  purchased: number
}

/** The event's media ledger figures — only from a ledger this organizer owns (else zero). */
export async function readEventPhotoLedger(organizerUid: string, draftId: string): Promise<EventPhotoLedger> {
  const d: ServiceLedgerDoc | undefined = await readServiceAllowances(draftId)
  const line = d && d.organizerUid === organizerUid ? d.media : undefined
  return { capacity: paidPhotoCapacity(line), purchased: Math.max(0, Math.trunc(line?.purchased ?? 0)) }
}

/**
 * New photo units a selection would buy. Draft mode: the selection is the event's TOTAL bought
 * quantity, so only the shortfall over what is already bought is new (exactly what quoteAddon
 * prices). Published mode: the selection is ADDITIONAL units.
 */
export function newPhotoUnits(mode: 'draft' | 'published', selected: number, ledger: EventPhotoLedger): number {
  const q = Math.max(0, Math.trunc(selected))
  return mode === 'draft' ? Math.max(0, q - ledger.purchased) : q
}

export function checkPhotoSelection(mode: 'draft' | 'published', selected: number, ledger: EventPhotoLedger): PhotoPurchaseCheck {
  return checkPhotoPurchase(ledger.capacity, newPhotoUnits(mode, selected, ledger))
}

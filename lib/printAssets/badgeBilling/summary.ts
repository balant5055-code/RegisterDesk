// RD-PRINT-BILL-P6 · The organizer's ID-badge summary for ONE published event. Server-only, READ-ONLY.
//
// What the Print & Assets balance card and the License & Services badge section show: how badges are
// billed on this event (from the Phase 5 resolver), the event's prepaid units (from the service-
// allowance ledger), and whether units can be bought right now (from the Phase 4 purchase checks).
// Every figure is the server's; nothing is written. Purchase PRICE and payable amount come only from
// the purchase quote route — this summary reports availability, never a payable figure.
//
// Reads (bounded): the live event · the ledger · open rounds only when the ledger shows usage ·
// the sale state only when purchases are released in code. With both release gates closed this is
// the event read plus the ledger read — the billing mode resolves to free before any config read.

import { adminDb } from '@/lib/firebase/admin'
import { ledgerRef, ledgerLine, availableUnits, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { isServicePurchaseReleased } from '@/lib/licensing/serviceAllowances'
import { getGlobalPrintBadgeTerms } from '@/lib/licensing/printBadgeTermsServer'
import { readOwnedLiveEvent, badgeEventProblem } from '@/lib/licensing/printBadgePurchase/quote'
import { readStoredPrintBadgeOverride, type PrintBadgeModeReason } from '@/lib/licensing/printBadgeCommercial'
import { PRINT_BADGE_ROUNDS } from './decisions'
import { resolvePrintJobBillingMode } from './store'
import { readPrintBadgePilot } from '@/lib/licensing/printBadgePilotServer'
import { isPilotOrganizer } from '@/lib/licensing/printBadgePilot'

/** Whether ID-badge units can be bought for this event right now (the purchase quote has the final word). */
export type BadgePurchaseState =
  | 'available'            // released, on sale and priced — get a quote to see the payable amount
  | 'not_released'         // purchases are not released in code (RELEASED_FOR_PURCHASE)
  | 'not_for_sale'         // switched off in Business Configuration
  | 'not_configured'       // no price configured
  | 'unavailable'          // the configuration could not be read
  | 'badges_not_charged'   // this event's badges are free or complimentary — no units needed
  | 'event_not_eligible'   // the event is cancelled, completed or archived
  | 'not_in_pilot'         // RD-PRINT-P8 — this organizer is not a paid ID-badge pilot organizer

export interface PrintBadgeSummary {
  eventSlug: string
  draftId:   string
  billing: {
    mode:           'free' | 'complimentary' | 'paid'
    reason:         PrintBadgeModeReason
    /** GST-inclusive price per badge (paid / complimentary events), null when not applicable. */
    unitPricePaise: number | null
    priceSource:    'global' | 'event' | null
  }
  units: {
    /** Usable now (bought + carried in − used − reserved − carried out − refunded). */
    available: number
    purchased: number
    carriedIn: number
    /** Kept for attendees already billed. */
    used:      number
    /** Held by print jobs that are still running (returned if not needed). */
    reserved:  number
  }
  purchase: {
    state:  BadgePurchaseState
    /** The caller may buy (the workspace owner, and purchases available). The server re-checks. */
    canBuy: boolean
  }
}

export type PrintBadgeSummaryResult =
  | { ok: true; summary: PrintBadgeSummary }
  | { ok: false; status: number; code: 'EVENT_NOT_FOUND' | 'BILLING_UNAVAILABLE'; error: string }

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

export async function getPrintBadgeSummary(args: {
  slug: string; workspaceUid: string; isOwner: boolean
}): Promise<PrintBadgeSummaryResult> {
  // The live event must be this workspace's AND name its draft (the Phase 4/5 binding).
  const live = await readOwnedLiveEvent(args.slug, args.workspaceUid)
  if (!live) return { ok: false, status: 404, code: 'EVENT_NOT_FOUND', error: 'Event not found.' }
  const { draftId } = live

  // Billing mode — the Phase 5 resolver, as a badge (ID_CARD) job on this event would get it.
  const mode = await resolvePrintJobBillingMode('ID_CARD', args.slug, { organizerUid: args.workspaceUid, draftId })
  if (!mode.ok) {
    return { ok: false, status: mode.reason === 'ownership' ? 404 : 503, code: mode.reason === 'ownership' ? 'EVENT_NOT_FOUND' : 'BILLING_UNAVAILABLE',
      error: mode.reason === 'ownership' ? 'Event not found.' : 'ID badge billing is temporarily unavailable. Try again shortly.' }
  }
  const terms = mode.terms
  const billing: PrintBadgeSummary['billing'] = {
    mode:           mode.mode,
    reason:         mode.notInPilot ? 'not_in_pilot' : terms?.reason ?? 'global_disabled',
    unitPricePaise: terms && terms.mode !== 'free' ? terms.unitPricePaise : null,
    priceSource:    terms && terms.mode !== 'free' ? (terms.sources.unitPricePaise === 'event' ? 'event' : 'global') : null,
  }

  // Units — the ledger, owner-checked exactly as reservations are (a foreign ledger counts as none).
  const lSnap = await ledgerRef(draftId).get()
  const ledgerDoc = lSnap.exists ? lSnap.data() as ServiceLedgerDoc : undefined
  const ledger = ledgerDoc && ledgerDoc.organizerUid !== args.workspaceUid ? undefined : ledgerDoc
  const line = ledgerLine(ledger, 'print_badges')
  let reserved = 0
  if (line.consumed > 0) {
    const open = await adminDb.collection(PRINT_BADGE_ROUNDS)
      .where('eventId', '==', draftId).where('status', '==', 'reserved').limit(200).get()
    for (const d of open.docs) {
      if (d.get('organizerUid') !== args.workspaceUid) continue
      reserved += Math.max(0, n(d.get('reserved')) - n(d.get('claimed')))
    }
  }
  const units: PrintBadgeSummary['units'] = {
    available: availableUnits(line),
    purchased: line.purchased,
    carriedIn: line.carriedIn,
    reserved:  Math.min(reserved, line.consumed),
    used:      Math.max(0, line.consumed - Math.min(reserved, line.consumed)),
  }

  // Purchase availability — the Phase 4 checks, in the same order, without pricing anything.
  let state: BadgePurchaseState
  if (!isServicePurchaseReleased('print_badges')) state = 'not_released'
  else if (badgeEventProblem(live.ev, args.workspaceUid, draftId)) state = 'event_not_eligible'
  else {
    // RD-PRINT-P8 — pilot membership, as the purchase quote checks it (a failed read is never membership).
    const pilot = await readPrintBadgePilot()
    // The event override, read exactly as the purchase quote reads it.
    const ov = readStoredPrintBadgeOverride(live.ev.printBadgeCommercial)
    if (!pilot.ok) state = 'unavailable'
    else if (!isPilotOrganizer(pilot, args.workspaceUid)) state = 'not_in_pilot'
    else if (!ov.ok) state = 'unavailable'
    else if (ov.override?.enabled === false || ov.override?.complimentary === true) state = 'badges_not_charged'
    else state = 'available'
  }
  if (state === 'available') {
    const g = await getGlobalPrintBadgeTerms()
    state = !g.ok || g.saleState === 'unavailable' || g.saleState === 'invalid' ? 'unavailable'
      : g.saleState === 'not_released' ? 'not_released'
      : g.saleState === 'disabled' ? 'not_for_sale'
      : g.saleState === 'available' ? 'available' : 'not_configured'
  }

  return {
    ok: true,
    summary: { eventSlug: args.slug, draftId, billing, units, purchase: { state, canBuy: args.isOwner && state === 'available' } },
  }
}

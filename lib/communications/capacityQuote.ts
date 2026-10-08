// RD-COMMS-CAPACITY-UX — "can this WhatsApp broadcast be funded?", answered BEFORE anything is
// created, charged or sent. Server-only, READ-ONLY.
//
// It applies EXACTLY the decision chargeAndStartCampaign (lib/communications/billing) makes in its
// transaction — the same functions, the same order — without writing anything:
//
//   1. the event's WhatsApp capacity (decideReserve / availableUnits) covers EVERY recipient
//      ⇒ funded by event capacity;
//   2. otherwise the LEGACY balance covers the WHOLE cost (legacyBalanceCanFund)
//      ⇒ funded by the legacy balance;
//   3. otherwise ⇒ insufficient. There is no partial send.
//
// It is advisory for the organizer (composer preview, scheduling refusal). The funding
// transaction at start remains the authority, because capacity can change in between.

import { adminDb } from '@/lib/firebase/admin'
import { decideReserve, draftIdForEventSlug, ledgerRef, viewOf, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { getCommunicationConfig } from './resolveCommunicationConfig'
import { legacyBalanceCanFund } from './capacity'

export interface WhatsAppCapacityQuote {
  /** Messages this broadcast needs: one per eligible recipient. */
  required:   number
  /** The event's WhatsApp capacity available right now (the ledger's own figure). */
  available:  number
  /** required − available when the broadcast cannot be funded, else 0. */
  shortfall:  number
  sufficient: boolean
  /** How it would be funded; null when it cannot be. */
  fundedBy:   'event_capacity' | 'legacy_balance' | null
}

export async function quoteWhatsAppBroadcastCapacity(args: {
  organizerUid: string; eventSlug: string; recipientCount: number
}): Promise<WhatsAppCapacityQuote> {
  const required = Number.isFinite(args.recipientCount) && args.recipientCount > 0 ? Math.floor(args.recipientCount) : 0
  const draftId = await draftIdForEventSlug(args.eventSlug)
  const ledger = draftId ? ((await ledgerRef(draftId).get()).data() as ServiceLedgerDoc | undefined) : undefined
  const available = viewOf(ledger).remaining.whatsapp

  if (required > 0 && draftId && decideReserve(ledger, false, 'whatsapp', required).mode === 'allowance') {
    return { required, available, shortfall: 0, sufficient: true, fundedBy: 'event_capacity' }
  }

  const [wallet, comm] = await Promise.all([
    adminDb.doc(`organizerWallets/${args.organizerUid}`).get(),
    getCommunicationConfig(),
  ])
  const balance = wallet.exists ? Number((wallet.data() as { balancePaise?: unknown }).balancePaise ?? 0) : 0
  const cost = Math.max(0, Math.round(comm.whatsapp.pricePaise * required))
  if (required > 0 && legacyBalanceCanFund(balance, cost)) {
    return { required, available, shortfall: 0, sufficient: true, fundedBy: 'legacy_balance' }
  }
  return { required, available, shortfall: Math.max(0, required - available), sufficient: false, fundedBy: null }
}

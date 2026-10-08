// RD-COMMS-P2-A — the FUNDING HOLD of one transactional WhatsApp message (registration
// confirmation, its manual retry, certificate ready). Server-only.
//
// ═══ THE RULE ═════════════════════════════════════════════════════════════════
// A message is funded BEFORE it is sent, in ONE transaction, from exactly one source:
//   1. the event's purchased WhatsApp capacity  (eventServiceAllowances/{draftId}/usage/{unitKey},
//      the existing reservation record), else
//   2. the organizer's LEGACY communication balance, only while it covers the whole legacy price
//      (lib/communications/capacity): debited up front under the message's deterministic ledger
//      id, exactly like a WhatsApp broadcast is charged up front and refunded for what Meta did
//      not accept (lib/communications/billing.ts). Never below zero, whatever allowNegativeBalance
//      says — that setting does not apply to the legacy balance.
// Otherwise nothing is sent. Funding decided outside a transaction (the old balance pre-check)
// let N concurrent sends go out on a balance that paid for one.
//
// ═══ ITS LIFE ═════════════════════════════════════════════════════════════════
//   held      → Meta ACCEPTED it (lib/whatsapp/acceptance.ts): the hold IS the charge. Final.
//   held      → Meta definitively REFUSED it: released by the sender (unit back / money back).
//   held      → no verdict (transport timeout): KEPT. Meta's status webhook proves an acceptance
//               against this same hold, so recovery never reserves again (no race, no free send).
//   held      → never resolved (abandoned before the send, or an unknown outcome with no
//               webhook): released by releaseExpiredWhatsAppHolds after HOLD_RELEASE_AFTER_MS.
// An open hold is indexed in `whatsappHolds/{unitKey}` (written with the hold, deleted when it is
// accepted or released) — that index is what the sweep reads; the hold itself is the usage record
// or the ledger row above. Release is idempotent and refuses an accepted hold.

import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { legacyBalanceCanFund } from '@/lib/communications/capacity'
import {
  ledgerRef as serviceLedgerRef, decideReserve, txnTakeUnits, ALLOWANCE_USAGE_SUBCOLLECTION, type ServiceLedgerDoc,
} from '@/lib/licensing/serviceAllowanceLedger'
import type { OrganizerWallet } from '@/types/events'

export const WHATSAPP_HOLDS = 'whatsappHolds'
/**
 * How long an unresolved hold is kept before it is given back. Meta keeps redelivering a status
 * webhook it could not deliver for days; a hold released earlier would leave a late acceptance with
 * nothing to bill against.
 */
export const HOLD_RELEASE_AFTER_MS = 7 * 24 * 60 * 60_000
const SWEEP_BATCH = 50

export interface WhatsAppFundingKey {
  organizerUid: string
  /** The event's prepaid ledger (owner-checked via draftIdForEventSlug), or null when it has none. */
  draftId:      string | null
  /** The send attempt's unit key — the allowance usage record id AND the hold index id. */
  unitKey:      string
  /** The deterministic walletTransactions id a legacy-funded hold is debited under. */
  holdLedgerId: string
}

export interface WhatsAppFundingRequest extends WhatsAppFundingKey {
  /** The legacy per-message price (Business Configuration). */
  legacyPricePaise: number
  source: string
  ledger: { referenceId: string; description: string; eventSlug: string; metadata: Record<string, unknown> }
}

export type WhatsAppFundingOutcome =
  | { ok: true; mode: 'allowance' | 'legacy'; costPaise: number }
  /** This attempt is already held (a concurrent duplicate, or an earlier attempt with this key): do not send. */
  | { ok: false; reason: 'already_held' }
  /** Not fundable: no capacity (none bought / used up) and no legacy balance that covers it. */
  | { ok: false; reason: 'allowance_exhausted' | 'allowance_required' }

const holdIndexRef = (unitKey: string) => adminDb.collection(WHATSAPP_HOLDS).doc(unitKey)
const usageRef = (draftId: string, unitKey: string) => serviceLedgerRef(draftId).collection(ALLOWANCE_USAGE_SUBCOLLECTION).doc(unitKey)
const walletRef = (uid: string) => adminDb.doc(`organizerWallets/${uid}`)
const ledgerRowRef = (id: string) => adminDb.collection('walletTransactions').doc(id)
export const holdReleaseLedgerId = (holdLedgerId: string) => `${holdLedgerId}_release`

/** The ledger id of a registration confirmation's hold, for the attempt's unit key. */
export function confirmationHoldLedgerId(registrationId: string, unitKey: string): string {
  const base = `wa_reg_${registrationId}`
  return unitKey.startsWith(base) ? `whatsapp_${registrationId}${unitKey.slice(base.length)}` : `whatsapp_${registrationId}__${unitKey}`
}
/** The ledger id of a certificate-ready message's hold. */
export const certificateHoldLedgerId = (certificateId: string) => `cert_whatsapp_${certificateId}`

/** Takes the funding hold for one message attempt — atomically, or not at all. */
export async function reserveWhatsAppFunding(req: WhatsAppFundingRequest): Promise<WhatsAppFundingOutcome> {
  const idxRef = holdIndexRef(req.unitKey)
  const rowRef = ledgerRowRef(req.holdLedgerId)
  return adminDb.runTransaction<WhatsAppFundingOutcome>(async txn => {
    const [idxSnap, rowSnap, walletSnap, lSnap, uSnap] = await Promise.all([
      txn.get(idxRef), txn.get(rowRef), txn.get(walletRef(req.organizerUid)),
      req.draftId ? txn.get(serviceLedgerRef(req.draftId)) : Promise.resolve(null),
      req.draftId ? txn.get(usageRef(req.draftId, req.unitKey)) : Promise.resolve(null),
    ])
    // Any existing record for this attempt (an open hold, a consumed unit, a legacy charge or its
    // release) means this attempt was already funded once: it must not be sent a second time.
    if (idxSnap.exists || rowSnap.exists || uSnap?.exists) return { ok: false, reason: 'already_held' }

    const ledger = lSnap?.exists ? lSnap.data() as ServiceLedgerDoc : undefined
    const outcome = req.draftId ? decideReserve(ledger, false, 'whatsapp', 1) : { mode: 'none' as const }
    const index = { organizerUid: req.organizerUid, draftId: req.draftId, unitKey: req.unitKey, holdLedgerId: req.holdLedgerId, source: req.source, createdAt: FieldValue.serverTimestamp() }

    if (outcome.mode === 'allowance' && req.draftId) {
      txnTakeUnits(txn, req.draftId, 'whatsapp', req.unitKey, 1, req.source)
      txn.set(idxRef, { ...index, mode: 'allowance' })
      return { ok: true, mode: 'allowance', costPaise: 0 }
    }

    const balance = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    if (!legacyBalanceCanFund(balance, req.legacyPricePaise)) {
      return { ok: false, reason: outcome.mode === 'exhausted' ? 'allowance_exhausted' : 'allowance_required' }
    }
    const after = balance - req.legacyPricePaise
    txn.set(walletRef(req.organizerUid), { balancePaise: after, currency: 'INR', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    txn.set(rowRef, {
      organizerUid: req.organizerUid, type: 'whatsapp_charge', amountPaise: req.legacyPricePaise, balancePaise: after,
      status: 'completed', referenceType: 'communication', referenceId: req.ledger.referenceId, description: req.ledger.description,
      metadata: { ...req.ledger.metadata, eventSlug: req.ledger.eventSlug, channel: 'whatsapp', units: 1, unitKey: req.unitKey, hold: true },
      holdState: 'held', createdAt: FieldValue.serverTimestamp(),
    })
    txn.set(idxRef, { ...index, mode: 'legacy', amountPaise: req.legacyPricePaise })
    return { ok: true, mode: 'legacy', costPaise: req.legacyPricePaise }
  })
}

/**
 * Gives back a hold Meta did not accept: the prepaid unit returns to the event, or the legacy
 * money returns to the balance under `<holdLedgerId>_release`. Idempotent; an ACCEPTED hold (the
 * acceptance record marked it) is never given back. Returns true when something was returned.
 */
export async function releaseWhatsAppFunding(key: WhatsAppFundingKey): Promise<boolean> {
  const idxRef = holdIndexRef(key.unitKey)
  const rowRef = ledgerRowRef(key.holdLedgerId)
  const relRef = ledgerRowRef(holdReleaseLedgerId(key.holdLedgerId))
  return adminDb.runTransaction<boolean>(async txn => {
    const [idxSnap, rowSnap, relSnap, walletSnap, uSnap] = await Promise.all([
      txn.get(idxRef), txn.get(rowRef), txn.get(relRef), txn.get(walletRef(key.organizerUid)),
      key.draftId ? txn.get(usageRef(key.draftId, key.unitKey)) : Promise.resolve(null),
    ])
    let released = false
    if (key.draftId && uSnap?.exists) {
      const u = uSnap.data() as { acceptedWamid?: unknown; quantity?: number }
      if (!u.acceptedWamid) {
        const q = Math.max(1, Math.trunc(u.quantity ?? 1))
        txn.delete(usageRef(key.draftId, key.unitKey))
        txn.set(serviceLedgerRef(key.draftId), { whatsapp: { consumed: FieldValue.increment(-q) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        released = true
      }
    }
    const row = rowSnap.exists ? rowSnap.data() as { holdState?: unknown; amountPaise?: number; metadata?: Record<string, unknown> } : null
    if (!released && row?.holdState === 'held' && !relSnap.exists) {
      const amount = Math.max(0, Math.round(row.amountPaise ?? 0))
      const balance = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
      txn.set(walletRef(key.organizerUid), { balancePaise: balance + amount, currency: 'INR', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      txn.set(relRef, {
        organizerUid: key.organizerUid, type: 'refund', amountPaise: amount, balancePaise: balance + amount,
        status: 'completed', referenceType: 'communication', referenceId: key.holdLedgerId,
        description: 'WhatsApp message not accepted by WhatsApp — returned',
        metadata: { ...(row.metadata ?? {}), hold: true, release: true },
        createdAt: FieldValue.serverTimestamp(),
      })
      txn.update(rowRef, { holdState: 'released', releasedAt: FieldValue.serverTimestamp() })
      released = true
    }
    // The index goes with the hold — unless the hold was accepted meanwhile (acceptance deletes it).
    if (idxSnap.exists) txn.delete(idxRef)
    return released
  })
}

export interface HoldSweepOutcome { scanned: number; released: number; errored: number }

/**
 * Backstop for holds that were never resolved: the process died between the hold and the send, or
 * Meta never answered and no status webhook ever proved an acceptance. Older than
 * HOLD_RELEASE_AFTER_MS ⇒ given back (idempotent; an accepted hold is never released).
 */
export async function releaseExpiredWhatsAppHolds(now: number = Date.now()): Promise<HoldSweepOutcome> {
  const out: HoldSweepOutcome = { scanned: 0, released: 0, errored: 0 }
  const due = await adminDb.collection(WHATSAPP_HOLDS)
    .where('createdAt', '<=', Timestamp.fromMillis(now - HOLD_RELEASE_AFTER_MS)).limit(SWEEP_BATCH).get()
  out.scanned = due.size
  for (const d of due.docs) {
    const h = d.data() as { organizerUid?: unknown; draftId?: unknown; unitKey?: unknown; holdLedgerId?: unknown }
    if (typeof h.organizerUid !== 'string' || typeof h.holdLedgerId !== 'string') { await d.ref.delete().catch(() => undefined); continue }
    try {
      const released = await releaseWhatsAppFunding({
        organizerUid: h.organizerUid, draftId: typeof h.draftId === 'string' && h.draftId ? h.draftId : null,
        unitKey: typeof h.unitKey === 'string' && h.unitKey ? h.unitKey : d.id, holdLedgerId: h.holdLedgerId,
      })
      if (released) out.released++
    } catch (err) {
      out.errored++
      console.error('[whatsapp-holds] release failed:', { unitKey: d.id, err: err instanceof Error ? err.message : err })
    }
  }
  return out
}

// Atomic broadcast billing — verify balance, deduct, write the immutable ledger
// entry, and flip the campaign to 'sending', all in ONE transaction.
//
// Invariants:
//   • Guarded on campaign status ∈ {scheduled, draft} → a cron/route replay that
//     finds the campaign already 'sending'/'sent' does NOTHING (no double billing,
//     cron-replay safe, scheduled-sent-once).
//   • The ledger doc id is deterministic (`broadcast_<campaignId>`) so even a
//     forced re-run can never create a second ledger row.
//   • Insufficient balance flips the campaign to 'failed'/insufficient_balance and
//     debits nothing (no partial sends).

import { FieldValue }  from 'firebase-admin/firestore'
import { adminDb }      from '@/lib/firebase/admin'
import type { BroadcastChannel } from './pricing'
import { getCommunicationConfig } from './resolveCommunicationConfig'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import type { OrganizerWallet } from '@/types/events'
import type { WalletTxnType }   from '@/lib/wallet/types'
import { decideReserve, txnReadForReserve, txnTakeUnits, draftIdForEventSlug, txnReadUsage, txnTrimUnits } from '@/lib/licensing/serviceAllowanceLedger'

const LEDGER_TYPE: Record<string, WalletTxnType> = {
  sms:      'broadcast_sms',
  whatsapp: 'broadcast_whatsapp',
}

export type StartResult =
  | { ok: true;  costPaise: number }
  | { ok: false; reason: 'insufficient_balance' }
  // RD-EVENT-COMMERCE-02 — the event's prepaid WhatsApp allowance cannot cover the campaign
  // and its exhaustion policy is 'block'. Nothing is sent and nothing is charged.
  | { ok: false; reason: 'allowance_exhausted' }
  | { ok: false; reason: 'bad_state' }   // already started / missing — skip silently

/**
 * Charges the workspace wallet for a broadcast and transitions the campaign to
 * 'sending'. Returns bad_state (no-op) when the campaign isn't in a startable
 * state — this is what makes cron/route replays safe.
 */
export async function chargeAndStartCampaign(args: {
  campaignId:   string
  organizerUid: string
  channel:      BroadcastChannel
  recipientCount: number
}): Promise<StartResult> {
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(args.campaignId)
  const walletRef   = adminDb.doc(`organizerWallets/${args.organizerUid}`)
  // Deterministic id ⇒ idempotent ledger write.
  const ledgerRef   = adminDb.collection('walletTransactions').doc(`broadcast_${args.campaignId}`)
  // Per-channel price from Business Configuration (single source of truth).
  const comm        = await getCommunicationConfig()
  const unitPaise   = args.channel === 'whatsapp' ? comm.whatsapp.pricePaise
                    : args.channel === 'sms'      ? comm.sms.pricePaise
                    : 0
  const units       = Number.isFinite(args.recipientCount) && args.recipientCount > 0 ? Math.floor(args.recipientCount) : 0
  const cost        = Math.max(0, Math.round(unitPaise * units))
  const paid        = unitPaise > 0 && cost > 0
  const walletCfg   = await getWalletConfig()

  // RD-EVENT-COMMERCE-02 — a WhatsApp broadcast for an event with a PREPAID allowance is
  // funded from that allowance: one unit per recipient, taken at start (the point at which the
  // wallet path charges), in THIS transaction. The ledger key is the event's draft id.
  let allowanceDraftId: string | null = null
  if (args.channel === 'whatsapp' && units > 0) {
    const camp = await campaignRef.get()
    const slug = camp.exists ? (camp.data() as { eventSlug?: unknown }).eventSlug : null
    if (typeof slug === 'string' && slug) allowanceDraftId = await draftIdForEventSlug(slug)
  }
  const unitKey = `bc_${args.campaignId}`

  return adminDb.runTransaction<StartResult>(async txn => {
    const [campSnap, walletSnap] = await Promise.all([txn.get(campaignRef), txn.get(walletRef)])
    const allowanceRead = allowanceDraftId ? await txnReadForReserve(txn, allowanceDraftId, unitKey) : null
    if (!campSnap.exists) return { ok: false, reason: 'bad_state' }

    const campData = campSnap.data() as { status?: string; eventSlug?: unknown; eventId?: unknown }
    const status = campData.status
    // Only a not-yet-started campaign may be billed + started. Anything else
    // (sending/sent/failed/cancelled) is a replay → no-op.
    if (status !== 'scheduled' && status !== 'draft') return { ok: false, reason: 'bad_state' }

    if (allowanceDraftId && allowanceRead) {
      const outcome = decideReserve(allowanceRead.ledger, allowanceRead.usageExists, 'whatsapp', units)
      if (outcome.mode === 'allowance') {
        if (!outcome.already) txnTakeUnits(txn, allowanceDraftId, 'whatsapp', unitKey, units, 'broadcast')
        txn.update(campaignRef, {
          status: 'sending', actualCostPaise: 0, fundedBy: 'prepaid_allowance', allowanceUnits: units,
          // RD-INTEG — what settleBroadcastBilling trues up at the end (charge on Meta accept).
          chargedUnits: units, allowanceDraftId, billingSettlement: 'pending',
          updatedAt: FieldValue.serverTimestamp(),
        })
        return { ok: true, costPaise: 0 }
      }
      if (outcome.mode === 'exhausted' && outcome.policy === 'block') {
        txn.update(campaignRef, {
          status: 'failed', failReason: 'allowance_exhausted', actualCostPaise: 0,
          sentAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
        })
        return { ok: false, reason: 'allowance_exhausted' }
      }
      // 'none', or exhausted with 'wallet_payg' ⇒ the existing wallet path below, unchanged.
    }

    const balance = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0

    if (paid) {
      if (!walletCfg.allowNegativeBalance && balance < cost) {
        txn.update(campaignRef, {
          status:          'failed',
          failReason:      'insufficient_balance',
          actualCostPaise: 0,
          sentAt:          FieldValue.serverTimestamp(),
          updatedAt:       FieldValue.serverTimestamp(),
        })
        return { ok: false, reason: 'insufficient_balance' }
      }
      const newBalance = balance - cost
      txn.set(walletRef, {
        balancePaise: newBalance,
        currency:     'INR',
        updatedAt:    FieldValue.serverTimestamp(),
      }, { merge: true })
      // Immutable ledger entry — atomic with the deduction + status flip.
      txn.set(ledgerRef, {
        organizerUid:  args.organizerUid,
        type:          LEDGER_TYPE[args.channel] ?? 'adjustment',
        amountPaise:   cost,
        balancePaise:  newBalance,
        status:        'completed',
        referenceType: 'communication',
        referenceId:   args.campaignId,
        description:   `${args.channel.toUpperCase()} broadcast — ${units} recipients`,
        // RD-INTEG — eventSlug/eventId so the charge appears on the EVENT Wallet (txnEventRef).
        metadata:      {
          campaignId: args.campaignId, units, channel: args.channel,
          ...(typeof campData.eventSlug === 'string' && campData.eventSlug ? { eventSlug: campData.eventSlug } : {}),
          ...(typeof campData.eventId === 'string' && campData.eventId ? { eventId: campData.eventId } : {}),
        },
        createdAt:     FieldValue.serverTimestamp(),
      })
    }

    txn.update(campaignRef, {
      status:          'sending',
      actualCostPaise: cost,
      ...(paid ? { chargedUnits: units, chargedCostPaise: cost, unitPricePaise: unitPaise, billingSettlement: 'pending' } : {}),
      updatedAt:       FieldValue.serverTimestamp(),
    })
    return { ok: true, costPaise: cost }
  })
}

// ─── RD-INTEG · D3 — settlement: a broadcast is billed for what WhatsApp ACCEPTED ─────────────
//
// Decision (2026-10-05, product owner): "charge on Meta accept", the same rule every single
// WhatsApp message already follows. chargeAndStartCampaign takes payment for EVERY recipient up
// front (so a campaign can never send more than it paid for); when the campaign ends — finished,
// failed, cancelled or never started — this gives back the money or prepaid units for every
// recipient Meta never accepted (invalid phone, rejected, timed out, cancelled, never reached). A
// message Meta accepted stays charged even if a later webhook reports it failed.
//
// Idempotent: guarded by `billingSettledAt` on the campaign, and the credit lands under the
// deterministic ledger id `broadcast_refund_<campaignId>`. Must be called only once the campaign
// can no longer send (terminal, and no worker holds its job) — `acceptedUnits` is then final.

export interface SettleResult {
  settled:        boolean
  already:        boolean
  billedUnits:    number
  refundedUnits:  number
  refundedPaise:  number
  /** The campaign's net charge after settlement (wallet money; 0 for prepaid-funded). */
  netCostPaise:   number
}

const NOT_SETTLED: SettleResult = { settled: false, already: false, billedUnits: 0, refundedUnits: 0, refundedPaise: 0, netCostPaise: 0 }

export async function settleBroadcastBilling(campaignId: string, acceptedUnits: number): Promise<SettleResult> {
  const campaignRef = adminDb.collection('broadcastCampaigns').doc(campaignId)
  const pre = await campaignRef.get()
  if (!pre.exists) return NOT_SETTLED
  const p = pre.data() as { fundedBy?: unknown; allowanceDraftId?: unknown; eventSlug?: unknown }
  // The prepaid ledger key: stamped at charge time; older campaigns resolve it the way the charge did.
  const allowanceDraftId = p.fundedBy === 'prepaid_allowance'
    ? (typeof p.allowanceDraftId === 'string' && p.allowanceDraftId ? p.allowanceDraftId
      : typeof p.eventSlug === 'string' && p.eventSlug ? await draftIdForEventSlug(p.eventSlug) : null)
    : null
  const chargeRef = adminDb.collection('walletTransactions').doc(`broadcast_${campaignId}`)
  const refundRef = adminDb.collection('walletTransactions').doc(`broadcast_refund_${campaignId}`)
  const unitKey   = `bc_${campaignId}`
  const accepted  = Number.isFinite(acceptedUnits) && acceptedUnits > 0 ? Math.floor(acceptedUnits) : 0

  const result = await adminDb.runTransaction<SettleResult>(async txn => {
    const campSnap = await txn.get(campaignRef)
    if (!campSnap.exists) return NOT_SETTLED
    const c = campSnap.data() as {
      organizerUid?: string; status?: string; channel?: string; eventSlug?: unknown; eventId?: unknown
      billingSettledAt?: unknown; actualCostPaise?: number; billedUnits?: number; refundedUnits?: number; refundedPaise?: number
    }
    if (c.billingSettledAt) {
      return { settled: true, already: true, billedUnits: c.billedUnits ?? 0, refundedUnits: c.refundedUnits ?? 0, refundedPaise: c.refundedPaise ?? 0, netCostPaise: c.actualCostPaise ?? 0 }
    }
    // Never charged yet (or about to be) — nothing to settle.
    if (c.status === 'scheduled' || c.status === 'draft') return NOT_SETTLED

    const usageRowRef = adminDb.collection('communicationUsage').doc(`bc_${campaignId}`)
    const [chargeSnap, refundSnap, usageRowSnap] = await Promise.all([txn.get(chargeRef), txn.get(refundRef), txn.get(usageRowRef)])
    const usage = allowanceDraftId ? await txnReadUsage(txn, allowanceDraftId, unitKey) : null
    const walletRef = c.organizerUid ? adminDb.doc(`organizerWallets/${c.organizerUid}`) : null
    const walletSnap = walletRef && chargeSnap.exists && !refundSnap.exists ? await txn.get(walletRef) : null
    // The credit references the event ONLY when the charge did: a charge written before charges
    // carried the slug is invisible to the event Wallet, so a slugged credit would net out money
    // that view never counted (a negative charge).
    const chargeMeta = chargeSnap.exists ? ((chargeSnap.data() as { metadata?: Record<string, unknown> }).metadata ?? {}) : {}
    const eventMeta = {
      ...(typeof chargeMeta.eventSlug === 'string' && chargeMeta.eventSlug ? { eventSlug: chargeMeta.eventSlug } : {}),
      ...(typeof chargeMeta.eventId === 'string' && chargeMeta.eventId ? { eventId: chargeMeta.eventId } : {}),
    }

    let billed = 0, refundedUnits = 0, refundedPaise = 0, net = 0

    // Wallet-funded: credit back the unaccepted share of the one upfront charge.
    if (chargeSnap.exists) {
      const ch = chargeSnap.data() as { amountPaise?: number; metadata?: { units?: number } }
      const charged = Math.max(0, Math.round(ch.amountPaise ?? 0))
      const units   = Math.max(0, Math.floor(ch.metadata?.units ?? 0))
      billed = Math.min(accepted, units)
      // Proportional, so a legacy charge whose stored unit price is unknown still settles exactly.
      const keepPaise = units > 0 ? Math.round((charged * billed) / units) : charged
      refundedPaise = Math.max(0, charged - keepPaise)
      refundedUnits = units - billed
      net = charged - refundedPaise
      if (refundedPaise > 0 && walletRef && walletSnap && !refundSnap.exists) {
        const balance    = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
        const newBalance = balance + refundedPaise
        txn.set(walletRef, { balancePaise: newBalance, currency: 'INR', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        txn.set(refundRef, {
          organizerUid:  c.organizerUid,
          type:          'refund' satisfies WalletTxnType,
          amountPaise:   refundedPaise,
          balancePaise:  newBalance,
          status:        'completed',
          referenceType: 'communication',
          referenceId:   campaignId,
          description:   `${String(c.channel ?? 'whatsapp').toUpperCase()} broadcast — ${refundedUnits} message${refundedUnits === 1 ? '' : 's'} not accepted by WhatsApp, returned`,
          metadata:      { campaignId, units: refundedUnits, channel: c.channel ?? 'whatsapp', ...eventMeta },
          createdAt:     FieldValue.serverTimestamp(),
        })
      }
    } else if (allowanceDraftId && usage && usage.exists) {
      // Prepaid-funded: keep one unit per accepted message, give the rest back to the event.
      billed = Math.min(accepted, usage.quantity)
      refundedUnits = txnTrimUnits(txn, allowanceDraftId, 'whatsapp', unitKey, usage, billed)
    } else {
      billed = 0
    }

    // RD-CLOSE — the campaign's ONE usage record is written HERE, atomically with the money: the
    // accepted (billed) count and the net cost. It used to be a separate best-effort write after
    // completion, which could fail on its own and leave usage disagreeing with the charge.
    if (billed > 0 || usageRowSnap.exists) {
      const cc = c as { eventName?: unknown }
      txn.set(usageRowRef, {
        organizerUid: c.organizerUid ?? '', ...(typeof c.eventSlug === 'string' ? { eventSlug: c.eventSlug, eventId: c.eventSlug } : {}),
        eventName: typeof cc.eventName === 'string' ? cc.eventName : '', channel: c.channel ?? 'whatsapp',
        quantity: billed, costPaise: chargeSnap.exists ? net : 0, campaignId, templateKey: 'broadcast',
        ...(usageRowSnap.exists ? {} : { createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }

    txn.update(campaignRef, {
      billingSettlement: 'settled',
      billingSettledAt:  FieldValue.serverTimestamp(),
      billingCatchUp:    'pending',   // RD-CLOSE — cleared by reconcileBroadcastBilledUnits (sweep retries)
      billedUnits:       billed,
      refundedUnits,
      refundedPaise,
      ...(chargeSnap.exists ? { actualCostPaise: net } : {}),
    })
    return { settled: true, already: false, billedUnits: billed, refundedUnits, refundedPaise, netCostPaise: chargeSnap.exists ? net : 0 }
  })
  // RD-CLOSE — an acceptance that committed between the count above and this commit was counted by
  // neither: charge it back now (idempotent; a no-op when nothing is missing).
  if (result.settled) {
    const { reconcileBroadcastBilledUnits } = await import('@/lib/whatsapp/acceptance')
    await reconcileBroadcastBilledUnits(campaignId).catch(err => console.error('[broadcast] billed-unit reconciliation failed — the sweep retries it:', { campaignId, err: err instanceof Error ? err.message : err }))
  }
  return result
}

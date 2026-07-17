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

const LEDGER_TYPE: Record<string, WalletTxnType> = {
  sms:      'broadcast_sms',
  whatsapp: 'broadcast_whatsapp',
}

export type StartResult =
  | { ok: true;  costPaise: number }
  | { ok: false; reason: 'insufficient_balance' }
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

  return adminDb.runTransaction<StartResult>(async txn => {
    const [campSnap, walletSnap] = await Promise.all([txn.get(campaignRef), txn.get(walletRef)])
    if (!campSnap.exists) return { ok: false, reason: 'bad_state' }

    const status = (campSnap.data() as { status?: string }).status
    // Only a not-yet-started campaign may be billed + started. Anything else
    // (sending/sent/failed/cancelled) is a replay → no-op.
    if (status !== 'scheduled' && status !== 'draft') return { ok: false, reason: 'bad_state' }

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
        description:   `${args.channel.toUpperCase()} broadcast — ${args.recipientCount} recipients`,
        metadata:      { campaignId: args.campaignId, units: args.recipientCount, channel: args.channel },
        createdAt:     FieldValue.serverTimestamp(),
      })
    }

    txn.update(campaignRef, {
      status:          'sending',
      actualCostPaise: cost,
      updatedAt:       FieldValue.serverTimestamp(),
    })
    return { ok: true, costPaise: cost }
  })
}

// Certificate wallet billing (GA-4 S2). Server-only.
//
// Charges the organizer wallet for a generated certificate, using the FROZEN
// Commercial Configuration (getCommunicationConfig().certificates) as the single
// source of truth for price / billing mode / free allowance, and the existing
// wallet ledger + policy (getWalletConfig). It REUSES the exact broadcast /
// attendee-WhatsApp billing pattern — no new billing engine:
//   • Deterministic ledger id `certificate_<certificateId>` ⇒ idempotent: a replay
//     (bulk re-run, retry, regeneration of the same tuple) never double-charges.
//   • Respects wallet policy: when negative balance is disallowed and funds are
//     insufficient, the charge is skipped (never blocks an already-issued
//     certificate) and reported so the caller can surface a wallet warning.
//   • Certificates are charged only when billingMode='wallet', walletBilling is on,
//     and pricePaise > 0 — otherwise they remain free (default-safe).

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import { txnDeductWallet } from '@/lib/firebase/firestore/wallet'
import { getCommunicationConfig } from '@/lib/communications/resolveCommunicationConfig'
import { getWalletConfig } from '@/lib/wallet/resolveWalletConfig'
import { COLLECTIONS } from './constants'
import type { OrganizerWallet } from '@/types/events'

export type CertificateChargeResult =
  | { charged: true;  costPaise: number }
  | { charged: false; reason: 'not_billable' | 'already_charged' | 'insufficient_balance' | 'free_allowance' }

export interface CertificateChargeArgs {
  organizerUid:  string
  certificateId: string
  eventId:       string
  eventName?:    string
}

/**
 * Idempotently charges the wallet for ONE certificate. Never throws for a business
 * outcome (insufficient balance / not billable) — those are returned. Safe to call
 * once per newly-created certificate on the single, bulk, and job paths.
 */
export async function chargeCertificate(args: CertificateChargeArgs): Promise<CertificateChargeResult> {
  const comm = await getCommunicationConfig()
  const cert = comm.certificates
  const cost = cert.pricePaise
  const billable = cert.billingMode === 'wallet' && cert.walletBilling && cost > 0
  if (!billable) return { charged: false, reason: 'not_billable' }

  // Free allowance (soft): the first N certificates per event are not charged.
  // Guarded so the default (0) adds no extra read on the hot path.
  if (cert.freeAllowance > 0) {
    const countSnap = await adminDb.collection(COLLECTIONS.CERTIFICATES)
      .where('eventId', '==', args.eventId)
      .count().get()
    // The just-written certificate is included in the count, so `<=` keeps exactly
    // `freeAllowance` certificates free.
    if (countSnap.data().count <= cert.freeAllowance) return { charged: false, reason: 'free_allowance' }
  }

  const walletRef = adminDb.doc(`organizerWallets/${args.organizerUid}`)
  // Deterministic id ⇒ idempotent ledger write (never double-charges a certificate).
  const ledgerRef = adminDb.collection('walletTransactions').doc(`certificate_${args.certificateId}`)
  const walletCfg = await getWalletConfig()

  return adminDb.runTransaction<CertificateChargeResult>(async txn => {
    const ledgerSnap = await txn.get(ledgerRef)
    if (ledgerSnap.exists) return { charged: false, reason: 'already_charged' }

    const walletSnap = await txn.get(walletRef)
    const balance    = walletSnap.exists ? ((walletSnap.data() as OrganizerWallet).balancePaise ?? 0) : 0
    if (!walletCfg.allowNegativeBalance && balance < cost) {
      return { charged: false, reason: 'insufficient_balance' }
    }

    const newBalance = balance - cost
    txnDeductWallet(txn, args.organizerUid, cost)   // reuse the existing wallet primitive
    txn.set(ledgerRef, {
      organizerUid:  args.organizerUid,
      type:          'certificate_charge',
      amountPaise:   cost,
      balancePaise:  newBalance,
      status:        'completed',
      referenceType: 'communication',
      referenceId:   args.certificateId,
      description:   `Certificate — ${args.eventName ?? args.eventId}`,
      metadata:      { eventId: args.eventId, certificateId: args.certificateId, channel: 'certificate', units: 1 },
      createdAt:     FieldValue.serverTimestamp(),
    })
    return { charged: true, costPaise: cost }
  })
}

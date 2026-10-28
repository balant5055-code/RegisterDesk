// M1.2 — recording a bank transfer that ALREADY completed. Server-only. Nothing here sends, retries or authorizes
// a transfer: RegisterDesk records transfers made outside it.
//
//   • stageConfirmedTransferPaid — the ONE accounting for "a completed transfer is recorded": the request becomes
//     paid; availablePaise covers what it can and the rest is a 'payout_shortfall' clawback; the request's own
//     reservation (if any) is released; other reservations that no longer fit go to payout review. Used by the
//     M1 record_transfer action and by the M1.2 changed-destination exception.
//   • the changed-destination EXCEPTION (policy B): when the organizer's payout destination changed after the
//     request (so the standard binding check refuses), a completed transfer to the ORIGINAL destination may be
//     recorded only with evidence, a reason and maker-checker (initiated by one Super Admin, approved by another
//     who is also not the request's approver), bound to the request, amount, UTR and evidence (a fingerprint).
//   • transfer references (M1.3 — ONE UTR, ONE payout, on EVERY recording path: mark-paid, record_transfer and
//     the exception approval): the canonical UTR is reserved in `payoutTransferReferences/{utr}` with a create-once
//     write IN the transaction that records the payout (a failed transaction reserves nothing), and a UTR already
//     reserved, or already stored on another payout request, is refused before any write. Records written before
//     M1.3 have no reservation: they are found by an equality query on their STORED utrNumber, which matches the
//     canonical, the submitted and the upper-cased submitted spelling only — a legacy UTR stored in any OTHER
//     spelling is not detected. Reference records are financial evidence and are retained on organizer deletion
//     (lib/admin/organizerDeletionManifest.ts ORGANIZER_RETAINED_COLLECTIONS).
//   • maker-checker has NO bypass: with no eligible independent Super Admin the exception stays pending (manual
//     fallback: docs/OPERATIONS_RUNBOOK.md B.12).

import { createHash } from 'node:crypto'
import { FieldValue, type Transaction, type DocumentReference } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { writeClawbackOnShortfall } from '@/lib/clawbacks/clawbackService'
import type { OrganizerRevenueWallet } from '@/lib/fees/types'
import { planPayoutRefit, stagePayoutReviews, type OpenPayoutRequest } from './payoutReview'
import type { SettlementRequestDoc } from './types'

export const TRANSFER_REFERENCES_COLLECTION = 'payoutTransferReferences'

// ─── transfer references ──────────────────────────────────────────────────────────────────────

/** M1.3 — THE canonical form of a transfer reference (lib/settlements/utr.ts: pure, so the console shares it). */
export { canonicalUtr } from './utr'

/**
 * The exception path's stricter format (M1.2, unchanged acceptance: letters and digits once spaces and hyphens are
 * removed, 6–40 characters). What it accepts is already canonical.
 */
export function normalizeUtr(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const v = raw.trim().toUpperCase().replace(/[\s-]/g, '')
  return /^[A-Z0-9]{6,40}$/.test(v) ? v : null
}

// ─── evidence (policy B) ──────────────────────────────────────────────────────────────────────

export const TRANSFER_EVIDENCE_SOURCES = ['bank_statement', 'bank_transfer_confirmation', 'payout_report'] as const
export type TransferEvidenceSource = typeof TRANSFER_EVIDENCE_SOURCES[number]

export interface TransferExceptionEvidence {
  /** the destination the transfer was made to — must be the request's own snapshot (masked; no identifiers) */
  originalDestination: { verifiedVersion: number; label: string | null }
  /** where the completed transfer is evidenced — a document REFERENCE, never account data */
  transfer: { source: TransferEvidenceSource; reference: string; observation: 'transfer_completed' }
}

export type EvidenceCheck = { ok: true; evidence: TransferExceptionEvidence } | { ok: false; code: string; error: string }

/** Validates the submitted evidence against the request's destination snapshot. Fails closed on anything unclear. */
export function validateTransferEvidence(raw: unknown, snapshot: SettlementRequestDoc['payoutDestination']): EvidenceCheck {
  const bad = (code: string, error: string): EvidenceCheck => ({ ok: false, code, error })
  if (!snapshot || typeof snapshot.verifiedVersion !== 'number') {
    return bad('NO_DESTINATION_SNAPSHOT', 'This request has no recorded payout destination, so the original destination cannot be proven. Investigate manually.')
  }
  const e = raw as { originalDestination?: { verifiedVersion?: unknown; label?: unknown }; transfer?: { source?: unknown; reference?: unknown; observation?: unknown } } | null
  const od = e?.originalDestination, tr = e?.transfer
  if (!od || !tr) return bad('EVIDENCE_REQUIRED', 'Evidence of the original destination and of the completed transfer is required.')
  if (od.verifiedVersion !== snapshot.verifiedVersion || (od.label ?? null) !== (snapshot.label ?? null)) {
    return bad('ORIGINAL_DESTINATION_MISMATCH', 'The original destination in the evidence does not match the destination this request was made against.')
  }
  if (typeof tr.source !== 'string' || !(TRANSFER_EVIDENCE_SOURCES as readonly string[]).includes(tr.source)) {
    return bad('EVIDENCE_SOURCE_INVALID', `The transfer evidence source must be one of: ${TRANSFER_EVIDENCE_SOURCES.join(', ')}.`)
  }
  if (tr.observation !== 'transfer_completed') {
    return bad('TRANSFER_OUTCOME_UNCONFIRMED', 'The evidence must confirm the transfer COMPLETED. A pending, failed, returned or unclear transfer cannot be recorded — investigate manually.')
  }
  const ref = typeof tr.reference === 'string' ? tr.reference.trim() : ''
  if (ref.length < 3 || ref.length > 200) return bad('EVIDENCE_REFERENCE_INVALID', 'The evidence reference must be 3–200 characters.')
  if (/\d{9,}/.test(ref)) {
    return bad('EVIDENCE_REFERENCE_SENSITIVE', 'The evidence reference looks like an account number. Record a document reference, never bank account data.')
  }
  return { ok: true, evidence: {
    originalDestination: { verifiedVersion: snapshot.verifiedVersion, label: snapshot.label ?? null },
    transfer: { source: tr.source as TransferEvidenceSource, reference: ref, observation: 'transfer_completed' },
  } }
}

/** The binding an approval must restate: request, amount, UTR and evidence. */
export function transferExceptionFingerprint(input: { settlementId: string; amountPaise: number; utr: string; evidence: TransferExceptionEvidence }): string {
  const e = input.evidence
  const canonical = JSON.stringify([
    input.settlementId, input.amountPaise, input.utr,
    e.originalDestination.verifiedVersion, e.originalDestination.label, e.transfer.source, e.transfer.reference, e.transfer.observation,
  ])
  return createHash('sha256').update(canonical).digest('hex')
}

// ─── the accounting ───────────────────────────────────────────────────────────────────────────

export interface ConfirmedTransferPlan {
  takePaise:      number
  shortfallPaise: number
  newAvailable:   number
  newInTransit:   number
  clawbackId:     string | null
  reviewed:       string[]
}

/**
 * In a transaction (WRITES — after every read): record that `settlement` was transferred. The caller has read
 * the wallet and the organizer's OTHER open requests and checked authorization; it writes the request itself.
 */
export function stageConfirmedTransferPaid(tx: Transaction, input: {
  settlementId: string; settlement: SettlementRequestDoc; walletRef: DocumentReference; wallet: OrganizerRevenueWallet
  otherRequests: OpenPayoutRequest[]
}): ConfirmedTransferPlan {
  const { settlementId: id, settlement, wallet } = input
  const amount       = settlement.amountPaise
  // this request's own reservation (absent when it was under review) is released as it is paid
  const ownHold      = settlement.reserved === true ? amount : 0
  const otherHeld    = Math.max(0, (wallet.inTransitPaise ?? 0) - ownHold)
  const take         = Math.max(0, Math.min(wallet.availablePaise, amount))
  const newAvailable = wallet.availablePaise - take
  const refit        = planPayoutRefit(input.otherRequests, newAvailable)
  const newInTransit = refit.toReview.length > 0 ? refit.keptPaise : Math.min(otherHeld, newAvailable)
  if (refit.toReview.length > 0) {
    stagePayoutReviews(tx, { organizerUid: settlement.organizerUid, availablePaise: newAvailable, trigger: { kind: 'payout_after_transfer', ref: id }, plan: refit })
  }
  const claw = writeClawbackOnShortfall(tx, {
    transactionId: `payout_${id}`, organizerUid: settlement.organizerUid, sourceType: 'settlement', sourceId: id,
    reversalAmountPaise: amount, debitedPaise: take, reason: 'payout_shortfall',
  })
  tx.update(input.walletRef, {
    availablePaise:   newAvailable,
    settledPaise:     wallet.settledPaise + amount,
    inTransitPaise:   newInTransit,
    lastSettlementAt: FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),
  })
  return { takePaise: take, shortfallPaise: amount - take, newAvailable, newInTransit, clawbackId: claw?.clawbackId ?? null, reviewed: refit.toReview.map(r => r.id) }
}

/** In a transaction (READ): is this normalized UTR already used by another payout request or reserved? */
export async function readTransferReferenceConflict(tx: Transaction, utr: string, settlementId: string, rawUtr: string): Promise<string | null> {
  const refSnap = await tx.get(adminDb.collection(TRANSFER_REFERENCES_COLLECTION).doc(utr))
  if (refSnap.exists && refSnap.get('settlementId') !== settlementId) return String(refSnap.get('settlementId') ?? 'unknown')
  // records written before M1.3 carry no reservation: match their stored spelling (canonical, as submitted, upper-cased)
  const values = [...new Set([utr, rawUtr.trim(), rawUtr.trim().toUpperCase()].filter(Boolean))]
  const used = await tx.get(adminDb.collection('settlementRequests').where('utrNumber', 'in', values).limit(5))
  const other = used.docs.find(d => d.id !== settlementId)
  return other ? other.id : null
}

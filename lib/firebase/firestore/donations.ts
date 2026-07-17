// Server-only: Firebase Admin SDK.
// CRUD layer for donations, donationPayments, donationReceipts, donationCounters.
// No business logic here — call donationService.ts for orchestration.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import type {
  DonationDocument,
  DonationPaymentDocument,
  DonationReceiptDocument,
  DonationCounter,
  DonationStatus,
  DonationPaymentStatus,
} from '@/lib/donations/types'

// ─── Collection refs ──────────────────────────────────────────────────────────

const donationsCol = () => adminDb.collection('donations')
const paymentsCol  = () => adminDb.collection('donationPayments')
const receiptsCol  = () => adminDb.collection('donationReceipts')
const countersCol  = () => adminDb.collection('donationCounters')

// ─── ID generators ────────────────────────────────────────────────────────────

export function generateDonationId():        string { return donationsCol().doc().id }
export function generateDonationPaymentId(): string { return paymentsCol().doc().id  }
export function generateDonationReceiptId(): string { return receiptsCol().doc().id  }

// ─── Donations ────────────────────────────────────────────────────────────────

export interface CreateDonationInput {
  id:            string
  campaignSlug:  string
  campaignId:    string
  campaignTitle: string
  organizerUid:  string
  donorName:     string
  donorEmail:    string
  donorPhone:    string | null
  donorUid?:     string
  amountPaise:   number
  amountRupees:  number
  isAnonymous:        boolean
  showAmountPublicly: boolean
  message?:      string
  dedication?:   string
}

export async function createDonation(input: CreateDonationInput): Promise<void> {
  const base: Record<string, unknown> = {
    id:                 input.id,
    campaignSlug:       input.campaignSlug,
    campaignId:         input.campaignId,
    campaignTitle:      input.campaignTitle,
    organizerUid:       input.organizerUid,
    donorName:          input.donorName,
    donorEmail:         input.donorEmail,
    donorPhone:         input.donorPhone,
    amountPaise:        input.amountPaise,
    amountRupees:       input.amountRupees,
    isAnonymous:        input.isAnonymous,
    showAmountPublicly: input.showAmountPublicly,
    status:             'initiated' satisfies DonationStatus,
    paymentStatus:      'pending'   satisfies DonationPaymentStatus,
    createdAt:          FieldValue.serverTimestamp(),
    updatedAt:          FieldValue.serverTimestamp(),
  }

  if (input.donorUid)   base.donorUid   = input.donorUid
  if (input.message)    base.message    = input.message
  if (input.dedication) base.dedication = input.dedication

  await donationsCol().doc(input.id).set(base)
}

export async function getDonation(donationId: string): Promise<DonationDocument | null> {
  const snap = await donationsCol().doc(donationId).get()
  if (!snap.exists) return null
  return snap.data() as DonationDocument
}

/**
 * Returns successful donations for a campaign, newest first.
 * Requires composite index: (campaignSlug ASC, status ASC, paidAt DESC)
 */
export async function getCampaignDonations(
  campaignSlug: string,
  limitCount = 50,
): Promise<DonationDocument[]> {
  const snap = await donationsCol()
    .where('campaignSlug', '==', campaignSlug)
    .where('status',       '==', 'successful')
    .orderBy('paidAt',     'desc')
    .limit(limitCount)
    .get()
  return snap.docs.map(d => d.data() as DonationDocument)
}

export interface UpdateDonationStatusInput {
  status:               DonationStatus
  paymentStatus:        DonationPaymentStatus
  paidAt?:              true              // when true, sets paidAt to server timestamp
  donationPaymentId?:   string
  razorpayOrderId?:     string
  razorpayPaymentId?:   string
  receiptId?:           string
  receiptNumber?:       string
}

export async function updateDonationStatus(
  donationId: string,
  input:      UpdateDonationStatusInput,
): Promise<void> {
  const updates: Record<string, unknown> = {
    status:        input.status,
    paymentStatus: input.paymentStatus,
    updatedAt:     FieldValue.serverTimestamp(),
  }

  if (input.paidAt)             updates.paidAt            = FieldValue.serverTimestamp()
  if (input.donationPaymentId)  updates.donationPaymentId = input.donationPaymentId
  if (input.razorpayOrderId)    updates.razorpayOrderId   = input.razorpayOrderId
  if (input.razorpayPaymentId)  updates.razorpayPaymentId = input.razorpayPaymentId
  if (input.receiptId)          updates.receiptId         = input.receiptId
  if (input.receiptNumber)      updates.receiptNumber     = input.receiptNumber

  await donationsCol().doc(donationId).update(updates)
}

// ─── Donation Payments ────────────────────────────────────────────────────────

export async function createDonationPayment(
  data: Omit<DonationPaymentDocument, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  await paymentsCol().doc(data.id).set({
    ...data,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  })
}

export async function getDonationPayment(
  paymentId: string,
): Promise<DonationPaymentDocument | null> {
  const snap = await paymentsCol().doc(paymentId).get()
  if (!snap.exists) return null
  return snap.data() as DonationPaymentDocument
}

export async function updateDonationPaymentStatus(
  paymentId: string,
  status:    DonationPaymentStatus,
  extras?:   Partial<Pick<
    DonationPaymentDocument,
    | 'razorpayPaymentId' | 'razorpaySignature'
    | 'failureReason'
    | 'refundId' | 'refundStatus' | 'refundAmountPaise'
  >>,
): Promise<void> {
  await paymentsCol().doc(paymentId).update({
    status,
    updatedAt: FieldValue.serverTimestamp(),
    ...(extras ?? {}),
  })
}

// ─── Donation Receipts ────────────────────────────────────────────────────────

export async function createDonationReceipt(
  data: Omit<DonationReceiptDocument, 'issuedAt' | 'pdfUrl' | 'pdfGeneratedAt' | 'donorPan'>,
): Promise<void> {
  await receiptsCol().doc(data.id).set({
    ...data,
    issuedAt: FieldValue.serverTimestamp(),
  })
}

export async function getDonationReceipt(
  receiptId: string,
): Promise<DonationReceiptDocument | null> {
  const snap = await receiptsCol().doc(receiptId).get()
  if (!snap.exists) return null
  return snap.data() as DonationReceiptDocument
}

// ─── Donation Counters ────────────────────────────────────────────────────────

/**
 * Returns the increment payload for donationCounters/{campaignSlug}.
 * Use inside a Firestore transaction or batch via:
 *   txn.set(counterRef, buildDonationCounterIncrement(...), { merge: true })
 *
 * donorCount always increments here. The service layer is responsible for
 * determining whether this is a repeat donor (Phase 2: skip donorCount for
 * known emails). For Phase 1 every successful donation increments both.
 */
export function buildDonationCounterIncrement(
  campaignSlug: string,
  amountPaise:  number,
): Record<string, unknown> {
  return {
    campaignSlug,
    totalRaisedPaise: FieldValue.increment(amountPaise),
    donorCount:       FieldValue.increment(1),
    donationCount:    FieldValue.increment(1),
    lastDonationAt:   FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),
  }
}

export async function getDonationCounter(
  campaignSlug: string,
): Promise<DonationCounter | null> {
  const snap = await countersCol().doc(campaignSlug).get()
  if (!snap.exists) return null
  return snap.data() as DonationCounter
}

/**
 * Ensures a zero-valued counter doc exists for a campaign.
 * Called once during campaign publish — idempotent via set+merge.
 */
export async function ensureDonationCounterExists(campaignSlug: string): Promise<void> {
  await countersCol().doc(campaignSlug).set(
    {
      campaignSlug,
      totalRaisedPaise: 0,
      donorCount:       0,
      donationCount:    0,
      lastDonationAt:   null,
      updatedAt:        FieldValue.serverTimestamp(),
    },
    { merge: true },
  )
}

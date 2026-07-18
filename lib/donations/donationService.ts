// Server-only: business logic for the donation lifecycle.
// Calls the CRUD layer (lib/firebase/firestore/donations.ts) for all reads/writes.
// No Razorpay SDK imports — payment gateway is isolated behind DonationGatewayAdapter.

import { FieldValue } from 'firebase-admin/firestore'
import { adminDb }    from '@/lib/firebase/admin'
import {
  createDonation,
  createDonationPayment,
  createDonationReceipt,
  updateDonationStatus,
  updateDonationPaymentStatus,
  generateDonationId,
  generateDonationPaymentId,
  generateDonationReceiptId,
  buildDonationCounterIncrement,
} from '@/lib/firebase/firestore/donations'
import {
  DonationValidationError,
  type InitiateDonationInput,
  type InitiateDonationResult,
  type CompleteDonationInput,
  type CompleteDonationResult,
  type DonationGatewayAdapter,
  type DonationDocument,
} from '@/lib/donations/types'
import { generateSequentialReceiptNumber } from '@/lib/donations/receiptSequence'
import { recordPlatformTransactionAndCredit } from '@/lib/firebase/firestore/platformTransactions'
import { buildDonationLedgerAndCredit }       from '@/lib/donations/donationLedger'
import { recordDonationFinancialReconciliation } from '@/lib/donations/donationReconciliation'
import { enqueueWebhook }                  from '@/lib/integrations/webhooks'
import { crmRecordDonation }               from '@/lib/crm/service'

// ─── System-level limits ──────────────────────────────────────────────────────

export const DONATION_MIN_RUPEES = 10           // ₹10 floor — absolute minimum
export const DONATION_MAX_RUPEES = 1_000_000    // ₹10,00,000 ceiling — absolute maximum

// ─── Validation helpers ───────────────────────────────────────────────────────

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE  = /^[6-9]\d{9}$/   // Indian mobile: 10 digits, starts 6–9

function validateDonorEmail(email: string): void {
  if (!EMAIL_RE.test(email.trim())) {
    throw new DonationValidationError('INVALID_EMAIL', 'Please enter a valid email address.')
  }
}

function validateDonorPhone(phone: string | null): void {
  if (phone === null) return
  const digits = phone.replace(/\D/g, '')
  if (!PHONE_RE.test(digits)) {
    throw new DonationValidationError(
      'INVALID_PHONE',
      'Please enter a valid 10-digit Indian mobile number.',
    )
  }
}

function validateDonorName(name: string): void {
  if (!name.trim()) {
    throw new DonationValidationError('DONOR_NAME_REQUIRED', 'Donor name is required.')
  }
}

function validateAmount(
  amountRupees:            number,
  campaignMinAmountRupees: number,
  campaignMaxAmountRupees: number | null,
): void {
  if (amountRupees < DONATION_MIN_RUPEES) {
    throw new DonationValidationError(
      'AMOUNT_BELOW_MINIMUM',
      `Minimum donation amount is ₹${DONATION_MIN_RUPEES}.`,
    )
  }

  if (amountRupees > DONATION_MAX_RUPEES) {
    throw new DonationValidationError(
      'AMOUNT_ABOVE_MAXIMUM',
      `Maximum donation amount is ₹${DONATION_MAX_RUPEES.toLocaleString('en-IN')}.`,
    )
  }

  const effectiveMin = Math.max(DONATION_MIN_RUPEES, campaignMinAmountRupees)
  if (amountRupees < effectiveMin) {
    throw new DonationValidationError(
      'AMOUNT_BELOW_CAMPAIGN_MINIMUM',
      `This campaign requires a minimum donation of ₹${effectiveMin}.`,
    )
  }

  if (campaignMaxAmountRupees !== null && amountRupees > campaignMaxAmountRupees) {
    throw new DonationValidationError(
      'AMOUNT_ABOVE_CAMPAIGN_MAXIMUM',
      `This campaign accepts donations up to ₹${campaignMaxAmountRupees.toLocaleString('en-IN')}.`,
    )
  }
}


// ─── Phase 1: initiate donation ───────────────────────────────────────────────
//
// Validates all inputs and creates the donation document in 'initiated' state.
// No gateway call in Phase 1 — Razorpay will plug in via DonationGatewayAdapter.
//
// Returns { donationId, amountPaise, gatewayOrderId: null, requiresPayment: true }
// so the caller can later upgrade to a gateway order without changing the contract.

export async function initiateDonation(
  input: InitiateDonationInput,
): Promise<InitiateDonationResult> {
  // 1. Validate inputs
  validateDonorName(input.donorName)
  validateDonorEmail(input.donorEmail)
  validateDonorPhone(input.donorPhone)
  validateAmount(
    input.amountRupees,
    input.campaignMinAmountRupees,
    input.campaignMaxAmountRupees,
  )

  // 2. Convert to paise — authoritative storage unit
  const amountPaise = Math.round(input.amountRupees * 100)

  // 3. Normalize donor contact
  const donorEmail = input.donorEmail.trim().toLowerCase()
  const donorPhone = input.donorPhone
    ? input.donorPhone.replace(/\D/g, '')
    : null

  // 4. Create donation document in 'initiated' state
  const donationId = generateDonationId()

  await createDonation({
    id:                 donationId,
    campaignSlug:       input.campaignSlug,
    campaignId:         input.campaignId,
    campaignTitle:      input.campaignTitle,
    organizerUid:       input.organizerUid,
    donorName:          input.donorName.trim(),
    donorEmail,
    donorPhone,
    donorUid:           input.donorUid,
    amountPaise,
    amountRupees:       input.amountRupees,
    isAnonymous:        input.isAnonymous,
    showAmountPublicly: input.showAmountPublicly,
    message:            input.message?.trim(),
    dedication:         input.dedication?.trim(),
  })

  return {
    donationId,
    amountPaise,
    amountRupees:    input.amountRupees,
    gatewayOrderId:  null,
    requiresPayment: true,
  }
}

// ─── Phase 1.5: create gateway order (stub) ───────────────────────────────────
//
// Called after initiateDonation() when the payment gateway is available.
// In Phase 1 there is no real gateway — this is the defined seam for Phase 2.
//
// Usage (Phase 2):
//   import { RazorpayDonationGateway } from '@/lib/razorpay/donationGateway'
//   const gateway = new RazorpayDonationGateway()
//   await createDonationGatewayOrder(donationId, campaignSlug, amountPaise, gateway)

export async function createDonationGatewayOrder(
  donationId:   string,
  campaignSlug: string,
  amountPaise:  number,
  gateway:      DonationGatewayAdapter,
): Promise<string> {
  const order = await gateway.createOrder({
    amountPaise,
    donationId,
    campaignSlug,
    currency: 'INR',
    notes:    { donationId, campaignSlug },
  })

  const paymentId = generateDonationPaymentId()

  await Promise.all([
    // Mark donation as 'pending' with gateway order reference
    updateDonationStatus(donationId, {
      status:             'pending',
      paymentStatus:      'pending',
      razorpayOrderId:    order.gatewayOrderId,
      donationPaymentId:  paymentId,
    }),
    // Create the payment tracking document
    createDonationPayment({
      id:              paymentId,
      donationId,
      campaignSlug,
      organizerUid:   '',   // populated from donation doc by caller if needed
      amountPaise,
      currency:       'INR',
      gateway:        'razorpay',
      razorpayOrderId: order.gatewayOrderId,
      status:         'pending',
    }),
  ])

  return order.gatewayOrderId
}

// ─── Phase 2: complete donation ───────────────────────────────────────────────
//
// Called by the payment verification webhook / callback after the gateway
// confirms a successful payment.
//
// Atomically:
//   1. Verifies the gateway signature
//   2. Marks donation as 'successful'
//   3. Increments donationCounters/{campaignSlug} inside a Firestore transaction
//   4. Creates donationPayments record with 'paid' status
//   5. Creates donationReceipts record
//
// Returns { donationId, receiptId, receiptNumber }

/**
 * Thrown when the presented (order, payment, signature) does not belong to the
 * donation being completed. A valid signature for ANOTHER donation's order must
 * never complete this donation — see completeDonation's order-binding check.
 */
export class DonationOrderMismatchError extends Error {
  constructor() {
    super('Payment order does not match this donation.')
    this.name = 'DonationOrderMismatchError'
  }
}

export async function completeDonation(
  input:   CompleteDonationInput,
  gateway: DonationGatewayAdapter,
  extras: {
    campaignSlug:  string
    campaignTitle: string
    organizerUid:  string
    donorName:     string
    donorEmail:    string
    amountPaise:   number
    amountRupees:  number
    isAnonymous:   boolean
    is80G:         boolean
  },
): Promise<CompleteDonationResult> {
  // 1. Verify gateway signature before touching any Firestore state
  const signatureValid = gateway.verifySignature({
    orderId:   input.razorpayOrderId,
    paymentId: input.razorpayPaymentId,
    signature: input.razorpaySignature,
  })

  if (!signatureValid) {
    await updateDonationStatus(input.donationId, {
      status:        'failed',
      paymentStatus: 'failed',
    })
    throw new Error('Payment signature verification failed.')
  }

  const donationRef = adminDb.collection('donations').doc(input.donationId)

  // 2. Fast path — if already completed (e.g. the browser verify call beat the
  //    webhook, or a duplicate delivery), return the existing receipt and run NO
  //    side effects or id generation. The transaction below is the authoritative
  //    guard; this just avoids burning a sequential receipt number on the common
  //    duplicate case.
  const preSnap = await donationRef.get()
  const preData = preSnap.data() as DonationDocument | undefined
  if (!preData) throw new Error('Donation not found')

  // 2a. Order binding — the presented order MUST be the one Razorpay created for
  //     THIS donation (stored at create-order time). Signature validity alone is
  //     NOT enough: a genuine signature for another (smaller) donation's
  //     order|payment could otherwise complete this donation and credit/receipt
  //     ITS amount. Rejected for everyone (browser + webhook); checked again
  //     inside the transaction below since this read is outside it.
  if (!preData.razorpayOrderId || preData.razorpayOrderId !== input.razorpayOrderId) {
    throw new DonationOrderMismatchError()
  }

  if (preData.status === 'successful') {
    return {
      donationId:    input.donationId,
      receiptId:     preData.receiptId ?? '',
      receiptNumber: preData.receiptNumber ?? '',
    }
  }

  // 3. Generate receipt identifiers before the transaction
  const receiptId     = generateDonationReceiptId()
  const receiptNumber = await generateSequentialReceiptNumber()
  const paymentId     = generateDonationPaymentId()
  const counterRef    = adminDb.collection('donationCounters').doc(extras.campaignSlug)

  // 4. Atomic guard: only the FIRST caller to observe a non-successful donation
  //    flips status → successful and increments the counter. A concurrent caller
  //    (verify vs webhook) conflicts on the donation doc, retries, sees
  //    'successful', and returns completed:false — so the counter increments
  //    exactly once and the side effects (incl. wallet credit) run exactly once.
  const outcome = await adminDb.runTransaction<{ completed: boolean; receiptId: string; receiptNumber: string }>(async txn => {
    const snap = await txn.get(donationRef)
    const data = snap.data() as DonationDocument | undefined
    if (!data) throw new Error('Donation not found')

    // Re-assert the order binding inside the transaction (defense-in-depth).
    if (!data.razorpayOrderId || data.razorpayOrderId !== input.razorpayOrderId) {
      throw new DonationOrderMismatchError()
    }

    if (data.status === 'successful') {
      // Lost the race — another path already completed it. No-op.
      return { completed: false, receiptId: data.receiptId ?? '', receiptNumber: data.receiptNumber ?? '' }
    }

    txn.update(donationRef, {
      status:             'successful' satisfies 'successful',
      paymentStatus:      'paid'       satisfies 'paid',
      razorpayOrderId:    input.razorpayOrderId,
      razorpayPaymentId:  input.razorpayPaymentId,
      donationPaymentId:  paymentId,
      receiptId,
      receiptNumber,
      paidAt:    FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    })

    txn.set(
      counterRef,
      buildDonationCounterIncrement(extras.campaignSlug, extras.amountPaise),
      { merge: true },
    )

    return { completed: true, receiptId, receiptNumber }
  })

  // If another caller completed this donation first, do NOT re-run side effects
  // (payment record, receipt, ledger, wallet credit) — they were/are handled by
  // the winning call. Return the existing receipt identifiers.
  if (!outcome.completed) {
    return { donationId: input.donationId, receiptId: outcome.receiptId, receiptNumber: outcome.receiptNumber }
  }

  // 5. FINANCIAL FIRST — atomic ledger + revenue-wallet credit (registration
  //    pattern). Run before payment-record/receipt writes so the crash window
  //    BEFORE the credit is only the Firestore write latency (~ms). The donation
  //    is already durable ('successful'); this is POST-COMMIT and must NEVER fail
  //    the donation, roll back success, or revoke the receipt. On a transient
  //    failure we persist a reconciliation record for exactly-once out-of-band
  //    retry. recordPlatformTransactionAndCredit is atomic AND idempotent on
  //    `ptx_${donationId}`, so the browser-verify, webhook and cron paths credit
  //    EXACTLY ONCE regardless of order/overlap.
  // Build via the SHARED helper (also used by the donation recovery sweep — RD-PAY-GA-01B
  // — so both paths post an identical, deterministic ptx_<donationId> entry).
  const { ledger, credit } = await buildDonationLedgerAndCredit({
    donationId:   input.donationId,
    organizerUid: extras.organizerUid,
    campaignSlug: extras.campaignSlug,
    donorName:    extras.donorName,
    donorEmail:   extras.donorEmail,
    isAnonymous:  extras.isAnonymous,
    amountPaise:  extras.amountPaise,
    paymentId:    input.razorpayPaymentId,
    orderId:      input.razorpayOrderId,
  })
  try {
    await recordPlatformTransactionAndCredit(ledger, credit)
  } catch (financialErr) {
    await recordDonationFinancialReconciliation({
      donationId: input.donationId,
      orderId:    input.razorpayOrderId,
      paymentId:  input.razorpayPaymentId,
      ledger,
      credit,
      error:      financialErr instanceof Error ? financialErr.message : 'financial_side_effect_failed',
    })
  }

  // 6. Create payment record (outside transaction — not contended)
  await createDonationPayment({
    id:                 paymentId,
    donationId:         input.donationId,
    campaignSlug:       extras.campaignSlug,
    organizerUid:       extras.organizerUid,
    amountPaise:        extras.amountPaise,
    currency:           'INR',
    gateway:            'razorpay',
    razorpayOrderId:    input.razorpayOrderId,
    razorpayPaymentId:  input.razorpayPaymentId,
    razorpaySignature:  input.razorpaySignature,
    status:             'paid',
  })

  // 7. Issue receipt
  await createDonationReceipt({
    id:            receiptId,
    receiptNumber,
    donationId:    input.donationId,
    campaignSlug:  extras.campaignSlug,
    campaignTitle: extras.campaignTitle,
    organizerUid:  extras.organizerUid,
    donorName:     extras.isAnonymous ? 'Anonymous' : extras.donorName,
    donorEmail:    extras.donorEmail,
    amountPaise:   extras.amountPaise,
    amountRupees:  extras.amountRupees,
    is80G:         extras.is80G,
    paidAt:        FieldValue.serverTimestamp(),
  })

  // Organizer webhook (fire-and-forget; no-op when no webhook configured).
  void enqueueWebhook(extras.organizerUid, 'donation.completed', {
    donationId: input.donationId, campaignSlug: extras.campaignSlug,
    amountPaise: extras.amountPaise, receiptNumber, donorName: extras.isAnonymous ? 'Anonymous' : extras.donorName,
  }).catch(() => {})

  // CRM donor contact upsert (fire-and-forget, idempotent). Uses the real donor
  // identity (anonymity is a public-display preference, not a CRM one).
  crmRecordDonation({
    organizerUid: extras.organizerUid, email: extras.donorEmail, name: extras.donorName,
    donationId: input.donationId, campaignSlug: extras.campaignSlug, campaignTitle: extras.campaignTitle,
    amountPaise: extras.amountPaise,
  })

  return { donationId: input.donationId, receiptId, receiptNumber }
}

// ─── Failure path ─────────────────────────────────────────────────────────────

export async function failDonation(
  donationId:    string,
  paymentId?:    string,
  failureReason?: string,
): Promise<void> {
  const tasks: Promise<void>[] = [
    updateDonationStatus(donationId, {
      status:        'failed',
      paymentStatus: 'failed',
    }),
  ]

  if (paymentId) {
    tasks.push(
      updateDonationPaymentStatus(paymentId, 'failed', {
        failureReason: failureReason ?? 'Unknown failure',
      }),
    )
  }

  await Promise.all(tasks)
}

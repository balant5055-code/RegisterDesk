// POST /api/donations/verify
//
// Security model:
//   1. Rate-limited by IP — 10 requests per 5 min.
//   2. Donation doc is loaded from Firestore — amount is never taken from the browser.
//   3. Signature verification (HMAC-SHA256) runs inside completeDonation() before any writes.
//   4. Status guard: only 'pending' donations can be verified; already-successful are idempotent.
//   5. Razorpay paymentId + orderId + signature are passed verbatim from the Razorpay handler.

import { NextRequest, NextResponse }    from 'next/server'
import { captureFinancialError }         from '@/lib/monitoring/sentry'
import { getClientIp }                  from '@/lib/rateLimit'
import { checkDistributedRateLimit }    from '@/lib/rateLimit/redis'
import { getDonation }                   from '@/lib/firebase/firestore/donations'
import { getCampaignBySlug }             from '@/lib/firebase/firestore/campaigns'
import { isContentTakenDown }            from '@/lib/admin/moderation'
import { completeDonation, DonationOrderMismatchError } from '@/lib/donations/donationService'
import { RazorpayDonationGateway }      from '@/lib/razorpay/donationGateway'
import { signReceiptToken }             from '@/lib/donations/receiptToken'
import { flagSuspiciousPayment }        from '@/lib/payments/flagSuspicious'

// ─── Request / response shapes ────────────────────────────────────────────────

interface VerifyDonationBody {
  razorpay_payment_id: string
  razorpay_order_id:   string
  razorpay_signature:  string
  donationId:          string
}

interface VerifyDonationResponse {
  success:       true
  donationId:    string
  receiptId:     string
  receiptNumber: string
  receiptToken:  string    // HMAC token — embed in download/view URLs
  amountPaise:   number
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  // Fail-CLOSED: payment verification must not open during a Redis outage.
  const ip = getClientIp(req)
  const rl = await checkDistributedRateLimit({ key: `donation-verify:${ip}`, limit: 10, windowSeconds: 5 * 60 })
  if (!rl.allowed) {
    return NextResponse.json({ error: 'Too many requests.' }, { status: 429 })
  }

  let body: VerifyDonationBody
  try {
    body = await req.json() as VerifyDonationBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const {
    razorpay_payment_id,
    razorpay_order_id,
    razorpay_signature,
    donationId,
  } = body

  if (
    !razorpay_payment_id || typeof razorpay_payment_id !== 'string' ||
    !razorpay_order_id   || typeof razorpay_order_id   !== 'string' ||
    !razorpay_signature  || typeof razorpay_signature  !== 'string' ||
    !donationId          || typeof donationId          !== 'string'
  ) {
    return NextResponse.json({ error: 'Missing required fields.' }, { status: 400 })
  }

  // Load donation from Firestore — never trust browser for amount
  const donation = await getDonation(donationId)
  if (!donation) {
    return NextResponse.json({ error: 'Donation not found.' }, { status: 404 })
  }

  // Idempotent success path — Razorpay may call the handler more than once
  if (donation.status === 'successful') {
    const rid = donation.receiptId ?? ''
    return NextResponse.json({
      success:       true,
      donationId,
      receiptId:     rid,
      receiptNumber: donation.receiptNumber ?? '',
      receiptToken:  rid ? signReceiptToken(rid) : '',
      amountPaise:   donation.amountPaise,
    } satisfies VerifyDonationResponse)
  }

  if (donation.status !== 'pending') {
    return NextResponse.json(
      { error: 'Donation is not in a verifiable state.' },
      { status: 409 },
    )
  }

  // Load campaign for is80G — not stored on the donation doc
  const campaign = await getCampaignBySlug(donation.campaignSlug)

  // Admin moderation — never complete a donation to a taken-down campaign.
  if (campaign && isContentTakenDown(campaign.moderationStatus)) {
    return NextResponse.json(
      { error: 'This campaign is no longer available.', reason: 'CAMPAIGN_UNAVAILABLE' },
      { status: 403 },
    )
  }

  const is80G    = campaign?.campaignDetails.taxConfig.enabled ?? false
  const title    = campaign?.campaignDetails.basics.title ?? donation.campaignTitle

  const gateway = new RazorpayDonationGateway()

  try {
    const { receiptId, receiptNumber } = await completeDonation(
      {
        donationId,
        razorpayOrderId:   razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
        razorpaySignature: razorpay_signature,
      },
      gateway,
      {
        campaignSlug:  donation.campaignSlug,
        campaignTitle: title,
        organizerUid:  donation.organizerUid,
        donorName:     donation.donorName,
        donorEmail:    donation.donorEmail,
        amountPaise:   donation.amountPaise,    // authoritative — from Firestore
        amountRupees:  donation.amountRupees,
        isAnonymous:   donation.isAnonymous,
        is80G,
      },
    )

    return NextResponse.json({
      success:       true,
      donationId,
      receiptId,
      receiptNumber,
      receiptToken:  signReceiptToken(receiptId),
      amountPaise:   donation.amountPaise,
    } satisfies VerifyDonationResponse)
  } catch (err) {
    // Order/payment does not belong to this donation — reject as a bad request
    // and flag for manual review (mirrors the webhook's mismatch handling).
    if (err instanceof DonationOrderMismatchError) {
      await flagSuspiciousPayment({
        source:          'donation',
        reason:          'order_mismatch_browser_verify',
        paymentId:       razorpay_payment_id,
        orderId:         razorpay_order_id,
        entityId:        donationId,
        expectedOrderId: donation.razorpayOrderId,
        actualOrderId:   razorpay_order_id,
        expectedAmountPaise: donation.amountPaise,
      })
      return NextResponse.json({ error: 'Payment does not match this donation.' }, { status: 400 })
    }
    captureFinancialError(err, { scope: 'donations.verify_failed' })
    // Public endpoint — do not leak the internal exception message. It is already
    // captured above for diagnosis; return a generic message to the client.
    return NextResponse.json({ error: 'Payment verification failed. Please try again or contact support.' }, { status: 422 })
  }
}

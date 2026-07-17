// POST /api/donations/create-order
//
// Security model:
//   1. Rate-limited by IP — 5 requests per 5 min.
//   2. Optional Firebase auth — anonymous donations are allowed.
//   3. Campaign loaded from Firestore — amount bounds come from the server, not the client.
//   4. Validation runs server-side before any Razorpay call.
//   5. Donation doc created in 'initiated' state; Razorpay order bumps it to 'pending'.
//   6. Returns keyId so the client can open the Razorpay checkout; never exposes key_secret.

import { NextRequest, NextResponse }       from 'next/server'
import { captureFinancialError }            from '@/lib/monitoring/sentry'
import { adminAuth }                        from '@/lib/firebase/admin'
import { getCampaignBySlug }               from '@/lib/firebase/firestore/campaigns'
import { isContentTakenDown }              from '@/lib/admin/moderation'
import {
  initiateDonation,
  createDonationGatewayOrder,
}                                           from '@/lib/donations/donationService'
import { RazorpayDonationGateway }         from '@/lib/razorpay/donationGateway'
import { RAZORPAY_KEY_ID }                 from '@/lib/razorpay/client'
import { getClientIp }                     from '@/lib/rateLimit'
import { checkDistributedRateLimit }       from '@/lib/rateLimit/redis'
import { DonationValidationError }         from '@/lib/donations/types'

// ─── Request / response shapes ────────────────────────────────────────────────

interface CreateDonationOrderBody {
  campaignSlug:       string
  amountRupees:       number
  donorName:          string
  donorEmail:         string
  donorPhone?:        string | null
  isAnonymous?:       boolean
  showAmountPublicly?: boolean
  message?:           string
  dedication?:        string
}

export interface CreateDonationOrderResponse {
  donationId:      string
  razorpayOrderId: string
  amountPaise:     number
  currency:        'INR'
  keyId:           string
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ip = getClientIp(req)
  const rl = await checkDistributedRateLimit({ key: `donation-create-order:${ip}`, limit: 5, windowSeconds: 5 * 60, failOpen: true })
  if (!rl.allowed) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment and try again.' },
      { status: 429 },
    )
  }

  // Optional auth — guest donations are supported
  let donorUid: string | undefined
  const authHeader = req.headers.get('Authorization')
  if (authHeader?.startsWith('Bearer ')) {
    try {
      const decoded = await adminAuth.verifyIdToken(authHeader.slice(7))
      donorUid = decoded.uid
    } catch {
      // Invalid token — treat as guest; do not reject
    }
  }

  let body: CreateDonationOrderBody
  try {
    body = await req.json() as CreateDonationOrderBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const {
    campaignSlug,
    amountRupees,
    donorName,
    donorEmail,
    donorPhone         = null,
    isAnonymous        = false,
    showAmountPublicly = true,
    message,
    dedication,
  } = body

  if (!campaignSlug || typeof campaignSlug !== 'string') {
    return NextResponse.json({ error: 'campaignSlug is required.' }, { status: 400 })
  }

  if (typeof amountRupees !== 'number' || !Number.isFinite(amountRupees) || amountRupees <= 0) {
    return NextResponse.json(
      { error: 'amountRupees must be a positive number.' },
      { status: 400 },
    )
  }

  // Load campaign — authoritative source for bounds and status checks
  const campaign = await getCampaignBySlug(campaignSlug)

  if (!campaign) {
    return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 })
  }

  if (campaign.visibility !== 'public') {
    return NextResponse.json({ error: 'Campaign not found.' }, { status: 404 })
  }

  if (campaign.status !== 'active') {
    return NextResponse.json(
      { error: 'This campaign is not currently accepting donations.' },
      { status: 409 },
    )
  }

  // Admin moderation — a taken-down campaign must not accept money.
  if (isContentTakenDown(campaign.moderationStatus)) {
    return NextResponse.json(
      { error: 'This campaign is no longer available.', reason: 'CAMPAIGN_UNAVAILABLE' },
      { status: 403 },
    )
  }

  const cd = campaign.campaignDetails
  const ds = campaign.donationSettings

  const campaignMinAmountRupees = ds?.amounts.minimumAmountRupees ?? 10
  const campaignMaxAmountRupees = ds?.amounts.maximumAmountRupees ?? null

  const gateway = new RazorpayDonationGateway()

  try {
    const { donationId, amountPaise } = await initiateDonation({
      campaignSlug,
      campaignId:    campaignSlug,
      campaignTitle: cd.basics.title,
      organizerUid:  campaign.uid,
      is80G:         cd.taxConfig.enabled,
      amountRupees,
      donorName,
      donorEmail,
      donorPhone:    donorPhone ?? null,
      donorUid,
      isAnonymous,
      showAmountPublicly,
      message,
      dedication,
      campaignMinAmountRupees,
      campaignMaxAmountRupees,
    })

    const razorpayOrderId = await createDonationGatewayOrder(
      donationId,
      campaignSlug,
      amountPaise,
      gateway,
    )

    return NextResponse.json({
      donationId,
      razorpayOrderId,
      amountPaise,
      currency: 'INR',
      keyId:    RAZORPAY_KEY_ID,
    } satisfies CreateDonationOrderResponse)
  } catch (err) {
    if (err instanceof DonationValidationError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 422 })
    }
    captureFinancialError(err, { scope: 'donations.create_order_failed' })
    return NextResponse.json({ error: 'Failed to create donation order.' }, { status: 500 })
  }
}

// GET /api/donations/receipt/[receiptId]
//
// Streams a PDF donation receipt to the browser.
//
// Authorization (checked in order):
//   1. ?token=<hmac>  — HMAC-SHA256(RECEIPT_TOKEN_SECRET, receiptId)
//      Signed at payment completion and embedded in the success page + receipt email.
//      No login required; the token itself is the capability.
//   2. Authorization: Bearer <firebase-id-token>
//      Allowed when the decoded uid matches:
//        a. donation.donorUid  (authenticated donor)
//        b. receipt.organizerUid  (campaign organizer)
//
// The PDF is generated on-the-fly using pdf-lib — no file storage needed.

import { NextRequest, NextResponse }    from 'next/server'
import { adminAuth }                    from '@/lib/firebase/admin'
import { getDonationReceipt }           from '@/lib/firebase/firestore/donations'
import { getDonation }                  from '@/lib/firebase/firestore/donations'
import { getCampaignBySlug }            from '@/lib/firebase/firestore/campaigns'
import { verifyReceiptToken }           from '@/lib/donations/receiptToken'
import { generateReceiptPdf }           from '@/lib/donations/receiptPdf'

function toDate(val: unknown): Date {
  if (val && typeof val === 'object' && 'toDate' in val) {
    return (val as { toDate: () => Date }).toDate()
  }
  return new Date()
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ receiptId: string }> },
): Promise<NextResponse> {
  const { receiptId } = await context.params

  // ── Authorization ─────────────────────────────────────────────────────────

  let authed = false

  // Path 1: HMAC token in query string
  const tokenParam = req.nextUrl.searchParams.get('token') ?? ''
  if (tokenParam) {
    authed = verifyReceiptToken(receiptId, tokenParam)
  }

  // Path 2: Firebase Bearer token — load receipt first to check ownership
  let receipt = authed
    ? await getDonationReceipt(receiptId)
    : null

  if (!authed) {
    const bearerToken = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
    if (bearerToken) {
      try {
        const decoded = await adminAuth.verifyIdToken(bearerToken)
        const uid     = decoded.uid
        // Need the receipt to check ownership
        receipt = await getDonationReceipt(receiptId)
        if (receipt) {
          // Check organizer access
          if (receipt.organizerUid === uid) {
            authed = true
          } else {
            // Check donor uid from donation doc
            const donation = await getDonation(receipt.donationId)
            if (donation?.donorUid === uid) authed = true
          }
        }
      } catch {
        // Invalid token — fall through to 403
      }
    }
  }

  if (!authed) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── Load receipt ──────────────────────────────────────────────────────────

  if (!receipt) {
    receipt = await getDonationReceipt(receiptId)
  }
  if (!receipt) {
    return NextResponse.json({ error: 'Receipt not found' }, { status: 404 })
  }

  // ── Load donation (for transactionId) and campaign (for 80G info) ─────────

  const [donation, campaign] = await Promise.all([
    getDonation(receipt.donationId),
    getCampaignBySlug(receipt.campaignSlug),
  ])

  const cd = campaign?.campaignDetails

  // ── Generate PDF ──────────────────────────────────────────────────────────

  const pdfBytes = await generateReceiptPdf({
    receiptNumber:       receipt.receiptNumber,
    donorName:           receipt.donorName,
    donorEmail:          receipt.donorEmail,
    campaignTitle:       receipt.campaignTitle,
    organizerName:       cd?.organizer?.name ?? 'Organization',
    amountRupees:        receipt.amountRupees,
    transactionId:       donation?.razorpayPaymentId ?? '',
    paidAt:              toDate(receipt.paidAt),
    is80G:               receipt.is80G,
    organizerPan:        cd?.taxConfig?.organizationPan     || undefined,
    reg80GNumber:        cd?.taxConfig?.registrationNumber  || undefined,
    reg80GCertExpiry:    cd?.taxConfig?.certificateExpiry   || undefined,
  })

  const safeNumber = receipt.receiptNumber.replace(/[^A-Za-z0-9-]/g, '')

  return new NextResponse(Buffer.from(pdfBytes), {
    status:  200,
    headers: {
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="receipt-${safeNumber}.pdf"`,
      'Cache-Control':       'no-store',
    },
  })
}

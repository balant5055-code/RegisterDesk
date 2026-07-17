// Server-only: Razorpay implementation of DonationGatewayAdapter.
// Plug into donationService functions that accept DonationGatewayAdapter.

import crypto from 'crypto'
import { razorpay, RAZORPAY_KEY_SECRET } from '@/lib/razorpay/client'
import type {
  DonationGatewayAdapter,
  DonationGatewayCreateOrderParams,
  DonationGatewayOrder,
} from '@/lib/donations/types'

export class RazorpayDonationGateway implements DonationGatewayAdapter {
  async createOrder(
    params: DonationGatewayCreateOrderParams,
  ): Promise<DonationGatewayOrder> {
    const order = await razorpay.orders.create({
      amount:   params.amountPaise,
      currency: params.currency,
      // Razorpay receipt field: max 40 chars; slice donationId safely
      receipt:  params.donationId.slice(0, 40),
      notes: {
        donationId:   params.donationId,
        campaignSlug: params.campaignSlug,
        ...(params.notes ?? {}),
      },
    })

    return {
      gatewayOrderId: order.id,
      amountPaise:    params.amountPaise,
      currency:       'INR',
    }
  }

  verifySignature(params: {
    orderId:   string
    paymentId: string
    signature: string
  }): boolean {
    // Razorpay signature = HMAC-SHA256(key_secret, "orderId|paymentId")
    const body = `${params.orderId}|${params.paymentId}`
    const expected = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex')

    try {
      const expectedBuf = Buffer.from(expected,         'hex')
      const actualBuf   = Buffer.from(params.signature, 'hex')
      // Lengths must match before timingSafeEqual
      if (expectedBuf.length !== actualBuf.length) return false
      return crypto.timingSafeEqual(expectedBuf, actualBuf)
    } catch {
      return false
    }
  }
}

// POST /api/organizer/wallet/topup/verify
//
// Called by the client immediately after Razorpay checkout succeeds.
// Verifies the HMAC signature, then credits the organizer wallet.
//
// Body: { orderId, paymentId, signature }

import crypto                                       from 'crypto'
import { NextRequest, NextResponse }               from 'next/server'
import { captureFinancialError }                    from '@/lib/monitoring/sentry'
import { adminDb }                                 from '@/lib/firebase/admin'
import { authorizeWorkspace }                      from '@/lib/team/workspace'
import { organizerStatusGuard }                    from '@/lib/admin/organizerStatus'
import { atomicTopupCredit, getWalletBalance }     from '@/lib/firebase/firestore/wallet'
import { recordWalletTopupReconciliation }         from '@/lib/wallet/topupReconciliation'
import { flagSuspiciousPayment }                   from '@/lib/payments/flagSuspicious'
import { razorpay, RAZORPAY_KEY_SECRET as KEY_SECRET } from '@/lib/razorpay/client'
import type { WalletTopupVerifyResponse }          from '@/types/events'
import { notificationEngine, NotificationType, NotificationChannel } from '@/lib/notifications'
import { sendOrganizerWhatsApp }                   from '@/lib/notifications/organizerWhatsApp'
import { notifyWalletRecharged }                   from '@/lib/notifications/inbox/notify'

const HEX_64 = /^[0-9a-f]{64}$/

interface TopupRecord {
  uid:         string
  amountPaise: number
  status:      string
}

export async function POST(req: NextRequest): Promise<NextResponse<WalletTopupVerifyResponse>> {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ success: false, error: blocked.message }, { status: 403 })

  // ── Parse body ────────────────────────────────────────────────────────────────
  let orderId: string, paymentId: string, signature: string
  try {
    const body = await req.json() as Record<string, unknown>
    orderId   = String(body.orderId   ?? '')
    paymentId = String(body.paymentId ?? '')
    signature = String(body.signature ?? '')
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 })
  }

  if (!orderId || !paymentId || !signature) {
    return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 })
  }

  // ── Verify HMAC signature ─────────────────────────────────────────────────────
  // Reject malformed signatures before any crypto to prevent length-extension
  // attacks and ensure timingSafeEqual receives equal-length buffers.
  if (!HEX_64.test(signature)) {
    return NextResponse.json({ success: false, error: 'Payment signature verification failed' }, { status: 400 })
  }

  const expected = crypto
    .createHmac('sha256', KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest()                           // raw Buffer — same length as actual

  const actual = Buffer.from(signature, 'hex')  // always 32 bytes after regex check

  if (!crypto.timingSafeEqual(expected, actual)) {
    return NextResponse.json({ success: false, error: 'Payment signature verification failed' }, { status: 400 })
  }

  // ── Load topup record ─────────────────────────────────────────────────────────
  const topupRef  = adminDb.collection('walletTopups').doc(orderId)
  const topupSnap = await topupRef.get()

  if (!topupSnap.exists) {
    return NextResponse.json({ success: false, error: 'Topup order not found' }, { status: 404 })
  }

  const topup = topupSnap.data() as TopupRecord

  // Ownership check
  if (topup.uid !== uid) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 })
  }

  // Fast-path idempotency — skip the transaction on obvious re-delivery
  if (topup.status === 'credited') {
    const balance = await getWalletBalance(uid)
    return NextResponse.json({ success: true, newBalance: balance })
  }

  // ── Amount + currency + order verification (defense-in-depth) ──────────────────
  // The signature already proves the payment belongs to `orderId`. We additionally
  // fetch the captured payment and assert amount/currency/order match the stored
  // intent before crediting — so a forged client body can't credit a wrong amount,
  // and a payment for another order can't be swapped in. Mismatch → flag + refuse.
  let payment: { amount?: number; currency?: string; status?: string; order_id?: string }
  try {
    payment = await razorpay.payments.fetch(paymentId) as typeof payment
  } catch (err) {
    captureFinancialError(err, { scope: 'topup.payment_fetch_failed', paymentId })
    return NextResponse.json({ success: false, error: 'Could not verify payment. Please try again.' }, { status: 502 })
  }

  const captured = payment.status === 'captured' || payment.status === 'authorized'
  if (
    !captured ||
    payment.currency !== 'INR' ||
    payment.amount !== topup.amountPaise ||
    payment.order_id !== orderId
  ) {
    await flagSuspiciousPayment({
      source: 'wallet_topup', reason: 'amount_or_order_mismatch',
      paymentId, orderId, entityId: uid,
      expectedAmountPaise: topup.amountPaise, actualAmountPaise: payment.amount,
      expectedCurrency: 'INR', actualCurrency: payment.currency,
      expectedOrderId: orderId, actualOrderId: payment.order_id,
    })
    return NextResponse.json({ success: false, error: 'Payment verification failed.' }, { status: 400 })
  }

  // ── Atomic credit + status + ledger (one transaction; idempotent) ──────────────
  // A transient failure here must NOT lose the captured payment: record a
  // reconciliation entry and report the credit as pending. The cron (and the
  // payment.captured webhook) will complete it exactly-once.
  try {
    const { newBalance, credited } = await atomicTopupCredit(uid, topup.amountPaise, topupRef, paymentId)

    // Wallet Recharge — organizer Email + WhatsApp (FREE, Phase G3.5). Only on the
    // real credit (not an idempotent replay). Best-effort; never blocks the response.
    if (credited) {
      void (async () => {
        try {
          const userSnap = await adminDb.collection('users').doc(uid).get()
          const u = userSnap.data() as { email?: string; name?: string } | undefined
          if (!u?.email) return
          if (notificationEngine.isAvailable(NotificationChannel.EMAIL)) {
            await notificationEngine.send(NotificationType.WALLET_RECHARGED, {
              to: u.email, organizerName: u.name ?? '', amountPaise: topup.amountPaise, newBalancePaise: newBalance,
            })
          }
          void sendOrganizerWhatsApp({
            type: NotificationType.WALLET_RECHARGED, organizerUid: uid,
            variables: { organizerName: u.name ?? '', amount: `₹${(topup.amountPaise / 100).toLocaleString('en-IN')}` },
          })
        } catch (err) {
          console.error('[wallet] recharge notification failed:', err)
        }
      })()

      // H.4.3: record in the organizer Notification Center inbox (best-effort).
      void notifyWalletRecharged({ workspaceUid: uid, amountPaise: topup.amountPaise, newBalancePaise: newBalance, topupId: topupRef.id })
    }

    return NextResponse.json({ success: true, newBalance })
  } catch (err) {
    await recordWalletTopupReconciliation({
      orderId, uid, amountPaise: topup.amountPaise, paymentId,
      error: err instanceof Error ? err.message : 'credit_failed',
    })
    return NextResponse.json(
      { success: false, pending: true, error: 'Payment received — your wallet will be credited shortly.' },
      { status: 202 },
    )
  }
}

// POST /api/organizer/wallet/topup
// Creates a Razorpay order for wallet top-up and stores a topup record.
//
// Body: { amountPaise: number }   — minimum 100 paise (₹1)
//
// Returns: { orderId, amount, currency }
//
// Flow:
//   1. Client calls this endpoint to get a Razorpay order.
//   2. Client opens Razorpay checkout.
//   3. On success client calls POST /api/organizer/wallet/topup/verify.
//   4. Webhook (razorpay) handles recovery if client never called verify.

import { NextRequest, NextResponse }         from 'next/server'
import { FieldValue }                         from 'firebase-admin/firestore'
import { adminDb }                            from '@/lib/firebase/admin'
import { authorizeWorkspace }                 from '@/lib/team/workspace'
import { organizerStatusGuard }               from '@/lib/admin/organizerStatus'
import { razorpay, RAZORPAY_KEY_ID }          from '@/lib/razorpay/client'
import { checkRateLimit }                     from '@/lib/rateLimit'
import { getWalletConfig }                    from '@/lib/wallet/resolveWalletConfig'
import { getWalletBalance }                   from '@/lib/firebase/firestore/wallet'
import type { WalletTopupOrderResponse }      from '@/types/events'

export async function POST(req: NextRequest): Promise<NextResponse<WalletTopupOrderResponse | { error: string }>> {
  // ── Auth ──────────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ error: blocked.message }, { status: 403 })

  // ── Wallet policy (Business Configuration) — enabled gate + top-up limits ──────
  const wallet = await getWalletConfig({ organizerUid: uid })
  if (!wallet.enabled) {
    return NextResponse.json({ error: 'Wallet top-ups are currently disabled.' }, { status: 403 })
  }
  if (wallet.frozen) {
    return NextResponse.json({ error: 'Wallet is currently frozen. Top-ups are temporarily unavailable.' }, { status: 403 })
  }

  // ── Rate limit: 10 topup orders per hour per organizer ───────────────────────
  const rl = checkRateLimit(uid, 'wallet-topup', 10, 60 * 60 * 1000)
  if (rl.limited) {
    return NextResponse.json(
      { error: 'Too many top-up requests. Please try again later.' },
      {
        status: 429,
        headers: {
          'Retry-After':       String(Math.ceil((rl.resetAt - Date.now()) / 1000)),
          'X-RateLimit-Limit': '10',
          'X-RateLimit-Reset': String(rl.resetAt),
        },
      },
    )
  }

  // ── Parse body ────────────────────────────────────────────────────────────────
  let amountPaise: number
  try {
    const body = await req.json() as Record<string, unknown>
    amountPaise = typeof body.amountPaise === 'number' ? Math.round(body.amountPaise) : 0
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  if (amountPaise < wallet.minimumTopupPaise) {
    return NextResponse.json({ error: `Minimum top-up is ₹${wallet.minimumTopupPaise / 100}` }, { status: 400 })
  }

  if (amountPaise > wallet.maximumTopupPaise) {
    return NextResponse.json(
      { error: `Maximum top-up is ₹${(wallet.maximumTopupPaise / 100).toLocaleString('en-IN')}` },
      { status: 400 },
    )
  }

  // Maximum wallet balance policy (0 = uncapped). Advisory pre-check at order
  // creation; the balance is re-read at credit time.
  if (wallet.maximumBalancePaise > 0) {
    const currentBalance = await getWalletBalance(uid)
    if (currentBalance + amountPaise > wallet.maximumBalancePaise) {
      return NextResponse.json(
        { error: `This top-up would exceed the maximum wallet balance of ₹${(wallet.maximumBalancePaise / 100).toLocaleString('en-IN')}` },
        { status: 400 },
      )
    }
  }

  // ── Create Razorpay order ──────────────────────────────────────────────────────
  let order: { id: string; amount: number; currency: string }
  try {
    order = await razorpay.orders.create({
      amount:   amountPaise,
      currency: wallet.currency,
      receipt:  `wallet_${uid.slice(-8)}_${Date.now()}`.slice(0, 40),
      notes:    { purpose: 'wallet_topup', uid },
    }) as { id: string; amount: number; currency: string }
  } catch (err) {
    console.error('[wallet/topup] Razorpay order creation failed:', err)
    return NextResponse.json({ error: 'Payment service unavailable. Please try again.' }, { status: 503 })
  }

  // ── Persist topup record ──────────────────────────────────────────────────────
  await adminDb.collection('walletTopups').doc(order.id).set({
    orderId:     order.id,
    uid,
    amountPaise,
    currency:    wallet.currency,
    status:      'pending',
    createdAt:   FieldValue.serverTimestamp(),
    updatedAt:   FieldValue.serverTimestamp(),
  })

  return NextResponse.json({
    orderId:  order.id,
    amount:   amountPaise,
    currency: wallet.currency,
    keyId:    RAZORPAY_KEY_ID ?? '',
  })
}

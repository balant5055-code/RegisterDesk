// GET /api/organizer/wallet/topup/status?orderId=…&paymentId=…
//
// RD-WALLET-W1.1 follow-up — has THIS top-up payment been credited? Used by the event wizard to
// clear its "do not pay again" hold only when the original payment is confirmed credited, never
// merely because the balance rose.
//
// READ-ONLY: reads walletTopups/{orderId} and the order's / payment's reconciliation records.
// It never calls the gateway, verifies, credits or starts a payment. Same authorization as the
// top-up routes (`wallet` permission); an order belonging to another workspace is reported as
// not found. The response carries a state and the caller's own balance — no payment details.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { getWalletBalance }          from '@/lib/firebase/firestore/wallet'
import { resolveTopupPaymentState, type TopupPaymentState } from '@/lib/wallet/topupStatus'

export const dynamic = 'force-dynamic'

export interface WalletTopupStatusResponse {
  state:         TopupPaymentState
  /** Only when `credited` — the caller's current wallet balance (paise). */
  balancePaise?: number
}

const ID = /^[A-Za-z0-9_-]{1,100}$/
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse<WalletTopupStatusResponse | { error: string }>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  const uid = authz.workspaceUid

  const orderId   = req.nextUrl.searchParams.get('orderId') ?? ''
  const paymentId = req.nextUrl.searchParams.get('paymentId') ?? ''
  if (!ID.test(orderId) || !ID.test(paymentId)) {
    return NextResponse.json({ error: 'orderId and paymentId are required.' }, { status: 400, headers: NO_STORE })
  }

  const [topupSnap, reconSnap, dupSnap, mismatchSnap] = await Promise.all([
    adminDb.doc(`walletTopups/${orderId}`).get(),
    adminDb.doc(`walletTopupReconciliation/${orderId}`).get(),
    adminDb.doc(`walletTopupReconciliation/dup_${paymentId}`).get(),
    adminDb.doc(`walletTopupReconciliation/mismatch_${paymentId}`).get(),   // RD-WALLET-W2.b
  ])
  const topup = topupSnap.exists ? topupSnap.data() as { uid?: unknown; status?: unknown; paymentId?: unknown; holdResolvedAt?: unknown } : null
  if (!topup || topup.uid !== uid) {
    return NextResponse.json({ error: 'Top-up not found.' }, { status: 404, headers: NO_STORE })
  }

  // The records are passed whole to the pure resolver; only the resulting STATE leaves this route
  // (never a reviewer, reason, refund reference or evidence).
  type Recon = { status?: unknown; paymentId?: unknown; paymentIds?: unknown; review?: unknown; orderId?: unknown }
  const state = resolveTopupPaymentState(
    topup, paymentId,
    reconSnap.exists ? reconSnap.data() as Recon : null,
    dupSnap.exists && (dupSnap.data() as Recon).orderId === orderId ? dupSnap.data() as Recon : null,
    mismatchSnap.exists && (mismatchSnap.data() as Recon).orderId === orderId ? mismatchSnap.data() as Recon : null,
  )
  return NextResponse.json(
    state === 'credited' ? { state, balancePaise: await getWalletBalance(uid) } : { state },
    { headers: NO_STORE },
  )
}

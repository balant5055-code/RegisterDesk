// GET /api/organizer/payment-issues
//
// The organizer's own unresolved payment/registration mismatches.
//
// ═══ AUTHORIZATION IS THE WHOLE DESIGN ═══════════════════════════════════════
// The browser supplies NOTHING that affects which rows come back — no organizer id, no
// event id, no filter that widens the set. `authorizeWorkspace` resolves the workspace from
// the verified token, and `workspaceUid` becomes the query's own equality filter. There is
// no code path in which one organizer's uid can produce another organizer's rows, because
// the uid is never read from the request.
//
// ═══ WHY THIS READS CASES AND NOT paymentIntents ═════════════════════════════
// A payment intent records that an ATTEMPT failed; it cannot say whether money exists —
// intents are written before any payment id does. Answering that per row would mean calling
// Razorpay once per row on page load. The reconciliation sweep already asked Razorpay and
// already wrote the answer down, so this route is a single indexed read of a derived index.
// No Razorpay call happens here at all.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase/admin'
import { authorizeWorkspace } from '@/lib/team/workspace'
import {
  RECONCILIATION_CASES, toOrganizerView,
  type ReconciliationCase, type OrganizerCaseView,
} from '@/lib/payments/reconciliationCases'

export const dynamic = 'force-dynamic'

/** Bounded by design — this is a triage list, not an archive. */
const PAGE_SIZE = 50

export interface PaymentIssuesResponse {
  issues?: OrganizerCaseView[]
  error?:  string
}

export async function GET(req: NextRequest): Promise<NextResponse<PaymentIssuesResponse>> {
  // `transactions` is the existing money-reading permission; no new permission is invented.
  const authz = await authorizeWorkspace(req, 'transactions')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  try {
    // ONE indexed query. `organizerUid` is the workspace resolved from the token — never a
    // parameter. `not_captured` never appears because its status is `requires_review` only
    // when money might exist; a declined card is filtered out below on paymentState.
    const snap = await adminDb.collection(RECONCILIATION_CASES)
      .where('organizerUid', '==', authz.workspaceUid)
      .where('status', 'in', ['actionable', 'requires_review'])
      .orderBy('detectedAt', 'desc')
      .limit(PAGE_SIZE)
      .get()

    const issues = snap.docs
      .map(d => d.data() as ReconciliationCase)
      // A declined payment is not a payment issue. Filtered in memory rather than in the
      // query so the composite index stays a three-field one.
      .filter(c => c.paymentState !== 'not_captured')
      .map(toOrganizerView)

    // NO per-event scope filter here, deliberately. `isEventInScope` restricts only
    // check-in-only roles, and those roles do not hold `transactions` — they are already
    // refused above. Calling it here would also mean comparing a case's eventSlug against
    // `eventIds`, which are event IDs: a filter that never fires today and compares the
    // wrong two things the day it does. If event-scoped finance roles are introduced, the
    // case row needs an eventId and this becomes a real filter.

    return NextResponse.json({ issues })
  } catch {
    // Never leak a Firestore error (a missing index reads as one). The client shows a retry.
    return NextResponse.json({ error: 'Could not load payment issues.' }, { status: 500 })
  }
}

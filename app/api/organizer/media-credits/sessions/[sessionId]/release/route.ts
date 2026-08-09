// POST /api/organizer/media-credits/sessions/{sessionId}/release
//
// MC-10.6. The organizer has cancelled an upload. Close the session now instead of waiting
// six hours for the sweep, so the credits it was holding come back immediately.
//
// ═══ THIS IS NOT A SECOND WAY TO MOVE CREDITS ════════════════════════════════
// MC-07 left the sessions route read-only and said so in its header: "an organizer endpoint
// that could seal or settle one would be a second way to move credits". That reasoning was
// about an endpoint that could BYPASS settlement — release a hold without charging for what
// was consumed. This one cannot.
//
// It calls `sealSession` and then `settleSession` — the same two functions, in the same
// order, that `runSessionCleanup` calls. No new state, no new arithmetic, no new writer. The
// only thing that changes is WHO triggers the transition and WHEN:
//
//   scheduler   ACTIVE → (expired, 6h) → SEALED → SETTLED
//   this route  ACTIVE → (owner cancelled) → SEALED → SETTLED
//
// The scheduler remains the safety net for every case this route cannot cover — a closed tab,
// a crashed browser, a dropped connection. Nothing about it changes.
//
// ═══ WHY SEAL REASON IS `CLOSED`, NOT A NEW ONE ══════════════════════════════
// `CreditSessionSealReason` is 'CLOSED' | 'EXPIRED'. An organizer cancelling is the
// definition of closed; inventing 'CANCELLED' would add a third state to a frozen enum to
// record something `sealedBy` already tells us.
//
// ═══ IDEMPOTENT, TWICE OVER ══════════════════════════════════════════════════
// `sealSession` reports an already-sealed or already-settled session instead of throwing, and
// `settleSession` short-circuits on SETTLED and re-checks inside its transaction. So a double
// click, a retry, or this route racing the sweep all converge on one settlement.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { sealSession } from '@/features/media-credits/services/sessionService'
import { settleSession } from '@/features/media-credits/services/sessionSettlementService'
import { getCreditPolicy, walletService } from '@/features/media-credits/services'
import { InvalidCreditOperationError } from '@/features/media-credits/errors'

type Params = { params: Promise<{ sessionId: string }> }

export async function POST(req: NextRequest, { params }: Params): Promise<NextResponse> {
  // `wallet`, matching every other media-credits organizer endpoint.
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { sessionId } = await params
  if (!sessionId) return NextResponse.json({ error: 'Missing session id' }, { status: 400 })

  // With credits off there is no session and nothing to release. Answering 200 rather than an
  // error keeps the client's cancel path identical in both modes — it never has to know.
  const policy = await getCreditPolicy()
  if (!policy.creditsEnabled) {
    return NextResponse.json({ released: false, reason: 'credits_disabled' })
  }

  try {
    // `organizerUid` is passed, so `sealSession` refuses a session belonging to another
    // workspace. The caller's own id — never a value from the request body.
    const seal = await sealSession({
      sessionId,
      organizerUid: authz.workspaceUid,
      reason:       'CLOSED',
      sealedBy:     authz.callerUid,
    })

    // Settle even when this call did not do the sealing: a session sealed a moment ago by the
    // sweep, or by a duplicate of this request, may still be awaiting settlement, and the
    // point of this endpoint is that the organizer does not wait for the next cron tick.
    // `settleSession` is a no-op on an already-settled session.
    const settled = await settleSession(sessionId)

    const balance = await walletService.getBalance(authz.workspaceUid)

    return NextResponse.json({
      released: true,
      /** False when the session was already sealed — a replay, not a failure. */
      sealedNow: seal.sealed,
      consumedSlots:  settled.consumedSlots,
      creditsCharged: settled.creditsConsumed,
      creditsReleased: settled.creditsReleased,
      // Returned so the client can show the recovered balance without a second round trip.
      balance: { balance: balance.balance, held: balance.held, available: balance.available },
    }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    if (err instanceof InvalidCreditOperationError) {
      // Covers an unknown session and one owned by another workspace. Both answer 404 rather
      // than 403, so the endpoint cannot be used to probe for real session ids.
      return NextResponse.json({ error: 'Session not found' }, { status: 404 })
    }
    // A failure here costs nothing: the session stays ACTIVE and the sweep will reclaim it.
    // That is exactly the behaviour that existed before this route, so the client can treat
    // it as "credits will come back later" rather than as a lost cancellation.
    console.error('[media-credits/sessions/release] failed:', err)
    return NextResponse.json(
      { error: 'Could not release this session now. Its credits will be returned shortly.' },
      { status: 503 },
    )
  }
}

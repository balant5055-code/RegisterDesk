// POST /api/admin/recover-orphaned-capture
//
// TEMPORARY, SINGLE-CASE execution surface for RD-RECOVER-01.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// `recoverOrphanedCapture` needs the production Razorpay credentials to verify a capture, and
// those exist only inside the deployed runtime. It is deliberately wired to no route and no
// cron, which is correct for a permanent posture but leaves it unreachable — so settling the
// one confirmed orphan (S.P. PRITHIVIK, order_TS6MJY6uL9NgCw) needs a door.
//
// ═══ DELETE THIS FILE ONCE THAT RECOVERY HAS RUN ═════════════════════════════
// It is scaffolding for a single incident, not a feature. It is not a general repair tool and
// must not become one: the correct long-term fix is to stop `payment.failed` writing a
// terminal status and to widen the capture sweep, neither of which this file does.
//
// ═══ WHY IT CANNOT BE AIMED ANYWHERE ELSE ════════════════════════════════════
// The target is a module-level constant. The request body is never read, never parsed and
// never consulted — there is no code path by which any caller-supplied orderId, paymentId,
// amount, event, pass or phone can reach `recoverOrphanedCapture`. Pointing this route at a
// different payment requires editing this file and deploying, which is a reviewable act.

import { NextRequest, NextResponse } from 'next/server'
import { resolveSuperAdminUid }      from '@/lib/admin/auth'
import { recoverOrphanedCapture }    from '@/lib/payments/recoverOrphanedCapture'
import type { OrphanedCaptureTarget } from '@/lib/payments/recoverOrphanedCapture'

/**
 * The ONE case this route may settle. A frozen module constant, not a parameter.
 *
 * Every field is re-verified downstream — the amount and payment against Razorpay, the event,
 * pass, phone and status against the stored intent — so this constant is the target, not a
 * set of assumptions the recovery trusts.
 */
const TARGET: Readonly<OrphanedCaptureTarget> = Object.freeze({
  orderId:             'order_TS6MJY6uL9NgCw',
  paymentId:           'pay_TS6MPmXBJ9bHsj',
  expectedAmountPaise: 51840,
  expectedEventSlug:   'noyyal-marathon-2026',
  expectedPassId:      'pass_riwintpf',
  expectedPhone:       '9994349808',
})

export interface RecoverOrphanedCaptureResponse {
  success:        boolean
  /** Settlement outcome kind, or the verification that refused. Never contains secrets. */
  result?:        string
  registrationId?: string
  reason?:        string
  detail?:        string
  error?:         string
}

/**
 * Settle the single hard-coded orphaned capture.
 *
 * ═══ AUTHORIZATION ══════════════════════════════════════════════════════════
 * `resolveSuperAdminUid` — the narrower of the two existing admin mechanisms, and the one
 * already used for admin actions that create value. It accepts ONLY a uid listed in the
 * `ADMIN_UIDS` deployment configuration; the `admin: true` custom claim alone is not enough.
 * That matters here: the claim is data in Firebase and can be set by anything already holding
 * admin credentials, whereas widening `ADMIN_UIDS` requires a deploy. This route moves real
 * money into a real registration and credits an organizer wallet, so it is gated on the
 * mechanism a compromised admin session cannot widen.
 *
 * No new role, claim, permission or shared secret is introduced — this reuses what exists.
 *
 * ═══ IDEMPOTENCY ════════════════════════════════════════════════════════════
 * Inherited, not re-implemented. A second POST re-runs the same verification and is refused
 * (`intent_not_orphaned`, because the first run left the intent `paid` with a registrationId).
 * Even if two requests raced, the settlement transaction and the `ticketCodeClaims` write
 * admit exactly one.
 */
export async function POST(req: NextRequest): Promise<NextResponse<RecoverOrphanedCaptureResponse>> {
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // The body is deliberately NOT read. There is no parameter to inject.
  const outcome = await recoverOrphanedCapture(TARGET)

  // NO admin-audit write. `logAdminAction` takes a closed action/entityType taxonomy with no
  // payment-recovery member, and widening that shared union for a file this comment already
  // says to delete would outlive the scaffolding it serves. The recovery is traceable
  // regardless: the intent flips to `paid` with a registrationId and paymentId, a registration
  // and wallet ledger entry appear, a refused run records captureFinancialError, and the
  // request itself is in the platform request log.

  if (!outcome.ok) {
    // A refused verification is a 422, not a 500: nothing failed, the guard held.
    return NextResponse.json(
      { success: false, reason: outcome.reason, detail: outcome.detail },
      { status: 422 },
    )
  }

  // Sanitized: the settlement kind and the new registration id only. No intent document, no
  // attendee PII, no Razorpay payload, no configuration.
  const s = outcome.outcome
  return NextResponse.json({
    success: true,
    result:  s.kind,
    ...('registrationId' in s ? { registrationId: s.registrationId } : {}),
  })
}

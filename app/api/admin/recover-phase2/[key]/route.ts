// POST /api/admin/recover-phase2/[key]
//
// TEMPORARY, FIXED-SET execution surface for RD-RECOVER-01 phase 2.
//
// ═══ WHY THIS EXISTS ═════════════════════════════════════════════════════════
// Six further orphaned captures were confirmed against the Razorpay dashboard. Like the
// PRITHIVIK case, `recoverOrphanedCapture` needs the production Razorpay credentials to
// verify each capture, and those live only inside the deployed runtime. This is the door.
//
// ═══ DELETE THIS DIRECTORY ONCE ALL SIX HAVE RUN ═════════════════════════════
// Scaffolding for one incident, not a feature. The permanent fix is to stop `payment.failed`
// writing a terminal status and to widen the capture sweep — neither of which this file does.
//
// ═══ WHY IT CANNOT BE AIMED ANYWHERE ELSE ════════════════════════════════════
// `[key]` is the ONLY thing the caller controls, and it is not a target — it is a lookup into
// a frozen table of six. An unknown key is refused before any work. No orderId, paymentId,
// amount, event, pass or phone can be supplied by a caller: the request body is never read,
// the query string is never read, and every target field is a literal in this file. Aiming
// this at a different payment requires editing this file and deploying, which is reviewable.
//
// The PRITHIVIK order is deliberately absent, and a test asserts its absence — he is already
// recovered, and a second settlement must not be reachable from here even by mistake.

import { NextRequest, NextResponse }   from 'next/server'
import { resolveSuperAdminUid }        from '@/lib/admin/auth'
import { recoverOrphanedCapture }      from '@/lib/payments/recoverOrphanedCapture'
import type { OrphanedCaptureTarget }  from '@/lib/payments/recoverOrphanedCapture'

/**
 * The six cases this route may settle, keyed by an opaque slug.
 *
 * Every field is re-verified downstream — the payment and amount against Razorpay, the
 * event, pass, phone, amount and orphan status against the stored intent — so this table is
 * the target, not a set of assumptions the recovery trusts. Each `paymentId` was read from
 * the Razorpay dashboard's CAPTURED list by the operator and mapped to its order by hand;
 * the recovery still refuses (`payment_not_on_order` / `payment_not_captured`) if a mapping
 * is wrong, so a transcription error cannot settle the wrong payment.
 */
const TARGETS: Readonly<Record<string, Readonly<OrphanedCaptureTarget & { name: string }>>> = Object.freeze({
  'vishnu-vk': Object.freeze({
    name: 'VISHNU VK',
    orderId: 'order_TQtlyzWELP0jsL', paymentId: 'pay_TQtm5TfOul176u',
    expectedAmountPaise: 51840, expectedEventSlug: 'noyyal-marathon-2026',
    expectedPassId: 'pass_qbos3nch', expectedPhone: '8148466846',
  }),
  'elakiya-b': Object.freeze({
    name: 'Elakiya B',
    orderId: 'order_TRBehMbYBLGVIm', paymentId: 'pay_TRBenyUqLQHkze',
    expectedAmountPaise: 51840, expectedEventSlug: 'noyyal-marathon-2026',
    expectedPassId: 'pass_riwintpf', expectedPhone: '+918220011402',
  }),
  'paramasivam': Object.freeze({
    name: 'Paramasivam',
    orderId: 'order_TRRvMasMUbgrP0', paymentId: 'pay_TRRvV5vG3HvJgm',
    expectedAmountPaise: 51840, expectedEventSlug: 'noyyal-marathon-2026',
    expectedPassId: 'pass_qbos3nch', expectedPhone: '9842265331',
  }),
  'vishnu-kumar': Object.freeze({
    name: 'Vishnu Kumar',
    orderId: 'order_TRxCGSJuLdssXd', paymentId: 'pay_TRxCZNuS0SOuDo',
    expectedAmountPaise: 51840, expectedEventSlug: 'noyyal-marathon-2026',
    expectedPassId: 'pass_qbos3nch', expectedPhone: '8525800235',
  }),
  'kaaviyan': Object.freeze({
    name: 'Kaaviyan',
    orderId: 'order_TS5ovIHIUySOtd', paymentId: 'pay_TS66fjnImrHpWZ',
    expectedAmountPaise: 25920, expectedEventSlug: 'noyyal-marathon-2026',
    expectedPassId: 'pass_riwintpf', expectedPhone: '9751789744',
  }),
  'sampath-kumar': Object.freeze({
    name: 'A N Sampath Kumar',
    orderId: 'order_TS7WLg0h7eCYqY', paymentId: 'pay_TS7YpmBpWtRPW9',
    expectedAmountPaise: 51840, expectedEventSlug: 'noyyal-marathon-2026',
    expectedPassId: 'pass_qbos3nch', expectedPhone: '9443153434',
  }),
})

/** Keys in display order. Exported so the page and its tests cannot drift from this table. */
export const RECOVERY_KEYS = Object.freeze(Object.keys(TARGETS))

/** Matches the repo convention for dynamic route handlers (see admin/audit-logs/[id]). */
interface RouteContext {
  params: Promise<{ key: string }>
}

export interface RecoverPhase2Response {
  success:         boolean
  result?:         string
  registrationId?: string
  reason?:         string
  detail?:         string
  error?:          string
}

/**
 * Settle ONE of the six hard-coded orphaned captures.
 *
 * ═══ AUTHORIZATION ══════════════════════════════════════════════════════════
 * `resolveSuperAdminUid` — the narrower of the two existing admin mechanisms. It accepts
 * ONLY a uid listed in the `ADMIN_UIDS` deployment configuration; the `admin: true` custom
 * claim alone is not enough. This route moves real money into real registrations and credits
 * an organizer wallet, so it is gated on the mechanism a compromised admin session cannot
 * widen. No new role, claim, permission or shared secret is introduced.
 *
 * ═══ IDEMPOTENCY ════════════════════════════════════════════════════════════
 * Inherited, not re-implemented. A second POST for the same key re-runs the verification and
 * is refused (`intent_not_orphaned`, because the first run left the intent `paid` with a
 * registrationId). Even under a race, the settlement transaction and the `ticketCodeClaims`
 * write admit exactly one — so no duplicate registration, ticket, counter tick or wallet credit.
 */
export async function POST(
  req: NextRequest,
  ctx: RouteContext,
): Promise<NextResponse<RecoverPhase2Response>> {
  const adminUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (!adminUid) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // The key is a lookup, never a target. Anything not in the frozen table is refused here,
  // before Razorpay, Firestore or the settlement transaction are touched.
  const { key } = await ctx.params
  const target = Object.prototype.hasOwnProperty.call(TARGETS, key) ? TARGETS[key] : undefined
  if (!target) {
    return NextResponse.json({ success: false, error: 'Unknown target' }, { status: 404 })
  }

  // The body is deliberately NOT read. There is no parameter to inject.
  //
  // The six contract fields are listed explicitly rather than spread, so that the display-only
  // `name` cannot reach the recovery contract and any future field added to the table has to
  // be passed here deliberately rather than arriving by accident.
  const outcome = await recoverOrphanedCapture({
    orderId:             target.orderId,
    paymentId:           target.paymentId,
    expectedAmountPaise: target.expectedAmountPaise,
    expectedEventSlug:   target.expectedEventSlug,
    expectedPassId:      target.expectedPassId,
    expectedPhone:       target.expectedPhone,
  })

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

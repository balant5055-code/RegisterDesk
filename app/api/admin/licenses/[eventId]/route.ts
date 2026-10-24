// /api/admin/licenses/[eventId] — Admin License Console detail + actions.
//   GET  → full license detail (row + overlay + order + immutable timeline)
//   POST → apply an admin action (grant / lifecycle / override / upgrade-downgrade
//          / mark-paid / refund / reissue / note). Admin-only, server-validated,
//          audited. Confirmation + reason are enforced (reason required for all but
//          note; note requires text).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid, resolveSuperAdminUid } from '@/lib/admin/auth'
import { parseFinancialReason, reasonErrorResponse, requireSuperAdmin } from '@/lib/admin/financialGuard'
import {
  getLicenseDetail,
  applyLicenseAction,
  LicenseActionError,
} from '@/lib/admin/licenseAdminService'
import {
  LICENSE_ACTIONS_REQUIRING_REASON,
  type LicenseAdminActionRequest,
  type LicenseAdminActionType,
} from '@/lib/admin/licenseAdminTypes'

// RD-SA-COMMERCE-P1 (P1-2) — a refund request can never outlive this. Releasing a refund hold requires the
// hold to be older than REFUND_HOLD_MIN_RELEASE_AGE_MS (15 min), so the request that created it has
// ended — together with the attempt fence, a release can never race a refund still in flight.
// Pinned by tests/unit/licenceRefundHoldAge.test.ts; keep it well under 15 minutes.
export const maxDuration = 120

const VALID_ACTIONS: LicenseAdminActionType[] = [
  'grant', 'suspend', 'reactivate', 'cancel', 'upgrade', 'downgrade',
  'overridePrice', 'overrideLimit', 'overrideFeatures', 'markPaymentReceived',
  'refund', 'reissue', 'addNote',
  // EA-4 S1 — expiry / publish-governance overrides / consumption controls
  'extendExpiry', 'reduceExpiry', 'disableExpiry',
  'overridePublish', 'overrideIdentity', 'overrideRegistrationSafety',
  'forceConsume', 'resetLicense',
  // RD-SA-COMMERCE-P1 — release the hold of a refund that never moved money (Super Admin, reason, audited)
  'releaseRefundHold',
  'completeRefund',
  'acknowledgeRefundFailure',
]

/**
 * RD-EVENT-COMMERCE-04B — actions that change centrally controlled LICENCE PRICING. Super Admin
 * only (ADMIN_UIDS), decided from the verified token. Every other action keeps its existing
 * admin access (the confirmed rule covers pricing; other permissions are unchanged).
 * RD-PHASE4-S1 · C3 — `refund` moves money out (gateway refund + wallet credit-back), so it joins
 * the Super Admin set, like every other refund path (registration, donation, hold retry).
 */
// RD-PHASE4-S4 · D1 — every MUTATING licence action is Super Admin only (capacity overrides,
// mark-paid, reissue, expiry, governance overrides, force-consume, reset, lifecycle, features).
// The one exception is `addNote`, which changes nothing and stays open to any admin.
const SUPER_ADMIN_ACTIONS: readonly LicenseAdminActionType[] = VALID_ACTIONS.filter(a => a !== 'addNote')

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const { eventId } = await params
  try {
    const [detail, superUid] = await Promise.all([getLicenseDetail(eventId), resolveSuperAdminUid(req.headers.get('authorization'))])
    if (!detail) return NextResponse.json({ error: 'License not found' }, { status: 404 })
    // Server-decided, advisory for rendering; POST re-checks.
    return NextResponse.json({ ...detail, canEditPricing: superUid !== null }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/licenses] detail failed', e)
    return NextResponse.json({ error: 'Failed to load license detail' }, { status: 500 })
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { eventId } = await params

  let body: LicenseAdminActionRequest
  try {
    body = await req.json() as LicenseAdminActionRequest
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const action = body?.action
  if (!action || !VALID_ACTIONS.includes(action)) {
    return NextResponse.json({ error: 'Invalid or missing action' }, { status: 400 })
  }
  const superUid = await resolveSuperAdminUid(req.headers.get('authorization'))
  if (SUPER_ADMIN_ACTIONS.includes(action) && !superUid) {
    return NextResponse.json({
      error: action === 'refund' ? 'Only a Super Admin can refund a licence.'
        : action === 'overridePrice' ? 'Only a Super Admin can change licence pricing.'
        : 'Only a Super Admin can change a licence.',
      code: 'SUPER_ADMIN_REQUIRED',
    }, { status: 403 })
  }
  // Reason is mandatory for every mutating action (audit requirement). RD-PHASE4-S4 · D3 — 3–500 chars.
  if (LICENSE_ACTIONS_REQUIRING_REASON.includes(action)) {
    const r = parseFinancialReason(body.reason)
    if (!r.ok) return reasonErrorResponse(r)
    body = { ...body, reason: r.reason }
  }

  try {
    const result = await applyLicenseAction(eventId, body, adminUid, { actorRole: superUid ? 'super_admin' : 'admin' })
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof LicenseActionError) {
      // RD-SA-COMMERCE-P1 — machine-readable extras (REFUND_REVIEW_REQUIRED + assessment,
      // CONFIRMATION_REQUIRED + the field to confirm) ride beside the message.
      return NextResponse.json({ error: e.message, ...(e.details ?? {}) }, { status: e.status })
    }
    console.error('[admin/licenses] action failed', e)
    return NextResponse.json({ error: 'Action failed' }, { status: 500 })
  }
}

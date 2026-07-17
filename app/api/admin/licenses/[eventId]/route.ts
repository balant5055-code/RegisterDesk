// /api/admin/licenses/[eventId] — Admin License Console detail + actions.
//   GET  → full license detail (row + overlay + order + immutable timeline)
//   POST → apply an admin action (grant / lifecycle / override / upgrade-downgrade
//          / mark-paid / refund / reissue / note). Admin-only, server-validated,
//          audited. Confirmation + reason are enforced (reason required for all but
//          note; note requires text).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
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

const VALID_ACTIONS: LicenseAdminActionType[] = [
  'grant', 'suspend', 'reactivate', 'cancel', 'upgrade', 'downgrade',
  'overridePrice', 'overrideLimit', 'overrideFeatures', 'markPaymentReceived',
  'refund', 'reissue', 'addNote',
  // EA-4 S1 — expiry / publish-governance overrides / consumption controls
  'extendExpiry', 'reduceExpiry', 'disableExpiry',
  'overridePublish', 'overrideIdentity', 'overrideRegistrationSafety',
  'forceConsume', 'resetLicense',
]

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { eventId } = await params
  try {
    const detail = await getLicenseDetail(eventId)
    if (!detail) return NextResponse.json({ error: 'License not found' }, { status: 404 })
    return NextResponse.json(detail, { headers: { 'Cache-Control': 'no-store' } })
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
  // Reason is mandatory for every mutating action (audit requirement).
  if (LICENSE_ACTIONS_REQUIRING_REASON.includes(action) && !(body.reason ?? '').trim()) {
    return NextResponse.json({ error: 'A reason is required for this action' }, { status: 400 })
  }

  try {
    const result = await applyLicenseAction(eventId, body, adminUid)
    return NextResponse.json(result)
  } catch (e) {
    if (e instanceof LicenseActionError) {
      return NextResponse.json({ error: e.message }, { status: e.status })
    }
    console.error('[admin/licenses] action failed', e)
    return NextResponse.json({ error: 'Action failed' }, { status: 500 })
  }
}

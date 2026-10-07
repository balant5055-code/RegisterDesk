// PATCH /api/admin/organizers/[uid]/plan
// Body: { overrideTier?: EventLicenseTier | null, reason: string }
//
// Super Admin only (RD-PHASE4-S4 · D1), with a 3–500 character reason (D3). The change and its
// audit row commit in ONE transaction (D6) — a comp tier never exists without its record. Sets (or clears) a workspace ENTITLEMENT OVERRIDE tier — a support /
// comp lever stored at users/{uid}.entitlementOverrideTier. The override can only
// RAISE a workspace's effective entitlements above its highest active event license
// (see lib/licensing/workspaceEntitlements). Passing null clears it. There is no
// subscription plan or monthly billing involved.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { stageAdminAudit }           from '@/lib/admin/audit'
import { requireSuperAdmin, parseFinancialReason, reasonErrorResponse } from '@/lib/admin/financialGuard'
import { isEventLicenseTier, type EventLicenseTier } from '@/lib/licensing/eventLicense'

type Ctx = { params: Promise<{ uid: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  const adminUid = guard.uid

  const { uid } = await params

  let body: { overrideTier?: unknown; reason?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  // Distinguish "clear" (explicit null) from "not provided" and "set a tier".
  if (!('overrideTier' in body)) {
    return NextResponse.json({ error: 'overrideTier is required (a tier, or null to clear)' }, { status: 400 })
  }
  const clearing = body.overrideTier === null
  if (!clearing && !isEventLicenseTier(body.overrideTier)) {
    return NextResponse.json({ error: 'Invalid overrideTier' }, { status: 400 })
  }
  const newOverride: EventLicenseTier | null = clearing ? null : (body.overrideTier as EventLicenseTier)
  const r = parseFinancialReason(body.reason)
  if (!r.ok) return reasonErrorResponse(r)

  const ref = adminDb.doc(`users/${uid}`)
  const found = await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) return false
    const cur = snap.data() as { entitlementOverrideTier?: unknown }
    const prevOverride: EventLicenseTier | null = isEventLicenseTier(cur.entitlementOverrideTier) ? cur.entitlementOverrideTier : null

    tx.update(ref, {
      entitlementOverrideTier: newOverride === null ? FieldValue.delete() : newOverride,
      entitlementUpdatedAt:    FieldValue.serverTimestamp(),
      entitlementUpdatedBy:    adminUid,
      updatedAt:               FieldValue.serverTimestamp(),
    })

    if (newOverride !== prevOverride) {
      stageAdminAudit(tx, {
        adminUid, actorRole: 'super_admin', action: 'plan.changed', entityType: 'billing', entityId: uid,
        reason: r.reason,
        changedFields: ['entitlementOverrideTier'],
        before: { entitlementOverrideTier: prevOverride },
        after:  { entitlementOverrideTier: newOverride },
        metadata: { from: prevOverride, to: newOverride, kind: 'entitlement_override' },
        correlation: { organizerUid: uid },
      })
    }
    return true
  })
  if (!found) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })

  return NextResponse.json({ uid, overrideTier: newOverride })
}

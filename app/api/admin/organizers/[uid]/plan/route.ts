// PATCH /api/admin/organizers/[uid]/plan
// Body: { overrideTier?: EventLicenseTier | null }
//
// Admin-only. Sets (or clears) a workspace ENTITLEMENT OVERRIDE tier — a support /
// comp lever stored at users/{uid}.entitlementOverrideTier. The override can only
// RAISE a workspace's effective entitlements above its highest active event license
// (see lib/licensing/workspaceEntitlements). Passing null clears it. There is no
// subscription plan or monthly billing involved.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }                from 'firebase-admin/firestore'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { logAdminAction }            from '@/lib/admin/audit'
import { isEventLicenseTier, type EventLicenseTier } from '@/lib/licensing/eventLicense'

type Ctx = { params: Promise<{ uid: string }> }

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { uid } = await params

  let body: { overrideTier?: unknown }
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

  const ref  = adminDb.doc(`users/${uid}`)
  const snap = await ref.get()
  if (!snap.exists) return NextResponse.json({ error: 'Organizer not found' }, { status: 404 })

  const cur      = snap.data() as { entitlementOverrideTier?: unknown }
  const prevOverride: EventLicenseTier | null = isEventLicenseTier(cur.entitlementOverrideTier) ? cur.entitlementOverrideTier : null

  await ref.update({
    entitlementOverrideTier: newOverride === null ? FieldValue.delete() : newOverride,
    entitlementUpdatedAt:    FieldValue.serverTimestamp(),
    entitlementUpdatedBy:    adminUid,
    updatedAt:               FieldValue.serverTimestamp(),
  })

  if (newOverride !== prevOverride) {
    void logAdminAction({
      adminUid, action: 'plan.changed', entityType: 'billing', entityId: uid,
      metadata: { from: prevOverride, to: newOverride, kind: 'entitlement_override' },
    }).catch(() => {})
  }

  return NextResponse.json({ uid, overrideTier: newOverride })
}

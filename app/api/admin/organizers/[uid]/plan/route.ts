// PATCH /api/admin/organizers/[uid]/plan — RETIRED (RD-LEGACY-01).
//
// This set a workspace "comp" licence tier at users/{uid}.entitlementOverrideTier. RegisterDesk no
// longer has licence tiers or tier-based feature entitlements: every feature is available to every
// organizer, and registration capacity and prepaid services are bought per event. Nothing reads the
// override for any decision, so setting one would only create a misleading record.
//
// Kept as an explicit 410 (Super Admin gate first, so a non-admin learns nothing) rather than a 404,
// so an old admin client gets a clear answer. Nothing is read or written. Overrides stored before
// retirement stay on the user document as history (Organizer 360 shows them as inactive).

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const guard = await requireSuperAdmin(req)
  if (guard.response) return guard.response
  return NextResponse.json({
    error: 'Licence tiers are retired. Registration capacity and prepaid services are bought per event.',
    code:  'PLAN_RETIRED',
  }, { status: 410 })
}

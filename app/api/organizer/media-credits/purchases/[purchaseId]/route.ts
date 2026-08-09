// GET /api/organizer/media-credits/purchases/{purchaseId}
//
// One purchase, in full. READ ONLY — there is no PATCH or DELETE here, and that is a
// deliberate part of the design: a completed purchase is immutable, so the API offers no
// verb that could change one.
//
// A purchase belonging to another workspace returns 404, not 403 — the same answer as a
// purchaseId that does not exist, so the endpoint cannot be used to probe for real ids.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { purchaseService } from '@/features/media-credits/services/purchaseService'

type Params = { params: Promise<{ purchaseId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { purchaseId } = await params
  const purchase = await purchaseService.getPurchase(authz.workspaceUid, purchaseId)
  if (!purchase) return NextResponse.json({ error: 'Purchase not found' }, { status: 404 })

  return NextResponse.json({ purchase }, { headers: { 'Cache-Control': 'no-store' } })
}

// GET /api/organizer/media-credits/refunds/{refundId}
//
// One refund, in full. READ ONLY — there is no PATCH or DELETE, because an organizer cannot
// change a refund after asking for it and cannot approve their own.
//
// Another workspace's refund returns 404, the same as a nonexistent id.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { refundService } from '@/features/media-credits/services/refundService'

type Params = { params: Promise<{ refundId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { refundId } = await params
  const refund = await refundService.getRefundRequest(authz.workspaceUid, refundId)
  if (!refund) return NextResponse.json({ error: 'Refund not found' }, { status: 404 })

  return NextResponse.json({ refund }, { headers: { 'Cache-Control': 'no-store' } })
}

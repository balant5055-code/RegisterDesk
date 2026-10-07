// GET /api/admin/whatsapp-inbox/unmatched/[inboundId] — one unmatched message and the
// routing evidence behind it, for Super Admin inspection (Phase 1c). Read-only. Other
// people's phone numbers in the evidence are masked (lib/whatsapp-inbox/adminRead.ts).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { getUnmatched } from '@/lib/whatsapp-inbox/adminRead'
import type { UnmatchedDetailResponse } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ inboundId: string }> },
): Promise<NextResponse<UnmatchedDetailResponse>> {
  const gate = await authorizeSuperAdminInbox(req)
  if (!gate.ok) return gate.response as NextResponse<UnmatchedDetailResponse>

  const { inboundId } = await params
  try {
    const r = await getUnmatched(inboundId)
    if (r.status === 'not_found') {
      return NextResponse.json({ success: false, error: 'Unmatched message not found.' }, { status: 404, headers: NO_STORE })
    }
    return NextResponse.json({ success: true, item: r.item, evidence: r.evidence }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-inbox] unmatched detail failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load this message.' }, { status: 500, headers: NO_STORE })
  }
}

// GET /api/admin/whatsapp-inbox/unmatched — the Super Admin unmatched-message queue
// (Phase 1c). Query: reason (one of the routing reasons), cursor. Read-only: nothing here
// re-routes or reassigns a message.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeSuperAdminInbox } from '@/lib/whatsapp-inbox/adminAuthz'
import { listUnmatched } from '@/lib/whatsapp-inbox/adminRead'
import { UNROUTED_REASON_LABELS, type UnmatchedListResponse, type UnroutedReason } from '@/lib/whatsapp-inbox/types'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse<UnmatchedListResponse>> {
  const gate = await authorizeSuperAdminInbox(req)
  if (!gate.ok) return gate.response as NextResponse<UnmatchedListResponse>

  const p = req.nextUrl.searchParams
  const rawReason = p.get('reason') ?? ''
  if (rawReason && !Object.prototype.hasOwnProperty.call(UNROUTED_REASON_LABELS, rawReason)) {
    return NextResponse.json({ success: false, error: 'Unknown reason filter.' }, { status: 400, headers: NO_STORE })
  }
  try {
    const r = await listUnmatched({
      reason: (rawReason || undefined) as UnroutedReason | undefined,
      cursor: (p.get('cursor') ?? '').slice(0, 200) || undefined,
    })
    return NextResponse.json({ success: true, items: r.items, nextCursor: r.nextCursor }, { headers: NO_STORE })
  } catch (err) {
    console.error('[admin/whatsapp-inbox] unmatched list failed:', (err as Error)?.message)
    return NextResponse.json({ success: false, error: 'Could not load unmatched messages.' }, { status: 500, headers: NO_STORE })
  }
}

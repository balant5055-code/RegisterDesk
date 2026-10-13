// GET /api/organizer/events/[eventId]/print-badges — RD-PRINT-BILL-P6. READ-ONLY.
//
// The ID-badge summary for ONE published event (`eventId` = the event slug, as the badge quote and
// purchase routes take it): how badges are billed here, the event's prepaid units (available, used,
// reserved by running jobs) and whether units can be bought now. Writes nothing.
//
// Security: `certificates` — the permission that generates badges — so whoever can start a badge job
// can see the balance it draws on. The live event must belong to this workspace and name its draft.
// `purchase.canBuy` is advisory: buying stays owner-only and the purchase routes re-authorize.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintBadgeSummary, type PrintBadgeSummary } from '@/lib/printAssets/badgeBilling/summary'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export type PrintBadgeSummaryResponse =
  | { success: true; summary: PrintBadgeSummary }
  | { success: false; error: string; code?: string }

export async function GET(
  req: NextRequest, context: { params: Promise<{ eventId: string }> },
): Promise<NextResponse<PrintBadgeSummaryResponse>> {
  const { eventId: slug } = await context.params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status, headers: NO_STORE })
  try {
    const r = await getPrintBadgeSummary({ slug, workspaceUid: authz.workspaceUid, isOwner: authz.isOwner })
    if (!r.ok) return NextResponse.json({ success: false, error: r.error, code: r.code }, { status: r.status, headers: NO_STORE })
    return NextResponse.json({ success: true, summary: r.summary }, { headers: NO_STORE })
  } catch (e) {
    console.error('[print-badges/summary] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ success: false, error: 'Could not load ID badges. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}

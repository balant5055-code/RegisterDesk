// GET /api/admin/print-badges/generation-reconciliation — RD-PRINT-BILL-P7. Super Admin (ADMIN_UIDS)
// only; READ-ONLY.
//
// Platform view of ID-badge GENERATION billing, bounded and paged in document-id order:
//   ?source=rounds (default)  billing rounds — ?open=1 for open rounds only; open rounds are flagged
//                             STALE / JOB_ENDED / JOB_MISSING
//   ?source=ledgers           event ledgers that show badge activity
//   ?cursor=<nextCursor>  ?limit=<rounds 1–50 / ledgers 1–100>  ?reconcile=0 to skip reconciliation
// The page's events are reconciled with the Phase 5 reconcilePrintBadgeUsage, at most 5 per request;
// any others are listed as NOT checked (never shown as clean). A list view: not audited.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { getGenerationSweep, SWEEP_ROUND_PAGE_MAX, SWEEP_LEDGER_PAGE_MAX } from '@/lib/admin/printBadgeAdmin/generationSweep'
import { pageSize, CURSOR_RE } from '@/lib/admin/printBadgeAdmin/common'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const p = req.nextUrl.searchParams
  const sourceRaw = p.get('source')?.trim() || 'rounds'
  if (sourceRaw !== 'rounds' && sourceRaw !== 'ledgers') return NextResponse.json({ error: 'Invalid source' }, { status: 400, headers: NO_STORE })
  const cursor = p.get('cursor')?.trim() || null
  if (cursor && !CURSOR_RE.test(cursor)) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400, headers: NO_STORE })
  const max = sourceRaw === 'rounds' ? SWEEP_ROUND_PAGE_MAX : SWEEP_LEDGER_PAGE_MAX
  try {
    const view = await getGenerationSweep({
      source: sourceRaw, openOnly: p.get('open') === '1', cursor, limit: pageSize(p.get('limit'), max, max), reconcile: p.get('reconcile') !== '0',
    })
    return NextResponse.json(view, { headers: NO_STORE })
  } catch (e) {
    console.error('[admin/print-badges/generation-reconciliation] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Could not load generation reconciliation' }, { status: 500, headers: NO_STORE })
  }
}

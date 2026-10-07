// GET /api/admin/wallet-service-requests?kind=refund|carry_forward&status=submitted|approved|rejected|processed|all
//                                        &organizer=<uid>&service=whatsapp|certificates&event=<text>&from=&to=&cursor=
//
// RD-WALLET-REQ — the Super Admin queues of organizer refund / carry-forward requests
// (lib/wallet/serviceRequests.ts). `requireSuperAdmin` (ADMIN_UIDS only): a caller holding only the
// legacy `admin: true` claim gets 403 SUPER_ADMIN_REQUIRED and cannot list them.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { listAdminRequests } from '@/lib/wallet/serviceRequests'
import { isServiceRequestKind, isServiceRequestStatus, isRequestableService } from '@/lib/wallet/serviceRequestRules'
import { dayBound } from '@/lib/wallet/activityScan'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const bad = (error: string, code: string) => NextResponse.json({ error, code }, { status: 400, headers: NO_STORE })

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const sp = req.nextUrl.searchParams
  const kind = sp.get('kind') ?? 'refund'
  const status = sp.get('status') ?? 'submitted'
  if (!isServiceRequestKind(kind)) return bad('Invalid kind.', 'INVALID_KIND')
  if (status !== 'all' && !isServiceRequestStatus(status)) return bad('Invalid status.', 'INVALID_STATUS')
  const organizer = sp.get('organizer')?.trim() || null
  if (organizer !== null && !/^[A-Za-z0-9_.:@-]{1,128}$/.test(organizer)) return bad('Invalid organizer.', 'INVALID_ORGANIZER')
  const service = sp.get('service') || null
  if (service !== null && !isRequestableService(service)) return bad('Invalid service.', 'INVALID_SERVICE')
  const from = dayBound(sp.get('from'), 'start'), to = dayBound(sp.get('to'), 'end')
  if (from && to && from > to) return bad('The start date is after the end date.', 'INVALID_RANGE')
  try {
    return NextResponse.json(await listAdminRequests({
      kind, status, organizer, service, event: sp.get('event'), from, to, cursor: sp.get('cursor'),
    }), { headers: NO_STORE })
  } catch (err) {
    captureFinancialError(err, { scope: 'admin.wallet_service_requests.list' })
    return NextResponse.json({ error: 'Could not load requests. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}

// GET /api/admin/finance-reports?from&to&format=csv|xlsx|pdf|json
// Admin-only platform finance report (GMV / Fees / Refunds / Settlements / MRR / ARR).
// (Note: /api/admin/reports is the abuse-report queue — unrelated.)

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { buildAdminFinanceReport } from '@/lib/reports/adminBuilders'
import { serializeTables, isExportFormat } from '@/lib/reports/export'
import type { ReportFilters } from '@/lib/reports/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CLOSE — a financial read: Super Admin only (ADMIN_UIDS). A legacy `admin: true` claim
  // alone gets 403 SUPER_ADMIN_REQUIRED (lib/admin/financialGuard.ts).
  const superGate = await requireSuperAdmin(req)
  if (superGate.response) return superGate.response

  const p = req.nextUrl.searchParams
  const clean = (v: string | null) => { const s = (v ?? '').trim(); return s ? s.slice(0, 120) : undefined }
  const filters: ReportFilters = { from: clean(p.get('from')), to: clean(p.get('to')) }

  let table
  try {
    table = await buildAdminFinanceReport(filters)
  } catch (err) {
    console.error('[admin/finance-reports] build failed:', err)
    return NextResponse.json({ error: 'Could not build the report.' }, { status: 500 })
  }

  const format = p.get('format')
  if (!format || format === 'json') {
    return NextResponse.json({ table }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (!isExportFormat(format)) return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })

  const datePart = filters.from || filters.to ? `_${filters.from ?? 'start'}_${filters.to ?? 'now'}` : ''
  const out = await serializeTables([table], format, `platform-finance${datePart}`, { heading: 'Platform Finance Summary', sub: 'RegisterDesk admin report' })
  return new NextResponse(out.body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}

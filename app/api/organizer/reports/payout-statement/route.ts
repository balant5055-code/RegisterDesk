// GET /api/organizer/reports/payout-statement?from&to&format=pdf|json
//
// Owner/finance (settlements permission). Builds a payout statement (Gross / Fees
// / GST / Refunds / Net + settlement reference & date) from stored ledgers and
// renders it to PDF. format=json returns the raw statement for preview.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { buildPayoutStatement } from '@/lib/reports/builders'
import { payoutStatementPdf } from '@/lib/reports/pdf'
import type { ReportFilters } from '@/lib/reports/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'settlements')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const p = req.nextUrl.searchParams
  const clean = (v: string | null) => { const s = (v ?? '').trim(); return s ? s.slice(0, 120) : undefined }
  const filters: ReportFilters = { from: clean(p.get('from')), to: clean(p.get('to')) }

  let stmt
  try {
    stmt = await buildPayoutStatement(authz.workspaceUid, filters)
  } catch (err) {
    console.error('[payout-statement] build failed:', err)
    return NextResponse.json({ error: 'Could not build the statement.' }, { status: 500 })
  }

  const format = p.get('format')
  if (!format || format === 'json') {
    return NextResponse.json({ statement: stmt }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (format !== 'pdf') return NextResponse.json({ error: 'Only PDF export is supported.' }, { status: 400 })

  const pdf = await payoutStatementPdf(stmt)
  const datePart = filters.from || filters.to ? `_${filters.from ?? 'start'}_${filters.to ?? 'now'}` : ''
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="payout-statement${datePart}.pdf"`,
      'Cache-Control': 'no-store',
    },
  })
}

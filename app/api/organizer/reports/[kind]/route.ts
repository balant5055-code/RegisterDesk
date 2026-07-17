// GET /api/organizer/reports/[kind]?from&to&event&campaign&status&format=csv|xlsx|pdf|json
//
// Single workspace-aware endpoint for all organizer finance reports. Permission is
// resolved per report kind via the central registry (finance role → transactions/
// settlements/wallet). format=json returns the table for in-app preview; csv/xlsx/
// pdf stream a download.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { ORGANIZER_REPORTS } from '@/lib/reports/registry'
import { serializeTables, isExportFormat } from '@/lib/reports/export'
import type { ReportFilters } from '@/lib/reports/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function parseFilters(req: NextRequest): ReportFilters {
  const p = req.nextUrl.searchParams
  const clean = (v: string | null) => { const s = (v ?? '').trim(); return s ? s.slice(0, 120) : undefined }
  return { from: clean(p.get('from')), to: clean(p.get('to')), event: clean(p.get('event')), campaign: clean(p.get('campaign')), status: clean(p.get('status')) }
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ kind: string }> },
): Promise<NextResponse> {
  const { kind } = await context.params
  const meta = ORGANIZER_REPORTS[kind]
  if (!meta) return NextResponse.json({ error: 'Unknown report' }, { status: 404 })

  const authz = await authorizeWorkspace(req, meta.permission)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const filters = parseFilters(req)
  const formatParam = req.nextUrl.searchParams.get('format')

  let table
  try {
    table = await meta.build(authz.workspaceUid, filters)
  } catch (err) {
    console.error(`[reports/${kind}] build failed:`, err)
    return NextResponse.json({ error: 'Could not build the report.' }, { status: 500 })
  }

  if (!formatParam || formatParam === 'json') {
    return NextResponse.json({ table }, { headers: { 'Cache-Control': 'no-store' } })
  }
  if (!isExportFormat(formatParam)) {
    return NextResponse.json({ error: 'Unsupported format' }, { status: 400 })
  }

  const datePart = filters.from || filters.to ? `_${filters.from ?? 'start'}_${filters.to ?? 'now'}` : ''
  const out = await serializeTables([table], formatParam, `${kind}${datePart}`, { heading: meta.label, sub: 'RegisterDesk finance report' })
  return new NextResponse(out.body as BodyInit, {
    status: 200,
    headers: {
      'Content-Type': out.contentType,
      'Content-Disposition': `attachment; filename="${out.filename}"`,
      'Cache-Control': 'no-store',
      'X-Total-Count': String(table.rows.length),
    },
  })
}

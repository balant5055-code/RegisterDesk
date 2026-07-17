// GET /api/organizer/analytics/[eventId]  (owner-scoped)
//   ?format=json (default) → the full EventAnalytics payload for the dashboard.
//   ?format=csv|xlsx|pdf   → downloadable report (reuses lib/reports serializer).
//
// Read-only; derives from existing data (see lib/analytics/eventAnalytics).

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { getEventAnalytics, type EventAnalytics } from '@/lib/analytics/eventAnalytics'
import { serializeTables, isExportFormat } from '@/lib/reports/export'
import type { ReportTable } from '@/lib/reports/types'

function toTables(a: EventAnalytics): ReportTable[] {
  const k = a.kpis
  return [
    {
      id: 'summary', title: 'Summary',
      columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'value', label: 'Value', type: 'number' }],
      rows: [
        { metric: 'Registrations', value: k.registrations },
        { metric: 'Paid',          value: k.paid },
        { metric: 'Free',          value: k.free },
        { metric: 'Pending',       value: k.pending },
        { metric: 'Cancelled',     value: k.cancelled },
        { metric: 'Refunded',      value: k.refunded },
        { metric: 'Checked in',    value: k.checkedIn },
        { metric: 'Conversion %',  value: k.conversionPct },
        { metric: 'Capacity used %', value: k.capacityUsedPct },
      ],
    },
    {
      id: 'financial', title: 'Financial',
      columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money', align: 'right' }],
      rows: [
        { metric: 'Gross revenue',      amount: a.financial.grossPaise },
        { metric: 'Platform fee',       amount: a.financial.platformFeePaise },
        { metric: 'GST',                amount: a.financial.gstPaise },
        { metric: 'Gateway fee',        amount: a.financial.gatewayFeePaise },
        { metric: 'Net',                amount: a.financial.netPaise },
        { metric: 'Refunds',            amount: a.financial.refundsPaise },
        { metric: 'Communication cost', amount: a.financial.communicationCostPaise },
        { metric: 'Profit (est.)',      amount: a.financial.profitEstimatePaise },
      ],
    },
    {
      id: 'registrations_by_day', title: 'Registrations by day',
      columns: [{ key: 'date', label: 'Date', type: 'text' }, { key: 'registrations', label: 'Registrations', type: 'number' }, { key: 'revenue', label: 'Revenue', type: 'money', align: 'right' }],
      rows: a.registrationsByDay.map((d, i) => ({ date: d.label, registrations: d.value, revenue: a.revenueByDay[i]?.value ?? 0 })),
    },
    {
      id: 'pass_sales', title: 'Pass sales',
      columns: [{ key: 'pass', label: 'Pass', type: 'text' }, { key: 'sold', label: 'Sold', type: 'number' }, { key: 'revenue', label: 'Revenue', type: 'money', align: 'right' }],
      rows: a.passSales.map(p => ({ pass: p.label, sold: p.value, revenue: a.passRevenue.find(r => r.label === p.label)?.value ?? 0 })),
    },
  ]
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)

  const { eventId } = await params
  const result = await getEventAnalytics(eventId)
  if (!result) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  if (result.organizerUid !== ctx.workspaceUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const format = req.nextUrl.searchParams.get('format')
  if (isExportFormat(format)) {
    const out = await serializeTables(toTables(result.analytics), format, `analytics-${eventId}`, { heading: `Analytics — ${result.analytics.eventName}` })
    return new NextResponse(out.body as BodyInit, {
      headers: { 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' },
    })
  }

  return NextResponse.json({ analytics: result.analytics }, { headers: { 'Cache-Control': 'no-store' } })
}

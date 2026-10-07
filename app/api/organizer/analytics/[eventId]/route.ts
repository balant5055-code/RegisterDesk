// GET /api/organizer/analytics/[eventId]
//   ?format=json (default) → the full EventAnalytics payload for the dashboard.
//   ?format=csv|xlsx|pdf   → downloadable report (reuses lib/reports serializer).
//
// Read-only; derives from existing data (see lib/analytics/eventAnalytics).
//
// ═══ RD-ANALYTICS-02 · THE FINANCE BOUNDARY ══════════════════════════════════
//
// The base permission that correctly excluded gate staff still let two ordinary organizer
// roles — admin and manager, roles /api/organizer/finance refuses outright — read gross
// revenue, platform fee, GST, gateway fee, net settlement, coupon discount totals and a
// profit estimate.
//
// The split mirrors the dashboard's (RD-DASH-12): workspace membership opens the page,
// `transactions` opens the money. Money is ABSENT from the payload rather than zeroed, and
// the financial READS are never issued — so there is nothing to leak through JSON, an
// export, or a field a future client forgets to guard.
//
// RD-ANALYTICS-12-15 changed the FIRST half of that split only (see the handler). The
// money half is untouched and is what has always done the work: admin and manager still
// receive no financial section, and `finance` — which holds `transactions` — now reaches
// this route at all.
//
// ═══ RD-ANALYTICS-01 · AUTHORIZATION ═════════════════════════════════════════
//
// WHAT THIS USED TO DO, AND WHY IT MATTERED. The route verified a caller, resolved a
// workspace, ran getEventAnalytics() — five capped collection scans — and only THEN
// compared ownership. Two defects came out of that order:
//
//   • NO PERMISSION WAS REQUIRED. Membership alone was enough. `checkin_staff` holds
//     exactly ['checkin'] and passed, receiving gross revenue, platform fee, GST,
//     gateway fee, net settlement, the profit estimate, coupon discount totals,
//     communication spend and the workspace wallet balances.
//   • NO EVENT SCOPE. A member assigned to one event could read every event in the
//     workspace by changing the slug.
//
// The order is now: authenticate → workspace + gate-role exclusion → resolve the event's
// identity (ONE document) → ownership + event scope → only then compute. Gate-only roles
// are refused at the first step, before a single analytics read happens — by
// `isCheckinOnlyRole`, which is derived from the permission matrix, rather than by the
// `events` permission they happen not to hold (RD-ANALYTICS-12-15).
//
// Ownership, scope and "no such event" all answer with the SAME 403 and the same message,
// which is what authorizeEvent() does for the same reason: a probing caller must not be
// able to tell an event that is not theirs from one that does not exist.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace, requireEventScope } from '@/lib/team/workspace'
import {
  getEventAnalytics, resolveAnalyticsEventIdentity, type EventAnalytics,
} from '@/lib/analytics/eventAnalytics'
import type { MaybeMoney } from '@/lib/finance/financeAnalytics'
import { serializeTables, isExportFormat } from '@/lib/reports/export'
import type { ReportTable, ReportColumn } from '@/lib/reports/types'

/**
 * One row, or none at all.
 *
 * An unavailable figure is not exported as 0: once a number reaches a spreadsheet cell the
 * distinction between "measured zero" and "could not read" is unrecoverable, and the file
 * outlives the screen that could have explained it.
 */
const moneyRow = (metric: string, m: MaybeMoney): { metric: string; amount: number }[] =>
  m.ok ? [{ metric, amount: m.paise }] : []

/**
 * RD-ANALYTICS-03 · one summary row, or none.
 *
 * Counts are `number | null` now that they come from aggregates. A null exported as 0
 * would be indistinguishable from a measured zero in a spreadsheet, so the row is omitted
 * exactly as an unavailable money figure is.
 */
const countRow = (metric: string, v: number | null): { metric: string; value: number }[] =>
  v === null ? [] : [{ metric, value: v }]

function toTables(a: EventAnalytics): ReportTable[] {
  const k = a.kpis
  const f = a.financial
  return [
    {
      id: 'summary', title: 'Summary',
      // Disclose the CAP truncation in-file (the serializer appends a "limited to N
      // records" note) so a large-event export never silently under-reports.
      truncated: a.truncated,
      columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'value', label: 'Value', type: 'number' }],
      rows: [
        ...countRow('Registrations',   k.registrations),
        ...countRow('Confirmed',       k.confirmed),
        ...countRow('Pending',         k.pending),
        ...countRow('Cancelled',       k.cancelled),
        ...countRow('Rejected',        k.rejected),
        ...countRow('Waitlisted',      k.waitlisted),
        ...countRow('Paid',            k.paid),
        ...countRow('Free',            k.free),
        ...countRow('Payment pending', k.paymentPending),
        ...countRow('Refunded',        k.refunded),
        ...countRow('Refund pending',  k.refundPending),
        ...countRow('Checked in',      k.checkedIn),
        ...countRow('Conversion %',    k.conversionPct),
        ...countRow('Capacity used %', k.capacityUsedPct),
      ],
    },
    // The whole section is absent for a caller without `transactions` — the same rule the
    // JSON follows, so UI and export cannot disagree about who may see money.
    ...(f ? [{
      id: 'financial', title: 'Financial',
      columns: [{ key: 'metric', label: 'Metric', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money', align: 'right' }] as ReportColumn[],
      rows: [
        ...moneyRow('Confirmed ticket revenue', f.confirmedRevenuePaise),
        ...moneyRow('Gross collected (gateway)', f.grossPaise),
        ...moneyRow('Platform fee',       f.platformFeePaise),
        ...moneyRow('GST',                f.gstPaise),
        ...moneyRow('Gateway fee',        f.gatewayFeePaise),
        ...moneyRow('Net settlement',     f.netPaise),
        ...moneyRow('Refunds completed',  f.refundsPaise),
        ...moneyRow('Communication cost', f.communicationCostPaise),
        ...moneyRow('Est. profit (net − refunds − comms)', f.profitEstimatePaise),
      ],
    }] : []),
    // Both day/pass tables keep their non-financial columns and drop the money column
    // entirely when gated, rather than exporting a column of zeros.
    // Absent entirely when the rollups could not be read — an exported column of zeros
    // would claim 30 quiet days.
    ...(a.registrationsByDay ? [{
      id: 'registrations_by_day', title: 'Registrations by day',
      columns: [
        { key: 'date', label: 'Date', type: 'text' },
        { key: 'registrations', label: 'Registrations', type: 'number' },
        ...(a.revenueByDay ? [{ key: 'revenue', label: 'Revenue', type: 'money', align: 'right' }] : []),
      ] as ReportColumn[],
      rows: a.registrationsByDay.map((d, i) => ({
        date: d.label, registrations: d.value,
        ...(a.revenueByDay ? { revenue: a.revenueByDay[i]?.value ?? 0 } : {}),
      })),
    }] : []),
    {
      id: 'pass_sales', title: 'Pass sales',
      columns: [
        { key: 'pass', label: 'Pass', type: 'text' },
        { key: 'sold', label: 'Sold', type: 'number' },
        ...(a.passRevenue ? [{ key: 'revenue', label: 'Revenue', type: 'money', align: 'right' }] : []),
      ] as ReportColumn[],
      rows: a.passSales.map(p => ({
        pass: p.label, sold: p.value,
        ...(a.passRevenue ? { revenue: a.passRevenue.find(r => r.label === p.label)?.value ?? 0 } : {}),
      })),
    },
  ]
}

/**
 * ONE message for "not yours", "not assigned to you" and "does not exist".
 *
 * Mirrors authorizeEvent()'s wording for the same reason: three distinguishable answers
 * would let a caller enumerate the events of other workspaces one slug at a time.
 */
const DENIED = 'You are not assigned to this event.'

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  /**
   * 1–3. Authenticate, resolve the workspace, exclude gate-only roles.
   *
   * RD-ANALYTICS-12-15 · was `authorizeWorkspace(req, 'events')`. The header above records
   * why `events` was picked: it "correctly excluded gate staff". That is a statement about
   * gate roles, not about event management — and `authorizeAnyWorkspace` makes it directly,
   * through `isCheckinOnlyRole`, without borrowing a permission whose other 28 call sites
   * are mutations. Gate-only roles still stop here, before any read.
   *
   * The finance boundary at step 5 is unchanged and still decides who sees money, so the
   * split this route's header describes — "`events` opens the page, `transactions` opens the
   * money" — becomes "workspace membership opens the page, `transactions` opens the money".
   * The money half is the half that was doing the work.
   */
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { eventId } = await params

  // 4. Authorize the EVENT itself. One document read — the bridge doc that carries the
  //    owning workspace and the eventDraft id. This is identity resolution, not analytics.
  const identity = await resolveAnalyticsEventIdentity(eventId)

  // Ownership and event assignment share one answer with "no such event", so the response
  // cannot be used to enumerate other workspaces' events.
  const denied = !identity
    || identity.organizerUid !== authz.workspaceUid
    || !requireEventScope(authz, identity.draftId ?? eventId)
  if (denied) return NextResponse.json({ error: DENIED }, { status: 403 })

  // 5. Only now is the analytics computation allowed to run — and it is told, up front,
  //    whether this caller may be shown money. The SAME permission /api/organizer/finance
  //    requires, so the two endpoints agree about who sees what.
  const financeAllowed = authz.permissions.includes('transactions')
  // RD-ANALYTICS-12-32 · reuse the document resolved and authorized above; no second read.
  const result = await getEventAnalytics(eventId, { includeFinancial: financeAllowed, eventDocument: identity!.document })
  if (!result) return NextResponse.json({ error: DENIED }, { status: 403 })

  const format = req.nextUrl.searchParams.get('format')
  if (isExportFormat(format)) {
    const out = await serializeTables(toTables(result.analytics), format, `analytics-${eventId}`, { heading: `Analytics — ${result.analytics.eventName}` })
    return new NextResponse(out.body as BodyInit, {
      headers: { 'Content-Type': out.contentType, 'Content-Disposition': `attachment; filename="${out.filename}"`, 'Cache-Control': 'no-store' },
    })
  }

  return NextResponse.json({ analytics: result.analytics }, { headers: { 'Cache-Control': 'no-store' } })
}

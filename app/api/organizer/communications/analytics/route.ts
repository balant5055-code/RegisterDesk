// GET /api/organizer/communications/analytics — RD-COMMS-ANALYTICS-02
//
// Communication Center › Analytics: outcome totals, trends, channel / type / template performance,
// WhatsApp capacity and data-backed insights for ONE event (eventId = draft id) or, with
// eventId=all, the whole workspace. READ-ONLY: it sends, charges and changes nothing.
//
// Query: eventId (draft id | 'all') · range (7d | 30d | 90d | custom) · from, to (YYYY-MM-DD, custom)
//        channel (all | email | whatsapp) · type (a notification category) · format=csv
//
// Auth: the Communication Center's permission (`broadcasts`). One event → authorizeEvent (an
// event-restricted team member sees only assigned events). 'all' → refused for event-restricted
// members, who may not see workspace-wide figures. The workspace uid is always server-derived.
// CSV: aggregates only — no recipient names, emails or phone numbers.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeEvent, authorizeWorkspace } from '@/lib/team/workspace'
import { checkRateLimit } from '@/lib/rateLimit'
import { captureError } from '@/lib/monitoring/sentry'
import { getCommunicationAnalytics, AnalyticsError } from '@/lib/communications/organizerAnalytics/read'
import { analyticsCsv } from '@/lib/communications/organizerAnalytics/compute'
import { TYPE_CATEGORY_LABEL, type ChannelFilter, type RangePreset, type TypeCategory } from '@/lib/communications/organizerAnalytics/types'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }
const RANGES = new Set<RangePreset>(['7d', '30d', '90d', 'custom'])
const CHANNELS = new Set<ChannelFilter>(['all', 'email', 'whatsapp'])

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = req.nextUrl.searchParams
  const eventParam = sp.get('eventId') ?? ''
  const all = eventParam === 'all'
  if (!all && !/^[A-Za-z0-9_-]{1,128}$/.test(eventParam)) {
    return NextResponse.json({ error: 'Select an event.' }, { status: 400, headers: NO_STORE })
  }
  const range = (sp.get('range') ?? '30d') as RangePreset
  const channel = (sp.get('channel') ?? 'all') as ChannelFilter
  const typeRaw = sp.get('type')
  if (!RANGES.has(range)) return NextResponse.json({ error: 'Unknown range.' }, { status: 400, headers: NO_STORE })
  if (!CHANNELS.has(channel)) return NextResponse.json({ error: 'Unknown channel.' }, { status: 400, headers: NO_STORE })
  if (typeRaw && !(typeRaw in TYPE_CATEGORY_LABEL)) return NextResponse.json({ error: 'Unknown notification type.' }, { status: 400, headers: NO_STORE })

  const authz = all ? await authorizeWorkspace(req, 'broadcasts') : await authorizeEvent(req, 'broadcasts', eventParam)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status, headers: NO_STORE })
  if (all && !authz.isOwner && authz.eventIds.length > 0) {
    return NextResponse.json({ error: 'You can view analytics only for the events assigned to you.' }, { status: 403, headers: NO_STORE })
  }
  const rl = checkRateLimit(authz.callerUid, 'communication-analytics', 60, 10 * 60 * 1000)
  if (rl.limited) return NextResponse.json({ error: 'Too many requests. Please wait a moment.' }, { status: 429, headers: NO_STORE })

  try {
    const data = await getCommunicationAnalytics({
      uid: authz.workspaceUid, eventId: all ? null : eventParam,
      range, from: sp.get('from'), to: sp.get('to'), channel, type: (typeRaw as TypeCategory | null) ?? null,
    })
    if (sp.get('format') === 'csv') {
      const name = `communication-analytics-${data.current.from}-to-${data.current.to}.csv`
      return new NextResponse(analyticsCsv(data), {
        headers: { ...NO_STORE, 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` },
      })
    }
    return NextResponse.json(data, { headers: NO_STORE })
  } catch (err) {
    if (err instanceof AnalyticsError) return NextResponse.json({ error: err.message }, { status: err.status, headers: NO_STORE })
    captureError(err, { scope: 'organizer.communications.analytics' })
    return NextResponse.json({ error: 'Could not load analytics. Please try again.' }, { status: 500, headers: NO_STORE })
  }
}

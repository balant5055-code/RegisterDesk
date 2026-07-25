// GET /admin/communications/insights — the canonical Communication Insights Engine
// (admin-only, READ-ONLY). Derives actionable insights from Analytics + Health + Registry +
// Templates. Supports severity / category / provider / notification / status filters. No
// mutation, remediation, or automation. RD-PLATFORM-COMMS-01 Phase 4H.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { resolveCommunicationInsights } from '@/lib/communications/insights/resolve'
import type { InsightFilters, InsightSeverity, InsightCategory, InsightStatus } from '@/lib/communications/insights/types'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  try {
    const q = req.nextUrl.searchParams
    const filters: InsightFilters = {
      severity:     (q.get('severity') as InsightSeverity | null) ?? undefined,
      category:     (q.get('category') as InsightCategory | null) ?? undefined,
      status:       (q.get('status')   as InsightStatus   | null) ?? undefined,
      provider:     q.get('provider')     ?? undefined,
      notification: q.get('notification') ?? undefined,
    }
    const data = await resolveCommunicationInsights(filters)
    return NextResponse.json({ data }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (e) {
    console.error('[admin/communications/insights] failed', e)
    return NextResponse.json({ error: 'Failed to load' }, { status: 500 })
  }
}

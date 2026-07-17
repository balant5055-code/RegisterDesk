// GET /api/admin/events/[slug]/governance — Event 360 Governance workspace data.
//
// Admin-gated read. Resolves the event → its immutable Event ID (draftId) →
// REUSES getBaseline (publish governance baseline + overrides) and getLicenseDetail
// (license row + overlay + order + immutable history). Read-only: every governance
// / license MUTATION is performed by the console through the EXISTING admin routes
// (POST /api/admin/licenses/[slug]), so no mutation logic is duplicated here.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }                   from '@/lib/firebase/admin'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { getLicenseDetail }          from '@/lib/admin/licenseAdminService'
import { getBaseline }               from '@/lib/events/governance/baseline'
import type { Event360Governance, GovernanceBaselineView } from '@/lib/admin/event360Types'

interface RouteContext { params: Promise<{ slug: string }> }

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    try { return (ts as { toDate: () => Date }).toDate().toISOString() } catch { return null }
  }
  return null
}
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

export async function GET(req: NextRequest, ctx: RouteContext): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { slug } = await ctx.params

  const eventSnap = await adminDb.collection('events').doc(slug).get()
  if (!eventSnap.exists) return NextResponse.json({ error: 'Event not found' }, { status: 404 })
  const ev      = eventSnap.data() as Record<string, unknown>
  const draftId = str(ev.draftId) ?? slug

  const [baseline, license] = await Promise.all([
    getBaseline(draftId).catch(() => null),
    getLicenseDetail(slug).catch(() => null),
  ])

  const baselineView: GovernanceBaselineView | null = baseline ? {
    eventId:          baseline.eventId,
    firstPublishedAt: tsToISO(baseline.firstPublishedAt),
    publishCount:     baseline.publishCount ?? 0,
    identity: baseline.identity ? {
      name:      str(baseline.identity.name),
      city:      str(baseline.identity.city),
      startDate: str(baseline.identity.startDate),
      eventType: str(baseline.identity.eventType),
    } : null,
    overrides: {
      publish:            baseline.overrides?.publish === true,
      identity:           baseline.overrides?.identity === true,
      registrationSafety: baseline.overrides?.registrationSafety === true,
    },
  } : null

  return NextResponse.json({ baseline: baselineView, license } satisfies Event360Governance, {
    headers: { 'Cache-Control': 'no-store' },
  })
}

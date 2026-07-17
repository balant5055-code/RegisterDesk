// GET /api/organizer/events/[eventId]/identifiers/migration
//
// Organizer-scoped, READ-ONLY migration status for THIS event: migration-ready %,
// duplicate IDs, orphans, conflicts and the repair plan. Reuses the H.1.5A
// analyzer scoped to the single event slug — no writes, no admin access.

import { NextRequest, NextResponse } from 'next/server'
import { runMigrationAudit } from '@/lib/identifiers/migrationAudit/analyzer'
import { resolveIdentifierScope } from '@/lib/identifiers/organizerScope'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, ctx: { params: Promise<{ eventId: string }> }): Promise<NextResponse> {
  const { eventId } = await ctx.params
  const scope = await resolveIdentifierScope(req, eventId)
  if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

  // Scoped to this event only — the analyzer reads just this slug's data.
  const report = await runMigrationAudit({ eventSlug: scope.slug, generatedAt: new Date().toISOString() })
  const event = report.events[0] ?? null

  return NextResponse.json({
    readOnly:   true,
    eventSlug:  scope.slug,
    summary:    report.summary,
    event,      // per-event detail: readiness, duplicates, orphans, conflicts, repairPlan
  }, { headers: { 'Cache-Control': 'no-store' } })
}

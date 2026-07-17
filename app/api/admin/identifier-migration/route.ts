// GET /api/admin/identifier-migration
//
// Phase H.1.5A — Migration Safety Layer.
// Admin-only, COMPLETELY READ-ONLY dry-run analysis of the legacy Bib data.
// Produces a structured migration-readiness report. Writes nothing.
//
// Query params:
//   eventSlug — optional; restrict the audit to a single event (else platform-wide)
//   download  — when '1' / 'true', sets a Content-Disposition so the JSON saves to a file
//
// Auth: same Bearer-token admin check used across /api/admin/*.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { runMigrationAudit }         from '@/lib/identifiers/migrationAudit/analyzer'

// This route reads live Firestore data per request — never prerender / cache it.
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const sp        = req.nextUrl.searchParams
  const eventSlug = sp.get('eventSlug')?.trim() || undefined
  const download  = sp.get('download') === '1' || sp.get('download') === 'true'

  let report
  try {
    report = await runMigrationAudit({
      eventSlug,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    console.error('[identifier-migration] audit failed:', err)
    return NextResponse.json({ error: 'Audit failed. See server logs.' }, { status: 500 })
  }

  const headers: Record<string, string> = { 'Cache-Control': 'no-store' }
  if (download) {
    const stamp = report.generatedAt.slice(0, 10)
    const scope = eventSlug ? eventSlug : 'platform'
    headers['Content-Disposition'] =
      `attachment; filename="identifier-migration-${scope}-${stamp}.json"`
  }

  return NextResponse.json(report, { headers })
}

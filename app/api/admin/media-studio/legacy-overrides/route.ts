// GET  /api/admin/media-studio/legacy-overrides        — what the cleanup would find
// POST /api/admin/media-studio/legacy-overrides        — run it  { "confirm": true }
//
// MS-SETTINGS-02. Removes platform-limit overrides written through the organizer flow before
// MS-SETTINGS-01 closed it.
//
// ADMIN ONLY, via the same `resolveAdminUid` gate every other /api/admin route uses. This is
// deliberately not an organizer surface: the data being removed is data organizers granted
// themselves, so they are the last party who should be able to trigger — or skip — the fix.
//
// ═══ WHY A ROUTE AND NOT A SCRIPT ════════════════════════════════════════════
// A script needs credentials on disk. This repository has none, and putting a service-account
// key on a laptop to run a one-off cleanup is a worse trade than an authenticated,
// audit-logged endpoint that works in every environment.
//
// ═══ GET IS SAFE ANYWHERE ════════════════════════════════════════════════════
// The audit writes nothing, so it can be run against production to answer "is there anything
// to clean" before anyone decides to clean it. POST requires an explicit `confirm: true`;
// without it the endpoint dry-runs and returns the identical report.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { logAdminAction } from '@/lib/admin/audit'
import {
  auditLegacyOverrides, cleanLegacyOverrides,
} from '@/features/media-studio/services/legacyOverrideAudit'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const raw   = Number(req.nextUrl.searchParams.get('limit') ?? '500')
  const limit = Number.isFinite(raw) ? Math.min(Math.max(1, Math.trunc(raw)), 2000) : 500

  const audit = await auditLegacyOverrides({ limit })
  return NextResponse.json(audit, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let confirm = false
  let limit   = 500
  try {
    const body = await req.json() as Record<string, unknown>
    confirm = body.confirm === true
    if (typeof body.limit === 'number') {
      limit = Math.min(Math.max(1, Math.trunc(body.limit)), 2000)
    }
  } catch {
    // No body is a dry run — the safe reading of an ambiguous request.
  }

  const result = await cleanLegacyOverrides({ limit, dryRun: !confirm })

  // Audited only when something was actually removed. Logging a dry run would fill the trail
  // with actions that never happened.
  if (confirm && result.eventsCleaned > 0) {
    await logAdminAction({
      adminUid,
      action:     'platform_settings.updated',
      entityType: 'platform_settings',
      entityId:   'media-studio:legacy-overrides',
      metadata: {
        sprint:            'MS-SETTINGS-02',
        workspacesTouched: result.workspacesTouched,
        eventsCleaned:     result.eventsCleaned,
        entriesRemoved:    result.entriesRemoved,
        keysRemoved:       result.keysRemoved,
        keysPreserved:     result.keysPreserved,
      },
    })
  }

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}

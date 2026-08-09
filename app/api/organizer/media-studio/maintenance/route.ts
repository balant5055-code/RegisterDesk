// GET  /api/organizer/media-studio/maintenance  — what maintenance would find
// POST /api/organizer/media-studio/maintenance  — run it now
//
// RD-MEDIA-05. The manual trigger for the pipeline that `/api/cron/media-jobs` would run on
// a schedule. Both call `runMediaMaintenance`; neither contains any of its logic.
//
// ═══ PLATFORM ADMIN ONLY ══════════════════════════════════════════════════════
// It sits under the Media Studio route tree, but it is NOT authorized like the rest of it.
// The operation is platform-wide by construction — the bulk queue and the reclamation query
// are both unscoped — so an organizer running it would advance other workspaces' batches and
// see counts spanning every tenant.
//
// Two ways to resolve that: scope the operation (a new index plus a tenant-iterating driver
// — a backend redesign), or gate the trigger. This gates the trigger, using the platform's
// existing `resolveAdminUid`. No new role, no new permission.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import {
  getMaintenanceStatus, runMediaMaintenance,
  type MaintenanceRun, type MaintenanceStatus,
} from '@/features/media-studio/services/maintenanceService'

/** Long enough for a full chunk of bulk work plus a reclamation sweep. */
export const maxDuration = 60
export const dynamic     = 'force-dynamic'

export type MaintenanceStatusResponse = MaintenanceStatus
export interface MaintenanceRunResponse { run: MaintenanceRun; status: MaintenanceStatus }

const NO_STORE = { 'Cache-Control': 'no-store, private' }

async function requirePlatformAdmin(req: NextRequest): Promise<string | null> {
  return resolveAdminUid(req.headers.get('authorization'))
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await requirePlatformAdmin(req)
  if (!adminUid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  const body: MaintenanceStatusResponse = await getMaintenanceStatus()
  return NextResponse.json(body, { headers: NO_STORE })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await requirePlatformAdmin(req)
  if (!adminUid) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: NO_STORE })
  }

  // The service never throws and reports its own failures, so a caller always gets a run
  // report rather than an error — including the "storage is not configured" case, which is
  // a real answer and not a 500.
  const run = await runMediaMaintenance({ trigger: 'manual', ranBy: adminUid })

  // Re-read AFTER the run so the panel shows what is left, not what there was. The two are
  // different numbers and the difference is the point.
  const status = await getMaintenanceStatus()

  const body: MaintenanceRunResponse = { run, status }
  return NextResponse.json(body, { headers: NO_STORE })
}

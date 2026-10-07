// GET /api/organizer/reports/history
//
// RD-ANALYTICS-12-11 — the Reports History feed: the caller's workspace export jobs,
// newest first, permission-filtered, keyset-paginated.
//
// ═══ WHY THIS ROUTE EXISTS ═══════════════════════════════════════════════════
// A background export was only ever visible in the React state of the tab that started it.
// Refresh the page and a completed report became unreachable — the job document and the
// artifact both still there, with nothing able to name them. History is the reader that was
// missing, not a second export system: it queries the same `reportExportJobs` collection the
// create/poll/process/cancel/download routes already use.
//
// ═══ ROUTE PLACEMENT ═════════════════════════════════════════════════════════
// `history` is a static sibling of the dynamic `[kind]` segment, which in the App Router
// takes precedence over it — the same shape `exports/` already has here. No report kind is
// named `history`, so nothing is shadowed.
//
// Security: `authorizeAnyWorkspace` (which excludes gate-only roles) resolves the workspace
// server-side, and every row is then gated by the report's own permission through
// `permissionForExportJob`. Nothing about this route is a new authorization model.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import {
  readReportHistory, decodeHistoryCursor, HISTORY_PAGE_SIZE,
  type ReportHistoryEntry,
} from '@/lib/reports/history'

export type { ReportHistoryEntry }

export type ReportHistoryResponse =
  | { success: true;  jobs: ReportHistoryEntry[]; nextCursor: string | null; hasMore: boolean }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<ReportHistoryResponse>> {
  /**
   * The same boundary the sibling export routes use, and for the same reason: it excludes
   * gate-only roles, whose entire grant is `checkin`. A permissionless surface is still an
   * organizer surface, and a list of financial exports is not a gate operator's business.
   */
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const url = new URL(req.url)
  const rawCursor = url.searchParams.get('cursor')
  // Validated server-side. A cursor that does not decode is rejected rather than ignored:
  // silently restarting from the newest row would present the first page again and read as
  // a History that never ends.
  if (rawCursor && !decodeHistoryCursor(rawCursor)) {
    return NextResponse.json({ success: false, error: 'Invalid cursor' }, { status: 400 })
  }

  // The client may ask for less, never more. Offset pagination is not offered at all —
  // there is no `page` or `skip` parameter to supply.
  const limitParam = Number(url.searchParams.get('limit'))
  const pageSize = Number.isFinite(limitParam) && limitParam > 0
    ? Math.min(Math.floor(limitParam), HISTORY_PAGE_SIZE)
    : HISTORY_PAGE_SIZE

  try {
    const page = await readReportHistory({
      workspaceUid: authz.workspaceUid,   // from the session — never from the request
      callerUid:    authz.callerUid,
      permissions:  authz.permissions,
      cursor:       rawCursor,
      pageSize,
    })
    return NextResponse.json(
      { success: true, jobs: page.entries, nextCursor: page.nextCursor, hasMore: page.hasMore },
      // A financial artifact index, scoped to one caller's permissions: never cached.
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    // The Firestore message can name the collection, the index it wants and the project.
    // It belongs in the server log, not in the response.
    console.error('[reports/history] read failed:', err)
    return NextResponse.json({ success: false, error: 'Could not load report history.' }, { status: 500 })
  }
}

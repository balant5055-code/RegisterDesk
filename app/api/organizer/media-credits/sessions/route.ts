// GET /api/organizer/media-credits/sessions
//
// MC-07. The workspace's recent upload sessions, newest first. READ ONLY.
//
// ═══ WHY THIS ROUTE EXISTS NOW ═══════════════════════════════════════════════
// MC-06A built `sessionService.listSessions` and never routed it, because nothing needed it:
// the Import page owns the session it describes and can report its own state. A dashboard
// cannot — a session opened in another tab is invisible to it. This routes the existing
// service and adds no logic of its own.
//
// ═══ NO MUTATION HERE ════════════════════════════════════════════════════════
// This route is read-only. Sessions are opened by the upload path and resolved by the
// scheduler; an endpoint that could seal or settle one ARBITRARILY would be a second way to
// move credits, which the architecture forbids.
//
// MC-10.6 refined that, and it is worth stating precisely rather than leaving the sentence
// above to read as an absolute. `sessions/{id}/release` lets the OWNER advance their own
// session along its one legal path — ACTIVE → SEALED → SETTLED — by calling the same
// `sealSession` and `settleSession` the sweep calls. It cannot skip settlement, cannot
// release a hold without charging for what was consumed, and cannot touch another
// workspace's session. The rule was never "no organizer may end a session"; it was "nothing
// may bypass settlement", and that still holds.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { listSessions } from '@/features/media-credits/services/sessionService'
import { getCreditPolicy } from '@/features/media-credits/services'

const DEFAULT_LIMIT = 10
const MAX_LIMIT     = 50

export async function GET(req: NextRequest): Promise<NextResponse> {
  // `wallet`, matching every other media-credits organizer endpoint. A session's allocation
  // is a financial hold, so it sits with the balance rather than with the media permission.
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const url    = new URL(req.url)
  const raw    = Number(url.searchParams.get('limit') ?? DEFAULT_LIMIT)
  const limit  = Math.min(Math.max(1, Number.isFinite(raw) ? Math.trunc(raw) : DEFAULT_LIMIT), MAX_LIMIT)
  const cursor = url.searchParams.get('cursor')

  const [policy, page] = await Promise.all([
    getCreditPolicy(),
    // Tenant-scoped inside the service; the cursor is checked there too, so a caller cannot
    // page from another workspace's sessionId.
    listSessions(authz.workspaceUid, limit, cursor),
  ])

  return NextResponse.json({
    ...page,
    // Reported so a client can tell "no sessions yet" from "credits are switched off".
    creditsEnabled: policy.creditsEnabled,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

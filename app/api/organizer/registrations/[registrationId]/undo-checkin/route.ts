// POST /api/organizer/registrations/[registrationId]/undo-checkin
//
// Reverts a check-in: clears checkedIn flag, removes check-in fields,
// decrements registrationCounters/{slug}.checkedInCount, writes audit entry.
// Idempotent — safe to call if already not checked in.

import { NextRequest, NextResponse }  from 'next/server'
import { authorizeWorkspace }           from '@/lib/team/workspace'
import { uncheckInRegistration, loadOwnedRegistration } from '@/lib/firebase/firestore/registrations'

export interface UndoCheckInResponse {
  success: boolean
  error?:  string
}

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<UndoCheckInResponse>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const authz = await authorizeWorkspace(req, 'registrations')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid
  const callerUid = authz.callerUid

  const { registrationId } = await context.params

  // ── 2. Load + ownership (canonical resolver, M7) ───────────────────────────
  const owned = await loadOwnedRegistration(registrationId, uid)
  if (!owned.ok) return NextResponse.json({ success: false, error: owned.error }, { status: owned.status })

  // ── 3. Canonical undo — shared transaction + counter reversal + audit ──────
  // Idempotent (returns success when nothing to undo). Same helper the scanner undo uses.
  await uncheckInRegistration(registrationId, uid, { byUid: callerUid, workspaceUid: uid })

  return NextResponse.json({ success: true })
}

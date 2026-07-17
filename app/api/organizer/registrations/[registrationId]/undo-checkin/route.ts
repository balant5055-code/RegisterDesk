// POST /api/organizer/registrations/[registrationId]/undo-checkin
//
// Reverts a check-in: clears checkedIn flag, removes check-in fields,
// decrements registrationCounters/{slug}.checkedInCount, writes audit entry.
// Idempotent — safe to call if already not checked in.

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb }          from '@/lib/firebase/admin'
import { writeCheckinDelta }            from '@/lib/firebase/firestore/registrationCounters'
import { authorizeWorkspace }           from '@/lib/team/workspace'
import { writeAuditEntry }              from '@/lib/firebase/firestore/registrations'
import type { RegistrationDocument }   from '@/lib/registrations/types'

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
  const regRef = adminDb.collection('registrations').doc(registrationId)

  // ── 2. Load + ownership check ──────────────────────────────────────────────
  const regSnap = await regRef.get()
  if (!regSnap.exists) {
    return NextResponse.json({ success: false, error: 'Registration not found' }, { status: 404 })
  }
  const reg = regSnap.data() as RegistrationDocument

  if (reg.organizerUid !== uid) {
    return NextResponse.json({ success: false, error: 'Forbidden' }, { status: 403 })
  }

  // ── 3. Idempotency guard ───────────────────────────────────────────────────
  if (!reg.checkedIn) {
    return NextResponse.json({ success: true })
  }

  // ── 4. Atomic undo inside transaction ─────────────────────────────────────
  await adminDb.runTransaction(async txn => {
    const fresh = (await txn.get(regRef)).data() as RegistrationDocument
    if (!fresh.checkedIn) return  // already undone concurrently

    txn.update(regRef, {
      checkedIn:       false,
      checkedInAt:     FieldValue.delete(),
      checkedInBy:     FieldValue.delete(),
      checkedInSource: FieldValue.delete(),
      updatedAt:       FieldValue.serverTimestamp(),
    })

    writeCheckinDelta(txn, reg.eventSlug, registrationId, reg.passId, -1)   // GA-5 S3: same shard as the check-in
  })

  // ── 5. Audit (fire-and-forget) ─────────────────────────────────────────────
  writeAuditEntry(registrationId, 'check_in_undone', callerUid, 'organizer', uid).catch(err =>
    console.error(`[undo-checkin] audit error for ${registrationId}:`, err),
  )

  return NextResponse.json({ success: true })
}

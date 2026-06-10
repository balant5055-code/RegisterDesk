// POST /api/organizer/registrations/[registrationId]/undo-checkin
//
// Reverts a check-in: clears checkedIn flag, removes check-in fields,
// decrements registrationCounters/{slug}.checkedInCount, writes audit entry.
// Idempotent — safe to call if already not checked in.

import { NextRequest, NextResponse }  from 'next/server'
import { FieldValue }                  from 'firebase-admin/firestore'
import { adminDb, adminAuth }          from '@/lib/firebase/admin'
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
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid or expired token' }, { status: 401 })
  }

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

    const counterRef = adminDb.collection('registrationCounters').doc(reg.eventSlug)
    txn.set(counterRef, { checkedInCount: FieldValue.increment(-1) }, { merge: true })
  })

  // ── 5. Audit (fire-and-forget) ─────────────────────────────────────────────
  writeAuditEntry(registrationId, 'check_in_undone', uid, 'organizer').catch(err =>
    console.error(`[undo-checkin] audit error for ${registrationId}:`, err),
  )

  return NextResponse.json({ success: true })
}

// POST /api/organizer/notifications/read-all
//
// Marks every unread notification in the workspace inbox read (Phase H.4.3).
// Server-side batch via the Admin SDK. Only categories the caller is permitted
// to see are affected, so a limited team member never clears items they cannot
// view. Bounded per call; returns how many were updated.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb }               from '@/lib/firebase/admin'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'
import { canSeeCategory }        from '@/lib/notifications/inbox/catalog'
import type { NotificationDoc }  from '@/lib/notifications/inbox/types'

const MAX_BATCH = 400   // Firestore batch write limit is 500; stay comfortably under

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  // Index-free: single-field query on `read`, filter visibility in-process.
  const snap = await adminDb
    .collection(`users/${uid}/notifications`)
    .where('read', '==', false)
    .limit(MAX_BATCH)
    .get()

  if (snap.empty) return NextResponse.json({ success: true, updated: 0 })

  const batch = adminDb.batch()
  const now   = FieldValue.serverTimestamp()
  let updated = 0
  for (const doc of snap.docs) {
    const d = doc.data() as NotificationDoc
    if (!canSeeCategory(d.category, authz.permissions)) continue
    batch.update(doc.ref, { read: true, updatedAt: now })
    updated++
  }
  if (updated > 0) await batch.commit()

  return NextResponse.json({ success: true, updated })
}

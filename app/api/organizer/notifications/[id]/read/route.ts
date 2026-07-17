// POST /api/organizer/notifications/[id]/read
//
// Marks a single notification read (Phase H.4.3). Server-side mutation via the
// Admin SDK — client rules forbid writes. Any active workspace member or the
// owner may mark read; the notification is scoped to the workspace inbox.

import { NextRequest, NextResponse } from 'next/server'
import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb }               from '@/lib/firebase/admin'
import { authorizeAnyWorkspace } from '@/lib/team/workspace'

export async function POST(
  req:     NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const authz = await authorizeAnyWorkspace(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const { id } = await context.params
  const ref = adminDb.doc(`users/${authz.workspaceUid}/notifications/${id}`)
  const snap = await ref.get()
  if (!snap.exists) return NextResponse.json({ error: 'Notification not found' }, { status: 404 })

  await ref.update({ read: true, updatedAt: FieldValue.serverTimestamp() })
  return NextResponse.json({ success: true })
}

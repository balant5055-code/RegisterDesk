// GET /api/organizer/registrations/[registrationId]/audit
//
// Returns the full audit log for a registration.
// Organizer-only: authenticated user must own the event (reg.organizerUid === uid).

import { NextRequest, NextResponse }  from 'next/server'
import { adminAuth, adminDb }          from '@/lib/firebase/admin'
import { getAuditLog }                 from '@/lib/firebase/firestore/registrations'
import type { RegistrationDocument }   from '@/lib/registrations/types'
import type { AuditAction, AuditActorType } from '@/lib/registrations/types'

export interface SerializedAuditEntry {
  id:        string
  action:    AuditAction
  actor:     string
  actorType: AuditActorType
  timestamp: string | null
}

export interface AuditLogResponse {
  entries: SerializedAuditEntry[]
}

function toISO(val: unknown): string | null {
  if (!val) return null
  if (typeof (val as { toDate?: () => Date }).toDate === 'function') {
    return (val as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(
  req:     NextRequest,
  context: { params: Promise<{ registrationId: string }> },
): Promise<NextResponse<AuditLogResponse | { error: string }>> {
  // ── 1. Auth ────────────────────────────────────────────────────────────────
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '')
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let uid: string
  try {
    uid = (await adminAuth.verifyIdToken(token)).uid
  } catch {
    return NextResponse.json({ error: 'Invalid or expired token' }, { status: 401 })
  }

  const { registrationId } = await context.params

  // ── 2. Load registration + verify ownership ────────────────────────────────
  const regSnap = await adminDb.collection('registrations').doc(registrationId).get()
  if (!regSnap.exists) {
    return NextResponse.json({ error: 'Registration not found' }, { status: 404 })
  }
  const reg = regSnap.data() as RegistrationDocument
  if (reg.organizerUid !== uid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // ── 3. Fetch audit log ─────────────────────────────────────────────────────
  const rawEntries = await getAuditLog(registrationId)

  const entries: SerializedAuditEntry[] = rawEntries.map(e => ({
    id:        e.id,
    action:    e.action,
    actor:     e.actor,
    actorType: e.actorType,
    timestamp: toISO(e.timestamp),
  }))

  return NextResponse.json({ entries })
}

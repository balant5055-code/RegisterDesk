// GET   /api/admin/clawbacks/[id]  — clawback detail + audit history
// PATCH /api/admin/clawbacks/[id]  — { action: 'waive' | 'mark_recovered', note? }
//
// Admin-only. Every mutating action is audited (logClawbackEvent inside the
// service writes clawback.waived / clawback.recovered).

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid }           from '@/lib/admin/auth'
import { adminDb }                   from '@/lib/firebase/admin'
import {
  getClawback, waiveClawback, markClawbackRecovered,
} from '@/lib/clawbacks/clawbackService'

type Ctx = { params: Promise<{ id: string }> }

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  const clawback = await getClawback(id)
  if (!clawback) return NextResponse.json({ error: 'Clawback not found' }, { status: 404 })

  // History — audit-log events for this clawback entity, newest first.
  const histSnap = await adminDb.collection('adminAuditLogs')
    .where('entityType', '==', 'clawback')
    .where('entityId', '==', id)
    .limit(50)
    .get()
  const history = histSnap.docs
    .map(d => {
      const x = d.data() as { action?: string; adminUid?: string; metadata?: unknown; createdAt?: unknown }
      return { action: x.action ?? '', actorUid: x.adminUid ?? '', metadata: x.metadata ?? null, createdAt: tsToISO(x.createdAt) }
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  return NextResponse.json({ clawback, history }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { id } = await params
  let body: { action?: unknown; note?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }
  const note = typeof body.note === 'string' ? body.note : undefined

  const result = body.action === 'waive'
    ? await waiveClawback(id, adminUid, note)
    : body.action === 'mark_recovered'
      ? await markClawbackRecovered(id, adminUid, note)
      : { ok: false as const, status: 400, error: 'Unknown action.' }

  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status })
  return NextResponse.json({ clawback: result.view })
}

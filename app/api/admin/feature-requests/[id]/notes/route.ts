// RD-FEATURE-REQ-01 — add a Super Admin INTERNAL note to a feature request. Notes live in a
// subcollection no organizer route reads; the audit row commits with the note.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { LIMITS } from '@/lib/featureRequests/types'
import { adminAddNote, FeatureRequestError } from '@/lib/featureRequests/service'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  let body: { text?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : ''
  if (text.length < LIMITS.note.min || text.length > LIMITS.note.max) {
    return NextResponse.json({ error: `Notes are ${LIMITS.note.min}–${LIMITS.note.max} characters.` }, { status: 400 })
  }
  try {
    const r = await adminAddNote({ id, adminUid: gate.uid, text })
    return NextResponse.json({ success: true, ...r }, { status: 201 })
  } catch (err) {
    if (err instanceof FeatureRequestError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    console.error('[feature-requests] note failed', id, err)
    return NextResponse.json({ error: 'Could not add the note.' }, { status: 500 })
  }
}

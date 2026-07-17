// GET  /api/admin/incidents      — list incidents (optional ?status=)
// POST /api/admin/incidents      — create an incident
// Admin-only.

import { NextRequest, NextResponse } from 'next/server'
import { resolveAdminUid } from '@/lib/admin/auth'
import { listIncidents, createIncident, isSeverity, isStatus } from '@/lib/operations/incidents'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const statusParam = req.nextUrl.searchParams.get('status')
  const status = isStatus(statusParam) ? statusParam : undefined
  const incidents = await listIncidents({ status })
  return NextResponse.json({ incidents }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const adminUid = await resolveAdminUid(req.headers.get('authorization'))
  if (!adminUid) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let body: { title?: unknown; description?: unknown; severity?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) return NextResponse.json({ error: 'title is required' }, { status: 400 })
  const severity = isSeverity(body.severity) ? body.severity : 'major'

  const incident = await createIncident(adminUid, {
    title,
    description: typeof body.description === 'string' ? body.description : '',
    severity,
  })
  return NextResponse.json({ incident }, { status: 201 })
}

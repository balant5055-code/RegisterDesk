// GET   /api/organizer/crm/contacts/[contactId] — profile + timeline
// PATCH /api/organizer/crm/contacts/[contactId] — update notes/tags (full scope only)

import { NextRequest, NextResponse } from 'next/server'
import { authorizeCrm } from '@/lib/crm/access'
import { getContact, updateContact } from '@/lib/crm/queries'

export const dynamic = 'force-dynamic'

export async function GET(
  req: NextRequest, context: { params: Promise<{ contactId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeCrm(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { contactId } = await context.params

  const data = await getContact(authz.workspaceUid, contactId, authz.scope)
  if (!data) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  return NextResponse.json({ ...data, scope: authz.scope, canWrite: authz.canWrite }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function PATCH(
  req: NextRequest, context: { params: Promise<{ contactId: string }> },
): Promise<NextResponse> {
  const authz = await authorizeCrm(req)
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  if (!authz.canWrite) return NextResponse.json({ error: 'Your role cannot edit contacts.' }, { status: 403 })
  const { contactId } = await context.params

  let body: { notes?: unknown; tags?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 }) }

  const ok = await updateContact(authz.workspaceUid, contactId, {
    notes: typeof body.notes === 'string' ? body.notes : undefined,
    tags:  Array.isArray(body.tags) ? body.tags.map(String) : undefined,
  })
  if (!ok) return NextResponse.json({ error: 'Contact not found' }, { status: 404 })
  return NextResponse.json({ success: true })
}

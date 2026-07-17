// GET  /api/organizer/print-templates — list the workspace's print templates
// POST /api/organizer/print-templates — create a print template (metadata only)
//
// Print Assets foundation (PA-1). Security: workspace auth (reuses the same
// permission as Certificates — both are organizer-designed printable artifacts) +
// event ownership on create. No rendering / designer / jobs.

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }             from '@/lib/firebase/admin'
import { authorizeWorkspace }  from '@/lib/team/workspace'
import { listPrintTemplates, createPrintTemplate } from '@/lib/printAssets/firestore'
import { validateCreate }      from '@/lib/printAssets/validation'
import { organizerStatusGuard } from '@/lib/admin/organizerStatus'
import type { PrintTemplate }  from '@/lib/printAssets/types'

export type ListPrintTemplatesResponse =
  | { success: true;  templates: PrintTemplate[] }
  | { success: false; error: string }

export type CreatePrintTemplateResponse =
  | { success: true;  template: PrintTemplate }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<ListPrintTemplatesResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const templates = await listPrintTemplates(authz.workspaceUid)
  return NextResponse.json({ success: true, templates }, { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(req: NextRequest): Promise<NextResponse<CreatePrintTemplateResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const blocked = await organizerStatusGuard(uid)
  if (blocked) return NextResponse.json({ success: false, error: blocked.message }, { status: 403 })

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = validateCreate(body)
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 })

  // Event ownership — the template's event must belong to this workspace.
  const draftSnap = await adminDb.doc(`users/${uid}/eventDrafts/${parsed.value.eventId}`).get()
  if (!draftSnap.exists) return NextResponse.json({ success: false, error: 'Event not found' }, { status: 404 })

  const template = await createPrintTemplate(uid, authz.callerUid, parsed.value)
  return NextResponse.json({ success: true, template }, { status: 201 })
}

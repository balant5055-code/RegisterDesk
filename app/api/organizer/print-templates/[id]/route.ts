// GET    /api/organizer/print-templates/[id] — one template
// PATCH  /api/organizer/print-templates/[id] — edit (name/description/assetType/status/canvas)
// DELETE /api/organizer/print-templates/[id] — delete
//
// PA-1. Security: workspace auth + template ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate, updatePrintTemplate, deletePrintTemplate } from '@/lib/printAssets/firestore'
import { validateUpdate }     from '@/lib/printAssets/validation'
import type { PrintTemplate } from '@/lib/printAssets/types'

type Params = { params: Promise<{ id: string }> }

async function ownedTemplate(req: NextRequest, id: string): Promise<{ error: NextResponse } | { uid: string; callerUid: string; template: PrintTemplate }> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return { error: NextResponse.json({ success: false, error: authz.error }, { status: authz.status }) }
  const template = await getPrintTemplate(id)
  if (!template || template.organizerUid !== authz.workspaceUid) {
    return { error: NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 }) }
  }
  return { uid: authz.workspaceUid, callerUid: authz.callerUid, template }
}

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  const r = await ownedTemplate(req, id)
  if ('error' in r) return r.error
  return NextResponse.json({ success: true, template: r.template })
}

export async function PATCH(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  const r = await ownedTemplate(req, id)
  if ('error' in r) return r.error

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = validateUpdate(body)
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 })

  await updatePrintTemplate(id, parsed.value)
  const updated = await getPrintTemplate(id)
  return NextResponse.json({ success: true, template: updated })
}

export async function DELETE(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { id } = await params
  const r = await ownedTemplate(req, id)
  if ('error' in r) return r.error
  await deletePrintTemplate(id)
  return NextResponse.json({ success: true })
}

// PUT /api/organizer/print-templates/[id]/design
//
// PA-2 — Saves the visual designer's document as ONE JSON (no per-element writes).
// RD-PRINT-P1 — the save commits an IMMUTABLE version (printTemplateVersions) and moves
// the template's `currentVersion` pointer in the same transaction; an unchanged design
// creates no version. Print jobs already pinned to an earlier version are unaffected.
// Security: `certificates` + template ownership.
//
// Body:  { design: PrintDesign } | PrintDesign
// Reply: { success, design, version }

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate, savePrintDesign } from '@/lib/printAssets/firestore'
import { validateDesign }     from '@/lib/printAssets/validation'

export async function PUT(
  req: NextRequest, { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const template = await getPrintTemplate(id)
  if (!template || template.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }

  let body: unknown
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }
  const parsed = validateDesign(body)
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 })

  const committed = await savePrintDesign(id, parsed.value, { actorUid: authz.callerUid })
  return NextResponse.json({ success: true, design: parsed.value, version: committed.version })
}

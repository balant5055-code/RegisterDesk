// POST /api/organizer/print-templates/[id]/duplicate — copy a template into a new draft.
// PA-1. Security: workspace auth + template ownership.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate, duplicatePrintTemplate } from '@/lib/printAssets/firestore'

export async function POST(
  req: NextRequest, { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  const source = await getPrintTemplate(id)
  if (!source || source.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }

  const template = await duplicatePrintTemplate(source, authz.callerUid)
  return NextResponse.json({ success: true, template }, { status: 201 })
}

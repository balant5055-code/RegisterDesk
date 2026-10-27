// RD-WA-TEMPLATES-01 — create the next version { fromVersion, revision, …draft }.
// Used after changes are requested, after an internal or Meta rejection, or to update an approved
// template. The new version starts as a draft linked to `fromVersion`; it inherits no approval.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { parseDraftInput } from '@/lib/whatsappTemplates/validate'
import { reviseTemplate } from '@/lib/whatsappTemplates/service'
import { NO_STORE, TEMPLATE_ID_RE, readJson, positiveInt, templateErrorResponse, badId } from '@/lib/whatsappTemplates/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  const fromVersion = positiveInt(parsed.body.fromVersion)
  if (!fromVersion) return NextResponse.json({ error: 'fromVersion is required', code: 'INVALID' }, { status: 400 })
  try {
    const r = await reviseTemplate({ caller: { workspaceUid: authz.workspaceUid, callerUid: authz.callerUid }, id, fromVersion, expectedRevision: parsed.body.revision, input: parseDraftInput(parsed.body) })
    return NextResponse.json({ success: true, ...r }, { status: 201, headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'revise') }
}

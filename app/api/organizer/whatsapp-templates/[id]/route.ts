// RD-WA-TEMPLATES-01 — one template.
//   GET   → versions (content, validation, internal + Meta state, Meta's rejection details) and history.
//           Super Admin internal notes are never part of this response.
//   PATCH { version, revision, …draft } → edit the latest version while it is still a draft.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { parseDraftInput } from '@/lib/whatsappTemplates/validate'
import { getOrganizerTemplate, updateDraft } from '@/lib/whatsappTemplates/service'
import { NO_STORE, TEMPLATE_ID_RE, readJson, positiveInt, templateErrorResponse, badId } from '@/lib/whatsappTemplates/http'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  try {
    return NextResponse.json({ template: await getOrganizerTemplate({ workspaceUid: authz.workspaceUid, callerUid: authz.callerUid }, id) }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'get') }
}

export async function PATCH(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  const version = positiveInt(parsed.body.version)
  if (!version) return NextResponse.json({ error: 'version is required', code: 'INVALID' }, { status: 400 })
  try {
    const r = await updateDraft({ caller: { workspaceUid: authz.workspaceUid, callerUid: authz.callerUid }, id, version, expectedRevision: parsed.body.revision, input: parseDraftInput(parsed.body) })
    return NextResponse.json({ success: true, ...r }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'update') }
}

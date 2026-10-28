// RD-WA-TEMPLATES-01 — the organizer's WhatsApp Template Library.
//   GET              → the workspace's templates (summaries)
//   GET ?sendable=1  → only templates a broadcast may use right now (Meta-approved active version)
//   POST             → create a template; version 1 is saved as a draft. `submit: true` also submits it.
//
// authorizeWorkspace(…, 'broadcasts'): the same permission the broadcast composer requires. Every
// read and write is scoped to the caller's workspace; another workspace's template is "not found".

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { checkRateLimit } from '@/lib/rateLimit'
import { parseDraftInput } from '@/lib/whatsappTemplates/validate'
import { createTemplate, submitForReview, listOrganizerTemplates, listSendableTemplates } from '@/lib/whatsappTemplates/service'
import { NO_STORE, readJson, templateErrorResponse } from '@/lib/whatsappTemplates/http'
import { resolveMarketingTemplatesEnabled } from '@/lib/whatsappTemplates/governance'

export async function GET(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const caller = { workspaceUid: authz.workspaceUid, callerUid: authz.callerUid }
  try {
    if (req.nextUrl.searchParams.get('sendable') === '1') return NextResponse.json({ templates: await listSendableTemplates(caller) }, { headers: NO_STORE })
    // RD-WA-MARKETING-01 — the editor offers Marketing only when it is enabled (the service enforces it).
    const marketing = await resolveMarketingTemplatesEnabled()
    return NextResponse.json({ templates: await listOrganizerTemplates(caller), marketingTemplatesEnabled: marketing.enabled }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'list') }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const rl = checkRateLimit(authz.callerUid, 'whatsapp-template-create', 20, 60 * 60 * 1000)
  if (rl.limited) return NextResponse.json({ error: 'Too many templates created in a short time. Try again later.', code: 'RATE_LIMITED' }, { status: 429 })
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  const caller = { workspaceUid: authz.workspaceUid, callerUid: authz.callerUid }
  try {
    const created = await createTemplate({ caller, input: parseDraftInput(parsed.body) })
    if (parsed.body.submit !== true) return NextResponse.json({ success: true, ...created }, { status: 201, headers: NO_STORE })
    // Submitting needs the revision the create produced (1).
    const submitted = await submitForReview({ caller, id: created.id, version: 1, expectedRevision: 1 })
    return NextResponse.json({ success: true, id: created.id, version: 1, ...submitted }, { status: 201, headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'create') }
}

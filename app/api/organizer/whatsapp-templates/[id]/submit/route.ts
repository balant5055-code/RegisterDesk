// RD-WA-TEMPLATES-01 — submit the latest draft { version, revision }.
// Validated again on the server (errors → 422 with the findings). Manual review mode: it waits for a
// Super Admin. Automatic mode: it goes straight to Meta. Either way Meta must approve it before use.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { checkRateLimit } from '@/lib/rateLimit'
import { submitForReview } from '@/lib/whatsappTemplates/service'
import { NO_STORE, TEMPLATE_ID_RE, readJson, positiveInt, templateErrorResponse, badId } from '@/lib/whatsappTemplates/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const authz = await authorizeWorkspace(req, 'broadcasts')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  const rl = checkRateLimit(authz.callerUid, 'whatsapp-template-submit', 30, 60 * 60 * 1000)
  if (rl.limited) return NextResponse.json({ error: 'Too many submissions in a short time. Try again later.', code: 'RATE_LIMITED' }, { status: 429 })
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  const version = positiveInt(parsed.body.version)
  if (!version) return NextResponse.json({ error: 'version is required', code: 'INVALID' }, { status: 400 })
  try {
    const r = await submitForReview({ caller: { workspaceUid: authz.workspaceUid, callerUid: authz.callerUid }, id, version, expectedRevision: parsed.body.revision })
    return NextResponse.json({ success: true, ...r }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'submit') }
}

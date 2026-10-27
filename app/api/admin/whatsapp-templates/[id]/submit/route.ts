// RD-WA-TEMPLATES-01 — retry a Meta submission { version }. Super Admin only.
// Allowed only for an internally-approved version whose last attempt failed, had an unknown outcome,
// or never ran. A retry first looks the template up at Meta by name, so it can never create a second
// copy of a template a lost answer already created.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { submitVersionToMeta } from '@/lib/whatsappTemplates/service'
import { NO_STORE, TEMPLATE_ID_RE, readJson, positiveInt, templateErrorResponse, badId } from '@/lib/whatsappTemplates/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  const version = positiveInt(parsed.body.version)
  if (!version) return NextResponse.json({ error: 'version is required', code: 'INVALID' }, { status: 400, headers: NO_STORE })
  try {
    const r = await submitVersionToMeta({ id, version, actor: { kind: 'super_admin', uid: gate.uid } })
    return NextResponse.json({ success: true, ...r }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'admin submit') }
}

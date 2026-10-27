// RD-WA-TEMPLATES-01 — read a version's current status from Meta and record any change { version }.
// Super Admin only. Read-only at Meta (a GET); nothing is created or changed there.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { syncVersion } from '@/lib/whatsappTemplates/service'
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
    const r = await syncVersion({ id, version, actor: { kind: 'super_admin', uid: gate.uid } })
    if (!r.ok) return NextResponse.json({ error: r.error ?? 'Could not reach Meta.', code: 'SYNC_FAILED' }, { status: 502, headers: NO_STORE })
    return NextResponse.json({ success: true, result: r.result }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'admin sync') }
}

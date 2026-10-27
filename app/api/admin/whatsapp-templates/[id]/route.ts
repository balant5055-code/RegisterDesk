// RD-WA-TEMPLATES-01 — one template for review: every version, its validation, internal and Meta
// state, the full history, the organizer, and the Super Admin internal notes. Super Admin only.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { adminGetTemplate } from '@/lib/whatsappTemplates/service'
import { NO_STORE, TEMPLATE_ID_RE, templateErrorResponse, badId } from '@/lib/whatsappTemplates/http'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  try {
    return NextResponse.json({ template: await adminGetTemplate(id) }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'admin get') }
}

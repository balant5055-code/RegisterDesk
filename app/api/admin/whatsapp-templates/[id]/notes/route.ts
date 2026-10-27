// RD-WA-TEMPLATES-01 — a Super Admin INTERNAL note { text, version? }. Never shown to the organizer
// and never in a notification; the audit row records that a note was added, not its text.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { adminAddNote } from '@/lib/whatsappTemplates/service'
import { NO_STORE, TEMPLATE_ID_RE, readJson, positiveInt, templateErrorResponse, badId } from '@/lib/whatsappTemplates/http'

type Ctx = { params: Promise<{ id: string }> }

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  try {
    await adminAddNote({ adminUid: gate.uid, id, text: typeof parsed.body.text === 'string' ? parsed.body.text : '', version: positiveInt(parsed.body.version) })
    return NextResponse.json({ success: true }, { status: 201, headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'admin note') }
}

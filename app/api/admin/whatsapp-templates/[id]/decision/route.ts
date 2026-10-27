// RD-WA-TEMPLATES-01 — a Super Admin decision on ONE exact version.
//   POST { version, contentHash, action: 'approve' | 'reject' | 'request_changes', reason?, note? }
// `contentHash` is the hash of the content the reviewer saw; a different stored content is refused
// (STALE) so a changed version can never inherit an approval. Approving re-validates the stored
// content on the server and then submits it to Meta. Reject / request changes need a reason, which
// the organizer sees; `note` is internal and never shown to the organizer.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { adminDecide, type AdminAction } from '@/lib/whatsappTemplates/service'
import { NO_STORE, TEMPLATE_ID_RE, readJson, positiveInt, templateErrorResponse, badId } from '@/lib/whatsappTemplates/http'

type Ctx = { params: Promise<{ id: string }> }
const ACTIONS = new Set<AdminAction>(['approve', 'reject', 'request_changes'])

export async function POST(req: NextRequest, { params }: Ctx): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { id } = await params
  if (!TEMPLATE_ID_RE.test(id)) return badId()
  const parsed = await readJson(req)
  if (!parsed.ok) return parsed.response
  const b = parsed.body
  const version = positiveInt(b.version)
  if (!version || typeof b.contentHash !== 'string' || !/^[a-f0-9]{40}$/.test(b.contentHash) || !ACTIONS.has(b.action as AdminAction)) {
    return NextResponse.json({ error: 'version, contentHash and action are required', code: 'INVALID' }, { status: 400, headers: NO_STORE })
  }
  try {
    const r = await adminDecide({
      adminUid: gate.uid, id, version, contentHash: b.contentHash, action: b.action as AdminAction,
      reason: typeof b.reason === 'string' ? b.reason : null, note: typeof b.note === 'string' ? b.note : null,
    })
    return NextResponse.json({ success: true, ...r }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'decision') }
}

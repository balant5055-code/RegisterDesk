// RD-WA-TEMPLATES-01 — the Super Admin WhatsApp template queue.
//   GET ?status=pending_review | at_meta | meta_rejected | approved | all
// requireSuperAdmin (ADMIN_UIDS): a claim-only admin is refused.

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { adminListTemplates } from '@/lib/whatsappTemplates/service'
import { resolveReviewMode } from '@/lib/whatsappTemplates/governance'
import { NO_STORE, templateErrorResponse } from '@/lib/whatsappTemplates/http'

const FILTERS = new Set(['pending_review', 'at_meta', 'meta_rejected', 'approved', 'all'])

export async function GET(req: NextRequest): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const raw = req.nextUrl.searchParams.get('status') ?? 'pending_review'
  const status = FILTERS.has(raw) ? raw : 'pending_review'
  try {
    const [templates, governance] = await Promise.all([adminListTemplates({ status: status === 'all' ? null : status }), resolveReviewMode()])
    return NextResponse.json({ templates, governance }, { headers: NO_STORE })
  } catch (err) { return templateErrorResponse(err, 'admin list') }
}

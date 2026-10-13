// POST /api/organizer/print-jobs/quote — RD-PRINT-BILL-P5. READ-ONLY.
//
// What a NEW print job would bill, before it is created: cards in the selection, attendees already
// billed on this event (free — D2), attendees to bill (one prepaid ID badge each), units available,
// the shortfall, and a quote hash the create call must send back (valid 15 minutes; a recount ABOVE
// the quoted number needs a new quote — D4). Writes nothing; reserves nothing.
//
// Body:  { templateId, filters?: { pass?, category?, registrationIds?[] } }   (the create body)
// Reply: { success, mode: 'free' | 'complimentary' } · { success, mode: 'paid', quote }
// Security: `certificates` + template ownership, exactly as the create route. Staff may read a quote;
// only the owner can start a job that bills attendees (quote.ownerRequired).

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { getPrintTemplate }   from '@/lib/printAssets/firestore'
import { quotePrintGenerationJob, MAX_EXPLICIT_SELECTION, type PrintBadgeQuote } from '@/lib/printAssets/generationJob'
import { parsePrintJobFilters, overSelectionError, printEventSlugForDraft } from '@/lib/printAssets/printJobRequest'
import { resolvePrintJobBillingMode } from '@/lib/printAssets/badgeBilling/store'

// RD-PRINT-P8 (W2) — explicit route budget: this route runs a seed walk or a 50 s render chunk,
// so its limit is declared rather than left to the platform default.
export const maxDuration = 60

export type PrintJobQuoteResponse =
  | { success: true; mode: 'free' | 'complimentary' }
  | { success: true; mode: 'paid'; quote: PrintBadgeQuote }
  | { success: false; error: string; code?: string; requested?: number; maxSelection?: number }

export async function POST(req: NextRequest): Promise<NextResponse<PrintJobQuoteResponse>> {
  const authz = await authorizeWorkspace(req, 'certificates')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })

  let body: { templateId?: unknown; filters?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 }) }

  const templateId = typeof body.templateId === 'string' ? body.templateId : ''
  if (!templateId) return NextResponse.json({ success: false, error: 'templateId is required' }, { status: 400 })

  const parsed = parsePrintJobFilters(body.filters)
  if (!parsed.ok) {
    return NextResponse.json(
      { success: false, error: overSelectionError(parsed.requested), requested: parsed.requested, maxSelection: MAX_EXPLICIT_SELECTION },
      { status: 413 },
    )
  }

  const template = await getPrintTemplate(templateId)
  if (!template || template.organizerUid !== authz.workspaceUid) {
    return NextResponse.json({ success: false, error: 'Template not found' }, { status: 404 })
  }
  const eventSlug = await printEventSlugForDraft(authz.workspaceUid, template.eventId)
  if (!eventSlug) {
    return NextResponse.json({ success: false, error: 'Event is not published yet — no registrations to generate.' }, { status: 409 })
  }

  const billingMode = await resolvePrintJobBillingMode(template.assetType, eventSlug, { organizerUid: authz.workspaceUid, draftId: template.eventId })
  if (!billingMode.ok) {
    return billingMode.reason === 'ownership'
      ? NextResponse.json({ success: false, error: 'This event could not be verified as the published event of this draft.', code: 'EVENT_OWNERSHIP_UNVERIFIED' }, { status: 409 })
      : NextResponse.json({ success: false, error: 'ID badge billing is temporarily unavailable. Try again shortly.', code: 'BILLING_UNAVAILABLE' }, { status: 503 })
  }
  if (billingMode.mode !== 'paid') return NextResponse.json({ success: true, mode: billingMode.mode })

  const quote = await quotePrintGenerationJob({
    templateId, eventId: template.eventId, eventSlug, assetType: template.assetType,
    filters: parsed.filters, organizerUid: authz.workspaceUid, createdBy: authz.callerUid,
  }, billingMode.terms)
  return NextResponse.json({ success: true, mode: 'paid', quote })
}

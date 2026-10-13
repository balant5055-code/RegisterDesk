// GET /api/admin/events/[slug]/print-badges/billing — RD-PRINT-BILL-P7. Super Admin (ADMIN_UIDS)
// only; READ-ONLY apart from its audit row.
//
// One event's ID-badge GENERATION billing: the ledger, usage records, billing rounds, claims
// (registration ids only — never attendee names or contacts), billed jobs and the Phase 5
// reconciliation. Lives under the existing [slug] (no sibling [eventId] at this level).
//   ?section=usage|rounds|claims|jobs&cursor=<nextCursor>   the next page of ONE section
//   ?limit=<1–100, default 25>
//
// AUDITED (approved): after authorization and a successful read, one adminAuditLogs row
// ('print_badge_billing.event_billing_viewed', entity 'billing', the event's draft id and the
// section paged, if any). If that row cannot be written the data is NOT returned (503).

import { NextRequest, NextResponse } from 'next/server'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { logAdminAction } from '@/lib/admin/audit'
import { getEventBadgeBilling, EVENT_BILLING_SECTIONS, EVENT_BILLING_PAGE, EVENT_BILLING_PAGE_MAX, type EventBillingSection } from '@/lib/admin/printBadgeAdmin/eventBilling'
import { pageSize, CURSOR_RE } from '@/lib/admin/printBadgeAdmin/common'

export const dynamic = 'force-dynamic'
const NO_STORE = { 'Cache-Control': 'no-store' }

export async function GET(req: NextRequest, context: { params: Promise<{ slug: string }> }): Promise<NextResponse> {
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response
  const { slug } = await context.params
  const p = req.nextUrl.searchParams
  const sectionRaw = p.get('section')?.trim() || null
  if (sectionRaw && !(EVENT_BILLING_SECTIONS as readonly string[]).includes(sectionRaw)) {
    return NextResponse.json({ error: 'Invalid section' }, { status: 400, headers: NO_STORE })
  }
  const cursor = p.get('cursor')?.trim() || null
  if (cursor && (!sectionRaw || !CURSOR_RE.test(cursor))) return NextResponse.json({ error: 'Invalid cursor' }, { status: 400, headers: NO_STORE })
  let view
  try {
    view = await getEventBadgeBilling({ slug, only: sectionRaw as EventBillingSection | null, cursor, limit: pageSize(p.get('limit'), EVENT_BILLING_PAGE, EVENT_BILLING_PAGE_MAX) })
  } catch (e) {
    console.error('[admin/events/print-badges/billing] failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'Could not load badge billing for this event' }, { status: 500, headers: NO_STORE })
  }
  if (!view) return NextResponse.json({ error: 'Event not found' }, { status: 404, headers: NO_STORE })
  try {
    await logAdminAction({
      adminUid: gate.uid, actorRole: 'super_admin', action: 'print_badge_billing.event_billing_viewed', entityType: 'billing', entityId: view.event.draftId,
      correlation: { eventId: view.event.draftId, slug, section: sectionRaw ?? 'all' },
    })
  } catch (e) {
    console.error('[admin/events/print-badges/billing] audit failed', { type: e instanceof Error ? e.name : typeof e })
    return NextResponse.json({ error: 'This view could not be recorded in the audit log. Try again.' }, { status: 503, headers: NO_STORE })
  }
  return NextResponse.json(view, { headers: NO_STORE })
}

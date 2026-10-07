// GET /api/licensing/activation-status?eventId=<draftId> — RD-EVENT-COMMERCE-02
//
// What a draft has PAID for, read from server records only: the activation order's state,
// the highest paid capacity (activation or pre-publish add-on), the prepaid service allowances
// (purchased / consumed / remaining) and any payable add-on order still outstanding.
// Read-only — no order, no Razorpay call, no write.
//
// The License & Services page uses it to show "Payment received" after a reload, to decide
// whether the current selection is covered, and to recover a payment whose browser response
// was lost. It is DISPLAY state: the purchase route, the settlement transactions and the
// publish route each re-derive coverage themselves.
//
// Ownership: records are returned only to the workspace that owns them. Any other caller gets
// the empty answer — the same as "nothing bought" — so this cannot probe other events.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { summarizeActivationOrder, NO_ACTIVATION } from '@/lib/licensing/activationStatus'
import { readDraftCoverage } from '@/lib/licensing/draftCoverage'
import { EMPTY_SELECTION } from '@/lib/licensing/serviceAllowances'
import { readPurchaseHistory } from '@/lib/licensing/purchaseHistory'
import { adminDb } from '@/lib/firebase/admin'

export const dynamic = 'force-dynamic'

// Draft ids are Firestore auto-ids; anything with a path separator or of absurd length is
// rejected before it reaches a document path.
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

const EMPTY = {
  ...NO_ACTIVATION,
  paidCapacity: null,
  services: { purchased: { ...EMPTY_SELECTION }, consumed: { ...EMPTY_SELECTION }, remaining: { ...EMPTY_SELECTION } },
  pendingAddon: null,
  purchases: [],
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-CE-FIX M5 · the same gate as the rest of licensing (capacity/*, checkout/confirm): verified
  // token, the workspace it acts for, suspension of caller OR owner, and the `events` permission —
  // a check-in-only or finance member, or a suspended workspace, cannot buy or read licences here.
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  const eventId = req.nextUrl.searchParams.get('eventId')?.trim() ?? ''
  if (!EVENT_ID_RE.test(eventId)) {
    return NextResponse.json({ error: 'A valid eventId is required' }, { status: 400 })
  }

  const ctx = authz
  const [coverage, draftSnap] = await Promise.all([
    readDraftCoverage(eventId, ctx.workspaceUid),
    // History is secondary: an unreadable draft doc must never take down the payment status.
    Promise.resolve().then(() => adminDb.doc(`users/${ctx.workspaceUid}/eventDrafts/${eventId}`).get()).catch(() => null),
  ])
  // RD-EVENT-COMMERCE-05 — purchase history for the Licence & Services page. Ownership is the
  // caller's OWN draft doc (so a draft that has not paid yet still reads its own empty history,
  // and a live event's slug-keyed capacity changes are included); orders are further filtered
  // to this workspace inside readPurchaseHistory.
  const slug = draftSnap?.exists ? (draftSnap.get('eventDetails.seo.urlSlug') as string | undefined) ?? null : null
  const purchases = draftSnap?.exists
    ? await readPurchaseHistory({ draftId: eventId, slug, organizerUid: ctx.workspaceUid }).catch(() => [])
    : []
  const owner = coverage.activation?.organizerUid ?? coverage.pendingAddon?.organizerUid ?? null
  if (owner !== ctx.workspaceUid) {
    return NextResponse.json({ ...EMPTY, purchases }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
  }

  const activation = summarizeActivationOrder(coverage.activation, ctx.workspaceUid)
  return NextResponse.json({
    ...activation,
    paidCapacity: coverage.paidCapacity,
    services: { purchased: coverage.purchased, consumed: coverage.consumed, remaining: coverage.remaining },
    pendingAddon: coverage.pendingAddon
      ? { orderId: coverage.pendingAddon.orderId, amountPaise: coverage.pendingAddon.amountPaise, selection: coverage.pendingAddon.selection ?? null }
      : null,
    purchases,
  }, { status: 200, headers: { 'Cache-Control': 'no-store' } })
}

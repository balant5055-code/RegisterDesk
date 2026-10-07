// GET /api/organizer/wallet/transactions
// Returns paginated wallet transaction history for the organizer.
//
// RD-WALLET-EVT-01 — optional `event=<draftId>`: only the rows that RELIABLY reference that event
// (lib/wallet/eventWalletView txnEventRef — WhatsApp charges by slug, certificate charges by draft
// id). The draft must be the workspace's own (else 404). Filtered over a bounded newest-first scan
// of the same query, so no new index is needed; `scanLimited` says when older rows were not read.
// Without `event` the behaviour is unchanged.
//
// RD-WALLET-REQ — also optional, all additive: `direction=credit|debit`, `from` / `to` (YYYY-MM-DD,
// India time) and `cursor` (the previous page's `nextCursor`). Every request reads at most
// ACTIVITY_SCAN_LIMIT rows (lib/wallet/activityScan.ts) and pages are stable: the cursor continues
// from the last row examined.

import { NextRequest, NextResponse } from 'next/server'
import { resolveOwnedEventSlug } from '@/lib/events/liveEventRef'
import { authorizeWorkspace }        from '@/lib/team/workspace'
import { adminDb }                   from '@/lib/firebase/admin'
import { txnBelongsToEvent, parseTxnDirection, txnDirection } from '@/lib/wallet/eventWalletView'
import { scanActivity, dayBound }   from '@/lib/wallet/activityScan'
import type { WalletTransaction, WalletTxnType, WalletTxnStatus, WalletTxnReferenceType, WalletTxnMetadata } from '@/lib/wallet/types'

function tsToIso(ts: unknown): string {
  if (!ts) return new Date().toISOString()
  if (typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return new Date().toISOString()
}

function docToTxn(id: string, d: Record<string, unknown>): WalletTransaction {
  return {
    id,
    organizerUid:  typeof d.organizerUid  === 'string' ? d.organizerUid  : '',
    type:          (d.type as WalletTxnType) ?? 'adjustment',
    amountPaise:   typeof d.amountPaise   === 'number' ? d.amountPaise   : 0,
    balancePaise:  typeof d.balancePaise  === 'number' ? d.balancePaise  : 0,
    status:        (d.status as WalletTxnStatus) ?? 'completed',
    referenceType: (d.referenceType as WalletTxnReferenceType) ?? 'manual',
    referenceId:   typeof d.referenceId   === 'string' ? d.referenceId   : '',
    description:   typeof d.description   === 'string' ? d.description   : '',
    metadata:      (d.metadata as WalletTxnMetadata) ?? {},
    createdAt:     tsToIso(d.createdAt),
  }
}

export type GetWalletTransactionsResponse =
  | { success: true;  transactions: WalletTransaction[]; event?: { draftId: string; name: string }; scanLimited?: boolean; nextCursor?: string | null }
  | { success: false; error: string }

export async function GET(req: NextRequest): Promise<NextResponse<GetWalletTransactionsResponse>> {
  const authz = await authorizeWorkspace(req, 'wallet')
  if (!authz.ok) return NextResponse.json({ success: false, error: authz.error }, { status: authz.status })
  const uid = authz.workspaceUid

  const { searchParams } = new URL(req.url)
  const limitParam = parseInt(searchParams.get('limit') ?? '50', 10)
  const limit      = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 50, 1), 200)
  const direction  = parseTxnDirection(searchParams.get('direction'))
  const from       = dayBound(searchParams.get('from'), 'start')
  const to         = dayBound(searchParams.get('to'), 'end')
  if (from && to && from > to) return NextResponse.json({ success: false, error: 'The start date is after the end date.' }, { status: 400 })

  let event: { draftId: string; name: string; slug: string | null } | null = null
  const eventParam = searchParams.get('event')
  if (eventParam !== null) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(eventParam)) {
      return NextResponse.json({ success: false, error: 'Invalid event.' }, { status: 400 })
    }
    const draft = await adminDb.doc(`users/${uid}/eventDrafts/${eventParam}`).get()
    if (!draft.exists) return NextResponse.json({ success: false, error: 'Event not found.' }, { status: 404 })
    const details = ((draft.data() as Record<string, unknown>).eventDetails ?? {}) as Record<string, Record<string, unknown> | undefined>
    event = {
      draftId: draft.id,
      // RD-INTEG — the slug only once events/{slug} confirms THIS organizer and THIS draft (the
      // draft's own urlSlug is client-writable, so it could name another event's records).
      slug: await resolveOwnedEventSlug(uid, draft.id, draft.data() as Record<string, unknown>),
      name: typeof details.info?.name === 'string' ? details.info.name : 'Untitled event',
    }
  }

  const ev = event
  const filtered = ev !== null || direction !== null
  const page = await scanActivity({
    collection: 'walletTransactions', uid, limit, cursor: searchParams.get('cursor'), from, to,
    keep: filtered
      ? d => (ev === null || txnBelongsToEvent({ type: d.type, metadata: d.metadata }, { slug: ev.slug, draftId: ev.draftId }))
          && (direction === null || txnDirection(d.type) === direction)
      : null,
    map: docToTxn,
  })
  return NextResponse.json({
    success: true, transactions: page.rows, nextCursor: page.nextCursor,
    ...(ev ? { event: { draftId: ev.draftId, name: ev.name } } : {}),
    ...(filtered ? { scanLimited: page.scanLimited } : {}),
  })
}

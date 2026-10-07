// GET /api/admin/service-allowances/reconciliation — RD-EVENT-COMMERCE-02
//
// DRY-RUN reconciliation of every event's prepaid service-allowance ledger against its paid
// orders and usage records (lib/licensing/allowanceReconciliation.ts). Admin-only, read-only:
// no write, no refund, no credit, no balance adjustment of any kind — there is no approved
// policy for unused allowances, so this reports and nothing else.
//
//   ?draftId=<id>   one event
//   (none)          the most recently updated ledgers (bounded)

import { NextRequest, NextResponse } from 'next/server'
import { adminDb }         from '@/lib/firebase/admin'
import { requireSuperAdmin } from '@/lib/admin/financialGuard'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import { EVENT_SERVICE_ALLOWANCES, ALLOWANCE_USAGE_SUBCOLLECTION, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { reconcileAllowance, type ReconOrder, type ReconUsage } from '@/lib/licensing/allowanceReconciliation'

export const dynamic = 'force-dynamic'
const LIMIT = 100

export async function GET(req: NextRequest): Promise<NextResponse> {
  // RD-INTEG — financial reconciliation (paid orders, unused paid units, their value) is a
  // Super Admin read (ADMIN_UIDS), like every other money surface; a legacy admin claim alone
  // no longer opens it.
  const gate = await requireSuperAdmin(req)
  if (gate.response) return gate.response

  const draftId = req.nextUrl.searchParams.get('draftId')?.trim() || null
  const ledgers = draftId
    ? [await adminDb.collection(EVENT_SERVICE_ALLOWANCES).doc(draftId).get()].filter(s => s.exists)
    : (await adminDb.collection(EVENT_SERVICE_ALLOWANCES).orderBy('updatedAt', 'desc').limit(LIMIT).get()).docs

  const events = await Promise.all(ledgers.map(async snap => {
    const ledger = snap.data() as ServiceLedgerDoc
    // RD-INTEG · D7 — activation/add-on orders key the DRAFT id, capacity orders (which can carry
    // service lines too) key the event SLUG: read both, as the organizer Wallet does. The slug is
    // the live event that points back at this draft AND belongs to the ledger's organizer.
    const owner = typeof ledger.organizerUid === 'string' ? ledger.organizerUid : null
    const liveSnap = owner
      ? await adminDb.collection('events').where('draftId', '==', snap.id).where('uid', '==', owner).limit(1).get().catch(() => null)
      : null
    const slug = liveSnap && !liveSnap.empty ? liveSnap.docs[0].id : null
    const keys = slug && slug !== snap.id ? [snap.id, slug] : [snap.id]
    const [ordersSnap, usageSnap] = await Promise.all([
      adminDb.collection(LICENSE_ORDERS_COLLECTION).where('eventId', 'in', keys).get(),
      snap.ref.collection(ALLOWANCE_USAGE_SUBCOLLECTION).get(),
    ])
    const orders = ordersSnap.docs
      .map(d => ({ ...(d.data() as ReconOrder), orderId: d.id }))
      .filter(o => !owner || (o as { organizerUid?: unknown }).organizerUid === undefined || (o as { organizerUid?: unknown }).organizerUid === owner)
    const usage  = usageSnap.docs.map(d => d.data() as ReconUsage)
    const result = reconcileAllowance(ledger, orders, usage)
    return {
      draftId: snap.id, eventSlug: slug, organizerUid: ledger.organizerUid ?? null,
      ...result,
      clean: result.issues.length === 0 && result.lines.every(l => l.issues.length === 0),
    }
  }))

  return NextResponse.json({
    dryRun: true,
    note: 'Report only. No refund, credit or adjustment is made or proposed; unused units are shown for visibility.',
    events,
    discrepancies: events.filter(e => !e.clean).length,
  }, { headers: { 'Cache-Control': 'no-store' } })
}

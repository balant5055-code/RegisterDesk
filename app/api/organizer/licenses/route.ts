// GET /api/organizer/licenses — the workspace's Event Licenses (read-only).
//
// eventLicenses is the canonical license document (one per published event). This
// endpoint lists them for the calling workspace, joined with the event name +
// lifecycle, registration usage, and payment/order info — everything the Billing
// "Licenses" tab needs. Read-only; it modifies nothing.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { adminDb }             from '@/lib/firebase/admin'
import {
  EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION,
} from '@/lib/licensing/schema'
import {
  isEventLicenseTier, isUnlimited,
  type EventLicenseTier,
} from '@/lib/licensing/eventLicense'
import { getLicenseCatalog } from '@/lib/licensing/resolveCatalog'

export interface OrganizerLicenseRow {
  slug:              string
  eventName:         string
  tier:              EventLicenseTier
  status:            string    // 'active' | 'pending_approval' | 'changes_requested' | 'rejected' | 'cancelled' | 'pending_payment'
  maxRegistrations:  number | null   // null = unlimited
  used:              number
  remaining:         number | null
  purchaseDate:      string | null
  amountPaidPaise:   number
  walletUsedPaise:   number
  orderId:           string | null
  razorpayPaymentId: string | null
  publishedAt:       string | null
}

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function str(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

function deriveStatus(ev: Record<string, unknown> | undefined, licenseStatus: string): string {
  if (!ev) return licenseStatus === 'pending' ? 'pending_payment' : 'active'
  if (ev.reviewStatus === 'rejected')                return 'rejected'
  const ls = ev.lifecycleStatus
  if (ls === 'pending_review')     return 'pending_approval'
  if (ls === 'changes_requested')  return 'changes_requested'
  if (ls === 'cancelled')          return 'cancelled'
  if (ls === 'published')          return 'active'
  return licenseStatus === 'pending' ? 'pending_payment' : 'active'
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)

  const snap = await adminDb
    .collection(EVENT_LICENSES_COLLECTION)
    .where('organizerUid', '==', ctx.workspaceUid)
    .limit(200)
    .get()

  if (snap.empty) return NextResponse.json({ licenses: [] }, { headers: { 'Cache-Control': 'no-store' } })

  const slugs    = snap.docs.map(d => d.id)
  const orderIds = snap.docs.map(d => (d.data().orderId as string | null) || '').filter(Boolean)
  // Wallet ledger entries are keyed by draft id (order id without the 'lic_' prefix).
  const draftIds = orderIds.map(o => o.startsWith('lic_') ? o.slice(4) : o)

  const [eventSnaps, counterSnaps, orderSnaps, ledgerSnaps] = await Promise.all([
    adminDb.getAll(...slugs.map(s => adminDb.doc(`${'events'}/${s}`))),
    adminDb.getAll(...slugs.map(s => adminDb.doc(`registrationCounters/${s}`))),
    orderIds.length ? adminDb.getAll(...orderIds.map(o => adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${o}`))) : Promise.resolve([]),
    draftIds.length ? adminDb.getAll(...draftIds.map(d => adminDb.doc(`walletTransactions/license_${d}`))) : Promise.resolve([]),
  ])

  const eventMap = new Map<string, Record<string, unknown>>()
  eventSnaps.forEach((s, i) => { if (s.exists) eventMap.set(slugs[i], s.data() as Record<string, unknown>) })
  const usedMap = new Map<string, number>()
  counterSnaps.forEach((s, i) => { if (s.exists) usedMap.set(slugs[i], ((s.data() as { totalCount?: number }).totalCount) ?? 0) })
  const orderMap = new Map<string, Record<string, unknown>>()
  orderSnaps.forEach((s) => { if (s.exists) orderMap.set(s.id, s.data() as Record<string, unknown>) })
  const walletMap = new Map<string, number>()
  ledgerSnaps.forEach((s) => { if (s.exists) walletMap.set(s.id, ((s.data() as { amountPaise?: number }).amountPaise) ?? 0) })

  // Effective (config-aware) catalog for registration limits — one source of truth.
  const catalog = await getLicenseCatalog()
  const licenses: OrganizerLicenseRow[] = snap.docs.map((doc) => {
    const d    = doc.data() as Record<string, unknown>
    const tier = isEventLicenseTier(d.tier) ? d.tier : 'starter'
    const ev   = eventMap.get(doc.id)
    const orderId = typeof d.orderId === 'string' ? d.orderId : null
    const order   = orderId ? orderMap.get(orderId) : undefined
    const draftId = orderId && orderId.startsWith('lic_') ? orderId.slice(4) : null

    const maxReg = catalog[tier].limits.maxRegistrations
    const used   = usedMap.get(doc.id) ?? 0
    const maxRegistrations = isUnlimited(maxReg) ? null : maxReg

    return {
      slug:              doc.id,
      eventName:         typeof str(ev, 'eventDetails', 'info', 'name') === 'string'
        ? (str(ev, 'eventDetails', 'info', 'name') as string) : doc.id,
      tier,
      status:            deriveStatus(ev, typeof d.status === 'string' ? d.status : 'active'),
      maxRegistrations,
      used,
      remaining:         maxRegistrations == null ? null : Math.max(0, maxRegistrations - used),
      purchaseDate:      tsToISO(d.paidAt) ?? tsToISO(d.createdAt),
      amountPaidPaise:   typeof d.amountPaise === 'number' ? d.amountPaise : 0,
      walletUsedPaise:   draftId ? (walletMap.get(`license_${draftId}`) ?? 0) : 0,
      orderId,
      razorpayPaymentId: typeof order?.razorpayPaymentId === 'string' ? order.razorpayPaymentId : null,
      publishedAt:       tsToISO(str(ev, 'publishedAt')),
    }
  })

  return NextResponse.json({ licenses }, { headers: { 'Cache-Control': 'no-store' } })
}

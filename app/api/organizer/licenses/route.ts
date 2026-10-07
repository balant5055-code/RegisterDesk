// GET /api/organizer/licenses — the workspace's Event Licenses (read-only).
//
// eventLicenses is the canonical license document (one per published event). This
// endpoint lists them for the calling workspace, joined with the event name +
// lifecycle, registration usage, and payment/order info — everything the Billing
// "Licenses" tab needs. Read-only; it modifies nothing.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { adminDb }             from '@/lib/firebase/admin'
import {
  EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION,
} from '@/lib/licensing/schema'
import {
  isValidTierForVersion, isUnlimited,
  type AnyEventLicenseTier, type LicenseVersion,
} from '@/lib/licensing/eventLicense'
import { getLicenseCatalog, getLicenseCatalogV2 } from '@/lib/licensing/resolveCatalog'
import { resolveLicenseEntryForVersion } from '@/lib/licensing/licenseCatalogShared'

export interface OrganizerLicenseRow {
  slug:              string
  eventName:         string
  // RD-LICENSE-01B Phase 3C: tier is the STORED tier (V1 or V2) resolved against `version`.
  tier:              AnyEventLicenseTier
  version:           LicenseVersion   // license schema version — drives client-side display
  /** RD-LEGACY-01 — 'capacity' for every pay-as-you-go licence; null = a historical tier licence. */
  commercialModel:   'capacity' | null
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
  // RD-CE-FIX M5 · the same gate as the rest of licensing (capacity/*, checkout/confirm): verified
  // token, the workspace it acts for, suspension of caller OR owner, and the `events` permission —
  // a check-in-only or finance member, or a suspended workspace, cannot buy or read licences here.
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })
  const ctx = authz

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

  // Effective (config-aware) V1 + V2 catalogs — a license resolves against the catalog
  // for ITS stored version (Phase 3C), so historical V1 licenses and future V2 licenses
  // both render correctly. One source of truth; no hardcoded limits.
  const [catalog, catalogV2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
  const licenses: OrganizerLicenseRow[] = snap.docs.map((doc) => {
    const d       = doc.data() as Record<string, unknown>
    const version = typeof d.version === 'number' && d.version >= 1 ? d.version : 1
    const tier    = isValidTierForVersion(d.tier, version) ? d.tier : 'starter'
    const ev   = eventMap.get(doc.id)
    const orderId = typeof d.orderId === 'string' ? d.orderId : null
    const order   = orderId ? orderMap.get(orderId) : undefined
    const draftId = orderId && orderId.startsWith('lic_') ? orderId.slice(4) : null

    // RD-LEGACY-01 — a CAPACITY licence's limit is its paid capacity: the event's ENFORCED
    // totalCapacity, else the licence's record of what was bought (null = uncapped admin grant).
    // The free-tier compatibility stamp it carries is never a limit. Only a HISTORICAL tier
    // licence still resolves its limit from the tier catalog.
    const isCapacity = d.commercialModel === 'capacity'
    const evCap  = ev && typeof ev.totalCapacity === 'number' && Number.isInteger(ev.totalCapacity) && ev.totalCapacity > 0 ? ev.totalCapacity : null
    const licCap = typeof d.capacity === 'number' && Number.isInteger(d.capacity) && d.capacity > 0 ? d.capacity : null
    const maxReg = isCapacity ? (evCap ?? licCap ?? Infinity) : resolveLicenseEntryForVersion(catalog, catalogV2, tier, version).registrationLimit
    const used   = usedMap.get(doc.id) ?? 0
    const maxRegistrations = isUnlimited(maxReg) ? null : maxReg

    return {
      slug:              doc.id,
      eventName:         typeof str(ev, 'eventDetails', 'info', 'name') === 'string'
        ? (str(ev, 'eventDetails', 'info', 'name') as string) : doc.id,
      tier,
      version,
      commercialModel:   isCapacity ? 'capacity' : null,
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

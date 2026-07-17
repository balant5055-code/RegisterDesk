// GET /api/organizer/licenses/[eventId] — rich per-event license detail for the
// Organizer License Center (RD-LIC-ORG-01). Owner-scoped, READ-ONLY.
//
// Reuses eventLicenses (canonical doc) + resolveEffectiveEventLicense (tier +
// config + admin overlay) + licenseHistory (immutable timeline) + licenseOrders /
// wallet ledger (billing). It creates/modifies nothing.

import { NextRequest, NextResponse } from 'next/server'
import { verifyCaller }        from '@/lib/team/access'
import { resolveWorkspaceUid } from '@/lib/team/workspace'
import { adminDb }             from '@/lib/firebase/admin'
import {
  EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, LICENSE_HISTORY_COLLECTION,
  type EventLicenseDoc,
} from '@/lib/licensing/schema'
import {
  isEventLicenseTier, isUnlimited, nextEventLicenseTier,
  type EventLicenseFeature,
} from '@/lib/licensing/eventLicense'
import { getLicenseCatalog } from '@/lib/licensing/resolveCatalog'
import { resolveEffectiveEventLicense } from '@/lib/licensing/adminLicense'
import {
  FEATURE_LABELS,
  type LicenseCenterDetail, type LicenseCenterStatus, type LicenseCenterPayment,
  type LicenseFeatureCell, type LicenseTimelineItem,
} from '@/lib/organizer/licenseCenterTypes'

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}
function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) { if (!cur || typeof cur !== 'object') return undefined; cur = (cur as Record<string, unknown>)[k] }
  return cur
}

const FEATURE_KEYS: EventLicenseFeature[] =
  ['offlineCheckin', 'teamAccess', 'apiAccess', 'whiteLabel', 'customDomain', 'advancedReports', 'prioritySupport']

// Organizer-friendly labels. `note` (internal admin notes) is intentionally hidden.
const ACTION_LABEL: Record<string, string> = {
  purchased: 'License purchased', activated: 'License activated',
  upgraded: 'License upgraded', downgraded: 'License downgraded',
  granted: 'Complimentary license granted', refunded: 'License refunded',
  suspended: 'License suspended', reactivated: 'License reactivated',
  cancelled: 'License cancelled', price_override: 'Price adjusted by admin',
  limit_override: 'Registration limit adjusted by admin', feature_override: 'Features adjusted by admin',
  payment_received: 'Payment received', reissued: 'License reissued',
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ eventId: string }> },
): Promise<NextResponse> {
  const caller = await verifyCaller(req)
  if (!caller) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const ctx = await resolveWorkspaceUid(caller.uid)

  const { eventId } = await params
  const snap = await adminDb.collection(EVENT_LICENSES_COLLECTION).doc(eventId).get()
  if (!snap.exists) return NextResponse.json({ error: 'License not found' }, { status: 404 })
  const doc = { ...(snap.data() as EventLicenseDoc), eventId }

  // Ownership — a workspace may only view its own licenses.
  if (doc.organizerUid !== ctx.workspaceUid) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const tier = isEventLicenseTier(doc.tier) ? doc.tier : 'starter'

  const [eventSnap, counterSnap, orderSnap, chargeSnap, historySnap, catalog] = await Promise.all([
    adminDb.doc(`events/${eventId}`).get(),
    adminDb.doc(`registrationCounters/${eventId}`).get(),
    doc.orderId ? adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`).get() : Promise.resolve(null),
    adminDb.doc(`walletTransactions/license_${doc.orderId?.startsWith('lic_') ? doc.orderId.slice(4) : eventId}`).get(),
    adminDb.collection(LICENSE_HISTORY_COLLECTION).where('eventId', '==', eventId).limit(200).get(),
    getLicenseCatalog(),
  ])

  const baseDef = catalog[tier]
  const eff     = resolveEffectiveEventLicense(baseDef, doc.status, doc.amountPaise ?? 0, doc.admin)
  const overlay = doc.admin

  // ── Status / payment ──
  const status: LicenseCenterStatus =
    overlay?.lifecycle === 'suspended' ? 'suspended'
    : overlay?.lifecycle === 'cancelled' ? 'cancelled'
    : doc.status === 'active' ? 'active' : 'pending'

  const order = orderSnap?.exists ? (orderSnap.data() as Record<string, unknown>) : undefined
  const payment: LicenseCenterPayment = (() => {
    if (overlay?.complimentary) return 'complimentary'
    if (order) {
      const s = order.status
      if (s === 'paid') return 'paid'
      if (s === 'failed') return 'failed'
      if (s === 'refunded') return 'refunded'
      if (s === 'created') return overlay?.paymentReceived ? 'paid' : 'pending'
    }
    if ((doc.amountPaise ?? 0) > 0) return overlay?.paymentReceived ? 'paid' : 'pending'
    return 'free'
  })()

  // ── Feature matrix (from the effective definition) ──
  const features: LicenseFeatureCell[] = FEATURE_KEYS.map(key => {
    const included    = eff.definition.features[key] === true
    const overridden  = overlay?.featureOverrides != null && typeof overlay.featureOverrides[key] === 'boolean'
    const adminGranted = overridden && included && baseDef.features[key] === false
    return { key, label: FEATURE_LABELS[key], included, overridden, adminGranted }
  })

  // ── Registration usage ──
  const effMax  = eff.definition.limits.maxRegistrations
  const baseMax = baseDef.limits.maxRegistrations
  const used    = counterSnap.exists ? ((counterSnap.data() as { totalCount?: number }).totalCount ?? 0) : 0
  const registrationLimit = isUnlimited(effMax) ? null : effMax
  const limitOverridden   = overlay?.limitOverrides != null && overlay.limitOverrides.maxRegistrations !== undefined

  // ── Billing ──
  const walletUsedPaise = chargeSnap.exists ? ((chargeSnap.data() as { amountPaise?: number }).amountPaise ?? 0) : 0
  const orderAmount     = typeof order?.amountPaise === 'number' ? order.amountPaise : (doc.amountPaise ?? 0)

  // ── Timeline (organizer-safe: hides internal notes + reasons) ──
  const timeline: LicenseTimelineItem[] = historySnap.docs
    .map(d => {
      const h = d.data() as Record<string, unknown>
      const action = typeof h.action === 'string' ? h.action : ''
      return {
        id:        d.id,
        action,
        label:     ACTION_LABEL[action] ?? action.replace(/_/g, ' '),
        createdAt: tsToISO(h.createdAt),
        bySystem:  h.source !== 'self_serve',
      }
    })
    // Internal admin notes are hidden from the organizer-facing timeline.
    .filter(t => t.action !== 'note')
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  // ── Upgrade option (hidden at Enterprise / top tier) ──
  const next = nextEventLicenseTier(tier)
  const upgrade = next ? {
    nextTier:             next,
    nextTierName:         catalog[next].name,
    currentPricePaise:    baseDef.licensePricePaise,
    nextPricePaise:       catalog[next].licensePricePaise,
    priceDifferencePaise: Math.max(0, catalog[next].licensePricePaise - baseDef.licensePricePaise),
    benefits:             catalog[next].featureList,
  } : null

  const detail: LicenseCenterDetail = {
    eventId,
    eventName:   typeof nested(eventSnap.exists ? eventSnap.data() : undefined, 'eventDetails', 'info', 'name') === 'string'
      ? (nested(eventSnap.data(), 'eventDetails', 'info', 'name') as string) : eventId,
    eventStatus: eventSnap.exists && typeof (eventSnap.data() as Record<string, unknown>).lifecycleStatus === 'string'
      ? ((eventSnap.data() as Record<string, unknown>).lifecycleStatus as string) : null,
    tier,
    tierName:    eff.definition.name,
    status,
    payment,
    complimentary: eff.complimentary,
    hasOverrides:  overlay != null && (eff.complimentary || overlay.pricePaiseOverride != null ||
      Object.keys(overlay.limitOverrides ?? {}).length > 0 || Object.keys(overlay.featureOverrides ?? {}).length > 0),
    registrationLimit,
    baseRegistrationLimit: isUnlimited(baseMax) ? null : baseMax,
    limitOverridden,
    used,
    remaining:   registrationLimit == null ? null : Math.max(0, registrationLimit - used),
    amountPaidPaise:     doc.amountPaise ?? 0,
    effectivePricePaise: eff.effectivePricePaise,
    purchaseDate:        tsToISO(doc.paidAt) ?? tsToISO(doc.createdAt),
    features,
    timeline,
    billing: {
      orderId:           doc.orderId,
      status:            typeof order?.status === 'string' ? order.status : (payment === 'complimentary' ? 'complimentary' : payment === 'free' ? 'free' : 'n/a'),
      amountPaise:       orderAmount,
      walletUsedPaise,
      gatewayPaise:      Math.max(0, orderAmount - walletUsedPaise),
      razorpayPaymentId: typeof order?.razorpayPaymentId === 'string' ? order.razorpayPaymentId : null,
      date:              tsToISO(order?.paidAt) ?? tsToISO(doc.paidAt) ?? tsToISO(doc.createdAt),
    },
    upgrade,
  }

  return NextResponse.json({ detail }, { headers: { 'Cache-Control': 'no-store' } })
}

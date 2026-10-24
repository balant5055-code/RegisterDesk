// Admin License Management service (RD-LIC-ADMIN-01) — server-only.
//
// The single place that lists event licenses for the admin console and applies
// admin actions (grant / lifecycle / overrides / upgrade-downgrade / mark-paid /
// refund / reissue / note). Every mutation:
//   • validates server-side (no client trust; business rules in one place),
//   • writes an IMMUTABLE licenseHistory entry (who/when/before/after/reason),
//   • records an adminAuditLogs entry (cross-cutting admin audit view).
//
// It reuses the frozen license model: it never mutates the base `status` enum —
// suspend/cancel live on the additive `admin` overlay, which workspaceEntitlements
// and the effective-license resolver already respect. Reads/writes go through the
// Admin SDK directly (mirrors the existing licensing route handlers).

import { randomUUID } from 'crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { baselineRef, stageBaselineOverrides } from '@/lib/events/governance'
import { stageAdminAudit, logAdminActionOrRecord } from '@/lib/admin/audit'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import {
  EVENT_LICENSES_COLLECTION,
  LICENSE_ORDERS_COLLECTION,
  LICENSE_HISTORY_COLLECTION,
  type EventLicenseDoc,
  type LicenseHistoryAction,
} from '@/lib/licensing/schema'
import {
  isEventLicenseTier,
  isEventLicenseTierV2,
  isValidTierForVersion,
  defaultLicenseTierForVersion,
  isUnlimited,
  type AnyEventLicenseTier,
  type EventLicenseFeature,
} from '@/lib/licensing/eventLicense'
import { getLicenseCatalog, getLicenseCatalogV2, type LicenseCatalog, type LicenseCatalogV2 } from '@/lib/licensing/resolveCatalog'
import { pickVersionedDefinition } from '@/lib/licensing/licenseCatalogShared'
import { resolveEffectiveEventLicense } from '@/lib/licensing/adminLicense'
import { capacityPlanForRegistrationLimit, deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import { assessLicenceRefund, type LicenceRefundAssessment, type RefundServiceLine } from '@/lib/licensing/licenceRefundAssessment'
import { readEventPhotoCapacity, txnReadPhotoCapacity } from '@/features/media-studio/services/photoCapacityGate'
import { soldFromCounter } from '@/lib/licensing/capacityChange'
import {
  REFUND_HOLD_MIN_RELEASE_AGE_MS, refundHoldOldEnough, classifyGatewayRefunds, isDefinitiveGatewayRejection, gatewayErrorMessage,
  type GatewayRefundOutcome, type RefundHoldPhase,
} from '@/lib/licensing/licenceRefundHold'
import { atomicWalletCredit } from '@/lib/firebase/firestore/wallet'
import { organizerRedemptionCounterRef } from '@/lib/licensing/coupons'
import { ledgerRef as serviceLedgerRef, ledgerLine, heldRefundUnits, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { SERVICE_KINDS } from '@/lib/licensing/serviceAllowances'

/** RD-M5 — the per-organizer coupon counter a licence order's redemption belongs to (null ⇒ none). */
function couponCounterRefOf(order: Record<string, unknown>) {
  return typeof order.couponCode === 'string' && order.couponCode && typeof order.organizerUid === 'string' && order.organizerUid
    ? organizerRedemptionCounterRef(order.couponCode, order.organizerUid)
    : null
}
// RD-ENV-ARCH-05 — Razorpay is NOT statically imported here. This service is imported by
// admin READ paths (license list/detail, Event360, governance, timeline, export) that
// must never initialize/validate Razorpay. The gateway client is lazy-loaded only at the
// single payment-execution point (the 'refund' action), so read paths stay Razorpay-free.
import { licenceRegistrationBlock } from '@/lib/licensing/licenceRegistrationBlock'
import type { AdminAuditAction, AdminAuditParams, AuditActorRole } from '@/lib/admin/auditConstants'
import type {
  LicenseRow,
  LicenseListResponse,
  LicenseDetail,
  LicenseTimelineEntry,
  LicenseAdminActionRequest,
  LicenseAdminActionResponse,
  LicenseDisplayStatus,
  LicensePaymentStatus,
  LicenseAdminActionType,
  LicenseRefundStateView,
} from './licenseAdminTypes'

// ─── Errors ─────────────────────────────────────────────────────────────────────

export class LicenseActionError extends Error {
  /** RD-SA-COMMERCE-P1 — optional machine-readable extras the route returns beside `error`
   *  (e.g. `code: 'REFUND_REVIEW_REQUIRED'` with the `refundAssessment`). */
  constructor(message: string, public status = 400, public details?: Record<string, unknown>) { super(message) }
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function tsToISO(ts: unknown): string | null {
  if (ts && typeof (ts as { toDate?: () => Date }).toDate === 'function') {
    return (ts as { toDate: () => Date }).toDate().toISOString()
  }
  return null
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let cur: unknown = obj
  for (const k of keys) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[k]
  }
  return cur
}

// RD-LICENSE-GA-02: tier rank is now cross-version (by registration limit), resolved
// locally inside applyLicenseAction where both catalogs are on hand — see `rankOf`.

const licenseRef = (eventId: string) => adminDb.collection(EVENT_LICENSES_COLLECTION).doc(eventId)

/** Drop `undefined` values so the object is safe to persist to Firestore. */
function clean<T>(obj: T): Record<string, unknown> {
  return JSON.parse(JSON.stringify(obj ?? {})) as Record<string, unknown>
}

interface OverlayShape {
  lifecycle:          'active' | 'suspended' | 'cancelled'
  complimentary:      boolean
  pricePaiseOverride: number | null
  limitOverrides:     Partial<Record<'maxRegistrations' | 'maxTeamMembers' | 'maxBroadcastRecipients', number | null>>
  featureOverrides:   Partial<Record<string, boolean>>
  paymentReceived:    boolean
}

function readOverlay(doc: Partial<EventLicenseDoc>): OverlayShape {
  const a = doc.admin
  return {
    lifecycle:          a?.lifecycle ?? 'active',
    complimentary:      a?.complimentary === true,
    pricePaiseOverride: typeof a?.pricePaiseOverride === 'number' ? a.pricePaiseOverride : null,
    limitOverrides:     a?.limitOverrides ?? {},
    featureOverrides:   (a?.featureOverrides ?? {}) as Partial<Record<string, boolean>>,
    paymentReceived:    a?.paymentReceived === true,
  }
}

function displayStatus(baseStatus: string, lifecycle: OverlayShape['lifecycle']): LicenseDisplayStatus {
  if (lifecycle === 'suspended') return 'suspended'
  if (lifecycle === 'cancelled') return 'cancelled'
  return baseStatus === 'active' ? 'active' : 'pending'
}

function paymentStatus(
  overlay: OverlayShape,
  amountPaise: number,
  order: Record<string, unknown> | undefined,
): LicensePaymentStatus {
  if (overlay.complimentary) return 'complimentary'
  if (order) {
    const s = order.status
    if (s === 'paid')     return 'paid'
    if (s === 'failed')   return 'failed'
    if (s === 'refunded') return 'refunded'
    if (s === 'refunding') return 'refunding'
    if (s === 'created')  return overlay.paymentReceived ? 'paid' : 'pending'
  }
  if (amountPaise > 0) return overlay.paymentReceived ? 'paid' : 'pending'
  return 'free'
}

// ─── Row builder ────────────────────────────────────────────────────────────────

interface RowJoins {
  event?:      Record<string, unknown>
  organizer?:  Record<string, unknown>
  order?:      Record<string, unknown>
  used?:       number
}

function buildRow(doc: EventLicenseDoc, catalog: LicenseCatalog, catalogV2: LicenseCatalogV2, joins: RowJoins): LicenseRow {
  // RD-LICENSE-01B Phase 3C.1 — resolve the DISPLAY def by the license's stored version
  // (V1 tier → V1 catalog, V2 tier → V2 catalog); never crashes on a cross-version tier.
  const version = typeof doc.version === 'number' && doc.version >= 1 ? doc.version : 1
  const tier: AnyEventLicenseTier = isValidTierForVersion(doc.tier, version) ? doc.tier : 'starter'
  const overlay = readOverlay(doc)
  const baseDef = pickVersionedDefinition(catalog, catalogV2, tier, version)
  const eff     = resolveEffectiveEventLicense(baseDef, doc.status, doc.amountPaise ?? 0, doc.admin)
  const maxReg  = eff.definition.limits.maxRegistrations

  const ev = joins.event
  // RD-EVENT-COMMERCE-04 — a capacity licence carries the free tier only as a compatibility
  // stamp. Its limit is the capacity it BOUGHT: the enforced events.totalCapacity (the single
  // enforced source), else the licence's own purchased figure — never the tier's 200.
  const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
  const capacityLimit = isCapacityLicence(doc)
    ? (isInt(ev?.totalCapacity) ? ev.totalCapacity : isInt((doc as { capacity?: unknown }).capacity) ? (doc as { capacity: number }).capacity : (isUnlimited(maxReg) ? null : maxReg))
    : undefined
  const org = joins.organizer
  const hasOverrides =
    overlay.complimentary ||
    overlay.pricePaiseOverride !== null ||
    Object.keys(overlay.limitOverrides).length > 0 ||
    Object.keys(overlay.featureOverrides).length > 0

  return {
    eventId:             doc.eventId,
    eventName:           typeof nested(ev, 'eventDetails', 'info', 'name') === 'string'
      ? (nested(ev, 'eventDetails', 'info', 'name') as string) : doc.eventId,
    eventStatus:         typeof ev?.lifecycleStatus === 'string' ? (ev.lifecycleStatus as string) : null,
    organizerUid:        doc.organizerUid,
    organizerName:       typeof org?.name === 'string' ? (org.name as string) : '',
    organizerEmail:      typeof org?.email === 'string' ? (org.email as string) : '',
    organizationName:    typeof org?.organizationName === 'string' ? (org.organizationName as string) : '',
    tier,
    // RD-EVENT-COMMERCE-05 — a tier licence is HISTORICAL (tiers are no longer sold), and says so.
    tierName:            capacityLimit !== undefined ? 'Capacity licence' : `${baseDef.name} (legacy tier)`,   // version-aware display name (V1 or V2)
    displayStatus:       displayStatus(doc.status, overlay.lifecycle),
    lifecycle:           overlay.lifecycle,
    complimentary:       overlay.complimentary,
    source:              doc.source === 'admin' ? 'admin' : 'self_serve',
    amountPaidPaise:     doc.amountPaise ?? 0,
    effectivePricePaise: eff.effectivePricePaise,
    registrationLimit:   capacityLimit !== undefined ? capacityLimit : isUnlimited(maxReg) ? null : maxReg,
    used:                joins.used ?? 0,
    purchaseDate:        tsToISO(doc.paidAt) ?? tsToISO(doc.createdAt),
    paymentStatus:       paymentStatus(overlay, doc.amountPaise ?? 0, joins.order),
    hasOverrides,
    updatedAt:           tsToISO(doc.updatedAt),
  }
}

// ─── List ─────────────────────────────────────────────────────────────────────

export async function listLicenses(opts: {
  pageSize: number
  cursor?:  string | null
  search?:  string
  status?:  string
}): Promise<LicenseListResponse> {
  const pageSize = Math.min(Math.max(opts.pageSize, 1), 100)

  // RD-SA-COMMERCE-P1 (P1-5) — "on refund hold" is a QUERY, not a per-page filter: every held licence
  // platform-wide (bounded — holds are rare and each one is an incident), never a short page.
  const holdsOnly = (opts.status ?? '').trim() === 'refund_hold'
  let q = holdsOnly
    ? adminDb.collection(EVENT_LICENSES_COLLECTION).where('refundHold', '!=', null).limit(100)
    : adminDb.collection(EVENT_LICENSES_COLLECTION).orderBy('createdAt', 'desc').limit(pageSize + 1)
  if (opts.cursor && !holdsOnly) {
    const curSnap = await licenseRef(opts.cursor).get()
    if (curSnap.exists) q = q.startAfter(curSnap)
  }

  const snap     = await q.get()
  const hasMore  = !holdsOnly && snap.docs.length > pageSize
  const pageDocs = hasMore ? snap.docs.slice(0, pageSize) : snap.docs
  if (pageDocs.length === 0) return { items: [], nextCursor: null }

  const eventIds   = pageDocs.map(d => d.id)
  const orgUids    = [...new Set(pageDocs.map(d => (d.data() as EventLicenseDoc).organizerUid).filter(Boolean))]
  const orderIds   = pageDocs.map(d => (d.data() as EventLicenseDoc).orderId).filter((o): o is string => !!o)

  const [eventSnaps, orgSnaps, counterSnaps, orderSnaps, catalog, catalogV2] = await Promise.all([
    adminDb.getAll(...eventIds.map(id => adminDb.doc(`events/${id}`))),
    orgUids.length ? adminDb.getAll(...orgUids.map(u => adminDb.doc(`users/${u}`))) : Promise.resolve([]),
    adminDb.getAll(...eventIds.map(id => adminDb.doc(`registrationCounters/${id}`))),
    orderIds.length ? adminDb.getAll(...orderIds.map(o => adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${o}`))) : Promise.resolve([]),
    getLicenseCatalog(),
    getLicenseCatalogV2(),
  ])

  const eventMap = new Map<string, Record<string, unknown>>()
  eventSnaps.forEach((s, i) => { if (s.exists) eventMap.set(eventIds[i], s.data() as Record<string, unknown>) })
  const orgMap = new Map<string, Record<string, unknown>>()
  orgSnaps.forEach((s, i) => { if (s.exists) orgMap.set(orgUids[i], s.data() as Record<string, unknown>) })
  const usedMap = new Map<string, number>()
  counterSnaps.forEach((s, i) => { if (s.exists) usedMap.set(eventIds[i], (s.data() as { totalCount?: number }).totalCount ?? 0) })
  const orderMap = new Map<string, Record<string, unknown>>()
  orderSnaps.forEach(s => { if (s.exists) orderMap.set(s.id, s.data() as Record<string, unknown>) })

  let items = pageDocs.map(d => {
    const doc = { ...(d.data() as EventLicenseDoc), eventId: d.id }
    return buildRow(doc, catalog, catalogV2, {
      event:     eventMap.get(d.id),
      organizer: orgMap.get(doc.organizerUid),
      order:     doc.orderId ? orderMap.get(doc.orderId) : undefined,
      used:      usedMap.get(d.id),
    })
  })

  // In-memory filters for the page (Firestore has no substring search) — mirrors
  // the established admin list pattern (app/api/admin/organizers).
  const search = (opts.search ?? '').trim().toLowerCase()
  if (search) {
    items = items.filter(r =>
      r.eventName.toLowerCase().includes(search) ||
      r.eventId.toLowerCase().includes(search) ||
      r.organizerName.toLowerCase().includes(search) ||
      r.organizerEmail.toLowerCase().includes(search) ||
      r.organizationName.toLowerCase().includes(search) ||
      r.tier.includes(search),
    )
  }
  const status = (opts.status ?? '').trim()
  if (status && !holdsOnly) {
    if (status === 'complimentary') items = items.filter(r => r.complimentary)
    else                            items = items.filter(r => r.displayStatus === status)
  }

  return { items, nextCursor: hasMore ? pageDocs[pageDocs.length - 1].id : null }
}

// ─── Detail (+ timeline) ────────────────────────────────────────────────────────

export async function getLicenseDetail(eventId: string): Promise<LicenseDetail | null> {
  const snap = await licenseRef(eventId).get()
  if (!snap.exists) return null
  const doc = { ...(snap.data() as EventLicenseDoc), eventId }

  const [eventSnap, orgSnap, counterSnap, orderSnap, historySnap, catalog, catalogV2] = await Promise.all([
    adminDb.doc(`events/${eventId}`).get(),
    adminDb.doc(`users/${doc.organizerUid}`).get(),
    adminDb.doc(`registrationCounters/${eventId}`).get(),
    doc.orderId ? adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`).get() : Promise.resolve(null),
    adminDb.collection(LICENSE_HISTORY_COLLECTION).where('eventId', '==', eventId).limit(200).get(),
    getLicenseCatalog(),
    getLicenseCatalogV2(),
  ])

  const order = orderSnap?.exists ? (orderSnap.data() as Record<string, unknown>) : undefined
  const row = buildRow(doc, catalog, catalogV2, {
    event:     eventSnap.exists ? (eventSnap.data() as Record<string, unknown>) : undefined,
    organizer: orgSnap.exists ? (orgSnap.data() as Record<string, unknown>) : undefined,
    order,
    used:      counterSnap.exists ? ((counterSnap.data() as { totalCount?: number }).totalCount ?? 0) : 0,
  })

  const timeline: LicenseTimelineEntry[] = historySnap.docs
    .map(d => {
      const h = d.data() as Record<string, unknown>
      return {
        id:        d.id,
        action:    typeof h.action === 'string' ? h.action : 'unknown',
        // History spans versions — accept either vocabulary (no version stored per entry).
        fromTier:  (isEventLicenseTier(h.fromTier) || isEventLicenseTierV2(h.fromTier)) ? h.fromTier as AnyEventLicenseTier : null,
        toTier:    (isEventLicenseTier(h.toTier) || isEventLicenseTierV2(h.toTier)) ? h.toTier as AnyEventLicenseTier : doc.tier,
        source:    (h.source === 'admin' || h.source === 'system') ? h.source : 'self_serve',
        actorUid:  typeof h.actorUid === 'string' ? h.actorUid : null,
        note:      typeof h.note === 'string' ? h.note : '',
        reason:    typeof h.reason === 'string' ? h.reason : null,
        createdAt: tsToISO(h.createdAt),
      } as LicenseTimelineEntry
    })
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))

  const ov = readOverlay(doc)
  return {
    row,
    overlay: doc.admin ? {
      lifecycle:          ov.lifecycle,
      complimentary:      ov.complimentary,
      pricePaiseOverride: ov.pricePaiseOverride,
      limitOverrides:     ov.limitOverrides,
      featureOverrides:   ov.featureOverrides as Partial<Record<EventLicenseFeature, boolean>>,
      paymentReceived:    ov.paymentReceived,
    } : null,
    order: order && doc.orderId ? {
      orderId:           doc.orderId,
      status:            typeof order.status === 'string' ? order.status : 'unknown',
      amountPaise:       typeof order.amountPaise === 'number' ? order.amountPaise : 0,
      razorpayPaymentId: typeof order.razorpayPaymentId === 'string' ? order.razorpayPaymentId : null,
    } : null,
    timeline,
    capacityModel: isCapacityLicence(doc),
    refundState: refundStateOf(doc as unknown as Record<string, unknown>, Date.now(), order ? { ...order, orderId: doc.orderId } : undefined),
  }
}

/** RD-SA-COMMERCE-P1 — the licence's refund fields, projected for Super Admin visibility only. */
export function refundStateOf(d: Record<string, unknown>, nowMs = Date.now(), order?: Record<string, unknown>): LicenseRefundStateView {
  const obj = (v: unknown) => (v && typeof v === 'object' ? v as Record<string, unknown> : null)
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  const h = obj(d.refundHold), r = obj(d.refundReview)
  const holdAt = h ? tsToISO(h.at) : null
  const legacy = !h && order?.status === 'refunding' && typeof order.orderId === 'string'
  return {
    hold: h ? {
      orderId: str(h.orderId), by: str(h.by), at: holdAt,
      ageHours: holdAt ? Math.max(0, Math.floor((nowMs - Date.parse(holdAt)) / 3_600_000)) : null,
      phase: str(h.phase),
      releasableAfter: holdAt ? new Date(Date.parse(holdAt) + REFUND_HOLD_MIN_RELEASE_AGE_MS).toISOString() : null,
      releaseAgeReached: refundHoldOldEnough(holdAt ? Date.parse(holdAt) : null, nowMs),
      gatewayOutcome: str(h.gatewayOutcome),
    } : null,
    legacyRefundingOrder: legacy ? { orderId: order!.orderId as string, since: tsToISO(order!.refundClaimedAt) ?? tsToISO(order!.updatedAt) } : null,
    refundFailure: (() => {
      const rf = obj(d.refundFailure)
      return rf ? {
        status: str(rf.status), evidence: str(rf.evidence), refundIds: Array.isArray(rf.refundIds) ? rf.refundIds.map(String) : [],
        amountPaise: num(rf.amountPaise), firstAt: tsToISO(rf.firstAt), acknowledgedBy: str(rf.acknowledgedBy), acknowledgedReason: str(rf.acknowledgedReason),
      } : null
    })(),
    review: r ? {
      at: tsToISO(r.at), by: str(r.by), reason: str(r.reason),
      conflicts: Array.isArray(r.conflicts) ? r.conflicts.filter((c): c is string => typeof c === 'string') : [],
      totalRefundPaise: num(r.totalRefundPaise), sold: num(r.sold), capacityBefore: num(r.capacityBefore), capacityAfter: num(r.capacityAfter),
    } : null,
    refundedAt:            tsToISO(d.refundedAt),
    entitlementRestoredAt: tsToISO(d.entitlementRestoredAt),
    // A legacy `refunding` order (P1-3) is not a licence block today — shown so it can be resolved.
    blocksNewSales:        licenceRegistrationBlock(d) !== null,
  }
}

// ─── Actions ────────────────────────────────────────────────────────────────────

const AUDIT_ACTION: Record<LicenseAdminActionType, AdminAuditAction> = {
  grant:               'license.granted',
  suspend:             'license.suspended',
  reactivate:          'license.reactivated',
  cancel:              'license.cancelled',
  upgrade:             'license.upgraded',
  downgrade:           'license.downgraded',
  overridePrice:       'license.price_override',
  overrideLimit:       'license.limit_override',
  overrideFeatures:    'license.feature_override',
  markPaymentReceived: 'license.payment_received',
  refund:              'license.refunded',
  reissue:             'license.reissued',
  addNote:             'license.note_added',
  extendExpiry:               'license.expiry_extended',
  reduceExpiry:               'license.expiry_reduced',
  disableExpiry:              'license.expiry_disabled',
  overridePublish:            'license.governance_override',
  overrideIdentity:           'license.governance_override',
  overrideRegistrationSafety: 'license.governance_override',
  forceConsume:               'license.force_consumed',
  resetLicense:               'license.reset',
  releaseRefundHold:          'license.refund_hold_released',
  completeRefund:             'license.refund_completed',
  acknowledgeRefundFailure:   'license.refund_failure_acknowledged',
}

const HISTORY_ACTION: Record<LicenseAdminActionType, LicenseHistoryAction> = {
  grant:               'granted',
  suspend:             'suspended',
  reactivate:          'reactivated',
  cancel:              'cancelled',
  upgrade:             'upgraded',
  downgrade:           'downgraded',
  overridePrice:       'price_override',
  overrideLimit:       'limit_override',
  overrideFeatures:    'feature_override',
  markPaymentReceived: 'payment_received',
  refund:              'refunded',
  reissue:             'reissued',
  addNote:             'note',
  extendExpiry:               'expiry_extended',
  reduceExpiry:               'expiry_reduced',
  disableExpiry:              'expiry_disabled',
  overridePublish:            'governance_override',
  overrideIdentity:           'governance_override',
  overrideRegistrationSafety: 'governance_override',
  forceConsume:               'force_consumed',
  resetLicense:               'reset',
  releaseRefundHold:          'refund_hold_released',
  completeRefund:             'refund_completed',
  acknowledgeRefundFailure:   'refund_failure_acknowledged',
}

/** The licence-history entry (immutable, append-only) for one admin action. */
interface LicenseHistoryEntryInput {
  eventId: string; organizerUid: string; action: LicenseHistoryAction
  // RD-LICENSE-01B — widened to match the widened LicenseHistoryDoc (type-only; the values
  // written are unchanged — the admin service still produces V1 tiers under version 1).
  fromTier: AnyEventLicenseTier | null; toTier: AnyEventLicenseTier
  actorUid: string; note: string; reason: string; before?: unknown; after?: unknown
  orderId?: string | null
}
type LicensePlatformAudit = Omit<AdminAuditParams, 'entityType' | 'entityId'> & { entityType?: AdminAuditParams['entityType'] }

/**
 * Stage the licenseHistory row AND its platform audit row (adminAuditLogs) on the caller's
 * transaction or batch. RD-EVENT-COMMERCE-04A made them one batch; RD-PHASE4-S4 (F8) moves them
 * INTO the action's own transaction, so the mutation, its history and its audit commit together
 * or not at all. Both are `create`: append-only, and the platform row's id is derived from the
 * history row's, so one logical action can never yield two platform rows.
 */
function stageLicenseHistory(
  writer: FirebaseFirestore.Transaction | FirebaseFirestore.WriteBatch,
  entry: LicenseHistoryEntryInput,
  platform?: LicensePlatformAudit,
): void {
  const histRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc()
  if (platform) {
    stageAdminAudit(writer, {
      ...platform,
      entityType: platform.entityType ?? 'license',
      entityId:   entry.eventId,
      reason:     platform.reason ?? (entry.reason || undefined),
      metadata:   { ...clean(platform.metadata ?? {}), licenseHistoryId: histRef.id },
      correlation: { eventId: entry.eventId, organizerUid: entry.organizerUid, orderId: entry.orderId ?? null, ...(platform.correlation ?? {}) },
    }, `license_${histRef.id}`)
  }
  ;(writer as FirebaseFirestore.WriteBatch).create(histRef, {
    eventId:      entry.eventId,
    organizerUid: entry.organizerUid,
    action:       entry.action,
    fromTier:     entry.fromTier,
    toTier:       entry.toTier,
    source:       'admin',
    orderId:      entry.orderId ?? null,
    actorUid:     entry.actorUid,
    note:         entry.note,
    reason:       entry.reason,
    // JSON round-trip: Firestore rejects `undefined`.
    ...(entry.before !== undefined ? { before: clean(entry.before) } : {}),
    ...(entry.after  !== undefined ? { after:  clean(entry.after)  } : {}),
    createdAt:    FieldValue.serverTimestamp(),
  })
}

/** The merge payload of a full admin overlay + bumped updatedAt. */
function overlayPayload(overlay: OverlayShape, adminUid: string) {
  return {
    admin: {
      lifecycle:          overlay.lifecycle,
      complimentary:      overlay.complimentary,
      pricePaiseOverride: overlay.pricePaiseOverride,
      limitOverrides:     overlay.limitOverrides,
      featureOverrides:   overlay.featureOverrides,
      paymentReceived:    overlay.paymentReceived,
      updatedBy:          adminUid,
      updatedAt:          FieldValue.serverTimestamp(),
    },
    updatedAt: FieldValue.serverTimestamp(),
  }
}

/** RD-EVENT-COMMERCE-01 · D5 — a capacity-model licence's capacity was BOUGHT; no tier-derived
 *  limit may ever be written over it. */
const isCapacityLicence = (d: { commercialModel?: unknown } | null | undefined): boolean =>
  d?.commercialModel === 'capacity'

/** The event-doc capacity fields for an effective limit (`Infinity` = unlimited). Every
 *  enforcement path reads `totalCapacity` — the registration transaction, verify-payment, webhook,
 *  restore, approve, bulk, AND the gate — so it moves in lock-step with the override. */
function eventCapacityPatch(maxRegistrations: number) {
  return {
    capacityPlan:     capacityPlanForRegistrationLimit(maxRegistrations),
    capacityOverride: Number.isFinite(maxRegistrations) ? maxRegistrations : FieldValue.delete(),
    totalCapacity:    Number.isFinite(maxRegistrations) ? maxRegistrations : null,
    updatedAt:        FieldValue.serverTimestamp(),
  }
}

/** Who performed a licence action — the route decides (addNote is open to any admin). */
export interface LicenseActionActor { actorRole?: AuditActorRole }

/** Apply an admin action to an event license. Validates, mutates, audits. */
export async function applyLicenseAction(
  eventId: string,
  req: LicenseAdminActionRequest,
  adminUid: string,
  actor: LicenseActionActor = {},
): Promise<LicenseAdminActionResponse> {
  const action = req.action
  const reason = (req.reason ?? '').trim()
  const actorRole: AuditActorRole = actor.actorRole ?? 'super_admin'

  // ═══ RD-EVENT-COMMERCE-05 · TIER ACTIONS RETIRED ═══════════════════════════════
  // RegisterDesk sells ONLY pay-as-you-go capacity + separately purchased services. Granting a
  // tier, or moving a licence up/down a tier, no longer exists as a commercial action — for any
  // licence, legacy or capacity. Historical tier licences stay readable (their tier, version and
  // history are untouched); admin capacity changes go through overrideLimit (sold-floor guarded)
  // and pricing through the capacity model. 410 so a stale client learns the action is gone.
  if (action === 'grant' || action === 'upgrade' || action === 'downgrade') {
    throw new LicenseActionError('Tier licences are retired. RegisterDesk sells registration capacity pay-as-you-go; use a capacity override instead of a tier grant, upgrade or downgrade.', 410)
  }
  // RD-LEGACY-01 — per-licence FEATURE overrides are retired too: there are no feature tiers, every
  // feature is available to every organizer, and nothing enforces a licence feature flag. Overrides
  // stored before retirement stay on the licence as history.
  if (action === 'overrideFeatures') {
    throw new LicenseActionError('Licence feature switches are retired — every feature is available to every organizer.', 410)
  }

  // RD-LICENSE-GA-02: resolve BOTH catalogs; a stored license doc resolves at its OWN version.
  // (RD-EVENT-COMMERCE-05 retired the tier writes — grant / upgrade — that resolved at the
  // current version, so no cross-version rank is needed any more.)
  const [catalog, catalogV2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
  const defFor = (t: string, v: number) => pickVersionedDefinition(catalog, catalogV2, t, v)
  const respond = (extra?: Partial<LicenseAdminActionResponse>): LicenseAdminActionResponse =>
    ({ ok: true, eventId, action, ...extra })

  if (action === 'refund') return refundLicense(eventId, adminUid, reason, actorRole, respond, { dryRun: req.dryRun === true })
  if (action === 'releaseRefundHold') return releaseStuckRefundHold(eventId, adminUid, reason, actorRole, respond)
  if (action === 'completeRefund') return completeInterruptedRefund(eventId, adminUid, reason, actorRole, respond)
  if (action === 'acknowledgeRefundFailure') return acknowledgeLicenceRefundFailure(eventId, adminUid, reason, actorRole, respond)

  // ── Request validation that needs no stored state (before any transaction) ──
  const limitKey = req.limitKey ?? 'maxRegistrations'
  if (action === 'overridePrice' && (typeof req.pricePaise !== 'number' || !Number.isInteger(req.pricePaise) || req.pricePaise < 0)) {
    throw new LicenseActionError('pricePaise must be a non-negative integer')
  }
  if (action === 'overrideLimit') {
    if (limitKey !== 'maxRegistrations' && limitKey !== 'maxTeamMembers' && limitKey !== 'maxBroadcastRecipients') {
      throw new LicenseActionError('Invalid limit key')
    }
    const v = req.limitValue
    if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
      throw new LicenseActionError('Registration/limit value must be a non-negative integer or null (unlimited)')
    }
  }
  let newExpiry: Timestamp | null = null
  if (action === 'extendExpiry' || action === 'reduceExpiry') {
    const days = req.expiryDays
    if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
      throw new LicenseActionError('expiryDays must be a positive number')
    }
    newExpiry = Timestamp.fromMillis(Date.now() + Math.round(days) * 86_400_000)
  }
  const note = (req.note ?? '').trim()
  if (action === 'addNote' && !note) throw new LicenseActionError('Note text is required')

  const GOVERNANCE_KEY = { overridePublish: 'publish', overrideIdentity: 'identity', overrideRegistrationSafety: 'registrationSafety' } as const
  const isGovernance = action === 'overridePublish' || action === 'overrideIdentity' || action === 'overrideRegistrationSafety'

  // ═══ RD-PHASE4-S4 · F8 — ONE transaction per action ═══════════════════════════════════════════
  // The overlay is read INSIDE the transaction (it used to be read outside and written back as a
  // full map, so two concurrent admin actions could silently undo each other), and the mutation,
  // its licenseHistory row and its adminAuditLogs row commit together. Reads first, then writes.
  await adminDb.runTransaction(async tx => {
    const lRef = licenseRef(eventId)
    const snap = await tx.get(lRef)
    // Every action requires an existing license.
    if (!snap.exists) throw new LicenseActionError('No license exists for this event', 404)
    const doc = { ...(snap.data() as EventLicenseDoc), eventId }
    const organizerUid = doc.organizerUid
    // Stored license doc → resolve its tier against ITS stored version (V1 or V2).
    const storedVersion = typeof doc.version === 'number' && doc.version >= 1 ? doc.version : 1
    const tier: AnyEventLicenseTier = isValidTierForVersion(doc.tier, storedVersion) ? doc.tier : defaultLicenseTierForVersion(storedVersion)
    const overlay = readOverlay(doc)
    const orderRef = doc.orderId ? adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(doc.orderId) : null

    // ── reads (all before any write) ──
    const evRef = adminDb.doc(`events/${eventId}`)
    const needsEvent =
      (action === 'overrideLimit' && limitKey === 'maxRegistrations') ||
      (action === 'reissue' && !isCapacityLicence(doc)) ||
      isGovernance || action === 'forceConsume' || action === 'resetLicense'
    const evSnap = needsEvent ? await tx.get(evRef) : null
    const draftIdRaw = evSnap?.exists ? (evSnap.data() as { draftId?: unknown }).draftId : null
    const draftId = typeof draftIdRaw === 'string' ? draftIdRaw : null
    const counterSnap = action === 'overrideLimit' && limitKey === 'maxRegistrations' && req.limitValue !== null
      ? await tx.get(adminDb.doc(`registrationCounters/${eventId}`)) : null
    const baselineSnap = (isGovernance || action === 'resetLicense') && draftId ? await tx.get(baselineRef(draftId)) : null

    const history = (h: Omit<LicenseHistoryEntryInput, 'eventId' | 'organizerUid' | 'actorUid' | 'fromTier' | 'toTier'> & { fromTier?: AnyEventLicenseTier | null }, platform: Omit<LicensePlatformAudit, 'adminUid' | 'actorRole'>) =>
      stageLicenseHistory(tx, {
        eventId, organizerUid, actorUid: adminUid, fromTier: h.fromTier === undefined ? tier : h.fromTier, toTier: tier, ...h,
      }, { adminUid, actorRole, ...platform })

    // The shared history + audit for the overlay / override actions (unchanged content).
    const simpleHistory = () => history({
      action: HISTORY_ACTION[action], fromTier: null,
      note: `${action} by admin`, reason,
      before: { tier, lifecycle: overlay.lifecycle, priceOverride: overlay.pricePaiseOverride, limits: overlay.limitOverrides, features: overlay.featureOverrides },
      after: clean(req),
    }, { action: AUDIT_ACTION[action], metadata: clean({ ...req, reason }) })

    // RD-SA-COMMERCE-P1 — a REFUNDED licence blocks new registrations until its entitlement is
    // explicitly restored. Reactivate / reissue are the two actions that set it active again, so on
    // a refunded licence they must say so (`restoreRefundedEntitlement: true`); the restore is stamped
    // on the licence and carried into the history + audit rows written in this same transaction.
    // A refund still in progress cannot be reactivated around.
    const licData = snap.data() as Record<string, unknown>
    const isRestoringAction = action === 'reactivate' || action === 'reissue'
    if (isRestoringAction && licData.refundHold != null) {
      throw new LicenseActionError('A refund of this licence is in progress. Reactivate it only after the refund has finished.', 409)
    }
    const refundedNotRestored = refundedMarkerOf(licData) && licData.entitlementRestoredAt == null
    if (isRestoringAction && refundedNotRestored && req.restoreRefundedEntitlement !== true) {
      throw new LicenseActionError(
        'This licence was refunded. Reactivating it gives the event back its entitlement without payment. Confirm to restore it.',
        409, { code: 'CONFIRMATION_REQUIRED', confirmField: 'restoreRefundedEntitlement', confirmValue: true },
      )
    }
    const restoreStamp = isRestoringAction && refundedNotRestored
      ? { entitlementRestoredAt: FieldValue.serverTimestamp(), entitlementRestoredBy: adminUid } : {}

    switch (action) {
      // ── Lifecycle ──
      case 'suspend': {
        if (overlay.lifecycle !== 'active') throw new LicenseActionError(`Cannot suspend a ${overlay.lifecycle} license`, 409)
        tx.set(lRef, overlayPayload({ ...overlay, lifecycle: 'suspended' }, adminUid), { merge: true })
        simpleHistory()
        return
      }
      case 'reactivate': {
        if (overlay.lifecycle === 'active' && !refundedNotRestored) throw new LicenseActionError('License is already active', 409)
        tx.set(lRef, { ...overlayPayload({ ...overlay, lifecycle: 'active' }, adminUid), ...restoreStamp }, { merge: true })
        simpleHistory()
        return
      }
      case 'cancel': {
        if (overlay.lifecycle === 'cancelled') throw new LicenseActionError('License is already cancelled', 409)
        tx.set(lRef, overlayPayload({ ...overlay, lifecycle: 'cancelled' }, adminUid), { merge: true })
        simpleHistory()
        return
      }

      // ── Overrides ──
      case 'overridePrice': {
        tx.set(lRef, overlayPayload({ ...overlay, pricePaiseOverride: req.pricePaise as number }, adminUid), { merge: true })
        simpleHistory()
        return
      }
      case 'overrideLimit': {
        const v = req.limitValue as number | null
        // RD-EVENT-COMMERCE-04 — a capacity-model event's capacity was BOUGHT: "unlimited" would
        // give it away for nothing. Checked before anything is written.
        if (limitKey === 'maxRegistrations' && v === null && isCapacityLicence(doc)) {
          throw new LicenseActionError('This event is on the capacity model: its capacity was purchased and cannot be made unlimited. Set a number instead.', 409)
        }
        // A finite registration limit may never go below registrations already taken — checked
        // against the counter read in THIS transaction (the doc every registration transaction
        // reads), so a registration landing concurrently cannot slip between check and write.
        if (limitKey === 'maxRegistrations') {
          if (v !== null) {
            const sold = soldFromCounter(counterSnap?.exists ? counterSnap.data() as Record<string, unknown> : undefined)
            if (v < sold) throw new LicenseActionError(`Capacity cannot go below the ${sold.toLocaleString('en-IN')} registrations already taken.`, 409)
          }
          // Registration cap enforcement is driven by the event doc — synced in the same commit.
          if (evSnap?.exists) tx.set(evRef, eventCapacityPatch(v === null ? Number.POSITIVE_INFINITY : v), { merge: true })
        }
        tx.set(lRef, overlayPayload({ ...overlay, limitOverrides: { ...overlay.limitOverrides, [limitKey]: v } }, adminUid), { merge: true })
        simpleHistory()
        return
      }
      // ── Payment ──
      case 'markPaymentReceived': {
        // RD-EVENT-COMMERCE-04 — capacity activation is settled ONLY by a verified gateway payment
        // (confirm / webhook apply the capacity in the same transaction). Flipping its order to
        // `paid` by hand would apply nothing, and the webhook would then skip a real capture as
        // "already paid". Legacy tier licences keep the manual path.
        if (isCapacityLicence(doc)) throw new LicenseActionError('This event is on the capacity model: its activation is settled only by a verified Razorpay payment. Use payment recovery for a stuck payment.', 409)
        tx.set(lRef, {
          ...overlayPayload({ ...overlay, paymentReceived: true }, adminUid),
          status: 'active',
          ...(doc.paidAt == null ? { paidAt: FieldValue.serverTimestamp() } : {}),
        }, { merge: true })
        if (orderRef) tx.set(orderRef, { status: 'paid', paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        simpleHistory()
        return
      }

      // ── Reissue — re-stamp the license record (support recovery) at its current tier ──
      case 'reissue': {
        // RD-EVENT-COMMERCE-04 — the STORED version is kept. Re-stamping CURRENT_LICENSE_VERSION
        // re-read a historical licence under a different catalog: a V1-only tier ('growth') became
        // invalid and a tier present in both versions silently changed its limits — a retroactive
        // entitlement rewrite. Reissue restores status; it never reinterprets what was sold.
        tx.set(lRef, {
          ...overlayPayload({ ...overlay, lifecycle: 'active' }, adminUid),
          status: 'active', version: storedVersion,
          ...restoreStamp,
        }, { merge: true })
        // RD-EVENT-COMMERCE-01 · D5 — a reissue is support recovery, not a capacity change. For a
        // capacity licence the tier limit is the FREE stamp; re-syncing it reset a paid capacity
        // (e.g. 1,206) to the free limit and stranded any in-flight capacity order as stale.
        if (!isCapacityLicence(doc) && evSnap?.exists) {
          tx.set(evRef, eventCapacityPatch(defFor(tier, storedVersion).limits.maxRegistrations), { merge: true })
        }
        simpleHistory()
        return
      }

      // ── Note (any admin; the only non-financial licence action) ──
      case 'addNote': {
        history({ action: 'note', note, reason: '' }, { action: AUDIT_ACTION.addNote, metadata: { note } })
        return
      }

      // ── EA-4 S1: License expiry ──
      case 'extendExpiry':
      case 'reduceExpiry': {
        const days = Math.round(req.expiryDays as number)
        const exp = newExpiry as Timestamp
        tx.set(lRef, { expiresAt: exp, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        if (orderRef) tx.set(orderRef, { expiresAt: exp, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        history({ action: HISTORY_ACTION[action], note: `Expiry set to ${days} days`, reason, after: { expiresAtMs: exp.toMillis() } },
          { action: AUDIT_ACTION[action], metadata: { days, reason } })
        return
      }
      case 'disableExpiry': {
        tx.set(lRef, { expiresAt: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        if (orderRef) tx.set(orderRef, { expiresAt: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        history({ action: 'expiry_disabled', note: 'Expiry disabled (perpetual)', reason }, { action: 'license.expiry_disabled', metadata: { reason } })
        return
      }

      // ── EA-4 S1: Publish-governance overrides (written to the event's baseline) ──
      case 'overridePublish':
      case 'overrideIdentity':
      case 'overrideRegistrationSafety': {
        if (!draftId || !baselineSnap) throw new LicenseActionError('Could not resolve the event to apply a governance override', 422)
        const enabled = req.overrideEnabled !== false
        const key = GOVERNANCE_KEY[action]
        stageBaselineOverrides(tx, baselineSnap, draftId, { [key]: enabled, setBy: adminUid, reason })
        history({ action: 'governance_override', note: `${key} override ${enabled ? 'enabled' : 'cleared'}`, reason, after: { [key]: enabled } },
          { action: 'license.governance_override', metadata: { key, enabled, reason } })
        return
      }

      // ── EA-4 S1: Consumption controls ──
      case 'forceConsume': {
        const now = FieldValue.serverTimestamp()
        tx.set(lRef, { consumed: true, consumedAt: now, updatedAt: now }, { merge: true })
        if (orderRef && doc.orderId) {
          tx.set(orderRef, { consumed: true, boundEventId: draftId ?? doc.orderId.replace(/^lic_/, ''), consumedAt: now, updatedAt: now }, { merge: true })
        }
        history({ action: 'force_consumed', note: 'License force-consumed by admin', reason }, { action: 'license.force_consumed', metadata: { reason } })
        return
      }
      case 'resetLicense': {
        const now = FieldValue.serverTimestamp()
        tx.set(lRef, { consumed: false, consumedAt: null, updatedAt: now }, { merge: true })
        if (orderRef) tx.set(orderRef, { consumed: false, boundEventId: null, consumedAt: null, updatedAt: now }, { merge: true })
        if (draftId && baselineSnap) stageBaselineOverrides(tx, baselineSnap, draftId, { publish: false, identity: false, registrationSafety: false, setBy: adminUid, reason })
        history({ action: 'reset', note: 'License governance state reset by admin', reason }, { action: 'license.reset', metadata: { reason } })
        return
      }

      default:
        throw new LicenseActionError(`Unknown action: ${String(action)}`)
    }
  })
  return respond()
}

// ── Refund — gateway refund + wallet credit-back + cancel license ──────────────────────────────
//
// RD-PHASE4-S4 · F3 — once the gateway refund has SUCCEEDED, money has moved: no later step may
// turn that into a failure response. The steps after it (order finalize, wallet credit-back, the
// overlay cancel + history + audit transaction) are each still attempted; a failure is recorded
// durably (adminAuditFailures, via logAdminActionOrRecord) and returned as `reconciliation`, and
// the response reports the TRUE outcome. Before the gateway leg, failures still fail the call.
/** RD-COMMS-P1 — set (once) when a licence refund is recorded; the non-wallet "already refunded" marker. */
const refundedMarkerOf = (d: unknown): boolean =>
  !!d && typeof d === 'object' && (d as { refundedAt?: unknown }).refundedAt != null

/** RD-SA-COMMERCE-P1 — the assessment inputs read from one consistent set of snapshots (a
 *  transaction's, or plain reads for a preview). Reads only; no writes. */
function refundAssessmentFrom(args: {
  licence: Record<string, unknown>; order: Record<string, unknown> | null; orderId: string | null
  organizerUid: string; event: Record<string, unknown> | undefined; counter: Record<string, unknown> | undefined
  ledger: (ServiceLedgerDoc & { appliedOrders?: Record<string, unknown>; refundedOrders?: Record<string, unknown> }) | undefined
  walletChargePaise: number
  /** RD-SA-COMMERCE-P1 — photos holding the event's paid photo capacity (media usage is NOT a ledger
   *  counter: it is the stored-photo count the photo gate maintains). 0 when the order has no media. */
  photosUsed: number
}): LicenceRefundAssessment {
  const lines: Record<string, RefundServiceLine> = {}
  if (args.ledger) {
    for (const k of SERVICE_KINDS) {
      const l = ledgerLine(args.ledger, k)
      lines[k] = { purchased: l.purchased, consumed: k === 'media' ? Math.max(0, args.photosUsed) : l.consumed, carriedOut: l.carriedOut, refunded: l.refunded }
    }
  }
  return assessLicenceRefund({
    licence: { commercialModel: args.licence.commercialModel },
    order: args.order, orderId: args.orderId, organizerUid: args.organizerUid,
    eventCapacity: args.event ? deriveStoredEventCapacity(args.event) : null,
    sold: soldFromCounter(args.counter),
    ledger: args.ledger ? {
      organizerUid: args.ledger.organizerUid, appliedOrders: args.ledger.appliedOrders,
      refundedOrders: args.ledger.refundedOrders, lines,
    } : null,
    walletChargePaise: args.walletChargePaise,
  })
}

async function refundLicense(
  eventId: string, adminUid: string, reason: string, actorRole: AuditActorRole,
  respond: (extra?: Partial<LicenseAdminActionResponse>) => LicenseAdminActionResponse,
  opts: { dryRun?: boolean } = {},
): Promise<LicenseAdminActionResponse> {
  const snap = await licenseRef(eventId).get()
  if (!snap.exists) throw new LicenseActionError('No license exists for this event', 404)
  const doc = { ...(snap.data() as EventLicenseDoc), eventId }
  const organizerUid = doc.organizerUid
  const storedVersion = typeof doc.version === 'number' && doc.version >= 1 ? doc.version : 1
  const tier: AnyEventLicenseTier = isValidTierForVersion(doc.tier, storedVersion) ? doc.tier : defaultLicenseTierForVersion(storedVersion)

  const refundLedgerRef = adminDb.doc(`walletTransactions/license_refund_${eventId}`)
  const evRef      = adminDb.doc(`events/${eventId}`)
  const counterRef = adminDb.doc(`registrationCounters/${eventId}`)
  const orderRef   = doc.orderId ? adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`) : null
  const draftKeyForLedger = doc.orderId?.startsWith('lic_') ? doc.orderId.slice(4) : null

  // The historical wallet-paid portion (retired wallet-first activation). Immutable once written,
  // so it is read once and shared by the preview, the claim and the credit-back below.
  const walletUsed = await historicalWalletChargePaise(doc.orderId, eventId)

  // RD-INTEG — two states in which refunding the whole activation order would be wrong:
  //   • a WhatsApp broadcast for this event is still unsettled: its reserved prepaid units count as
  //     consumed now and are released at settlement — after this refund retired the "unused" ones,
  //     they would become usable again on a refunded order;
  //   • an event-service refund was already requested/approved/paid for this event's units: the
  //     gateway refund below returns the FULL order amount, so that money would go back twice.
  {
    const draftKey = doc.orderId?.startsWith('lic_') ? doc.orderId.slice(4) : null
    const [openBroadcast, serviceRefunds] = await Promise.all([
      adminDb.collection('broadcastCampaigns').where('eventSlug', '==', eventId).where('billingSettlement', '==', 'pending').limit(1).get(),
      draftKey
        ? adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', draftKey).where('status', 'in', ['submitted', 'approved', 'processed']).limit(10).get()
        : Promise.resolve(null),
    ])
    if (!openBroadcast.empty) throw new LicenseActionError('A WhatsApp broadcast for this event has not finished settling. Refund the licence once it has ended (the cron settles it within minutes).', 409)
    if (serviceRefunds && serviceRefunds.docs.some(d => (d.data() as { kind?: unknown }).kind === 'refund')) {
      throw new LicenseActionError('An event-service refund for this event is open or already approved/paid. Resolve it first — a licence refund returns the full order amount, which would refund those units twice.', 409)
    }
  }
  // Already refunded: the licence's own refund marker (RD-COMMS-P1, below), or — for refunds made
  // before that marker existed — the deterministic refund ledger row (F-1).
  if (refundedMarkerOf(snap.data()) || (await refundLedgerRef.get()).exists) {
    throw new LicenseActionError('This license has already been refunded', 409)
  }
  if ((snap.data() as { refundHold?: unknown }).refundHold != null) {
    throw new LicenseActionError('A refund of this licence is already in progress.', 409)
  }

  // RD-SA-COMMERCE-P1 — media usage is the stored-photo count (not a ledger counter); read it only when
  // the activation order actually bought media units.
  // ═══ RD-SA-COMMERCE-P1 · preview — what this refund would do, with no side effects ═══════════
  if (opts.dryRun) {
    const [orderSnap, evSnap, cSnap, lgSnap] = await Promise.all([
      orderRef ? orderRef.get() : Promise.resolve(null),
      evRef.get(), counterRef.get(),
      draftKeyForLedger ? serviceLedgerRef(draftKeyForLedger).get() : Promise.resolve(null),
    ])
    const order = orderSnap?.exists ? orderSnap.data() as Record<string, unknown> : null
    const photosUsed = draftKeyForLedger && orderHasMedia(order) ? (await readEventPhotoCapacity(organizerUid, draftKeyForLedger)).used : 0
    const refundAssessment = refundAssessmentFrom({
      licence: snap.data() as Record<string, unknown>,
      order, orderId: doc.orderId ?? null,
      organizerUid, event: evSnap.exists ? evSnap.data() : undefined, counter: cSnap.exists ? cSnap.data() : undefined,
      ledger: lgSnap?.exists ? lgSnap.data() as ServiceLedgerDoc : undefined,
      walletChargePaise: walletUsed, photosUsed,
    })
    return respond({
      refundAssessment,
      message: refundAssessment.conflicts.length
        ? 'This refund needs a Super Admin decision before it can be issued.'
        : 'Preview only — nothing was refunded or changed.',
    })
  }

  // ═══ RD-SA-COMMERCE-P1 · CLAIM — one transaction, before any money moves ══════════════════════
  // Re-reads the licence, the activation order, the event, the sold count, the allowance ledger and
  // (for media) the stored-photo count, re-assesses the refund from THOSE snapshots and refuses —
  // writing nothing here — when a full refund would return money for something already used.
  // Otherwise, atomically:
  //   • claims the order (→ 'refunding', so two concurrent refunds cannot both reach the gateway — H-1);
  //   • puts the LICENCE on refund hold — every seat-adding registration transaction reads it, so no new
  //     registration can land and the sold count used for the capacity floor can only go down;
  //   • puts the order's unused prepaid units on refund hold on the LEDGER — every consumer
  //     (decideReserve for WhatsApp / certificates, the photo gate for media) reads the ledger in its
  //     own transaction and treats held units as unavailable, so none can be used while their money
  //     is returned. Finalize retires exactly these units; a rollback releases them.
  // P1-2 — the hold and the order carry THIS attempt's id; every later step that ends the hold re-checks
  // it in its own transaction, so no actor can act on another attempt's hold.
  const attemptId = randomUUID()
  const claimed = await adminDb.runTransaction<{ ok: true; claim: RefundClaim } | { ok: false; assessment: LicenceRefundAssessment }>(async txn => {
    const lSnap = await txn.get(licenseRef(eventId))
    if (!lSnap.exists) throw new LicenseActionError('No license exists for this event', 404)
    const lData = lSnap.data() as Record<string, unknown>
    if (refundedMarkerOf(lData)) throw new LicenseActionError('This license has already been refunded', 409)
    if (lData.refundHold != null) throw new LicenseActionError('A refund of this licence is already in progress.', 409)
    const oSnap = orderRef ? await txn.get(orderRef) : null
    const o = oSnap?.exists ? (oSnap.data() as Record<string, unknown>) : null
    if (o && (o.status === 'refunded' || o.status === 'refunding')) {
      throw new LicenseActionError('Order already refunded', 409)
    }
    const [evSnap, cSnap] = await txn.getAll(evRef, counterRef)
    const lgSnap = draftKeyForLedger ? await txn.get(serviceLedgerRef(draftKeyForLedger)) : null
    const photosUsed = draftKeyForLedger && orderHasMedia(o) ? (await txnReadPhotoCapacity(txn, organizerUid, draftKeyForLedger)).used : 0
    const ledger = lgSnap?.exists ? lgSnap.data() as ServiceLedgerDoc : undefined
    if (ledger?.refundHold) throw new LicenseActionError('Units of this event are already held by a refund in progress.', 409)
    const assessment = refundAssessmentFrom({
      licence: lData, order: o, orderId: doc.orderId ?? null, organizerUid,
      event: evSnap.exists ? evSnap.data() : undefined, counter: cSnap.exists ? cSnap.data() : undefined,
      ledger, walletChargePaise: walletUsed, photosUsed,
    })
    // No refund amount exists in the policy for a partial refund — a Super Admin must decide.
    if (assessment.conflicts.length) return { ok: false, assessment }
    // RD-M5 refund race — the claim does NOT release the organizer's coupon use: a `refunding`
    // order still counts (counter unchanged; the seeding/pre-check query includes `refunding`)
    // until the refund is CONFIRMED and finalized below. `wasPaid` tells finalization whether
    // this order was a redemption at all.
    if (o && orderRef) {
      txn.update(orderRef, {
        status: 'refunding', refundAttemptId: attemptId, refundClaimedFrom: String(o.status ?? ''),
        refundClaimedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      })
    }
    txn.set(licenseRef(eventId), {
      refundHold: { at: FieldValue.serverTimestamp(), by: adminUid, orderId: doc.orderId ?? null, attemptId, phase: 'claimed' satisfies RefundHoldPhase },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    const holdUnits: Record<string, number> = {}
    for (const s of assessment.services) if (s.retirable > 0) holdUnits[s.service] = s.retirable
    const heldLedger = draftKeyForLedger && lgSnap?.exists && Object.keys(holdUnits).length ? draftKeyForLedger : null
    if (heldLedger) {
      txn.set(serviceLedgerRef(heldLedger), {
        refundHold: { orderId: doc.orderId, units: holdUnits, at: FieldValue.serverTimestamp() },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    }
    return {
      ok: true,
      claim: {
        paymentId:     typeof o?.razorpayPaymentId === 'string' ? o.razorpayPaymentId : null,
        gatewayAmount: typeof o?.amountPaise === 'number' ? o.amountPaise : 0,
        wasPaid:       o?.status === 'paid',
        assessment, heldLedger,
      },
    }
  })

  if (!claimed.ok) {
    // RD-SA-COMMERCE-P1 — a durable Super Admin REVIEW state (nothing moved, nothing blocked): the
    // licence records what was asked and why it needs a decision, with a history + audit row, in one
    // transaction. The licence stays as it was — suspend it separately if sales must stop.
    // P1-6 — if that transaction fails, the refusal is still recorded durably: the audit row (or, if
    // that write fails too, an adminAuditFailures record) and a financial error event.
    const a = claimed.assessment
    const codes = a.conflicts.map(c => c.code)
    await adminDb.runTransaction(async tx => {
      tx.set(licenseRef(eventId), {
        refundReview: {
          at: FieldValue.serverTimestamp(), by: adminUid, reason,
          conflicts: codes, totalRefundPaise: a.totalRefundPaise,
          sold: a.sold, capacityBefore: a.capacityBefore, capacityAfter: a.capacityAfter,
        },
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      stageLicenseHistory(tx, {
        eventId, organizerUid, action: 'refund_review_required', fromTier: tier, toTier: tier,
        actorUid: adminUid, reason, orderId: doc.orderId,
        note: `Refund needs a Super Admin decision: ${codes.join(', ')}`,
        after: { conflicts: a.conflicts, totalRefundPaise: a.totalRefundPaise, sold: a.sold, capacityBefore: a.capacityBefore, capacityAfter: a.capacityAfter, services: a.services },
      }, { adminUid, actorRole, action: 'license.refund_review_required', metadata: { reason, conflicts: codes, totalRefundPaise: a.totalRefundPaise } })
    }).catch(async err => {
      console.error(`[license-refund] could not record the review state for ${eventId}`, err)
      captureFinancialError(err, { scope: 'license_refund.review_record_failed', eventId })
      await logAdminActionOrRecord({
        adminUid, actorRole, action: 'license.refund_review_required', entityType: 'license', entityId: eventId,
        reason, metadata: { conflicts: codes, totalRefundPaise: a.totalRefundPaise, reviewRecordFailed: true },
        correlation: { eventId, organizerUid, orderId: doc.orderId ?? null },
      })
    })
    throw new LicenseActionError(
      `This refund needs a Super Admin decision: ${a.conflicts.map(c => c.message).join(' ')}`,
      409, { code: 'REFUND_REVIEW_REQUIRED', refundAssessment: a },
    )
  }
  const claim = claimed.claim
  const releaseOwnHold = (revertOrder: boolean) => releaseAttemptHold({ eventId, orderRef, heldLedger: claim.heldLedger, orderId: doc.orderId ?? null, attemptId, revertOrder })

  // ═══ RD-SA-COMMERCE-P1 (P1-1 / P1-2) · the gateway leg ════════════════════════════════════════
  let gatewayRefunded = false
  const notes: string[] = []
  if (doc.orderId && orderRef && claim.paymentId && claim.gatewayAmount > 0) {
    // FENCE — only the attempt that still owns the hold may send money; it marks the hold `gateway`.
    try {
      await adminDb.runTransaction(async txn => {
        const l = await txn.get(licenseRef(eventId))
        const h = (l.data() as { refundHold?: { attemptId?: unknown } } | undefined)?.refundHold
        if (!h || h.attemptId !== attemptId) {
          throw new LicenseActionError('The refund hold was released or replaced before the refund was sent — nothing was refunded. Reload and try again.', 409, { code: 'REFUND_HOLD_LOST' })
        }
        txn.update(licenseRef(eventId), { 'refundHold.phase': 'gateway' satisfies RefundHoldPhase, 'refundHold.gatewayAt': FieldValue.serverTimestamp() })
      })
    } catch (err) {
      if (err instanceof LicenseActionError) throw err
      await releaseOwnHold(true)        // nothing was sent — undo the claim
      throw err
    }
    try {
      // Lazy-load the Razorpay client ONLY when a real gateway refund executes, so
      // this module never initializes/validates Razorpay on any read path.
      const { razorpay } = await import('@/lib/razorpay/client')
      await razorpay.payments.refund(claim.paymentId, {
        amount: claim.gatewayAmount, speed: 'optimum',
        notes: { kind: 'license_refund', eventId },
        receipt: `lrfnd_${eventId}`.slice(0, 40),
      })
      gatewayRefunded = true
    } catch (e) {
      // P1-1 / H1 — a thrown request says NOTHING about what the gateway did. Two facts are needed:
      //   • did the gateway itself REJECT this request (a structured 4xx error response)? A timeout,
      //     connection reset, missing response or 5xx is NOT a rejection — the refund may still be created;
      //   • what does the gateway's refund list show NOW (read-only)?
      // Only a definitive rejection AND a list with no refund undo the claim. An immediate "none" after an
      // ambiguous failure proves nothing (the refund can appear later), so it keeps everything held.
      // Nothing here ever sends another refund.
      const definitive = isDefinitiveGatewayRejection(e)
      const outcome = await gatewayRefundOutcome(claim.paymentId, claim.gatewayAmount)
      const msg = gatewayErrorMessage(e)
      if (outcome.kind === 'full') {
        // The gateway DID refund (e.g. the response was lost): finish the refund internally, no new refund.
        gatewayRefunded = true
        notes.push('gateway_error_but_refunded')
      } else if (definitive && outcome.kind === 'none') {
        // Proven: the gateway rejected the request and holds no refund. Undo the claim — only while the
        // hold is still this attempt's.
        const lifted = await releaseOwnHold(true)
        throw new LicenseActionError(`Razorpay refund failed: ${msg}${lifted ? '' : ' — the refund hold could not be lifted and stays in place; release it once confirmed'}`, 502)
      } else {
        // Ambiguous failure, partial refund or unreadable list: nothing is concluded, nothing is released.
        const recorded = definitive ? outcome.kind : `${outcome.kind}_after_ambiguous_error`
        await recordRefundOutcomeUnknown({ eventId, organizerUid, tier, adminUid, actorRole, reason, orderId: doc.orderId, attemptId, outcome: recorded, error: msg })
        throw new LicenseActionError(
          'The Razorpay refund request failed and its outcome could not be confirmed. Nothing was released: the licence and its units stay on refund hold. Check Razorpay, then use “Complete refund” if it shows the full refund, or — after 15 minutes — “Release refund hold” if it still shows none.',
          502, { code: 'REFUND_OUTCOME_UNKNOWN', gatewayOutcome: outcome.kind, ambiguousError: !definitive },
        )
      }
    }
  }

  return settleLicenceRefund({
    eventId, doc, organizerUid, tier, adminUid, reason, actorRole, respond, walletUsed, claim,
    gatewayRefunded, moneyAlreadyMoved: false, releaseOwnHold, mode: 'refund', attemptId, notes,
  })
}

// ═══ RD-SA-COMMERCE-P1 · shared helpers for the refund pipeline ════════════════════════════════

type RefundClaim = { paymentId: string | null; gatewayAmount: number; wasPaid: boolean; assessment: LicenceRefundAssessment; heldLedger: string | null }

const orderHasMedia = (o: Record<string, unknown> | null) =>
  Array.isArray(o?.serviceItems) && (o!.serviceItems as Array<{ service?: unknown; quantity?: unknown }>).some(i => i.service === 'media' && typeof i.quantity === 'number' && i.quantity > 0)

const tsMillis = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null

/** The historical wallet-paid portion of an activation (retired wallet-first activation); 0 for current licences. */
async function historicalWalletChargePaise(orderId: string | null | undefined, eventId: string): Promise<number> {
  const draftId = orderId?.startsWith('lic_') ? orderId.slice(4) : eventId
  const chargeSnap = await adminDb.doc(`walletTransactions/license_${draftId}`).get()
  const charged = chargeSnap.exists ? (chargeSnap.data() as { amountPaise?: unknown }).amountPaise : 0
  return typeof charged === 'number' && Number.isFinite(charged) && charged > 0 ? charged : 0
}

/** P1-1 — the gateway's own refund list for a payment (read-only). Any failure to read it is `unknown`. */
async function gatewayRefundOutcome(paymentId: string, expectedPaise: number): Promise<GatewayRefundOutcome> {
  try {
    const { razorpay } = await import('@/lib/razorpay/client')
    return classifyGatewayRefunds(await razorpay.payments.fetchMultipleRefund(paymentId), expectedPaise)
  } catch {
    return { kind: 'unknown' }
  }
}

/**
 * P1-2 — lift the licence + ledger refund holds of ONE attempt, atomically: nothing is written unless
 * the licence hold still belongs to `attemptId`. With `revertOrder`, the order goes back to its
 * pre-claim status only if it is still `refunding` for this attempt. Never throws; false = not lifted
 * (left in place, fail-safe), reported as a financial error.
 */
async function releaseAttemptHold(args: {
  eventId: string; orderRef: FirebaseFirestore.DocumentReference | null; heldLedger: string | null
  orderId: string | null; attemptId: string; revertOrder: boolean
}): Promise<boolean> {
  try {
    await adminDb.runTransaction(async txn => {
      const l = await txn.get(licenseRef(args.eventId))
      const o = args.orderRef ? await txn.get(args.orderRef) : null
      const lg = args.heldLedger ? await txn.get(serviceLedgerRef(args.heldLedger)) : null
      const h = (l.data() as { refundHold?: { attemptId?: unknown } } | undefined)?.refundHold
      if (!h || h.attemptId !== args.attemptId) return          // not this attempt's any more — leave it
      txn.set(licenseRef(args.eventId), { refundHold: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      const lgHold = lg?.exists ? (lg.data() as ServiceLedgerDoc).refundHold : null
      if (lgHold && lgHold.orderId === args.orderId) {
        txn.set(serviceLedgerRef(args.heldLedger!), { refundHold: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
      const od = o?.exists ? o.data() as Record<string, unknown> : null
      if (args.revertOrder && od && od.status === 'refunding' && od.refundAttemptId === args.attemptId) {
        const back = od.refundClaimedFrom === 'created' ? 'created' : 'paid'
        txn.set(args.orderRef!, { status: back, refundAttemptId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
    })
    return true
  } catch (err) {
    console.error(`[license-refund] could not lift the refund hold on ${args.eventId}; registrations / held units stay blocked until it is released`, err)
    captureFinancialError(err, { scope: 'license_refund.hold_release_failed', eventId: args.eventId, orderId: args.orderId })
    return false
  }
}

/** P1-1 — the gateway outcome of a failed refund call could not be established: marked on the hold,
 *  with history + audit, durably (an audit-failure record if the transaction itself fails). */
async function recordRefundOutcomeUnknown(args: {
  eventId: string; organizerUid: string; tier: AnyEventLicenseTier; adminUid: string; actorRole: AuditActorRole
  reason: string; orderId: string | null | undefined; attemptId: string; outcome: string; error: string
}): Promise<void> {
  captureFinancialError(new Error('license refund outcome unknown'), { scope: 'license_refund.outcome_unknown', eventId: args.eventId, orderId: args.orderId ?? null, outcome: args.outcome })
  try {
    await adminDb.runTransaction(async tx => {
      const l = await tx.get(licenseRef(args.eventId))
      const h = (l.data() as { refundHold?: { attemptId?: unknown } } | undefined)?.refundHold
      if (h && h.attemptId === args.attemptId) {
        tx.update(licenseRef(args.eventId), { 'refundHold.phase': 'unknown' satisfies RefundHoldPhase, 'refundHold.unknownAt': FieldValue.serverTimestamp(), 'refundHold.gatewayOutcome': args.outcome })
      }
      stageLicenseHistory(tx, {
        eventId: args.eventId, organizerUid: args.organizerUid, action: 'refund_outcome_unknown', fromTier: args.tier, toTier: args.tier,
        actorUid: args.adminUid, reason: args.reason, orderId: args.orderId ?? null,
        note: `Gateway refund outcome could not be confirmed (${args.outcome}) — held for reconciliation`,
      }, { adminUid: args.adminUid, actorRole: args.actorRole, action: 'license.refund_outcome_unknown', metadata: { reason: args.reason, outcome: args.outcome, error: args.error.slice(0, 300) } })
    })
  } catch (err) {
    console.error(`[license-refund] could not record the unknown outcome for ${args.eventId}`, err)
    await logAdminActionOrRecord({
      adminUid: args.adminUid, actorRole: args.actorRole, action: 'license.refund_outcome_unknown', entityType: 'license', entityId: args.eventId,
      reason: args.reason, metadata: { outcome: args.outcome, error: args.error.slice(0, 300), recordFailed: true },
      correlation: { eventId: args.eventId, organizerUid: args.organizerUid, orderId: args.orderId ?? null },
    })
  }
}

/**
 * Everything after money has (or, for a zero-amount order, need not have) moved: finalize the order and
 * retire the held units, the historical wallet credit-back, and the licence cancel + capacity + history +
 * audit transaction. Shared by `refund` and by `completeRefund` (P1-4 / H2). Each step is idempotent and
 * NONE of them calls the gateway: this function never moves gateway money.
 *
 * Modes:
 *   refund         — the normal refund, right after the gateway leg.
 *   complete       — completion of a refund whose money is verified to have moved (licence not yet refunded).
 *   finalize_only  — H2: the licence is already cancelled/refunded but the internal finalization (order,
 *                    held units, coupon use) did not complete; only the missing steps run, then the
 *                    recovery is recorded. The licence cancel transaction is NOT run again.
 *
 * RD-PHASE4-S4 · F3 — in `refund` mode, once money has moved, no later step may turn that into a failure
 * response: each failure is recorded durably and returned as `reconciliation`. H2 — if the finalize step
 * fails after money moved, the licence is still cancelled (sales stay blocked) but its refund hold is KEPT
 * (phase `reconcile`) so the unfinished refund stays visible and alerting until `completeRefund` finishes
 * it. In the recovery modes a failed step is never reported as success and never releases a hold.
 */
async function settleLicenceRefund(ctx: {
  eventId: string; doc: EventLicenseDoc & { eventId: string }; organizerUid: string; tier: AnyEventLicenseTier
  adminUid: string; reason: string; actorRole: AuditActorRole
  respond: (extra?: Partial<LicenseAdminActionResponse>) => LicenseAdminActionResponse
  walletUsed: number; claim: RefundClaim; gatewayRefunded: boolean
  /** P1-4 — completion of a refund whose money is known to have moved (never rolled back). */
  moneyAlreadyMoved: boolean
  releaseOwnHold: (revertOrder: boolean) => Promise<boolean>
  mode: 'refund' | 'complete' | 'finalize_only'
  /** The attempt that owns the licence hold now (recovery modes close only their own hold). */
  attemptId: string | null
  notes: string[]
}): Promise<LicenseAdminActionResponse> {
  const { eventId, doc, organizerUid, tier, adminUid, reason, actorRole, respond, walletUsed, claim, gatewayRefunded } = ctx
  const refundLedgerRef = adminDb.doc(`walletTransactions/license_refund_${eventId}`)
  const evRef      = adminDb.doc(`events/${eventId}`)
  const counterRef = adminDb.doc(`registrationCounters/${eventId}`)
  const orderRef   = doc.orderId ? adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`) : null
  const recovering = ctx.mode !== 'refund'
  let walletCreditedPaise = 0
  let servicesRetired: Record<string, number> = {}
  let finalizeFailed = false
  const reconciliation: string[] = [...ctx.notes]
  const moneyMoved = () => gatewayRefunded || ctx.moneyAlreadyMoved || walletCreditedPaise > 0
  /** H2 — a recovery step failed: recorded durably, nothing released, never reported as success. */
  const failRecovery = async (stage: string, err: unknown): Promise<never> => {
    console.error(`[license-refund] recovery step '${stage}' FAILED (event ${eventId}); everything stays held`, err)
    captureFinancialError(err, { scope: `license_refund.recovery_${stage}_failed`, eventId, orderId: doc.orderId ?? null })
    await logAdminActionOrRecord({
      adminUid, actorRole, action: 'license.refund_audit_recovered', entityType: 'license', entityId: eventId, reason,
      metadata: { recoveryStage: stage, recoveryFailed: true, orderId: doc.orderId ?? null },
      correlation: { eventId, organizerUid, orderId: doc.orderId ?? null },
    })
    throw new LicenseActionError(`Completing the refund failed at "${stage}". Nothing was released — the licence and its units stay on hold. Try again; the completed steps are not repeated.`, 500, { code: 'REFUND_RECOVERY_FAILED', stage })
  }

  if (doc.orderId && orderRef) {
    // RD-M5 — the refund is CONFIRMED (gateway succeeded, or there was no gateway leg): in ONE
    // transaction, and only on the → 'refunded' transition (so exactly once), mark it refunded and
    // release the organizer's coupon use on an EXISTING counter (never below zero; a missing counter
    // is left missing — the next activation seeds it from order statuses). The global `currentUses`
    // is deliberately NOT changed. A missing order doc keeps the old behaviour (the merge write).
    //
    // RD-INTEG · D1 — the activation order's prepaid service lines were applied to the event's
    // allowance ledger when it was paid. Refunding the order returns their money too, so their
    // still-unused units are retired here, in the SAME transaction — exactly once, guarded by
    // `refundedOrders[orderId]`. Consumed units cannot be taken back.
    //
    // H2 — an order already `refunded` whose units are STILL on this refund's ledger hold (an
    // interrupted finalization) has only the missing ledger step completed: the held units are retired
    // and the hold lifted; the order status and the coupon use are not touched again. An order already
    // refunded with no ledger hold is fully finalized and nothing is written.
    try {
      const ledgerDraftId = doc.orderId.startsWith('lic_') ? doc.orderId.slice(4) : null
      let revertedMeanwhile = false
      servicesRetired = await adminDb.runTransaction(async txn => {
        revertedMeanwhile = false
        const s = await txn.get(orderRef)
        if (!s.exists) {
          txn.set(orderRef, { status: 'refunded', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          return {}
        }
        const o = s.data() as Record<string, unknown>
        const alreadyRefunded = o.status === 'refunded'
        const items = Array.isArray(o.serviceItems) ? o.serviceItems as Array<{ service?: unknown; quantity?: unknown }> : []
        const lRef  = ledgerDraftId && items.length ? serviceLedgerRef(ledgerDraftId) : null
        const lSnap = lRef ? await txn.get(lRef) : null
        const ledger = lSnap?.exists ? lSnap.data() as ServiceLedgerDoc & { refundedOrders?: Record<string, boolean> } : undefined
        // RD-SA-COMMERCE-P1 — the units this refund's claim put on hold (none for a refund claimed
        // before the hold existed). They could not be consumed since, so all of them are retired.
        const hold = ledger?.refundHold && ledger.refundHold.orderId === doc.orderId ? ledger.refundHold : null
        if (alreadyRefunded && !hold) return {}                     // fully finalized already
        // P1-2 — never a silent no-op: money moved for this order, so it is finalized even if its status
        // changed meanwhile; the change is reported for reconciliation.
        if (!alreadyRefunded && o.status !== 'refunding') revertedMeanwhile = true
        // The coupon use is released ONLY on the transition to `refunded` (exactly once).
        const counterRef  = !alreadyRefunded && claim.wasPaid ? couponCounterRefOf(o) : null
        const counterSnap = counterRef ? await txn.get(counterRef) : null
        // RD-SA-COMMERCE-P1 — media usage (stored photos) for the bound below; read before any write.
        const photosNow = lRef && ledgerDraftId && orderHasMedia(o) ? (await txnReadPhotoCapacity(txn, organizerUid, ledgerDraftId)).used : 0
        if (counterRef && counterSnap?.exists) {
          const n = (counterSnap.data() as { count?: unknown }).count
          const cur = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0
          txn.set(counterRef, { count: Math.max(0, cur - 1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        }
        const retired: Record<string, number> = {}
        let processed = false
        if (lRef && ledger && ledger.appliedOrders?.[doc.orderId as string] && !ledger.refundedOrders?.[doc.orderId as string]
          && ledger.organizerUid === organizerUid) {
          processed = true
          const patch: Record<string, unknown> = { refundedOrders: { [doc.orderId as string]: true }, updatedAt: FieldValue.serverTimestamp() }
          for (const k of SERVICE_KINDS) {
            const bought = items.filter(i => i.service === k).reduce((a, i) => a + (typeof i.quantity === 'number' && i.quantity > 0 ? Math.floor(i.quantity) : 0), 0)
            // Never more than is still unused on the event (consumed units cannot come back), and
            // removed from `purchased`: the money for them is returned, so they were never bought.
            // (retainedServiceLines keeps the consumed remainder of this order as zero-value lots.)
            // Media usage is the stored-photo count, never a ledger counter.
            const l = ledgerLine(ledger, k)
            const used = k === 'media' ? photosNow : l.consumed
            const ownUnused = Math.max(0, l.purchased - used - l.carriedOut - l.refunded)
            const want = hold ? heldRefundUnits(ledger, k) : bought
            const take = Math.min(want, ownUnused)
            if (take > 0) { patch[k] = { purchased: FieldValue.increment(-take) }; retired[k] = take }
            if (take < want) retired[`${k}_short`] = want - take   // never expected with a hold: reconciled below
          }
          if (hold) patch.refundHold = FieldValue.delete()
          txn.set(lRef, patch, { merge: true })
        } else if (lRef && hold) {
          txn.set(lRef, { refundHold: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        }
        if (!alreadyRefunded) {
          txn.set(orderRef, { status: 'refunded', ...(processed ? { servicesRetiredOnRefund: retired } : {}), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        } else if (processed) {
          txn.set(orderRef, { servicesRetiredOnRefund: retired, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        }
        return retired
      })
      if (revertedMeanwhile) reconciliation.push('order_status_changed_during_refund')
      const short = Object.keys(servicesRetired).filter(k => k.endsWith('_short'))
      if (short.length) reconciliation.push(`service_units_short:${short.map(k => `${k.replace(/_short$/, '')}=${servicesRetired[k]}`).join(',')}`)
      for (const k of short) delete servicesRetired[k]
    } catch (err) {
      // The order stays 'refunding' (its use stays counted) — surfaced for reconciliation.
      console.error(`[license-refund] finalize to 'refunded' FAILED for order ${doc.orderId} (event ${eventId}, gateway=${gatewayRefunded}); order left 'refunding'`, err)
      if (!moneyMoved()) { await ctx.releaseOwnHold(true); throw err }   // nothing moved yet — a plain failure
      if (recovering) await failRecovery('finalize', err)
      finalizeFailed = true
      reconciliation.push('order_finalize_failed')
    }
  }

  // Credit back any wallet-paid portion (walletTransactions/license_<draftId>) — HISTORICAL only.
  // That `license_charge` row was written by the retired wallet-first licence activation; current
  // licences are paid through Razorpay in full and have none, so they get NO communication-wallet
  // operation at all (RD-COMMS-P1: no ₹0 ledger row, no wallet document created).
  // Credit-back + the refund ledger entry commit as ONE idempotent transaction keyed on the
  // deterministic license_refund_<eventId> doc (F-1): a concurrent second refund or a crash-retry (or
  // a completion) can never double-credit, and the balance can never drift from the ledger.
  try {
    if (walletUsed > 0) {
      const { credited } = await atomicWalletCredit(organizerUid, walletUsed, refundLedgerRef, {
        organizerUid, type: 'license_refund',
        status: 'completed', referenceType: 'license', referenceId: eventId,
        description: `License refund — ${eventId}`, gatewayRefunded, metadata: { reason },
      })
      if (credited) walletCreditedPaise = walletUsed
    }
  } catch (err) {
    if (!moneyMoved()) { await ctx.releaseOwnHold(true); throw err }
    if (recovering) await failRecovery('wallet_credit', err)
    console.error(`[license-refund] wallet credit-back FAILED after a gateway refund (event ${eventId})`, err)
    reconciliation.push('wallet_credit_failed')
  }

  // RD-INTEG — other PAID orders for this event (add_/cap_), which this action does not refund.
  const otherPaidOrders: string[] = await (async () => {
    const draftKey = doc.orderId?.startsWith('lic_') ? doc.orderId.slice(4) : null
    try {
      const keys = [eventId, ...(draftKey && draftKey !== eventId ? [draftKey] : [])]
      const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION).where('eventId', 'in', keys).where('status', '==', 'paid').limit(50).get()
      return snap.docs.map(d => d.id).filter(id => id !== doc.orderId)
    } catch { return [] }
  })()

  // H2 · finalize_only — the licence was cancelled/refunded earlier; close THIS recovery: lift its own
  // licence hold and record the completed finalization, in one transaction. Never reported as success
  // unless it commits.
  if (ctx.mode === 'finalize_only') {
    try {
      await adminDb.runTransaction(async tx => {
        const s = await tx.get(licenseRef(eventId))
        const h = (s.data() as { refundHold?: { attemptId?: unknown } } | undefined)?.refundHold
        if (!h || h.attemptId !== ctx.attemptId) throw new LicenseActionError('The refund hold changed during the recovery — reload and try again.', 409)
        tx.set(licenseRef(eventId), { refundHold: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        stageLicenseHistory(tx, {
          eventId, organizerUid, action: 'refund_completed', fromTier: tier, toTier: tier, actorUid: adminUid, reason, orderId: doc.orderId,
          note: `Interrupted refund finalization completed (gateway=${gatewayRefunded}, wallet=₹${walletCreditedPaise / 100})`,
          after: { finalizationRecovered: true, servicesRetired, walletCreditedPaise },
        }, {
          adminUid, actorRole, action: 'license.refund_completed',
          metadata: { reason, finalizationRecovered: true, gatewayRefunded, walletCreditedPaise, ...(Object.keys(servicesRetired).length ? { servicesRetired } : {}), ...(reconciliation.length ? { reconciliation } : {}) },
        })
      })
    } catch (err) {
      if (err instanceof LicenseActionError) throw err
      await failRecovery('record', err)
    }
    return respond({
      refund: { gatewayRefunded, walletCreditedPaise, ...(Object.keys(servicesRetired).length ? { servicesRetired } : {}), ...(otherPaidOrders.length ? { otherPaidOrdersNotRefunded: otherPaidOrders } : {}) },
      ...(reconciliation.length ? { reconciliation } : {}),
      message: 'The interrupted refund finalization was completed. No money was moved.',
    })
  }

  // Cancel the licence + history + audit — ONE transaction, the overlay read fresh inside it.
  const completing = ctx.mode === 'complete'
  const historyEntry: LicenseHistoryEntryInput = {
    eventId, organizerUid, action: completing ? 'refund_completed' : 'refunded', fromTier: tier, toTier: tier,
    actorUid: adminUid,
    note: `${completing ? 'Interrupted refund completed' : 'Refunded'} (gateway=${gatewayRefunded}, wallet=₹${walletCreditedPaise / 100})`,
    reason, orderId: doc.orderId,
  }
  // Set ONLY from a COMMITTED transaction's return value — a failed commit reports no capacity change.
  let capacityOutcome: { before: number | null; after: number | null; sold: number; paidSeats: number | null } | null = null
  try {
    capacityOutcome = await adminDb.runTransaction(async tx => {
      const [s, evSnap, cSnap] = await tx.getAll(licenseRef(eventId), evRef, counterRef)
      // RD-COMMS-P1 — the licence's refund marker, claimed in THIS transaction: a refund with no
      // order (so no order claim) racing another one is refused here instead of recording twice.
      if (refundedMarkerOf(s.data())) throw new LicenseActionError('This license has already been refunded', 409)
      const overlay = readOverlay(s.exists ? s.data() as EventLicenseDoc : {})

      // RD-SA-COMMERCE-P1 — take the refunded seats off the event, from the capacity and sold count
      // read in THIS transaction, and never below the registrations already taken. The licence has
      // been on refund hold since the claim, so no registration can have been added since.
      const paidSeats = claim.assessment.paidSeats
      const before = evSnap.exists ? deriveStoredEventCapacity(evSnap.data()) : null
      const sold = soldFromCounter(cSnap.exists ? cSnap.data() : undefined)
      let after = before
      if (paidSeats !== null && paidSeats > 0 && before !== null) {
        after = Math.max(sold, Math.max(0, before - paidSeats))
        if (after < before && evSnap.exists) {
          tx.set(evRef, { totalCapacity: after, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        }
      }
      tx.set(licenseRef(eventId), {
        ...overlayPayload({ ...overlay, lifecycle: 'cancelled' }, adminUid),
        refundedAt: FieldValue.serverTimestamp(), refundedBy: adminUid,
        // H2 — an unfinished finalization keeps the hold (phase `reconcile`): still visible, still
        // alerting, and finished only by `completeRefund`. Otherwise the hold ends here.
        refundHold: finalizeFailed
          ? { phase: 'reconcile' satisfies RefundHoldPhase, reconcileAt: FieldValue.serverTimestamp() }
          : FieldValue.delete(),
        ...(after !== before && after !== null ? { capacity: after } : {}),
        refundCapacity: { before, after, sold, paidSeats },
      }, { merge: true })
      stageLicenseHistory(tx, {
        ...historyEntry,
        before: { lifecycle: overlay.lifecycle, capacity: before },
        after:  { lifecycle: 'cancelled', gatewayRefunded, walletCreditedPaise, capacity: after, sold, paidSeatsRemoved: paidSeats },
      }, {
        adminUid, actorRole, action: completing ? 'license.refund_completed' : AUDIT_ACTION.refund,
        metadata: {
          gatewayRefunded, walletCreditedPaise, reason, ...(reconciliation.length ? { reconciliation } : {}),
          ...(Object.keys(servicesRetired).length ? { servicesRetired } : {}),
          // RD-INTEG — this action refunds the ACTIVATION order only. Other paid orders on the
          // event (add-on services, capacity increases) are separate payments and are NOT
          // refunded here; they are listed so the admin can see what remains.
          ...(otherPaidOrders.length ? { otherPaidOrdersNotRefunded: otherPaidOrders } : {}),
          capacity: { before, after, sold, paidSeatsRemoved: paidSeats },
        },
      })
      return { before, after, sold, paidSeats }
    })
  } catch (err) {
    if (!moneyMoved()) { await ctx.releaseOwnHold(true); throw err }
    if (recovering) {
      if (err instanceof LicenseActionError) throw err
      await failRecovery('cancel', err)
    }
    // Money moved: the licence KEEPS its refund hold (no new registrations), so the failure is
    // safe to reconcile — `completeRefund` finishes it.
    console.error(`[license-refund] cancel/history/audit FAILED after money moved (event ${eventId})`, err)
    reconciliation.push('license_cancel_audit_failed')
    if (claim.assessment.capacityChange) reconciliation.push('capacity_not_lowered')
  }

  if (reconciliation.length) {
    // Money moved but a later step failed (or the gateway answered only on a lookup): durably recorded.
    captureFinancialError(new Error('license refund needs reconciliation'), { scope: 'license_refund.reconciliation', eventId, reconciliation: reconciliation.join(',') })
    await logAdminActionOrRecord({
      adminUid, actorRole, action: 'license.refund_audit_recovered', entityType: 'license', entityId: eventId,
      reason,
      metadata: { gatewayRefunded, walletCreditedPaise, reconciliation, orderId: doc.orderId ?? null },
      correlation: { eventId, organizerUid, orderId: doc.orderId ?? null },
    })
  }
  const cap = capacityOutcome
  const needsAttention = reconciliation.some(r => r !== 'gateway_error_but_refunded')
  return respond({
    refund: {
      gatewayRefunded, walletCreditedPaise,
      ...(Object.keys(servicesRetired).length ? { servicesRetired } : {}),
      ...(otherPaidOrders.length ? { otherPaidOrdersNotRefunded: otherPaidOrders } : {}),
      ...(cap ? { capacityBefore: cap.before, capacityAfter: cap.after, sold: cap.sold } : {}),
    },
    ...(reconciliation.length ? {
      reconciliation,
      message: needsAttention
        ? 'The refund went through, but a follow-up step failed and has been recorded for reconciliation — use “Complete refund” to finish it.'
        : 'The refund went through (Razorpay confirmed it after the request itself failed).',
    } : {}),
  })
}

// ═══ RD-SA-COMMERCE-P1 · releasing the hold of a refund that never moved money ═══════════════════
//
// A refund that dies between its claim and its finalize (process crash, timeout, unknown gateway
// outcome) leaves the licence and the held units on refund hold — fail-safe: nothing sells and nothing
// is used. A Super Admin releases it here, and ONLY when every check says no money moved (PD-2):
//   • the hold is at least 15 minutes old (REFUND_HOLD_MIN_RELEASE_AGE_MS) — longer than any refund
//     request can live — and is not a completion in progress. Age is necessary, never sufficient;
//   • the order is not `refunded` (finalization ran — complete it, never undo it);
//   • for an order with a gateway payment, Razorpay is ASKED (read-only): any refund (full or partial)
//     refuses; no answer refuses;
//   • no wallet credit-back row (walletTransactions/license_refund_{eventId}) exists.
// Then ONE transaction re-checks that the hold is still the one read (same attempt), that the order was
// not finalized meanwhile, and that no wallet row appeared; it returns the order to `paid`, lifts both
// holds and writes history + audit. Moves no money.
//
// P1-3 — a refund claimed by the code before refund holds existed left its order `refunding` with NO
// licence hold. Such an order is released (or completed) the same way, keyed on the licence's order.
async function releaseStuckRefundHold(
  eventId: string, adminUid: string, reason: string, actorRole: AuditActorRole,
  respond: (extra?: Partial<LicenseAdminActionResponse>) => LicenseAdminActionResponse,
): Promise<LicenseAdminActionResponse> {
  const snap = await licenseRef(eventId).get()
  if (!snap.exists) throw new LicenseActionError('No license exists for this event', 404)
  const lic = snap.data() as Record<string, unknown>
  const hold = (lic.refundHold ?? null) as { orderId?: unknown; attemptId?: unknown; at?: unknown; phase?: unknown; completingAt?: unknown } | null
  const orderId = hold
    ? (typeof hold.orderId === 'string' && hold.orderId ? hold.orderId : null)
    : (typeof lic.orderId === 'string' && lic.orderId ? lic.orderId : null)
  const orderRef = orderId ? adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${orderId}`) : null
  const order = orderRef ? (await orderRef.get()).data() as Record<string, unknown> | undefined : undefined
  const legacy = !hold
  // H2 — money moved and the licence was cancelled: never released, whatever a lookup says. Finish it.
  if (refundedMarkerOf(lic) || hold?.phase === 'reconcile') {
    throw new LicenseActionError('This licence refund already moved money — its hold cannot be released. Use “Complete refund” to finish it.', 409, { code: 'REFUND_FINALIZE_PENDING' })
  }
  if (legacy && order?.status !== 'refunding') throw new LicenseActionError('This licence has no refund hold to release.', 409)
  if (order?.status === 'refunded') {
    throw new LicenseActionError('This order is already refunded — the refund completed. Use “Complete refund” to finish it (do not release the hold).', 409, { code: 'REFUND_FINALIZED' })
  }
  // PD-2 — the minimum age. For a legacy order, the time it was claimed (or last changed).
  const atMs = hold ? tsMillis(hold.at) : (tsMillis(order?.refundClaimedAt) ?? tsMillis(order?.updatedAt))
  if (!refundHoldOldEnough(atMs, Date.now())) {
    const mins = atMs === null ? 0 : Math.ceil((REFUND_HOLD_MIN_RELEASE_AGE_MS - (Date.now() - atMs)) / 60_000)
    throw new LicenseActionError(`This refund hold is less than 15 minutes old — the refund may still be in progress. Try again in about ${mins} minute(s); the hold stays in place.`, 409, { code: 'REFUND_HOLD_TOO_RECENT' })
  }
  if (hold?.phase === 'completing' && !refundHoldOldEnough(tsMillis(hold.completingAt), Date.now())) {
    throw new LicenseActionError('A Super Admin is completing this refund right now.', 409, { code: 'REFUND_COMPLETION_IN_PROGRESS' })
  }
  const paymentId = typeof order?.razorpayPaymentId === 'string' ? order.razorpayPaymentId : null
  const amount = typeof order?.amountPaise === 'number' ? order.amountPaise : 0
  if (paymentId) {
    const outcome = await gatewayRefundOutcome(paymentId, amount)
    if (outcome.kind === 'unknown') throw new LicenseActionError('Could not confirm with Razorpay that no refund was issued. Try again later; the hold stays in place.', 503)
    if (outcome.kind !== 'none') {
      throw new LicenseActionError('Razorpay shows a refund for this payment — money has moved. Use “Complete refund” instead of releasing the hold.', 409, { code: 'REFUND_FOUND_AT_GATEWAY', gatewayOutcome: outcome.kind })
    }
  }
  // A historical wallet-paid portion is credited back under a deterministic ledger row: if it exists,
  // money moved through the wallet — never release, reconcile instead (read again in the transaction).
  const walletRefundRef = adminDb.doc(`walletTransactions/license_refund_${eventId}`)
  if ((await walletRefundRef.get()).exists) {
    throw new LicenseActionError('A wallet credit-back for this licence refund exists — money has moved. Use “Complete refund” instead of releasing the hold.', 409, { code: 'REFUND_FOUND_IN_WALLET' })
  }
  const draftKey = orderId?.startsWith('lic_') ? orderId.slice(4) : null
  const storedVersion = typeof lic.version === 'number' && lic.version >= 1 ? lic.version as number : 1
  const tier: AnyEventLicenseTier = isValidTierForVersion(lic.tier as string, storedVersion) ? lic.tier as AnyEventLicenseTier : defaultLicenseTierForVersion(storedVersion)
  await adminDb.runTransaction(async tx => {
    const s = await tx.get(licenseRef(eventId))
    const cur = s.data() as Record<string, unknown> | undefined
    const curHold = (cur?.refundHold ?? null) as { orderId?: unknown; attemptId?: unknown } | null
    // P1-2 — an atomic transition from exactly the state that was verified above.
    if (legacy ? curHold !== null : (!curHold || (curHold.orderId ?? null) !== orderId || (curHold.attemptId ?? null) !== (hold!.attemptId ?? null))) {
      throw new LicenseActionError('The refund hold changed — reload and try again.', 409)
    }
    if (refundedMarkerOf(cur)) throw new LicenseActionError('This license has already been refunded.', 409)
    const o = orderRef ? await tx.get(orderRef) : null
    const lg = draftKey ? await tx.get(serviceLedgerRef(draftKey)) : null
    if ((await tx.get(walletRefundRef)).exists) throw new LicenseActionError('A wallet credit-back for this licence refund exists — money has moved.', 409, { code: 'REFUND_FOUND_IN_WALLET' })
    const od = o?.exists ? o.data() as Record<string, unknown> : null
    if (od?.status === 'refunded') throw new LicenseActionError('This order is already refunded.', 409, { code: 'REFUND_FINALIZED' })
    if (legacy && od?.status !== 'refunding') throw new LicenseActionError('The order changed — reload and try again.', 409)
    if (od?.status === 'refunding') {
      tx.set(orderRef!, { status: od.refundClaimedFrom === 'created' ? 'created' : 'paid', refundAttemptId: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }
    if (!legacy) tx.set(licenseRef(eventId), { refundHold: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    const lgHold = lg?.exists ? (lg.data() as ServiceLedgerDoc).refundHold : null
    if (lg && lgHold && lgHold.orderId === orderId) {
      tx.set(serviceLedgerRef(draftKey!), { refundHold: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }
    stageLicenseHistory(tx, {
      eventId, organizerUid: String(cur?.organizerUid ?? ''), action: 'refund_hold_released', fromTier: tier, toTier: tier,
      actorUid: adminUid, reason, orderId,
      note: legacy ? 'Legacy refunding order released — no money had moved (gateway and wallet checked)' : 'Refund hold released — no money had moved (gateway and wallet checked)',
    }, { adminUid, actorRole, action: 'license.refund_hold_released', metadata: { reason, orderId, gatewayChecked: paymentId !== null, legacyOrder: legacy } })
  })
  return respond({ message: 'The refund hold was released. Nothing was refunded; the licence and its units are available again.' })
}

// ═══ RD-SA-COMMERCE-P1 (P1-4 / P1-3 / H2) · completing a refund whose money has already moved ═════════
//
// When the gateway refund (or the historical wallet credit-back) went through but a later step did not —
// the process died, finalize or the cancel transaction failed, or the gateway answered only on a lookup —
// a Super Admin completes it here. It NEVER calls the gateway refund endpoint and never moves money: it
// only re-verifies, read-only, that the money moved (Razorpay shows non-failed refunds covering the FULL
// order amount, or the wallet credit-back row exists) and then runs the missing internal steps.
//
// Two shapes:
//   • the licence is NOT yet refunded → mode `complete`: finalize + wallet + the licence cancel transaction;
//   • H2 — the licence IS already refunded (`refundedAt`) but the finalization is incomplete (order still
//     `refunding`, units still on this refund's ledger hold, or the licence hold still present) → mode
//     `finalize_only`: only the missing finalization runs, then the recovery is recorded. `refundedAt`
//     alone is never taken as proof that everything completed — and a refunded licence whose finalization
//     IS complete is refused (nothing to do).
// A partial or unreadable gateway answer, or a contradictory state (e.g. the licence marked refunded while
// Razorpay shows no refund), refuses and leaves every protective state in place for explicit review.
// Concurrency: an ATOMIC takeover marks the hold `completing` with a new attempt id; a second completion is
// refused while it is in progress, and every closing write re-checks the attempt.
async function completeInterruptedRefund(
  eventId: string, adminUid: string, reason: string, actorRole: AuditActorRole,
  respond: (extra?: Partial<LicenseAdminActionResponse>) => LicenseAdminActionResponse,
): Promise<LicenseAdminActionResponse> {
  const snap = await licenseRef(eventId).get()
  if (!snap.exists) throw new LicenseActionError('No license exists for this event', 404)
  const lic = snap.data() as Record<string, unknown>
  const refundedAlready = refundedMarkerOf(lic)
  const doc = { ...(lic as unknown as EventLicenseDoc), eventId }
  const hold = (lic.refundHold ?? null) as { orderId?: unknown } | null
  const orderId = (hold && typeof hold.orderId === 'string' && hold.orderId) ? hold.orderId : (doc.orderId ?? null)
  if (!orderId) throw new LicenseActionError('This licence has no order to complete a refund for.', 409)
  doc.orderId = orderId
  const orderRef = adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${orderId}`)
  const order = (await orderRef.get()).data() as Record<string, unknown> | undefined
  if (!order) throw new LicenseActionError('The licence order was not found.', 404)
  const status = order.status
  const draftKey = orderId.startsWith('lic_') ? orderId.slice(4) : null
  const lgSnap = draftKey ? await serviceLedgerRef(draftKey).get() : null
  const ledger = lgSnap?.exists ? lgSnap.data() as ServiceLedgerDoc : undefined
  const ledgerHeld = !!draftKey && ledger?.refundHold?.orderId === orderId

  if (refundedAlready) {
    // H2 — is anything actually unfinished? Never inferred from `refundedAt` alone.
    const incomplete = status === 'refunding' || ledgerHeld || hold !== null
    if (!incomplete) throw new LicenseActionError('This licence refund is already complete — nothing to finish.', 409, { code: 'REFUND_ALREADY_COMPLETE' })
    if (status !== 'refunding' && status !== 'refunded') {
      throw new LicenseActionError(`The licence is marked refunded but its order is ${String(status)} — contradictory. Nothing was changed; this needs manual review.`, 409, { code: 'REFUND_STATE_CONTRADICTORY' })
    }
  } else if (status !== 'refunding' && status !== 'refunded' && status !== 'paid') {
    throw new LicenseActionError(`This order is ${String(status)} — there is no refund to complete.`, 409)
  }

  const organizerUid = doc.organizerUid
  const storedVersion = typeof doc.version === 'number' && doc.version >= 1 ? doc.version : 1
  const tier: AnyEventLicenseTier = isValidTierForVersion(doc.tier, storedVersion) ? doc.tier : defaultLicenseTierForVersion(storedVersion)
  const walletRefundRef = adminDb.doc(`walletTransactions/license_refund_${eventId}`)
  const walletRow = (await walletRefundRef.get()).exists
  const paymentId = typeof order.razorpayPaymentId === 'string' ? order.razorpayPaymentId : null
  const amount = typeof order.amountPaise === 'number' ? order.amountPaise : 0
  // READ-ONLY verification that the money moved. Nothing below sends a refund.
  let gatewayRefunded = false
  if (paymentId && amount > 0) {
    const outcome = await gatewayRefundOutcome(paymentId, amount)
    if (outcome.kind === 'unknown') throw new LicenseActionError('Could not read the refunds for this payment from Razorpay. Try again later; nothing was changed.', 503)
    if (outcome.kind === 'partial') {
      throw new LicenseActionError(`Razorpay shows only a partial refund (₹${(outcome.refundedPaise / 100).toFixed(2)} of ₹${(amount / 100).toFixed(2)}). This needs manual reconciliation — nothing was changed.`, 409, { code: 'PARTIAL_REFUND_AT_GATEWAY' })
    }
    if (outcome.kind === 'full') gatewayRefunded = true
    else if (!walletRow) {
      throw refundedAlready
        ? new LicenseActionError('The licence is marked refunded but Razorpay shows no refund for its payment and no wallet credit-back exists — contradictory. Nothing was changed; this needs manual review.', 409, { code: 'REFUND_STATE_CONTRADICTORY' })
        : new LicenseActionError('Razorpay shows no refund for this payment and no wallet credit-back exists — no money moved. Use “Release refund hold” instead.', 409, { code: 'NO_REFUND_FOUND' })
    }
  } else if (status === 'paid' && !walletRow) {
    throw new LicenseActionError('No refund was found for this order — there is nothing to complete.', 409, { code: 'NO_REFUND_FOUND' })
  }

  // The assessment is only needed for the seats a not-yet-cancelled licence gives back (sales have been
  // blocked by the hold since the claim; a conflict no longer matters — the money is already back).
  const walletUsed = await historicalWalletChargePaise(orderId, eventId)
  const [evSnap, cSnap] = await Promise.all([adminDb.doc(`events/${eventId}`).get(), adminDb.doc(`registrationCounters/${eventId}`).get()])
  const photosUsed = draftKey && orderHasMedia(order) ? (await readEventPhotoCapacity(organizerUid, draftKey)).used : 0
  const assessment = refundAssessmentFrom({
    licence: lic, order, orderId, organizerUid,
    event: evSnap.exists ? evSnap.data() : undefined, counter: cSnap.exists ? cSnap.data() : undefined,
    ledger, walletChargePaise: walletUsed, photosUsed,
  })

  // ATOMIC takeover — refused while a younger claim (its request may still be alive) or completion runs.
  const attemptId = randomUUID()
  await adminDb.runTransaction(async tx => {
    const s = await tx.get(licenseRef(eventId))
    const o = await tx.get(orderRef)
    const lgTx = draftKey ? await tx.get(serviceLedgerRef(draftKey)) : null
    const cur = s.data() as Record<string, unknown> | undefined
    if (refundedMarkerOf(cur) !== refundedAlready) throw new LicenseActionError('The licence changed — reload and try again.', 409)
    const h = (cur?.refundHold ?? null) as { orderId?: unknown; at?: unknown; by?: unknown; phase?: unknown; completingAt?: unknown } | null
    if (refundedAlready) {
      // Re-verified HERE (not only before): a concurrent recovery may have finished meanwhile.
      const lgHoldTx = lgTx?.exists ? (lgTx.data() as ServiceLedgerDoc).refundHold : null
      const stillIncomplete = (o.exists && (o.data() as { status?: unknown }).status === 'refunding')
        || (!!lgHoldTx && lgHoldTx.orderId === orderId) || h !== null
      if (!stillIncomplete) throw new LicenseActionError('This licence refund is already complete — nothing to finish.', 409, { code: 'REFUND_ALREADY_COMPLETE' })
    }
    if (h && h.orderId != null && h.orderId !== orderId) throw new LicenseActionError('The refund hold changed — reload and try again.', 409)
    if (h?.phase === 'completing' && !refundHoldOldEnough(tsMillis(h.completingAt), Date.now())) {
      throw new LicenseActionError('Another Super Admin is completing this refund right now.', 409, { code: 'REFUND_COMPLETION_IN_PROGRESS' })
    }
    if (h && (h.phase === 'claimed' || h.phase === 'gateway') && !refundHoldOldEnough(tsMillis(h.at), Date.now())) {
      throw new LicenseActionError('This refund started less than 15 minutes ago and may still be finishing. Try again shortly.', 409, { code: 'REFUND_HOLD_TOO_RECENT' })
    }
    const od = o.exists ? o.data() as Record<string, unknown> : null
    const allowed = refundedAlready ? ['refunding', 'refunded'] : ['refunding', 'refunded', 'paid']
    if (!od || !allowed.includes(String(od.status))) throw new LicenseActionError('The order changed — reload and try again.', 409)
    if (od.status === 'paid') {
      tx.set(orderRef, { status: 'refunding', refundAttemptId: attemptId, refundClaimedFrom: 'paid', refundClaimedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    } else if (od.status === 'refunding') {
      tx.set(orderRef, { refundAttemptId: attemptId, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    }
    tx.set(licenseRef(eventId), {
      refundHold: {
        at: h?.at ?? FieldValue.serverTimestamp(), by: typeof h?.by === 'string' ? h.by : adminUid, orderId, attemptId,
        phase: 'completing' satisfies RefundHoldPhase, completingAt: FieldValue.serverTimestamp(), completingBy: adminUid,
      },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
  })

  const wasPaid = order.refundClaimedFrom !== undefined ? order.refundClaimedFrom === 'paid' : (status === 'paid' || paymentId !== null)
  const heldLedger = ledgerHeld ? draftKey : null
  return settleLicenceRefund({
    eventId, doc, organizerUid, tier, adminUid, reason, actorRole, respond, walletUsed,
    claim: { paymentId, gatewayAmount: amount, wasPaid, assessment, heldLedger },
    gatewayRefunded, moneyAlreadyMoved: true, mode: refundedAlready ? 'finalize_only' : 'complete', attemptId, notes: [],
    // Completion never rolls back: on failure the hold stays (fail-safe) and the failure is recorded.
    releaseOwnHold: async () => false,
  })
}

// ═══ M3 / M2 · gateway refund events for LICENCE payments ══════════════════════════════════════════
//
// The Razorpay webhook sees every refund, including the licence refunds RegisterDesk itself issues
// (refundLicense). These helpers decide, from server-written records only, whether such an event is the
// EXPECTED echo of a RegisterDesk licence refund (M3 — no financial alert), and record a licence refund
// that the gateway later reports FAILED (M2 — a durable, audited manual-review state).

export type LicenceRefundEventClass =
  | { expected: true; licenseOrderId: string; licenceSlug: string }
  | { expected: false; why: 'no_licence_order' | 'not_activation_order' | 'order_not_refunding' | 'payment_mismatch' | 'amount_mismatch' | 'no_licence' | 'licence_not_refunding' | 'currency_mismatch' | 'gateway_unverified' | 'gateway_mismatch'; licenseOrderId: string | null; licenceSlug: string | null }

/**
 * M3 — is this refund event the expected echo of a licence refund RegisterDesk issued? Only when ALL hold:
 * the Razorpay order is a licence ACTIVATION order (`lic_…`, the only licence order refunded in-app), the
 * order is `refunding` / `refunded`, it was paid by THIS payment, the refund is for exactly the refunded
 * amount, and its licence is refunded or on refund hold. Anything else (a capacity / add-on / badge order,
 * a different payment or amount, an order not being refunded) is NOT expected and keeps the alert.
 * With `gateway` (a refund.processed echo), the read-only refund list must ALSO show this refund as the
 * only money out — exactly the refunded amount — so a second (double) refund of the payment, or a list
 * that cannot be read, still alerts.
 */
export async function classifyLicenceRefundEvent(
  razorpayOrderId: string,
  ev: { paymentId: string; amountPaise: number; currency?: string | null },
  opts: { gateway?: { refundId: string } } = {},
): Promise<LicenceRefundEventClass> {
  const ord = await adminDb.collection(LICENSE_ORDERS_COLLECTION).where('razorpayOrderId', '==', razorpayOrderId).limit(2).get()
  if (ord.size !== 1) return { expected: false, why: 'no_licence_order', licenseOrderId: null, licenceSlug: null }
  const licenseOrderId = ord.docs[0].id
  const o = ord.docs[0].data() as { status?: unknown; razorpayPaymentId?: unknown; amountPaise?: unknown }
  const lic = await adminDb.collection(EVENT_LICENSES_COLLECTION).where('orderId', '==', licenseOrderId).limit(2).get()
  const licenceSlug = lic.size === 1 ? lic.docs[0].id : null
  const no = (why: Extract<LicenceRefundEventClass, { expected: false }>['why']): LicenceRefundEventClass => ({ expected: false, why, licenseOrderId, licenceSlug })
  if (!licenseOrderId.startsWith('lic_')) return no('not_activation_order')
  if (o.status !== 'refunding' && o.status !== 'refunded') return no('order_not_refunding')
  if (o.razorpayPaymentId !== ev.paymentId) return no('payment_mismatch')
  if (o.amountPaise !== ev.amountPaise) return no('amount_mismatch')
  if (!licenceSlug) return no('no_licence')
  const l = lic.docs[0].data() as { refundedAt?: unknown; refundHold?: unknown }
  if (l.refundedAt == null && l.refundHold == null) return no('licence_not_refunding')
  if (ev.currency && ev.currency !== 'INR') return no('currency_mismatch')
  if (opts.gateway) {
    const g = await gatewayRefundOutcome(ev.paymentId, ev.amountPaise)
    if (g.kind === 'unknown') return no('gateway_unverified')
    if (g.kind !== 'full' || g.refundedPaise !== ev.amountPaise || !g.refundIds.includes(opts.gateway.refundId)) return no('gateway_mismatch')
  }
  return { expected: true, licenseOrderId, licenceSlug }
}

export type LicenceRefundFailureEvidence = 'confirmed_no_refund' | 'refunded_elsewhere' | 'partial' | 'ambiguous'
export type LicenceRefundFailureResult =
  | { outcome: 'recorded' | 'duplicate'; licenceSlug: string; evidence: LicenceRefundFailureEvidence }
  | { outcome: 'not_applicable'; why: string }

/**
 * M2 — the gateway reports that a licence refund RegisterDesk issued (and that the gateway had ACCEPTED)
 * has FAILED. Nothing is retried, re-issued, reactivated or restored: the licence keeps its refunded /
 * cancelled state (sales stay blocked — the conservative state), the order, units and capacity are not
 * touched. Recorded durably, in ONE transaction, idempotent per refund id:
 *   eventLicenses/{slug}.refundFailure = { status 'open', refundIds[], evidence, orderId, … }
 *   licenseHistory 'refund_failed_at_gateway' + audit 'license.refund_failed_at_gateway' (actor: system)
 * Read-only gateway evidence classifies the case:
 *   confirmed_no_refund — Razorpay holds no non-failed refund for the payment: the money did NOT leave
 *   refunded_elsewhere  — non-failed refunds still cover the amount (e.g. a manual re-refund): contradictory
 *   partial / ambiguous — a partial refund, or the lookup could not be read: nothing is concluded
 * Resolution is a Super Admin decision (re-issue the refund, or restore the entitlement through the
 * existing confirmed reactivate/reissue path); `acknowledgeRefundFailure` records that decision.
 */
export async function recordLicenceRefundFailure(input: {
  razorpayOrderId: string; refundId: string; paymentId: string; amountPaise: number; currency?: string | null; failureReason: string | null
}): Promise<LicenceRefundFailureResult> {
  const cls = await classifyLicenceRefundEvent(input.razorpayOrderId, { paymentId: input.paymentId, amountPaise: input.amountPaise, currency: input.currency })
  if (!cls.expected) return { outcome: 'not_applicable', why: cls.why }
  const g = await gatewayRefundOutcome(input.paymentId, input.amountPaise)
  const evidence: LicenceRefundFailureEvidence =
    g.kind === 'none' ? 'confirmed_no_refund' : g.kind === 'full' ? 'refunded_elsewhere' : g.kind === 'partial' ? 'partial' : 'ambiguous'
  const lRef = licenseRef(cls.licenceSlug)
  return adminDb.runTransaction<LicenceRefundFailureResult>(async tx => {
    const lSnap = await tx.get(lRef)
    if (!lSnap.exists) return { outcome: 'not_applicable', why: 'no_licence' }
    const l = lSnap.data() as Record<string, unknown>
    const rf = l.refundFailure as { refundIds?: unknown } | undefined
    // Idempotent per refund id; racing deliveries serialize on this licence document.
    if (Array.isArray(rf?.refundIds) && rf!.refundIds.includes(input.refundId)) {
      return { outcome: 'duplicate', licenceSlug: cls.licenceSlug, evidence }
    }
    const storedVersion = typeof l.version === 'number' && l.version >= 1 ? l.version as number : 1
    const tier: AnyEventLicenseTier = isValidTierForVersion(l.tier as string, storedVersion) ? l.tier as AnyEventLicenseTier : defaultLicenseTierForVersion(storedVersion)
    const now = FieldValue.serverTimestamp()
    tx.set(lRef, {
      refundFailure: {
        status: 'open', refundIds: FieldValue.arrayUnion(input.refundId), orderId: cls.licenseOrderId, paymentId: input.paymentId,
        amountPaise: input.amountPaise, evidence, failureReason: input.failureReason, ...(rf ? {} : { firstAt: now }), lastAt: now,
      },
      updatedAt: now,
    }, { merge: true })
    stageLicenseHistory(tx, {
      eventId: cls.licenceSlug, organizerUid: String(l.organizerUid ?? ''), action: 'refund_failed_at_gateway', fromTier: tier, toTier: tier,
      actorUid: 'system:razorpay_webhook', reason: 'gateway reported the licence refund failed', orderId: cls.licenseOrderId,
      note: `Razorpay reported refund ${input.refundId} FAILED after accepting it (evidence: ${evidence}). Nothing retried or restored — a Super Admin decides.`,
      after: { refundId: input.refundId, evidence, amountPaise: input.amountPaise },
    }, {
      adminUid: 'system:razorpay_webhook', actorRole: 'system', action: 'license.refund_failed_at_gateway',
      reason: 'gateway reported the licence refund failed',
      metadata: { refundId: input.refundId, paymentId: input.paymentId, evidence, failureReason: input.failureReason, amountPaise: input.amountPaise },
    })
    return { outcome: 'recorded', licenceSlug: cls.licenceSlug, evidence }
  })
}

/** M2 — a Super Admin records the decision taken on a licence refund that failed at the gateway. Moves
 *  no money, restores nothing; the licence stays as it is. Audited in the same transaction. */
async function acknowledgeLicenceRefundFailure(
  eventId: string, adminUid: string, reason: string, actorRole: AuditActorRole,
  respond: (extra?: Partial<LicenseAdminActionResponse>) => LicenseAdminActionResponse,
): Promise<LicenseAdminActionResponse> {
  await adminDb.runTransaction(async tx => {
    const s = await tx.get(licenseRef(eventId))
    if (!s.exists) throw new LicenseActionError('No license exists for this event', 404)
    const l = s.data() as Record<string, unknown>
    const rf = l.refundFailure as { status?: unknown; refundIds?: unknown } | undefined
    if (!rf) throw new LicenseActionError('This licence has no failed refund to acknowledge.', 409)
    if (rf.status !== 'open') throw new LicenseActionError('This refund failure was already acknowledged.', 409, { code: 'ALREADY_ACKNOWLEDGED' })
    const storedVersion = typeof l.version === 'number' && l.version >= 1 ? l.version as number : 1
    const tier: AnyEventLicenseTier = isValidTierForVersion(l.tier as string, storedVersion) ? l.tier as AnyEventLicenseTier : defaultLicenseTierForVersion(storedVersion)
    tx.set(licenseRef(eventId), {
      refundFailure: { status: 'acknowledged', acknowledgedBy: adminUid, acknowledgedAt: FieldValue.serverTimestamp(), acknowledgedReason: reason },
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    stageLicenseHistory(tx, {
      eventId, organizerUid: String(l.organizerUid ?? ''), action: 'refund_failure_acknowledged', fromTier: tier, toTier: tier,
      actorUid: adminUid, reason, orderId: typeof l.orderId === 'string' ? l.orderId : null,
      note: 'Failed licence refund acknowledged by a Super Admin — nothing refunded or restored by this action',
      after: { refundIds: rf.refundIds ?? [] },
    }, { adminUid, actorRole, action: 'license.refund_failure_acknowledged', metadata: { reason, refundIds: rf.refundIds ?? [] } })
  })
  return respond({ message: 'The failed refund was acknowledged. Nothing was refunded or restored.' })
}

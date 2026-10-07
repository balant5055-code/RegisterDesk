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
import { resolveEffectiveEventLicense, OVERRIDABLE_FEATURE_KEYS } from '@/lib/licensing/adminLicense'
import { capacityPlanForRegistrationLimit } from '@/lib/registrations/capacity'
import { soldFromCounter } from '@/lib/licensing/capacityChange'
import { atomicWalletCredit } from '@/lib/firebase/firestore/wallet'
import { organizerRedemptionCounterRef } from '@/lib/licensing/coupons'
import { ledgerRef as serviceLedgerRef, ledgerLine, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
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
} from './licenseAdminTypes'

// ─── Errors ─────────────────────────────────────────────────────────────────────

export class LicenseActionError extends Error {
  constructor(message: string, public status = 400) { super(message) }
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

  let q = adminDb.collection(EVENT_LICENSES_COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(pageSize + 1)
  if (opts.cursor) {
    const curSnap = await licenseRef(opts.cursor).get()
    if (curSnap.exists) q = q.startAfter(curSnap)
  }

  const snap     = await q.get()
  const hasMore  = snap.docs.length > pageSize
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
  if (status) {
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

  // RD-LICENSE-GA-02: resolve BOTH catalogs; a stored license doc resolves at its OWN version.
  // (RD-EVENT-COMMERCE-05 retired the tier writes — grant / upgrade — that resolved at the
  // current version, so no cross-version rank is needed any more.)
  const [catalog, catalogV2] = await Promise.all([getLicenseCatalog(), getLicenseCatalogV2()])
  const defFor = (t: string, v: number) => pickVersionedDefinition(catalog, catalogV2, t, v)
  const respond = (extra?: Partial<LicenseAdminActionResponse>): LicenseAdminActionResponse =>
    ({ ok: true, eventId, action, ...extra })

  if (action === 'refund') return refundLicense(eventId, adminUid, reason, actorRole, respond)

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
  const featurePatch: Partial<Record<string, boolean>> = {}
  if (action === 'overrideFeatures') {
    for (const [k, val] of Object.entries(req.features ?? {})) {
      if (!(OVERRIDABLE_FEATURE_KEYS as string[]).includes(k)) throw new LicenseActionError(`Unknown feature: ${k}`)
      if (typeof val !== 'boolean') throw new LicenseActionError(`Feature ${k} must be boolean`)
      featurePatch[k] = val
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

    switch (action) {
      // ── Lifecycle ──
      case 'suspend': {
        if (overlay.lifecycle !== 'active') throw new LicenseActionError(`Cannot suspend a ${overlay.lifecycle} license`, 409)
        tx.set(lRef, overlayPayload({ ...overlay, lifecycle: 'suspended' }, adminUid), { merge: true })
        simpleHistory()
        return
      }
      case 'reactivate': {
        if (overlay.lifecycle === 'active') throw new LicenseActionError('License is already active', 409)
        tx.set(lRef, overlayPayload({ ...overlay, lifecycle: 'active' }, adminUid), { merge: true })
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
      case 'overrideFeatures': {
        tx.set(lRef, overlayPayload({ ...overlay, featureOverrides: { ...overlay.featureOverrides, ...featurePatch } }, adminUid), { merge: true })
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
async function refundLicense(
  eventId: string, adminUid: string, reason: string, actorRole: AuditActorRole,
  respond: (extra?: Partial<LicenseAdminActionResponse>) => LicenseAdminActionResponse,
): Promise<LicenseAdminActionResponse> {
  const snap = await licenseRef(eventId).get()
  if (!snap.exists) throw new LicenseActionError('No license exists for this event', 404)
  const doc = { ...(snap.data() as EventLicenseDoc), eventId }
  const organizerUid = doc.organizerUid
  const storedVersion = typeof doc.version === 'number' && doc.version >= 1 ? doc.version : 1
  const tier: AnyEventLicenseTier = isValidTierForVersion(doc.tier, storedVersion) ? doc.tier : defaultLicenseTierForVersion(storedVersion)

  const refundLedgerRef = adminDb.doc(`walletTransactions/license_refund_${eventId}`)

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
  if ((await refundLedgerRef.get()).exists) throw new LicenseActionError('This license has already been refunded', 409)

  let gatewayRefunded = false
  let walletCreditedPaise = 0
  let servicesRetired: Record<string, number> = {}
  const reconciliation: string[] = []

  if (doc.orderId) {
    const orderRef = adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`)

    // Atomically CLAIM the order (→ 'refunding') BEFORE the gateway refund so two
    // concurrent refunds (double-click / two admins) cannot both fire
    // razorpay.payments.refund (H-1 double gateway refund). An already
    // refunded/refunding order aborts here; the F-1 ledger guard above blocks
    // re-refund after completion. Only paid orders carry a paymentId, so the
    // failure-revert to 'paid' below is always the correct prior state.
    const claim = await adminDb.runTransaction<{ paymentId: string | null; gatewayAmount: number; wasPaid: boolean }>(async txn => {
      const s = await txn.get(orderRef)
      const o = s.exists ? (s.data() as Record<string, unknown>) : null
      if (o && (o.status === 'refunded' || o.status === 'refunding')) {
        throw new LicenseActionError('Order already refunded', 409)
      }
      // RD-M5 refund race — the claim does NOT release the organizer's coupon use: a `refunding`
      // order still counts (counter unchanged; the seeding/pre-check query includes `refunding`)
      // until the refund is CONFIRMED and finalized below. `wasPaid` tells finalization whether
      // this order was a redemption at all.
      if (o) txn.update(orderRef, { status: 'refunding', updatedAt: FieldValue.serverTimestamp() })
      return {
        paymentId:     typeof o?.razorpayPaymentId === 'string' ? o.razorpayPaymentId : null,
        gatewayAmount: typeof o?.amountPaise === 'number' ? o.amountPaise : 0,
        wasPaid:       o?.status === 'paid',
      }
    })

    if (claim.paymentId && claim.gatewayAmount > 0) {
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
        // Release the claim so a retry is possible (a crash mid-flight leaves it
        // 'refunding' — reconciled manually, never a silent double refund).
        // RD-M5 — only if still 'refunding' (idempotent). The coupon counter is NOT touched: the
        // use was never released (the claim keeps it counted), so reverting restores nothing.
        let reverted = true
        await adminDb.runTransaction(async txn => {
          const s = await txn.get(orderRef)
          const o = s.exists ? (s.data() as Record<string, unknown>) : null
          if (!o || o.status !== 'refunding') return
          txn.set(orderRef, { status: 'paid', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        }).catch(err => {
          // The order stays 'refunding' (its use stays counted) — surfaced for manual reconciliation.
          reverted = false
          console.error(`[license-refund] revert to 'paid' FAILED for order ${doc.orderId} (event ${eventId}); order left 'refunding'`, err)
        })
        throw new LicenseActionError(`Razorpay refund failed: ${e instanceof Error ? e.message : 'unknown error'}${reverted ? '' : ' — the order could not be reverted and is still marked refunding; reconcile manually'}`, 502)
      }
    }
    // RD-M5 — the refund is CONFIRMED (gateway succeeded, or there was no gateway leg): in ONE
    // transaction, and only on the 'refunding' → 'refunded' transition (so exactly once), mark it
    // refunded and release the organizer's coupon use on an EXISTING counter (never below zero;
    // a missing counter is left missing — the next activation seeds it from order statuses).
    // The global `currentUses` is deliberately NOT changed. A missing order doc keeps the old
    // behaviour (the merge write), with no counter involved.
    try {
      // RD-INTEG · D1 — the activation order's prepaid service lines (WhatsApp/certificates/media
      // units) were applied to the event's allowance ledger when it was paid. Refunding the order
      // returns their money too, so their still-unused units are retired here (ledger `refunded`),
      // in the SAME transaction that marks the order refunded — exactly once, guarded by
      // `refundedOrders[orderId]`. Units already consumed cannot be taken back and stay counted.
      const ledgerDraftId = doc.orderId.startsWith('lic_') ? doc.orderId.slice(4) : null
      servicesRetired = await adminDb.runTransaction(async txn => {
        const s = await txn.get(orderRef)
        if (!s.exists) {
          txn.set(orderRef, { status: 'refunded', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
          return {}
        }
        const o = s.data() as Record<string, unknown>
        if (o.status !== 'refunding') return {}
        const counterRef  = claim.wasPaid ? couponCounterRefOf(o) : null
        const counterSnap = counterRef ? await txn.get(counterRef) : null
        const items = Array.isArray(o.serviceItems) ? o.serviceItems as Array<{ service?: unknown; quantity?: unknown }> : []
        const lRef  = ledgerDraftId && items.length ? serviceLedgerRef(ledgerDraftId) : null
        const lSnap = lRef ? await txn.get(lRef) : null
        if (counterRef && counterSnap?.exists) {
          const n = (counterSnap.data() as { count?: unknown }).count
          const cur = typeof n === 'number' && Number.isInteger(n) && n > 0 ? n : 0
          txn.set(counterRef, { count: Math.max(0, cur - 1), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        }
        const retired: Record<string, number> = {}
        let processed = false
        const ledger = lSnap?.exists ? lSnap.data() as ServiceLedgerDoc & { refundedOrders?: Record<string, boolean> } : undefined
        if (lRef && ledger && ledger.appliedOrders?.[doc.orderId as string] && !ledger.refundedOrders?.[doc.orderId as string]
          && ledger.organizerUid === organizerUid) {
          processed = true
          const patch: Record<string, unknown> = { refundedOrders: { [doc.orderId as string]: true }, updatedAt: FieldValue.serverTimestamp() }
          for (const k of SERVICE_KINDS) {
            const bought = items.filter(i => i.service === k).reduce((a, i) => a + (typeof i.quantity === 'number' && i.quantity > 0 ? Math.floor(i.quantity) : 0), 0)
            // Never more than is still unused on the event (consumed units cannot come back), and
            // removed from `purchased`: the money for them is returned, so they were never bought.
            // (retainedServiceLines keeps the consumed remainder of this order as zero-value lots.)
            const l = ledgerLine(ledger, k)
            const ownUnused = Math.max(0, l.purchased - l.consumed - l.carriedOut - l.refunded)
            const take = Math.min(bought, ownUnused)
            if (take > 0) { patch[k] = { purchased: FieldValue.increment(-take) }; retired[k] = take }
          }
          txn.set(lRef, patch, { merge: true })
        }
        txn.set(orderRef, { status: 'refunded', ...(processed ? { servicesRetiredOnRefund: retired } : {}), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        return retired
      })
    } catch (err) {
      // The order stays 'refunding' (its use stays counted) — surfaced for manual reconciliation.
      console.error(`[license-refund] finalize to 'refunded' FAILED for order ${doc.orderId} (event ${eventId}, gateway=${gatewayRefunded}); order left 'refunding'`, err)
      if (!gatewayRefunded) throw err   // nothing moved yet — a plain failure
      reconciliation.push('order_finalize_failed')
    }
  }

  // Credit back any wallet-paid portion (walletTransactions/license_<draftId>).
  // Credit-back + the refund ledger entry commit as ONE idempotent transaction
  // keyed on the deterministic license_refund_<eventId> doc (F-1): a concurrent
  // second refund (wallet-only license, no gateway guard) or a crash-retry can
  // never double-credit, and the balance can never drift from the ledger. When
  // walletUsed is 0 the credit is a no-op but the audit ledger entry is still
  // recorded. Mirrors atomicTopupCredit.
  try {
    const draftId = doc.orderId?.startsWith('lic_') ? doc.orderId.slice(4) : eventId
    const chargeSnap = await adminDb.doc(`walletTransactions/license_${draftId}`).get()
    const walletUsed = chargeSnap.exists ? ((chargeSnap.data() as { amountPaise?: number }).amountPaise ?? 0) : 0
    const { credited } = await atomicWalletCredit(organizerUid, walletUsed, refundLedgerRef, {
      organizerUid, type: 'license_refund',
      status: 'completed', referenceType: 'license', referenceId: eventId,
      description: `License refund — ${eventId}`, gatewayRefunded, metadata: { reason },
    })
    if (credited) walletCreditedPaise = walletUsed
  } catch (err) {
    if (!gatewayRefunded) throw err
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

  // Cancel the licence + history + audit — ONE transaction, the overlay read fresh inside it.
  const historyEntry: LicenseHistoryEntryInput = {
    eventId, organizerUid, action: 'refunded', fromTier: tier, toTier: tier,
    actorUid: adminUid, note: `Refunded (gateway=${gatewayRefunded}, wallet=₹${walletCreditedPaise / 100})`, reason,
    orderId: doc.orderId,
  }
  try {
    await adminDb.runTransaction(async tx => {
      const s = await tx.get(licenseRef(eventId))
      const overlay = readOverlay(s.exists ? s.data() as EventLicenseDoc : {})
      tx.set(licenseRef(eventId), overlayPayload({ ...overlay, lifecycle: 'cancelled' }, adminUid), { merge: true })
      stageLicenseHistory(tx, {
        ...historyEntry,
        before: { lifecycle: overlay.lifecycle },
        after:  { lifecycle: 'cancelled', gatewayRefunded, walletCreditedPaise },
      }, {
        adminUid, actorRole, action: AUDIT_ACTION.refund,
        metadata: {
          gatewayRefunded, walletCreditedPaise, reason, ...(reconciliation.length ? { reconciliation } : {}),
          ...(Object.keys(servicesRetired).length ? { servicesRetired } : {}),
          // RD-INTEG — this action refunds the ACTIVATION order only. Other paid orders on the
          // event (add-on services, capacity increases) are separate payments and are NOT
          // refunded here; they are listed so the admin can see what remains.
          ...(otherPaidOrders.length ? { otherPaidOrdersNotRefunded: otherPaidOrders } : {}),
        },
      })
    })
  } catch (err) {
    if (!gatewayRefunded && walletCreditedPaise === 0) throw err
    console.error(`[license-refund] cancel/history/audit FAILED after money moved (event ${eventId})`, err)
    reconciliation.push('license_cancel_audit_failed')
  }

  if (reconciliation.length) {
    // Money moved but a later step failed: durably recorded (never thrown) for reconciliation.
    captureFinancialError(new Error('license refund needs reconciliation'), { scope: 'license_refund.reconciliation', eventId, reconciliation: reconciliation.join(',') })
    await logAdminActionOrRecord({
      adminUid, actorRole, action: 'license.refund_audit_recovered', entityType: 'license', entityId: eventId,
      reason,
      metadata: { gatewayRefunded, walletCreditedPaise, reconciliation, orderId: doc.orderId ?? null },
      correlation: { eventId, organizerUid, orderId: doc.orderId ?? null },
    })
  }
  return respond({
    refund: { gatewayRefunded, walletCreditedPaise, ...(Object.keys(servicesRetired).length ? { servicesRetired } : {}), ...(otherPaidOrders.length ? { otherPaidOrdersNotRefunded: otherPaidOrders } : {}) },
    ...(reconciliation.length ? {
      reconciliation,
      message: 'The refund went through, but a follow-up step failed and has been recorded for reconciliation.',
    } : {}),
  })
}

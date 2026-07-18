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
import { setBaselineOverrides } from '@/lib/events/governance'
import {
  EVENT_LICENSES_COLLECTION,
  LICENSE_ORDERS_COLLECTION,
  LICENSE_HISTORY_COLLECTION,
  type EventLicenseDoc,
  type LicenseHistoryAction,
} from '@/lib/licensing/schema'
import {
  EVENT_LICENSE_TIERS,
  CURRENT_LICENSE_VERSION,
  isEventLicenseTier,
  isUnlimited,
  type EventLicenseTier,
  type EventLicenseFeature,
} from '@/lib/licensing/eventLicense'
import { getLicenseCatalog, type LicenseCatalog } from '@/lib/licensing/resolveCatalog'
import { resolveEffectiveEventLicense, OVERRIDABLE_FEATURE_KEYS } from '@/lib/licensing/adminLicense'
import { capacityPlanForRegistrationLimit } from '@/lib/registrations/capacity'
import { atomicWalletCredit } from '@/lib/firebase/firestore/wallet'
// RD-ENV-ARCH-05 — Razorpay is NOT statically imported here. This service is imported by
// admin READ paths (license list/detail, Event360, governance, timeline, export) that
// must never initialize/validate Razorpay. The gateway client is lazy-loaded only at the
// single payment-execution point (the 'refund' action), so read paths stay Razorpay-free.
import { logAdminAction } from '@/lib/admin/audit'
import type { AdminAuditAction } from '@/lib/admin/auditConstants'
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

const tierRank = (t: EventLicenseTier): number => EVENT_LICENSE_TIERS.indexOf(t)

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

function buildRow(doc: EventLicenseDoc, catalog: LicenseCatalog, joins: RowJoins): LicenseRow {
  const tier    = isEventLicenseTier(doc.tier) ? doc.tier : 'starter'
  const overlay = readOverlay(doc)
  const eff     = resolveEffectiveEventLicense(catalog[tier], doc.status, doc.amountPaise ?? 0, doc.admin)
  const maxReg  = eff.definition.limits.maxRegistrations

  const ev = joins.event
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
    displayStatus:       displayStatus(doc.status, overlay.lifecycle),
    lifecycle:           overlay.lifecycle,
    complimentary:       overlay.complimentary,
    source:              doc.source === 'admin' ? 'admin' : 'self_serve',
    amountPaidPaise:     doc.amountPaise ?? 0,
    effectivePricePaise: eff.effectivePricePaise,
    registrationLimit:   isUnlimited(maxReg) ? null : maxReg,
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

  const [eventSnaps, orgSnaps, counterSnaps, orderSnaps, catalog] = await Promise.all([
    adminDb.getAll(...eventIds.map(id => adminDb.doc(`events/${id}`))),
    orgUids.length ? adminDb.getAll(...orgUids.map(u => adminDb.doc(`users/${u}`))) : Promise.resolve([]),
    adminDb.getAll(...eventIds.map(id => adminDb.doc(`registrationCounters/${id}`))),
    orderIds.length ? adminDb.getAll(...orderIds.map(o => adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${o}`))) : Promise.resolve([]),
    getLicenseCatalog(),
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
    return buildRow(doc, catalog, {
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

  const [eventSnap, orgSnap, counterSnap, orderSnap, historySnap, catalog] = await Promise.all([
    adminDb.doc(`events/${eventId}`).get(),
    adminDb.doc(`users/${doc.organizerUid}`).get(),
    adminDb.doc(`registrationCounters/${eventId}`).get(),
    doc.orderId ? adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`).get() : Promise.resolve(null),
    adminDb.collection(LICENSE_HISTORY_COLLECTION).where('eventId', '==', eventId).limit(200).get(),
    getLicenseCatalog(),
  ])

  const order = orderSnap?.exists ? (orderSnap.data() as Record<string, unknown>) : undefined
  const row = buildRow(doc, catalog, {
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
        fromTier:  isEventLicenseTier(h.fromTier) ? h.fromTier : null,
        toTier:    isEventLicenseTier(h.toTier) ? h.toTier : doc.tier,
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

/** Resolve the immutable Event ID (draftId) from a published event slug — needed to
 *  bind publish-governance overrides, which are keyed by draftId, not the slug. */
async function resolveDraftId(slug: string): Promise<string | null> {
  const ev = await adminDb.doc(`events/${slug}`).get()
  const d  = ev.exists ? (ev.data() as { draftId?: unknown }) : null
  return typeof d?.draftId === 'string' ? d.draftId : null
}

/** Write an immutable licenseHistory entry (never overwrites — always appends). */
async function appendHistory(entry: {
  eventId: string; organizerUid: string; action: LicenseHistoryAction
  fromTier: EventLicenseTier | null; toTier: EventLicenseTier
  actorUid: string; note: string; reason: string; before?: unknown; after?: unknown
  orderId?: string | null
}): Promise<void> {
  await adminDb.collection(LICENSE_HISTORY_COLLECTION).add({
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
    ...(entry.before !== undefined ? { before: entry.before } : {}),
    ...(entry.after  !== undefined ? { after:  entry.after  } : {}),
    createdAt:    FieldValue.serverTimestamp(),
  })
}

/** Persist a full admin overlay (merge) + bump updatedAt. */
async function writeOverlay(eventId: string, overlay: OverlayShape, adminUid: string): Promise<void> {
  await licenseRef(eventId).set({
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
  }, { merge: true })
}

/** Recompute + persist the event's enforced capacity from an effective limit.
 *  `maxRegistrations` may be Infinity (unlimited). No-op if the event doc is gone. */
async function syncEventCapacity(eventId: string, maxRegistrations: number): Promise<void> {
  const evRef = adminDb.doc(`events/${eventId}`)
  if (!(await evRef.get()).exists) return
  const plan = capacityPlanForRegistrationLimit(maxRegistrations)
  await evRef.set({
    capacityPlan:     plan,
    capacityOverride: Number.isFinite(maxRegistrations) ? maxRegistrations : FieldValue.delete(),
    // `totalCapacity` is the field EVERY enforcement path reads — the registration
    // transaction, verify-payment, webhook, restore, approve, bulk, AND the gate.
    // It must move in lock-step with the override (number, or null = unlimited) so
    // an admin limit change applies immediately at registration time. This is the
    // single enforced source of truth for capacity.
    totalCapacity:    Number.isFinite(maxRegistrations) ? maxRegistrations : null,
    updatedAt:        FieldValue.serverTimestamp(),
  }, { merge: true })
}

/** Apply an admin action to an event license. Validates, mutates, audits. */
export async function applyLicenseAction(
  eventId: string,
  req: LicenseAdminActionRequest,
  adminUid: string,
): Promise<LicenseAdminActionResponse> {
  const action = req.action
  const reason = (req.reason ?? '').trim()

  const snap = await licenseRef(eventId).get()
  const doc  = snap.exists ? { ...(snap.data() as EventLicenseDoc), eventId } : null

  const catalog = await getLicenseCatalog()
  const respond = (extra?: Partial<LicenseAdminActionResponse>): LicenseAdminActionResponse =>
    ({ ok: true, eventId, action, ...extra })

  // ── grant — create a comp/free license for an event that has none ──
  if (action === 'grant') {
    if (!isEventLicenseTier(req.tier)) throw new LicenseActionError('A valid tier is required to grant a license')
    if (doc && readOverlay(doc).lifecycle === 'active' && doc.status === 'active') {
      throw new LicenseActionError('Event already has an active license — use override/upgrade instead of grant', 409)
    }
    const evSnap = await adminDb.doc(`events/${eventId}`).get()
    if (!evSnap.exists) throw new LicenseActionError('Event not found', 404)
    const ev = evSnap.data() as Record<string, unknown>
    const organizerUid = doc?.organizerUid
      ?? (typeof ev.organizerUid === 'string' ? ev.organizerUid : undefined)
      ?? (typeof ev.uid === 'string' ? ev.uid : undefined)
    if (!organizerUid) throw new LicenseActionError('Could not resolve the event organizer', 422)

    const complimentary = req.complimentary !== false   // default true for a grant
    await licenseRef(eventId).set({
      eventId,
      organizerUid,
      tier:         req.tier,
      status:       'active',
      version:      CURRENT_LICENSE_VERSION,
      amountPaise:  0,
      orderId:      null,
      paidAt:       null,
      upgradedFrom: null,
      upgradedAt:   null,
      source:       'admin',
      admin: {
        lifecycle: 'active', complimentary, pricePaiseOverride: null,
        limitOverrides: {}, featureOverrides: {}, paymentReceived: true,
        updatedBy: adminUid, updatedAt: FieldValue.serverTimestamp(),
      },
      createdAt: doc?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    await syncEventCapacity(eventId, catalog[req.tier].limits.maxRegistrations)
    await appendHistory({
      eventId, organizerUid, action: 'granted', fromTier: doc?.tier ?? null, toTier: req.tier,
      actorUid: adminUid, note: complimentary ? 'Complimentary license granted' : 'License granted', reason,
      before: doc ? { tier: doc.tier, status: doc.status } : null, after: { tier: req.tier, status: 'active', complimentary },
    })
    void logAdminAction({ adminUid, action: AUDIT_ACTION.grant, entityType: 'license', entityId: eventId, metadata: { tier: req.tier, complimentary, reason } }).catch(() => {})
    return respond()
  }

  // Every other action requires an existing license.
  if (!doc) throw new LicenseActionError('No license exists for this event', 404)
  const organizerUid = doc.organizerUid
  const tier = isEventLicenseTier(doc.tier) ? doc.tier : 'starter'
  const overlay = readOverlay(doc)

  switch (action) {
    // ── Lifecycle ──
    case 'suspend': {
      if (overlay.lifecycle !== 'active') throw new LicenseActionError(`Cannot suspend a ${overlay.lifecycle} license`, 409)
      await writeOverlay(eventId, { ...overlay, lifecycle: 'suspended' }, adminUid)
      break
    }
    case 'reactivate': {
      if (overlay.lifecycle === 'active') throw new LicenseActionError('License is already active', 409)
      await writeOverlay(eventId, { ...overlay, lifecycle: 'active' }, adminUid)
      break
    }
    case 'cancel': {
      if (overlay.lifecycle === 'cancelled') throw new LicenseActionError('License is already cancelled', 409)
      await writeOverlay(eventId, { ...overlay, lifecycle: 'cancelled' }, adminUid)
      break
    }

    // ── Overrides ──
    case 'overridePrice': {
      if (typeof req.pricePaise !== 'number' || !Number.isInteger(req.pricePaise) || req.pricePaise < 0) {
        throw new LicenseActionError('pricePaise must be a non-negative integer')
      }
      await writeOverlay(eventId, { ...overlay, pricePaiseOverride: req.pricePaise }, adminUid)
      break
    }
    case 'overrideLimit': {
      const key = req.limitKey ?? 'maxRegistrations'
      if (key !== 'maxRegistrations' && key !== 'maxTeamMembers' && key !== 'maxBroadcastRecipients') {
        throw new LicenseActionError('Invalid limit key')
      }
      const v = req.limitValue
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0)) {
        throw new LicenseActionError('Registration/limit value must be a non-negative integer or null (unlimited)')
      }
      const nextLimits = { ...overlay.limitOverrides, [key]: v }
      await writeOverlay(eventId, { ...overlay, limitOverrides: nextLimits }, adminUid)
      // Registration cap enforcement is driven by the event doc — sync it so the
      // change applies immediately at registration time.
      if (key === 'maxRegistrations') {
        await syncEventCapacity(eventId, v === null ? Number.POSITIVE_INFINITY : v)
      }
      break
    }
    case 'overrideFeatures': {
      const patch = req.features ?? {}
      const clean: Partial<Record<string, boolean>> = {}
      for (const [k, val] of Object.entries(patch)) {
        if (!(OVERRIDABLE_FEATURE_KEYS as string[]).includes(k)) throw new LicenseActionError(`Unknown feature: ${k}`)
        if (typeof val !== 'boolean') throw new LicenseActionError(`Feature ${k} must be boolean`)
        clean[k] = val
      }
      await writeOverlay(eventId, { ...overlay, featureOverrides: { ...overlay.featureOverrides, ...clean } }, adminUid)
      break
    }

    // ── Tier change ──
    case 'upgrade':
    case 'downgrade': {
      if (!isEventLicenseTier(req.tier)) throw new LicenseActionError('A valid target tier is required')
      const target = req.tier
      if (target === tier) throw new LicenseActionError(`License is already on the ${tier} tier`, 409)
      if (action === 'upgrade' && tierRank(target) < tierRank(tier)) throw new LicenseActionError('Upgrade target must be a higher tier', 409)
      if (action === 'downgrade' && tierRank(target) > tierRank(tier)) throw new LicenseActionError('Downgrade target must be a lower tier', 409)
      await licenseRef(eventId).set({
        tier: target, upgradedFrom: tier, upgradedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      // Effective limit for the new tier (respect an existing maxRegistrations override).
      const overrideMax = overlay.limitOverrides.maxRegistrations
      const effMax = overrideMax === undefined ? catalog[target].limits.maxRegistrations
        : overrideMax === null ? Number.POSITIVE_INFINITY : overrideMax
      await syncEventCapacity(eventId, effMax)
      break
    }

    // ── Payment ──
    case 'markPaymentReceived': {
      await writeOverlay(eventId, { ...overlay, paymentReceived: true }, adminUid)
      const updates: Record<string, unknown> = { status: 'active', updatedAt: FieldValue.serverTimestamp() }
      if (doc.paidAt == null) updates.paidAt = FieldValue.serverTimestamp()
      await licenseRef(eventId).set(updates, { merge: true })
      if (doc.orderId) {
        await adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`)
          .set({ status: 'paid', paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
      break
    }

    // ── Reissue — re-stamp the license record (support recovery) at its current tier ──
    case 'reissue': {
      await licenseRef(eventId).set({
        status: 'active', version: CURRENT_LICENSE_VERSION, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
      await writeOverlay(eventId, { ...overlay, lifecycle: 'active' }, adminUid)
      await syncEventCapacity(eventId, catalog[tier].limits.maxRegistrations)
      break
    }

    // ── Refund — gateway refund + wallet credit-back + cancel license ──
    case 'refund': {
      const refundLedgerRef = adminDb.doc(`walletTransactions/license_refund_${eventId}`)
      if ((await refundLedgerRef.get()).exists) throw new LicenseActionError('This license has already been refunded', 409)

      let gatewayRefunded = false
      let walletCreditedPaise = 0

      if (doc.orderId) {
        const orderRef = adminDb.doc(`${LICENSE_ORDERS_COLLECTION}/${doc.orderId}`)

        // Atomically CLAIM the order (→ 'refunding') BEFORE the gateway refund so two
        // concurrent refunds (double-click / two admins) cannot both fire
        // razorpay.payments.refund (H-1 double gateway refund). An already
        // refunded/refunding order aborts here; the F-1 ledger guard (line 604) blocks
        // re-refund after completion. Only paid orders carry a paymentId, so the
        // failure-revert to 'paid' below is always the correct prior state.
        const claim = await adminDb.runTransaction<{ paymentId: string | null; gatewayAmount: number }>(async txn => {
          const s = await txn.get(orderRef)
          const o = s.exists ? (s.data() as Record<string, unknown>) : null
          if (o && (o.status === 'refunded' || o.status === 'refunding')) {
            throw new LicenseActionError('Order already refunded', 409)
          }
          if (o) txn.update(orderRef, { status: 'refunding', updatedAt: FieldValue.serverTimestamp() })
          return {
            paymentId:     typeof o?.razorpayPaymentId === 'string' ? o.razorpayPaymentId : null,
            gatewayAmount: typeof o?.amountPaise === 'number' ? o.amountPaise : 0,
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
            await orderRef.set({ status: 'paid', updatedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {})
            throw new LicenseActionError(`Razorpay refund failed: ${e instanceof Error ? e.message : 'unknown error'}`, 502)
          }
        }
        await orderRef.set({ status: 'refunded', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }

      // Credit back any wallet-paid portion (walletTransactions/license_<draftId>).
      const draftId = doc.orderId?.startsWith('lic_') ? doc.orderId.slice(4) : eventId
      const chargeSnap = await adminDb.doc(`walletTransactions/license_${draftId}`).get()
      const walletUsed = chargeSnap.exists ? ((chargeSnap.data() as { amountPaise?: number }).amountPaise ?? 0) : 0

      // Credit-back + the refund ledger entry commit as ONE idempotent transaction
      // keyed on the deterministic license_refund_<eventId> doc (F-1): a concurrent
      // second refund (wallet-only license, no gateway guard) or a crash-retry can
      // never double-credit, and the balance can never drift from the ledger. When
      // walletUsed is 0 the credit is a no-op but the audit ledger entry is still
      // recorded. Mirrors atomicTopupCredit.
      const { credited } = await atomicWalletCredit(organizerUid, walletUsed, refundLedgerRef, {
        organizerUid, type: 'license_refund',
        status: 'completed', referenceType: 'license', referenceId: eventId,
        description: `License refund — ${eventId}`, gatewayRefunded, metadata: { reason },
      })
      if (credited) walletCreditedPaise = walletUsed

      await writeOverlay(eventId, { ...overlay, lifecycle: 'cancelled' }, adminUid)

      await appendHistory({
        eventId, organizerUid, action: 'refunded', fromTier: tier, toTier: tier,
        actorUid: adminUid, note: `Refunded (gateway=${gatewayRefunded}, wallet=₹${walletCreditedPaise / 100})`, reason,
        orderId: doc.orderId, before: { lifecycle: overlay.lifecycle }, after: { lifecycle: 'cancelled', gatewayRefunded, walletCreditedPaise },
      })
      void logAdminAction({ adminUid, action: AUDIT_ACTION.refund, entityType: 'license', entityId: eventId, metadata: { gatewayRefunded, walletCreditedPaise, reason } }).catch(() => {})
      return respond({ refund: { gatewayRefunded, walletCreditedPaise } })
    }

    // ── Note ──
    case 'addNote': {
      const note = (req.note ?? '').trim()
      if (!note) throw new LicenseActionError('Note text is required')
      await appendHistory({
        eventId, organizerUid, action: 'note', fromTier: tier, toTier: tier,
        actorUid: adminUid, note, reason: '',
      })
      void logAdminAction({ adminUid, action: AUDIT_ACTION.addNote, entityType: 'license', entityId: eventId, metadata: { note } }).catch(() => {})
      return respond()
    }

    // ── EA-4 S1: License expiry ──
    case 'extendExpiry':
    case 'reduceExpiry': {
      const days = req.expiryDays
      if (typeof days !== 'number' || !Number.isFinite(days) || days <= 0) {
        throw new LicenseActionError('expiryDays must be a positive number')
      }
      const newExpiry = Timestamp.fromMillis(Date.now() + Math.round(days) * 86_400_000)
      await licenseRef(eventId).set({ expiresAt: newExpiry, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      if (doc.orderId) {
        await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(doc.orderId)
          .set({ expiresAt: newExpiry, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
      await appendHistory({
        eventId, organizerUid, action: HISTORY_ACTION[action], fromTier: tier, toTier: tier,
        actorUid: adminUid, note: `Expiry set to ${Math.round(days)} days`, reason, after: { expiresAtMs: newExpiry.toMillis() },
      })
      void logAdminAction({ adminUid, action: AUDIT_ACTION[action], entityType: 'license', entityId: eventId, metadata: { days: Math.round(days), reason } }).catch(() => {})
      return respond()
    }
    case 'disableExpiry': {
      await licenseRef(eventId).set({ expiresAt: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      if (doc.orderId) {
        await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(doc.orderId)
          .set({ expiresAt: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
      await appendHistory({ eventId, organizerUid, action: 'expiry_disabled', fromTier: tier, toTier: tier, actorUid: adminUid, note: 'Expiry disabled (perpetual)', reason })
      void logAdminAction({ adminUid, action: 'license.expiry_disabled', entityType: 'license', entityId: eventId, metadata: { reason } }).catch(() => {})
      return respond()
    }

    // ── EA-4 S1: Publish-governance overrides (written to the event's baseline) ──
    case 'overridePublish':
    case 'overrideIdentity':
    case 'overrideRegistrationSafety': {
      const draftId = await resolveDraftId(eventId)
      if (!draftId) throw new LicenseActionError('Could not resolve the event to apply a governance override', 422)
      const enabled = req.overrideEnabled !== false
      const key = action === 'overridePublish' ? 'publish' : action === 'overrideIdentity' ? 'identity' : 'registrationSafety'
      await setBaselineOverrides(draftId, { [key]: enabled, setBy: adminUid, reason })
      await appendHistory({ eventId, organizerUid, action: 'governance_override', fromTier: tier, toTier: tier, actorUid: adminUid, note: `${key} override ${enabled ? 'enabled' : 'cleared'}`, reason, after: { [key]: enabled } })
      void logAdminAction({ adminUid, action: 'license.governance_override', entityType: 'license', entityId: eventId, metadata: { key, enabled, reason } }).catch(() => {})
      return respond()
    }

    // ── EA-4 S1: Consumption controls ──
    case 'forceConsume': {
      const now = FieldValue.serverTimestamp()
      const draftId = await resolveDraftId(eventId)
      await licenseRef(eventId).set({ consumed: true, consumedAt: now, updatedAt: now }, { merge: true })
      if (doc.orderId) {
        await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(doc.orderId)
          .set({ consumed: true, boundEventId: draftId ?? doc.orderId.replace(/^lic_/, ''), consumedAt: now, updatedAt: now }, { merge: true })
      }
      await appendHistory({ eventId, organizerUid, action: 'force_consumed', fromTier: tier, toTier: tier, actorUid: adminUid, note: 'License force-consumed by admin', reason })
      void logAdminAction({ adminUid, action: 'license.force_consumed', entityType: 'license', entityId: eventId, metadata: { reason } }).catch(() => {})
      return respond()
    }
    case 'resetLicense': {
      const now = FieldValue.serverTimestamp()
      await licenseRef(eventId).set({ consumed: false, consumedAt: null, updatedAt: now }, { merge: true })
      if (doc.orderId) {
        await adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(doc.orderId)
          .set({ consumed: false, boundEventId: null, consumedAt: null, updatedAt: now }, { merge: true })
      }
      const draftId = await resolveDraftId(eventId)
      if (draftId) await setBaselineOverrides(draftId, { publish: false, identity: false, registrationSafety: false, setBy: adminUid, reason })
      await appendHistory({ eventId, organizerUid, action: 'reset', fromTier: tier, toTier: tier, actorUid: adminUid, note: 'License governance state reset by admin', reason })
      void logAdminAction({ adminUid, action: 'license.reset', entityType: 'license', entityId: eventId, metadata: { reason } }).catch(() => {})
      return respond()
    }

    default:
      throw new LicenseActionError(`Unknown action: ${String(action)}`)
  }

  // Shared history + audit for the simple (non-early-returning) actions above.
  await appendHistory({
    eventId, organizerUid, action: HISTORY_ACTION[action],
    fromTier: (action === 'upgrade' || action === 'downgrade') ? tier : null,
    toTier: (action === 'upgrade' || action === 'downgrade') ? (req.tier as EventLicenseTier) : tier,
    actorUid: adminUid, note: `${action} by admin`, reason,
    before: { tier, lifecycle: overlay.lifecycle, priceOverride: overlay.pricePaiseOverride, limits: overlay.limitOverrides, features: overlay.featureOverrides },
    after: clean(req),
  })
  void logAdminAction({ adminUid, action: AUDIT_ACTION[action], entityType: 'license', entityId: eventId, metadata: clean({ ...req, reason }) }).catch(() => {})
  return respond()
}

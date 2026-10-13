// RD-PRINT-BILL-P3 · Super Admin management of ID-badge purchase coupons. Server-only (Admin SDK).
//
// The single place badge-coupon reads and mutations live. Every mutation: validated server-side,
// a 3–500 character reason (checked by the route), and an adminAuditLogs row staged IN THE SAME
// transaction as the change (both commit or neither does). Coupons are never deleted — archived.
// Mirrors lib/admin/licenseCouponService.ts in shape, but shares NO data with it: licence coupons
// are read here only to keep the code namespace unique (never written).

import { FieldValue, AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import type { AdminAuditAction } from '@/lib/admin/auditConstants'
import {
  BADGE_COUPON_SCOPE,
  type BadgeCouponDoc, type BadgeCouponInput, type BadgeCouponRow, type BadgeCouponValidation,
} from '@/lib/licensing/badgeCoupons/types'
import {
  normalizeBadgeCouponCode, BADGE_COUPON_CODE_RE, deriveBadgeCouponLifecycle, isFreeShape, normalizeIsoTimestamp,
  badgeCouponDefinitionErrors, unknownBadgeCouponKeys, uniqueIds, validateBadgeCoupon,
} from '@/lib/licensing/badgeCoupons/validate'
import {
  BADGE_COUPONS_COLLECTION, badgeCouponRef, licenseCouponNamespaceRef, getAllowFreeBadgeCoupons,
  getBadgeCouponOrganizerCount, BADGE_COUPON_REDEMPTIONS_SUBCOLLECTION,
} from '@/lib/licensing/badgeCoupons/store'
import { EVENT_PRINT_BADGE_FIELD, readStoredPrintBadgeOverride } from '@/lib/licensing/printBadgeCommercial'

export class BadgeCouponAdminError extends Error {
  constructor(message: string, public readonly status = 400, public readonly code = 'INVALID', public readonly details: string[] = []) {
    super(message); this.name = 'BadgeCouponAdminError'
  }
}

const rowOf = (c: BadgeCouponDoc, nowMs = Date.now()): BadgeCouponRow =>
  ({ ...c, lifecycle: deriveBadgeCouponLifecycle(c, nowMs), freeShape: isFreeShape(c) })

/** Firestore-safe comparable form of a value for the audit (timestamps → ms). */
const plain = (v: unknown): unknown => {
  if (v === undefined) return null
  if (v && typeof (v as { toMillis?: () => number }).toMillis === 'function') return (v as { toMillis: () => number }).toMillis()
  return v
}

function stageAudit(
  tx: FirebaseFirestore.Transaction, adminUid: string, action: AdminAuditAction, code: string, reason: string,
  extra: { metadata?: Record<string, unknown>; before?: unknown; after?: unknown; changedFields?: string[] } = {},
): void {
  stageAdminAudit(tx, {
    adminUid, actorRole: 'super_admin', action, entityType: 'badge_coupon', entityId: code,
    reason, changedFields: extra.changedFields, before: extra.before, after: extra.after,
    metadata: { ...(extra.metadata ?? {}), reason, scope: BADGE_COUPON_SCOPE },
    correlation: { couponCode: code },
  })
}

/** The definition a request produces (stored values for anything it does not set). */
function definitionOf(input: BadgeCouponInput, base?: BadgeCouponDoc) {
  return {
    type:              input.type              ?? base?.type,
    value:             input.value             ?? (input.type === 'free' ? 0 : base?.value),
    maxDiscountPaise:  input.maxDiscountPaise  !== undefined ? input.maxDiscountPaise  : (base?.maxDiscountPaise ?? null),
    minPurchasePaise:  input.minPurchasePaise  !== undefined ? input.minPurchasePaise  : (base?.minPurchasePaise ?? null),
    activatesAt:       input.activatesAt       !== undefined ? input.activatesAt       : (base?.activatesAt ?? null),
    expiresAt:         input.expiresAt         !== undefined ? input.expiresAt         : (base?.expiresAt ?? null),
    usageLimit:        input.usageLimit        !== undefined ? input.usageLimit        : (base?.usageLimit ?? null),
    perOrganizerLimit: input.perOrganizerLimit !== undefined ? input.perOrganizerLimit : (base?.perOrganizerLimit ?? null),
    eventIds:          input.eventIds          !== undefined ? input.eventIds          : (base?.restrictions.eventIds ?? []),
    organizerUids:     input.organizerUids     !== undefined ? input.organizerUids     : (base?.restrictions.organizerUids ?? []),
    enabled:           input.enabled           !== undefined ? input.enabled           : (base?.enabled ?? false),
    description:       input.description       !== undefined ? input.description       : (base?.description ?? ''),
    campaign:          input.campaign          !== undefined ? input.campaign          : (base?.campaign ?? ''),
    internalNotes:     input.internalNotes     !== undefined ? input.internalNotes     : (base?.internalNotes ?? ''),
  }
}

function refuseUnknown(raw: unknown): void {
  const unknown = unknownBadgeCouponKeys(raw)
  if (unknown.length > 0) throw new BadgeCouponAdminError(`Unknown coupon field: ${unknown.join(', ')}`, 400, 'UNKNOWN_FIELD')
}

// ─── Reads ──────────────────────────────────────────────────────────────────────

export async function listBadgeCoupons(opts: { includeArchived?: boolean } = {}): Promise<BadgeCouponRow[]> {
  const snap = await adminDb.collection(BADGE_COUPONS_COLLECTION).limit(500).get()
  const nowMs = Date.now()
  return snap.docs
    .map(d => d.data() as BadgeCouponDoc)
    .filter(c => opts.includeArchived || !c.archived)
    .map(c => rowOf(c, nowMs))
    .sort((a, b) => a.code.localeCompare(b.code))
}

export interface BadgeCouponUsage { currentUses: number; redemptions: number | null; discountGivenPaise: number | null }

export async function getBadgeCouponDetail(code: string): Promise<{ coupon: BadgeCouponRow; usage: BadgeCouponUsage } | null> {
  const ref = badgeCouponRef(code)
  const snap = await ref.get()
  if (!snap.exists) return null
  const c = snap.data() as BadgeCouponDoc
  const red = ref.collection(BADGE_COUPON_REDEMPTIONS_SUBCOLLECTION)
  // Measured, never guessed: an unreadable aggregate is reported as null, not 0.
  const [count, sum] = await Promise.all([
    red.count().get().then(s => s.data().count).catch(() => null),
    red.aggregate({ s: AggregateField.sum('discountPaise') }).get().then(s => s.data().s ?? 0).catch(() => null),
  ])
  return { coupon: rowOf(c), usage: { currentUses: c.currentUses ?? 0, redemptions: count, discountGivenPaise: sum } }
}

// ─── Mutations ──────────────────────────────────────────────────────────────────

export async function createBadgeCoupon(rawInput: unknown, adminUid: string, reason: string): Promise<BadgeCouponRow> {
  refuseUnknown(rawInput)
  const input = (rawInput ?? {}) as BadgeCouponInput
  const code = normalizeBadgeCouponCode(typeof input.code === 'string' ? input.code : '')
  if (!BADGE_COUPON_CODE_RE.test(code)) throw new BadgeCouponAdminError('The code must be 3–40 characters: A–Z, 0–9, _ or -.', 400, 'INVALID_CODE')
  const allowFree = await getAllowFreeBadgeCoupons()
  const def = definitionOf(input)
  const errors = badgeCouponDefinitionErrors(def, { allowFreeCoupons: allowFree })
  if (errors.length > 0) throw new BadgeCouponAdminError(errors.join(' '), 400, 'INVALID', errors)

  const doc: BadgeCouponDoc = {
    code, scope: BADGE_COUPON_SCOPE,
    description: def.description as string, type: def.type as BadgeCouponDoc['type'], value: def.value as number,
    maxDiscountPaise: def.maxDiscountPaise as number | null, minPurchasePaise: def.minPurchasePaise as number | null,
    // RD-PRINT-BILL-P3.2 — stored as UTC `toISOString()` (validated as strict ISO 8601 above).
    activatesAt: normalizeIsoTimestamp(def.activatesAt), expiresAt: normalizeIsoTimestamp(def.expiresAt),
    usageLimit: def.usageLimit as number | null, perOrganizerLimit: def.perOrganizerLimit as number | null,
    currentUses: 0,
    restrictions: { eventIds: uniqueIds(def.eventIds), organizerUids: uniqueIds(def.organizerUids) },
    enabled: def.enabled as boolean, paused: false, archived: false,
    campaign: def.campaign as string, internalNotes: def.internalNotes as string,
    version: 1, createdBy: adminUid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  }
  const ref = badgeCouponRef(code)
  await adminDb.runTransaction(async tx => {
    // ONE code namespace: refuse if EITHER collection holds the code. Both reads are inside this
    // transaction, so a concurrent licence- or badge-coupon create of the same code serializes.
    const [mine, licence] = await Promise.all([tx.get(ref), tx.get(licenseCouponNamespaceRef(code))])
    if (mine.exists) throw new BadgeCouponAdminError('A badge coupon with this code already exists.', 409, 'CODE_TAKEN')
    if (licence.exists) throw new BadgeCouponAdminError('This code is already used by a licence coupon. Coupon codes are unique across licence and badge coupons.', 409, 'CODE_TAKEN')
    tx.create(ref, doc)
    stageAudit(tx, adminUid, 'badge_coupon.created', code, reason, {
      metadata: { type: doc.type, value: doc.value, freeShape: isFreeShape(doc) },
      after: { type: doc.type, value: doc.value, maxDiscountPaise: doc.maxDiscountPaise, minPurchasePaise: doc.minPurchasePaise,
        usageLimit: doc.usageLimit, perOrganizerLimit: doc.perOrganizerLimit, restrictions: doc.restrictions, enabled: doc.enabled,
        activatesAt: doc.activatesAt, expiresAt: doc.expiresAt },
    })
  })
  return rowOf(doc)
}

const EDITABLE: (keyof BadgeCouponInput)[] = [
  'description', 'type', 'value', 'maxDiscountPaise', 'minPurchasePaise', 'activatesAt', 'expiresAt',
  'usageLimit', 'perOrganizerLimit', 'enabled', 'campaign', 'internalNotes',
]

export async function updateBadgeCoupon(code: string, rawInput: unknown, adminUid: string, reason: string): Promise<BadgeCouponRow> {
  refuseUnknown(rawInput)
  const input = (rawInput ?? {}) as BadgeCouponInput
  if (input.code !== undefined && normalizeBadgeCouponCode(String(input.code)) !== normalizeBadgeCouponCode(code)) {
    throw new BadgeCouponAdminError('A coupon code cannot be changed. Clone the coupon instead.', 400, 'CODE_IMMUTABLE')
  }
  const allowFree = await getAllowFreeBadgeCoupons()
  const ref = badgeCouponRef(code)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new BadgeCouponAdminError('Coupon not found', 404, 'NOT_FOUND')
    const cur = snap.data() as BadgeCouponDoc
    if (cur.archived) throw new BadgeCouponAdminError('An archived coupon cannot be edited. Clone it instead.', 409, 'ARCHIVED')
    // After the first redemption the DISCOUNT is frozen (type and value) — history and every
    // redemption snapshot must keep meaning what they meant. The count is read in this transaction.
    const discountChange = (input.type !== undefined && input.type !== cur.type) || (input.value !== undefined && input.value !== cur.value)
    if (discountChange && (cur.currentUses ?? 0) > 0) {
      throw new BadgeCouponAdminError('This coupon has been redeemed, so its discount type and value can no longer change. Clone it to offer a different discount.', 409, 'DISCOUNT_IMMUTABLE')
    }
    const def = definitionOf(input, cur)
    // The free gate applies only when this edit MAKES the coupon free (an existing free coupon
    // stays editable — e.g. pausing details — and is still refused at validation while disallowed).
    const becomesFree = isFreeShape({ type: def.type as BadgeCouponDoc['type'], value: def.value as number, maxDiscountPaise: def.maxDiscountPaise as number | null }) && !isFreeShape(cur)
    const errors = badgeCouponDefinitionErrors(def, { allowFreeCoupons: allowFree || !becomesFree })
    if (errors.length > 0) throw new BadgeCouponAdminError(errors.join(' '), 400, 'INVALID', errors)

    const patch: Record<string, unknown> = {}
    for (const k of EDITABLE) if (input[k] !== undefined) patch[k] = def[k as keyof typeof def]
    if (input.type === 'free') patch.value = 0
    // RD-PRINT-BILL-P3.2 — dates are stored normalized to UTC (null stays null: no bound).
    if (input.activatesAt !== undefined) patch.activatesAt = normalizeIsoTimestamp(def.activatesAt)
    if (input.expiresAt !== undefined) patch.expiresAt = normalizeIsoTimestamp(def.expiresAt)
    if (input.eventIds !== undefined || input.organizerUids !== undefined) {
      patch.restrictions = { eventIds: uniqueIds(def.eventIds), organizerUids: uniqueIds(def.organizerUids) }
    }
    const curRec = cur as unknown as Record<string, unknown>
    const fields = Object.keys(patch).filter(k => JSON.stringify(plain(curRec[k])) !== JSON.stringify(plain(patch[k])))
    if (fields.length === 0) return rowOf(cur)                                  // no-op: nothing written, no audit
    const write = { ...Object.fromEntries(fields.map(k => [k, patch[k]])), version: (cur.version ?? 1) + 1, updatedAt: FieldValue.serverTimestamp() }
    tx.set(ref, write, { merge: true })
    stageAudit(tx, adminUid, 'badge_coupon.updated', cur.code, reason, {
      changedFields: fields,
      before: Object.fromEntries(fields.map(k => [k, plain(curRec[k])])),
      after:  Object.fromEntries(fields.map(k => [k, plain(patch[k])])),
      metadata: { version: (cur.version ?? 1) + 1 },
    })
    return rowOf({ ...cur, ...write, updatedAt: null } as BadgeCouponDoc)
  })
}

export async function cloneBadgeCoupon(code: string, newCode: string, adminUid: string, reason: string): Promise<BadgeCouponRow> {
  const nc = normalizeBadgeCouponCode(newCode)
  if (!BADGE_COUPON_CODE_RE.test(nc)) throw new BadgeCouponAdminError('The new code must be 3–40 characters: A–Z, 0–9, _ or -.', 400, 'INVALID_CODE')
  const allowFree = await getAllowFreeBadgeCoupons()
  return adminDb.runTransaction(async tx => {
    const [src, dst, licence] = await Promise.all([tx.get(badgeCouponRef(code)), tx.get(badgeCouponRef(nc)), tx.get(licenseCouponNamespaceRef(nc))])
    if (!src.exists) throw new BadgeCouponAdminError('Source coupon not found', 404, 'NOT_FOUND')
    if (dst.exists) throw new BadgeCouponAdminError('A badge coupon with the new code already exists.', 409, 'CODE_TAKEN')
    if (licence.exists) throw new BadgeCouponAdminError('The new code is already used by a licence coupon.', 409, 'CODE_TAKEN')
    const c = src.data() as BadgeCouponDoc
    if (isFreeShape(c) && !allowFree) throw new BadgeCouponAdminError('Free (100%) badge coupons are not allowed, so a free coupon cannot be cloned.', 400, 'FREE_NOT_ALLOWED')
    // A fresh coupon: a draft (disabled), no usage, version 1.
    const next: BadgeCouponDoc = {
      ...c, code: nc, currentUses: 0, enabled: false, paused: false, archived: false, version: 1,
      createdBy: adminUid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    }
    tx.create(badgeCouponRef(nc), next)
    // RD-PRINT-BILL-P3.2 — the audit records the source AND the clone's resulting definition (the
    // source may change later). Definition fields only — no internal notes, actors or timestamps.
    stageAudit(tx, adminUid, 'badge_coupon.cloned', nc, reason, {
      metadata: { from: c.code, sourceVersion: c.version ?? 1 },
      before: { source: c.code, sourceVersion: c.version ?? 1 },
      after: cloneDefinition(next),
    })
    return rowOf(next)
  })
}

export type BadgeCouponStateAction = 'pause' | 'resume' | 'archive'

export async function setBadgeCouponState(code: string, action: BadgeCouponStateAction, adminUid: string, reason: string): Promise<BadgeCouponRow> {
  const ref = badgeCouponRef(code)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    if (!snap.exists) throw new BadgeCouponAdminError('Coupon not found', 404, 'NOT_FOUND')
    const cur = snap.data() as BadgeCouponDoc
    if (cur.archived) throw new BadgeCouponAdminError('This coupon is archived. Archived coupons stay archived — clone it to reuse it.', 409, 'ARCHIVED')
    const patch =
      action === 'pause'  ? { paused: true } :
      action === 'resume' ? { paused: false } :
                            { archived: true, paused: true }
    const before = { paused: cur.paused ?? false, archived: cur.archived ?? false }
    const after = { ...before, ...patch }
    if (before.paused === after.paused && before.archived === after.archived) return rowOf(cur)   // no-op
    tx.set(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    const auditAction: AdminAuditAction = action === 'pause' ? 'badge_coupon.paused' : action === 'resume' ? 'badge_coupon.resumed' : 'badge_coupon.archived'
    // RD-PRINT-BILL-P3.2 — changedFields are the REAL differences (archiving an already-paused coupon
    // changes `archived` only).
    const changedFields = (Object.keys(after) as (keyof typeof after)[]).filter(k => before[k] !== after[k])
    stageAudit(tx, adminUid, auditAction, cur.code, reason, { changedFields, before, after })
    return rowOf({ ...cur, ...patch })
  })
}

/**
 * A Super Admin's PREVIEW of what a coupon would do for an organizer, event and purchase amount —
 * computed exactly as the future purchase will (same validator, server-resolved context). Reads
 * only: it never reserves, consumes or records usage.
 */
export async function previewBadgeCoupon(code: string, args: { organizerUid: string; eventId: string; purchasePaise: number }): Promise<BadgeCouponValidation> {
  const [coupon, count, allowFree, ev] = await Promise.all([
    badgeCouponRef(code).get().then(s => (s.exists ? s.data() as BadgeCouponDoc : null)),
    getBadgeCouponOrganizerCount(code, args.organizerUid),
    getAllowFreeBadgeCoupons(),
    adminDb.collection('events').doc(args.eventId).get(),
  ])
  if (!count.ok) return { ok: false, failure: 'usage_unverified', message: 'This coupon’s usage could not be verified. Please try again.' }
  // The event's coupon eligibility comes from its override; unreadable or absent ⇒ allowed (the default).
  const read = readStoredPrintBadgeOverride(ev.exists ? (ev.data() as Record<string, unknown>)[EVENT_PRINT_BADGE_FIELD] : undefined)
  const eventCouponsAllowed = read.ok ? read.override?.couponsAllowed !== false : true
  return validateBadgeCoupon(coupon, {
    organizerUid: args.organizerUid, eventId: args.eventId, purchasePaise: args.purchasePaise,
    organizerRedemptions: count.count, eventCouponsAllowed, allowFreeCoupons: allowFree,
  }, Date.now())
}

/** RD-PRINT-BILL-P3.2 — the definition a clone starts with, for its audit row (no notes, actors or timestamps). */
function cloneDefinition(c: BadgeCouponDoc): Record<string, unknown> {
  return {
    code: c.code, scope: c.scope, description: c.description, type: c.type, value: c.value,
    maxDiscountPaise: c.maxDiscountPaise, minPurchasePaise: c.minPurchasePaise,
    activatesAt: c.activatesAt, expiresAt: c.expiresAt, usageLimit: c.usageLimit, perOrganizerLimit: c.perOrganizerLimit,
    restrictions: c.restrictions, enabled: c.enabled, paused: c.paused, archived: c.archived, campaign: c.campaign,
    currentUses: c.currentUses, version: c.version,
  }
}

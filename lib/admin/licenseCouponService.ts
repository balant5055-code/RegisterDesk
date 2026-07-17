// Admin License Coupon management (EA-4 S2). Server-only (Admin SDK).
//
// The single place admin coupon reads + mutations live. Every mutation validates
// server-side, requires a reason, and records an adminAuditLogs entry. Coupons are
// NEVER deleted — they are archived. This extends the existing admin/license
// surface; it does not touch registration/ticket/donation coupons.

import { FieldValue, AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { logAdminAction } from '@/lib/admin/audit'
import type { AdminAuditAction } from '@/lib/admin/auditConstants'
import {
  LICENSE_COUPONS_COLLECTION, normalizeCouponCode, deriveCouponLifecycle,
  type LicenseCouponDoc, type LicenseCouponType, type LicenseCouponLifecycle,
} from '@/lib/licensing/coupons'
import { LICENSE_ORDERS_COLLECTION } from '@/lib/licensing/schema'
import { isEventLicenseTier, type EventLicenseTier } from '@/lib/licensing/eventLicense'

export class CouponAdminError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); this.name = 'CouponAdminError' }
}

const col = () => adminDb.collection(LICENSE_COUPONS_COLLECTION)

export interface CouponInput {
  code?: string; description?: string; type?: LicenseCouponType; value?: number
  maxDiscountPaise?: number | null; minPurchasePaise?: number | null; maxPurchasePaise?: number | null
  activatesAt?: string | null; expiresAt?: string | null
  usageLimit?: number | null; perOrganizerLimit?: number | null
  tiers?: string[]; eventTypes?: string[]
  enabled?: boolean; priority?: number; stackable?: boolean
  visibility?: 'public' | 'private'; campaign?: string; internalNotes?: string
}

export interface CouponRow extends LicenseCouponDoc { lifecycle: LicenseCouponLifecycle }
export interface CouponUsage { currentUses: number; paidRedemptions: number; discountGivenPaise: number }

const isIntOrNull = (v: unknown): v is number | null => v === null || (typeof v === 'number' && Number.isInteger(v) && v >= 0)
const isIso       = (v: unknown): v is string | null => v === null || (typeof v === 'string' && !Number.isNaN(Date.parse(v)))

function validateNew(input: CouponInput): void {
  if (!input.type || !['percentage', 'fixed', 'free'].includes(input.type)) throw new CouponAdminError('A valid coupon type is required')
  const v = input.value ?? 0
  if (input.type === 'percentage' && (typeof v !== 'number' || v <= 0 || v > 100)) throw new CouponAdminError('percentage value must be 1..100')
  if (input.type === 'fixed' && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) throw new CouponAdminError('fixed value must be a positive integer (paise)')
  for (const [k, val] of Object.entries({ maxDiscountPaise: input.maxDiscountPaise, minPurchasePaise: input.minPurchasePaise, maxPurchasePaise: input.maxPurchasePaise, usageLimit: input.usageLimit, perOrganizerLimit: input.perOrganizerLimit })) {
    if (val !== undefined && !isIntOrNull(val)) throw new CouponAdminError(`${k} must be a non-negative integer or null`)
  }
  if (input.activatesAt !== undefined && !isIso(input.activatesAt)) throw new CouponAdminError('activatesAt must be an ISO date or null')
  if (input.expiresAt !== undefined && !isIso(input.expiresAt)) throw new CouponAdminError('expiresAt must be an ISO date or null')
  if (input.tiers && input.tiers.some(t => !isEventLicenseTier(t))) throw new CouponAdminError('tiers contains an invalid license tier')
}

function docFromInput(code: string, input: CouponInput, createdBy: string): LicenseCouponDoc {
  return {
    code,
    description:       input.description ?? '',
    type:             input.type as LicenseCouponType,
    value:            input.value ?? 0,
    maxDiscountPaise:  input.maxDiscountPaise ?? null,
    minPurchasePaise:  input.minPurchasePaise ?? null,
    maxPurchasePaise:  input.maxPurchasePaise ?? null,
    activatesAt:      input.activatesAt ?? null,
    expiresAt:        input.expiresAt ?? null,
    usageLimit:        input.usageLimit ?? null,
    perOrganizerLimit: input.perOrganizerLimit ?? null,
    currentUses:      0,
    restrictions:     { tiers: (input.tiers ?? []).filter(isEventLicenseTier) as EventLicenseTier[], eventTypes: input.eventTypes ?? [] },
    enabled:          input.enabled ?? false,
    paused:           false,
    archived:         false,
    priority:         typeof input.priority === 'number' ? input.priority : 0,
    stackable:        input.stackable ?? false,
    visibility:       input.visibility === 'public' ? 'public' : 'private',
    campaign:         input.campaign ?? '',
    internalNotes:    input.internalNotes ?? '',
    version:          1,
    createdBy,
    createdAt:        FieldValue.serverTimestamp(),
    updatedAt:        FieldValue.serverTimestamp(),
  }
}

async function audit(adminUid: string, action: AdminAuditAction, code: string, reason: string, metadata: Record<string, unknown> = {}): Promise<void> {
  void logAdminAction({ adminUid, action, entityType: 'license_coupon', entityId: code, metadata: { ...metadata, reason } }).catch(() => {})
}

// ─── Reads ──────────────────────────────────────────────────────────────────────

export async function listCoupons(opts: { includeArchived?: boolean } = {}): Promise<CouponRow[]> {
  const snap = await col().limit(500).get()
  const nowMs = Date.now()
  return snap.docs
    .map(d => d.data() as LicenseCouponDoc)
    .filter(c => opts.includeArchived || !c.archived)
    .map(c => ({ ...c, lifecycle: deriveCouponLifecycle(c, nowMs) }))
    .sort((a, b) => b.priority - a.priority || a.code.localeCompare(b.code))
}

export async function getCouponUsage(code: string): Promise<CouponUsage> {
  const ref = col().doc(normalizeCouponCode(code))
  const snap = await ref.get()
  const currentUses = snap.exists ? ((snap.data() as LicenseCouponDoc).currentUses ?? 0) : 0
  const paidQ = adminDb.collection(LICENSE_ORDERS_COLLECTION).where('couponCode', '==', normalizeCouponCode(code)).where('status', '==', 'paid')
  let paidRedemptions = 0, discountGivenPaise = 0
  try { paidRedemptions = (await paidQ.count().get()).data().count } catch { /* index */ }
  try { discountGivenPaise = (await paidQ.aggregate({ s: AggregateField.sum('discountPaise') }).get()).data().s ?? 0 } catch { /* index */ }
  return { currentUses, paidRedemptions, discountGivenPaise }
}

// ─── Mutations ──────────────────────────────────────────────────────────────────

export async function createCoupon(input: CouponInput, adminUid: string, reason: string): Promise<CouponRow> {
  const code = normalizeCouponCode(input.code ?? '')
  if (!/^[A-Z0-9_-]{3,40}$/.test(code)) throw new CouponAdminError('code must be 3–40 chars: A–Z, 0–9, _ or -')
  validateNew(input)
  const ref = col().doc(code)
  if ((await ref.get()).exists) throw new CouponAdminError('A coupon with this code already exists', 409)
  const doc = docFromInput(code, input, adminUid)
  await ref.set(doc)
  await audit(adminUid, 'license_coupon.created', code, reason, { type: doc.type, value: doc.value })
  return { ...doc, lifecycle: deriveCouponLifecycle(doc, Date.now()) }
}

export async function updateCoupon(code: string, input: CouponInput, adminUid: string, reason: string): Promise<void> {
  const ref = col().doc(normalizeCouponCode(code))
  const snap = await ref.get()
  if (!snap.exists) throw new CouponAdminError('Coupon not found', 404)
  const cur = snap.data() as LicenseCouponDoc
  // Only editable fields (never code/currentUses/createdAt). Re-validate type/value if present.
  validateNew({ type: input.type ?? cur.type, value: input.value ?? cur.value, ...input })
  const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp(), version: (cur.version ?? 1) + 1 }
  const editable: (keyof CouponInput)[] = ['description', 'type', 'value', 'maxDiscountPaise', 'minPurchasePaise', 'maxPurchasePaise', 'activatesAt', 'expiresAt', 'usageLimit', 'perOrganizerLimit', 'enabled', 'priority', 'stackable', 'visibility', 'campaign', 'internalNotes']
  for (const k of editable) if (input[k] !== undefined) patch[k] = input[k]
  if (input.tiers !== undefined || input.eventTypes !== undefined) {
    patch.restrictions = { tiers: (input.tiers ?? cur.restrictions.tiers).filter(isEventLicenseTier), eventTypes: input.eventTypes ?? cur.restrictions.eventTypes }
  }
  await ref.set(patch, { merge: true })
  await audit(adminUid, 'license_coupon.updated', cur.code, reason, { fields: Object.keys(patch) })
}

export async function cloneCoupon(code: string, newCode: string, adminUid: string, reason: string): Promise<CouponRow> {
  const src = await col().doc(normalizeCouponCode(code)).get()
  if (!src.exists) throw new CouponAdminError('Source coupon not found', 404)
  const c = src.data() as LicenseCouponDoc
  const nc = normalizeCouponCode(newCode)
  if (!/^[A-Z0-9_-]{3,40}$/.test(nc)) throw new CouponAdminError('New code must be 3–40 chars: A–Z, 0–9, _ or -')
  if ((await col().doc(nc).get()).exists) throw new CouponAdminError('A coupon with the new code already exists', 409)
  const clone: LicenseCouponDoc = {
    ...c, code: nc, currentUses: 0, enabled: false, paused: false, archived: false, version: 1,
    createdBy: adminUid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  }
  await col().doc(nc).set(clone)
  await audit(adminUid, 'license_coupon.cloned', nc, reason, { from: c.code })
  return { ...clone, lifecycle: deriveCouponLifecycle(clone, Date.now()) }
}

export type CouponStateAction = 'pause' | 'resume' | 'archive'

export async function setCouponState(code: string, action: CouponStateAction, adminUid: string, reason: string): Promise<void> {
  const ref = col().doc(normalizeCouponCode(code))
  if (!(await ref.get()).exists) throw new CouponAdminError('Coupon not found', 404)
  const patch =
    action === 'pause'   ? { paused: true } :
    action === 'resume'  ? { paused: false } :
                           { archived: true, paused: true }
  await ref.set({ ...patch, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  const auditAction: AdminAuditAction =
    action === 'pause' ? 'license_coupon.paused' : action === 'resume' ? 'license_coupon.resumed' : 'license_coupon.archived'
  await audit(adminUid, auditAction, normalizeCouponCode(code), reason)
}

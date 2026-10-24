// RD-EVENT-COMMERCE-02 · Event service-allowance LEDGER. Server-only.
//
// ═══ THE RECORD ══════════════════════════════════════════════════════════════
//   eventServiceAllowances/{draftId}
//     { draftId, organizerUid,
//       whatsapp:     { purchased, consumed, onExhausted, carriedIn?, carriedOut?, refunded? },
//       certificates: { purchased, consumed, onExhausted, carriedIn?, carriedOut?, refunded? },
//       appliedOrders: { [orderId]: true },   ← exactly-once application of a paid order
//       pendingAddonOrderId: string | null,   ← at most one payable add-on order at a time
//       updatedAt }
//   eventServiceAllowances/{draftId}/usage/{unitKey}
//     { service, quantity, source, createdAt }   ← exactly-once consumption per unit key
//
// Keyed by the DRAFT id: it is the event's immutable id from purchase (pre-publish) to the
// last send, and `events/{slug}.draftId` maps a live event back to it.
//
// SEPARATION: this ledger holds QUANTITIES of prepaid services. It never holds money, and it is
// never read or written by the communication wallet (`organizerWallets`) or the revenue wallet
// (`organizerRevenueWallets`) code paths. Purchased units are only ever ADDED by the payment
// activation transactions (activateLicenseOrder / activateAddonOrder) after a verified payment.
//
// RD-WALLET-REQ — Super Admin-APPROVED wallet service requests (lib/wallet/serviceRequests.ts) are
// the only other writers, and they never touch `purchased` or `consumed`:
//   refunded   — unused units an approved refund request took out of this event
//   carriedOut — unused units an approved carry-forward moved OUT of this event
//   carriedIn  — units an approved carry-forward moved INTO this event (usable, never "paid")
// Every field is optional (missing = 0), so ledgers written before these existed read unchanged.
//   usable total = purchased + carriedIn
//   available    = usable total − consumed − carriedOut − refunded
//
// CONCURRENCY: every consumption is a transaction that re-reads the ledger, so concurrent
// sends cannot push `consumed` past `purchased`. Contention note: all consumption for one
// event serialises on one document (Firestore sustains ~1 write/s per document with bursts
// absorbed by transaction retries) — adequate for transactional sends; a sharded counter would
// be needed before very high-rate bulk sends consume per message (broadcasts consume in ONE
// write at campaign start, so they do not contend).

import { FieldValue, type Transaction, type DocumentSnapshot } from 'firebase-admin/firestore'
import { adminDb }        from '@/lib/firebase/admin'
import { MAX_EVENT_PHOTO_CAPACITY } from './photoCapacity'
import {
  SERVICE_KINDS, EMPTY_SELECTION, isServicePurchaseReleased,
  type ServiceKind, type ServiceChargeItem,
  type AllowanceExhaustionPolicy, type ServicePurchased,
} from './serviceAllowances'

export const EVENT_SERVICE_ALLOWANCES = 'eventServiceAllowances'
export const ALLOWANCE_USAGE_SUBCOLLECTION = 'usage'

export interface ServiceLedgerLine {
  purchased:   number
  consumed:    number
  onExhausted: AllowanceExhaustionPolicy | null
  carriedIn?:  number
  carriedOut?: number
  refunded?:   number
}
export interface ServiceLedgerDoc {
  draftId:              string
  organizerUid:         string
  whatsapp?:            ServiceLedgerLine
  certificates?:        ServiceLedgerLine
  /** Media units RAISE the event's photo cap; usage is the event's stored-photo count, not a ledger counter. */
  media?:               ServiceLedgerLine
  /** RD-PRINT-BILL-P1 shape; RD-PRINT-BILL-P4 — `purchased` is written only by a badge purchase activation
   *  (printBadgePurchase/settle.ts). RD-PRINT-BILL-P5 — `consumed` is taken by badge generation rounds
   *  (lib/printAssets/badgeBilling/store.ts), usage key `pgen_<id>_r<n>`. */
  print_badges?:        ServiceLedgerLine
  appliedOrders?:       Record<string, boolean>
  pendingAddonOrderId?: string | null
  /** RD-PRINT-BILL-P4 — the ONE payable badge purchase order of this event (its own slot; add-ons keep theirs). */
  pendingBadgeOrderId?: string | null
  /**
   * RD-SA-COMMERCE-P1 — a licence refund is returning the money for these unused units. Written by the
   * refund's claim transaction, cleared by its finalize (which retires exactly these units) or by its
   * rollback. While present, every consumer treats them as unavailable: decideReserve (WhatsApp,
   * certificates) and the photo gate (media) subtract them, so nothing can use a unit being refunded.
   */
  refundHold?:          { orderId: string; units: Partial<Record<ServiceKind, number>>; at?: unknown } | null
}

/** RD-SA-COMMERCE-P1 — units of `service` held by an in-flight licence refund (0 when none). */
export function heldRefundUnits(d: Pick<ServiceLedgerDoc, 'refundHold'> | undefined, service: ServiceKind | 'print_badges'): number {
  const v = (d?.refundHold?.units as Record<string, unknown> | undefined)?.[service]
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

export const ledgerRef = (draftId: string) => adminDb.collection(EVENT_SERVICE_ALLOWANCES).doc(draftId)
const usageRef = (draftId: string, unitKey: string) =>
  ledgerRef(draftId).collection(ALLOWANCE_USAGE_SUBCOLLECTION).doc(unitKey)

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
export const ledgerLine = (d: ServiceLedgerDoc | undefined, k: ServiceKind | 'print_badges'): Required<ServiceLedgerLine> => ({
  purchased: n(d?.[k]?.purchased), consumed: n(d?.[k]?.consumed), onExhausted: d?.[k]?.onExhausted ?? null,
  carriedIn: n(d?.[k]?.carriedIn), carriedOut: n(d?.[k]?.carriedOut), refunded: n(d?.[k]?.refunded),
})
const line = ledgerLine

/** Units still usable on this event (never negative). */
export const availableUnits = (l: Required<ServiceLedgerLine>) =>
  Math.max(0, l.purchased + l.carriedIn - l.consumed - l.carriedOut - l.refunded)

export interface ServiceAllowanceView {
  /** Units PAID for on this event (unchanged meaning: purchase requirements compare against it). */
  purchased:  ServicePurchased
  consumed:   ServicePurchased
  remaining:  ServicePurchased
  carriedIn:  ServicePurchased
  carriedOut: ServicePurchased
  refunded:   ServicePurchased
}

export function viewOf(d: ServiceLedgerDoc | undefined): ServiceAllowanceView {
  const purchased = { ...EMPTY_SELECTION }, consumed = { ...purchased }, remaining = { ...purchased }
  const carriedIn = { ...purchased }, carriedOut = { ...purchased }, refunded = { ...purchased }
  for (const k of SERVICE_KINDS) {
    const l = line(d, k)
    purchased[k] = l.purchased; consumed[k] = l.consumed; remaining[k] = availableUnits(l)
    carriedIn[k] = l.carriedIn; carriedOut[k] = l.carriedOut; refunded[k] = l.refunded
  }
  return { purchased, consumed, remaining, carriedIn, carriedOut, refunded }
}

/** Read the ledger for a draft the caller has already proven it owns. */
export async function readServiceAllowances(draftId: string): Promise<ServiceLedgerDoc | undefined> {
  const snap = await ledgerRef(draftId).get()
  return snap.exists ? snap.data() as ServiceLedgerDoc : undefined
}

// ─── Application (payment side) ───────────────────────────────────────────────

/**
 * Writes a paid order's service lines into the ledger — INSIDE the caller's payment
 * transaction, with `ledgerSnap` read earlier in that same transaction (Firestore requires
 * reads before writes). Exactly once per order: `appliedOrders[orderId]` is the guard.
 */
export function txnApplyServiceItems(
  txn: Transaction,
  ledgerSnap: DocumentSnapshot,
  args: { draftId: string; organizerUid: string; orderId: string; items: readonly ServiceChargeItem[]; clearPendingAddon?: boolean },
): void {
  const items = args.items.filter(i => i.quantity > 0)
  const existing = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
  if (existing?.appliedOrders?.[args.orderId]) return
  // RD-HIGH-2 — the ledger is keyed by a GLOBAL draft id. A grant for a different organizer (or
  // onto a ledger with no owner) must never merge units into it or rewrite its owner: abort the
  // whole payment transaction instead. The routes refuse such orders before any payment, so this
  // is defence in depth; aborting leaves the paid order un-applied for manual review.
  if (existing && existing.organizerUid !== args.organizerUid) {
    throw new Error('LEDGER_OWNER_MISMATCH')
  }
  // RD-PRINT-BILL-P2 — release gate, last line of defence: a line for a service that is not
  // released for purchase in code (RELEASED_FOR_PURCHASE) aborts the WHOLE payment transaction
  // before any write — nothing is applied and the order is not activated (it stays for review),
  // exactly like PHOTO_CAPACITY_EXCEEDED below. Every order path refuses such a selection first.
  if (items.some(i => !isServicePurchaseReleased(i.service))) throw new Error('SERVICE_NOT_RELEASED')
  // RD-PHOTO-01 — last line of defence: no paid order may take an event above 3,000 photos. Every
  // order path checks this before any payment and the add-on / capacity settlements refuse it with a
  // payment hold; reaching here aborts the payment transaction (the order stays un-applied for review).
  const mediaAdding = items.reduce((n, i) => n + (i.service === 'media' ? i.quantity : 0), 0)
  if (mediaAdding > 0) {
    const m = existing?.media
    const v = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0)
    const net = Math.max(0, v(m?.purchased) + v(m?.carriedIn) - v(m?.carriedOut) - v(m?.refunded))
    if (net + mediaAdding > MAX_EVENT_PHOTO_CAPACITY) throw new Error('PHOTO_CAPACITY_EXCEEDED')
  }
  const patch: Record<string, unknown> = {
    draftId: args.draftId, organizerUid: args.organizerUid,
    appliedOrders: { [args.orderId]: true },
    updatedAt: FieldValue.serverTimestamp(),
    ...(args.clearPendingAddon ? { pendingAddonOrderId: null } : {}),
  }
  for (const i of items) {
    // Increment, never rewrite: `consumed` is owned by the usage side and is not touched here.
    // The newest purchase's exhaustion policy governs the whole allowance from here on —
    // it is what the organizer most recently agreed to.
    patch[i.service] = { purchased: FieldValue.increment(i.quantity), onExhausted: i.onExhausted }
  }
  txn.set(ledgerRef(args.draftId), patch, { merge: true })
}

// ─── Consumption (usage side) ─────────────────────────────────────────────────

export type ReserveOutcome =
  /** The event has no purchased allowance for this service — use the existing PAYG path unchanged. */
  | { mode: 'none' }
  /** One or more units taken from the allowance (or already taken for this unit key). */
  | { mode: 'allowance'; already: boolean }
  /** An allowance exists but cannot cover this; `policy` says what the caller must do. */
  | { mode: 'exhausted'; policy: AllowanceExhaustionPolicy }

/** Pure decision, shared by the standalone and in-transaction reservers. */
export function decideReserve(
  ledger: ServiceLedgerDoc | undefined, usageExists: boolean, service: ServiceKind, quantity: number,
): ReserveOutcome {
  const l = line(ledger, service)
  if (l.purchased + l.carriedIn <= 0) return { mode: 'none' }
  if (usageExists) return { mode: 'allowance', already: true }
  // RD-SA-COMMERCE-P1 — units held by an in-flight licence refund are not available.
  if (availableUnits(l) - heldRefundUnits(ledger, service) >= quantity) return { mode: 'allowance', already: false }
  // RD-WALLET-REQ — units only CARRIED IN (nothing bought here) carry no exhaustion policy the
  // organizer agreed to for this event: once they run out the event is back on pay-as-you-go,
  // exactly as it was before the carry-forward.
  if (l.purchased <= 0) return { mode: 'none' }
  // An allowance bought before a policy existed cannot happen (purchase requires one), but a
  // missing value must never let a send through for free: treat it as `block`.
  return { mode: 'exhausted', policy: l.onExhausted ?? 'block' }
}

/**
 * Atomically takes `quantity` units for `unitKey` (idempotent: a replay of the same key
 * returns `already` and takes nothing). Never throws for business outcomes.
 */
export async function reserveServiceUnits(args: {
  draftId: string; service: ServiceKind; unitKey: string; quantity?: number; source: string
}): Promise<ReserveOutcome> {
  const quantity = Math.max(1, Math.trunc(args.quantity ?? 1))
  const lRef = ledgerRef(args.draftId), uRef = usageRef(args.draftId, args.unitKey)
  return adminDb.runTransaction(async txn => {
    const [lSnap, uSnap] = await Promise.all([txn.get(lRef), txn.get(uRef)])
    const ledger = lSnap.exists ? lSnap.data() as ServiceLedgerDoc : undefined
    const outcome = decideReserve(ledger, uSnap.exists, args.service, quantity)
    if (outcome.mode === 'allowance' && !outcome.already) txnTakeUnits(txn, args.draftId, args.service, args.unitKey, quantity, args.source)
    return outcome
  })
}

/** The write half of a reservation, for callers that already read inside their own transaction.
 *  RD-PRINT-BILL-P5 — also takes `print_badges` (badge generation decides with its own blocking rule). */
export function txnTakeUnits(
  txn: Transaction, draftId: string, service: ServiceKind | 'print_badges', unitKey: string, quantity: number, source: string,
): void {
  txn.set(ledgerRef(draftId), { [service]: { consumed: FieldValue.increment(quantity) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  txn.set(usageRef(draftId, unitKey), { service, quantity, source, createdAt: FieldValue.serverTimestamp() })
}

/** Reads the caller needs inside its own transaction before calling decideReserve/txnTakeUnits. */
export async function txnReadForReserve(txn: Transaction, draftId: string, unitKey: string) {
  const [lSnap, uSnap] = await Promise.all([txn.get(ledgerRef(draftId)), txn.get(usageRef(draftId, unitKey))])
  return { ledger: lSnap.exists ? lSnap.data() as ServiceLedgerDoc : undefined, usageExists: uSnap.exists }
}

/**
 * Gives back a reservation whose unit was never consumed (e.g. the provider refused the
 * message). Idempotent: only a usage record that exists is released, exactly once.
 */
export async function releaseServiceUnits(args: { draftId: string; service: ServiceKind; unitKey: string }): Promise<boolean> {
  const lRef = ledgerRef(args.draftId), uRef = usageRef(args.draftId, args.unitKey)
  return adminDb.runTransaction(async txn => {
    const uSnap = await txn.get(uRef)
    if (!uSnap.exists) return false
    // RD-CLOSE — Meta ACCEPTED the message this unit paid for (recorded by the acceptance record,
    // e.g. from the status webhook while the sender's request was still timing out): it stays used.
    if ((uSnap.data() as { acceptedWamid?: unknown }).acceptedWamid) return false
    const q = Math.max(1, Math.trunc((uSnap.data() as { quantity?: number }).quantity ?? 1))
    txn.delete(uRef)
    txn.set(lRef, { [args.service]: { consumed: FieldValue.increment(-q) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return true
  })
}

/** The usage record for `unitKey`, read inside the caller's transaction (before any write). */
export async function txnReadUsage(txn: Transaction, draftId: string, unitKey: string): Promise<{ exists: boolean; quantity: number }> {
  const s = await txn.get(usageRef(draftId, unitKey))
  return { exists: s.exists, quantity: s.exists ? Math.max(0, Math.trunc((s.data() as { quantity?: number }).quantity ?? 0)) : 0 }
}

/**
 * RD-INTEG — PARTIAL release: keeps `keep` of a multi-unit reservation and gives the rest back
 * (a broadcast reserves one unit per recipient upfront and is billed only for those WhatsApp
 * accepted). `current` is what txnReadUsage returned in the same transaction. keep = 0 deletes the
 * record, exactly as releaseServiceUnits does. Returns the units given back.
 */
export function txnTrimUnits(
  txn: Transaction, draftId: string, service: ServiceKind | 'print_badges', unitKey: string, current: { exists: boolean; quantity: number }, keep: number,
): number {
  if (!current.exists) return 0
  const k = Math.max(0, Math.min(current.quantity, Math.trunc(keep)))
  const back = current.quantity - k
  if (back <= 0) return 0
  if (k === 0) txn.delete(usageRef(draftId, unitKey))
  else txn.set(usageRef(draftId, unitKey), { quantity: k, releasedUnits: back, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  txn.set(ledgerRef(draftId), { [service]: { consumed: FieldValue.increment(-back) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
  return back
}

/**
 * The live event's draft id — the ledger key — or null for events created without one.
 * RD-HIGH-2 — also null when that ledger belongs to a DIFFERENT organizer than the event (a draft
 * id collision): the event then uses its own organizer's pay-as-you-go path and can never
 * consume another organizer's prepaid units.
 */
export async function draftIdForEventSlug(eventSlug: string): Promise<string | null> {
  const snap = await adminDb.collection('events').doc(eventSlug).get()
  const data = snap.exists ? snap.data() as { draftId?: unknown; uid?: unknown } : null
  const id = data?.draftId
  if (typeof id !== 'string' || !id) return null
  const ledger = await ledgerRef(id).get()
  if (ledger.exists && (typeof data?.uid !== 'string' || ledger.get('organizerUid') !== data.uid)) {
    console.warn('[allowance] ledger owner does not match the event owner — allowance ignored', { eventSlug, draftId: id })
    return null
  }
  return id
}

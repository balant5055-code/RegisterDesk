// RD-CAPACITY-01 · Changing a published event's registration capacity. Server-only.
//
// An activation buys the capacity an event starts with. This module is everything that
// happens afterwards: buying MORE capacity, and paying the charge for giving some back.
//
// ═══ WHAT MAKES THIS DIFFERENT FROM ACTIVATION ══════════════════════════════
// Activation prices a number chosen from nothing. A change prices a DELTA against state
// that other requests are also allowed to move. That makes exactly one failure mode
// interesting, and it is the expensive one:
//
//   two concurrent increases both read capacity 500, both compute "+500 to reach 1,000",
//   both are paid, and the event ends up at 1,000 having sold 1,000 extra slots' worth
//   of capacity for one slot's worth of money.
//
// Two guards close it, and both live INSIDE transactions:
//
//   1. ORDER CREATION re-reads the current capacity and takes the next sequence number in
//      the same transaction that writes the order. Two racers contend on the licence
//      document, so the loser re-runs against the winner's sequence and the winner's
//      capacity — it can never mint a second order for the same delta.
//   2. ACTIVATION re-reads the current capacity and refuses an order whose recorded
//      `previousCapacity` no longer matches. A paid order that has been overtaken is
//      rejected rather than applied, and its captured remainder is refunded.
//
// ═══ WHAT IT DELIBERATELY DOES NOT DO ═══════════════════════════════════════
// It never refunds, reverses, or edits a historical activation payment. A decrease is a
// NEW charge, recorded as its own order; the money already collected for capacity stays
// collected, and every previous order document is left exactly as it was.
//
// RD-LICENSE-PAYMENT-01 · a capacity change is paid through RAZORPAY ONLY, for its whole
// amount. The communication wallet (`organizerWallets`) funds WhatsApp / bulk / SMS usage
// and is never read, debited or written by this module — no wallet share, no
// `walletTransactions` row.

import { FieldValue }            from 'firebase-admin/firestore'
import { adminDb }               from '@/lib/firebase/admin'
import { captureFinancialError } from '@/lib/monitoring/sentry'
import { deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import {
  EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, LICENSE_HISTORY_COLLECTION,
  licenseOrderConverter, capacityChargeSnapshot, capacityOrderDocId, isCapacityChangePurpose,
  type LicenseOrderDoc, type LicenseHistoryDoc, type CapacityChargeSnapshot,
} from './schema'
import { quoteCapacityChange, type CapacityQuote } from './capacityPricing'
import { CAPACITY_ALERT_FIELD } from './capacityThresholds'
import { getGlobalCommercialTerms, resolveEventCommercialTerms } from './resolveCommercialTerms'
import { defaultLicenseTierForVersion, CURRENT_LICENSE_VERSION } from './eventLicense'
import type { CommercialTerms } from './capacityCommercial'
import { resolveLiveEventRef, liveEventLookupMessage } from '@/lib/events/liveEventRef'
import { SERVICE_KINDS, sumServiceItems, isConsistentServiceItem, type ServiceChargeItem } from './serviceAllowances'
import { ledgerRef, txnApplyServiceItems, type ServiceLedgerDoc } from './serviceAllowanceLedger'
import { checkPhotoPurchase, mediaUnitsIn, paidPhotoCapacity } from './photoCapacity'
import { recordManualRefundHold } from './manualRefundHold'

const now = () => FieldValue.serverTimestamp() as unknown as FirebaseFirestore.Timestamp

const eventRef   = (id: string) => adminDb.collection('events').doc(id)
const licenceRef = (id: string) => adminDb.collection(EVENT_LICENSES_COLLECTION).doc(id)

// ─── Which live document is this? ──────────────────────────────────────────────

/**
 * RD-EVENT-COMMERCE-01 · D1 — resolve the id a caller sent to the live event's SLUG.
 *
 * The organizer dashboard is keyed by the DRAFT id (`/dashboard/events/{draftId}`), while the
 * live event and its licence live at `events/{slug}` / `eventLicenses/{slug}` — and the slug is
 * almost never the draft id. Every capacity route used the id verbatim, so for essentially every
 * published event the quote and the order answered "Event not found" and capacity could not be
 * changed from the dashboard at all.
 *
 * A draft id is resolved through the SAME reverse-pointer-checked lookup that save-changes and
 * /edit use (`resolveLiveEventRef`), so a stale or foreign slug is refused, never written to. An
 * id that is not one of this organizer's drafts is taken to already BE a slug (existing callers
 * and orders use slugs); ownership of whatever it names is still enforced downstream by the
 * `ev.uid === organizerUid` check in every loader.
 */
export async function resolveCapacityEventSlug(
  eventId: string,
  organizerUid: string,
): Promise<{ ok: true; slug: string } | { ok: false; code: 'EVENT_NOT_FOUND'; message: string }> {
  const draftSnap = await adminDb.doc(`users/${organizerUid}/eventDrafts/${eventId}`).get()
  if (!draftSnap.exists) return { ok: true, slug: eventId }
  const live = await resolveLiveEventRef(eventId, (draftSnap.data() ?? {}) as Record<string, unknown>, organizerUid)
  if (!live.ok) return { ok: false, code: 'EVENT_NOT_FOUND', message: liveEventLookupMessage(live) }
  return { ok: true, slug: live.slug }
}

// ─── RD-EVENT-COMMERCE-03 · lifecycle and sold-count guards ─────────────────────

/**
 * Lifecycle states in which a capacity (or service) purchase may be made for a live event.
 * A cancelled, archived, completed, rejected or unpublished event cannot buy anything: nothing
 * could use it, and money taken for it would have to be refunded. Events written before
 * lifecycle tracking carry no `lifecycleStatus`; they are live by construction and stay eligible.
 */
export const PURCHASE_ELIGIBLE_LIFECYCLES = ['published', 'pending_review'] as const
export function isPurchaseEligibleLifecycle(ev: Record<string, unknown> | undefined): boolean {
  const s = ev?.lifecycleStatus
  return s === undefined || s === null || (PURCHASE_ELIGIBLE_LIFECYCLES as readonly string[]).includes(String(s))
}

const counterRef = (slug: string) => adminDb.collection('registrationCounters').doc(slug)

/** Registrations already taken — the floor a capacity may never be reduced below. */
export function soldFromCounter(data: Record<string, unknown> | undefined): number {
  const n = data?.totalCount
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
}

/** Read-only: the sold count for a live event. */
export async function readSoldCount(slug: string): Promise<number> {
  const snap = await counterRef(slug).get()
  return soldFromCounter(snap.exists ? snap.data() as Record<string, unknown> : undefined)
}

// ─── Reading the current, enforced capacity ────────────────────────────────────

/**
 * The capacity a change is measured FROM: the event's own enforced value, read through the
 * same legacy-aware derivation the registration gate uses.
 *
 * Reading the EVENT rather than the licence is deliberate, and it is what makes
 * grandfathering work: a pre-migration event has no capacity on its licence document, but
 * it does have an enforced `totalCapacity` (or a legacy `capacityPlan` to derive one from).
 * Measuring from the enforced value means such an event can be increased or decreased
 * without first back-filling or rewriting its licence — nothing destructive is required to
 * bring an old event into the new model.
 */
export function currentCapacityFromEvent(eventData: Record<string, unknown> | undefined): number | null {
  if (!eventData) return null
  return deriveStoredEventCapacity(eventData as Parameters<typeof deriveStoredEventCapacity>[0])
}

export interface CapacityChangeContext {
  eventId:         string
  organizerUid:    string
  currentCapacity: number
  terms:           CommercialTerms
  /** The next sequence number a change order would take. */
  nextSeq:         number
}

export type CapacityChangeFailure =
  | 'EVENT_NOT_FOUND'
  | 'FORBIDDEN'
  | 'UNLIMITED_CAPACITY'          // an uncapped event has no delta to price
  | 'INVALID_CAPACITY'
  | 'STALE_CAPACITY'
  | 'INSUFFICIENT_WALLET'
  | 'ALREADY_APPLIED'
  | 'BELOW_SOLD'                  // RD-EVENT-COMMERCE-03 — would drop below registrations already taken
  | 'LIFECYCLE_INELIGIBLE'        // RD-EVENT-COMMERCE-03 — cancelled / archived / completed / rejected

/**
 * Load everything a quote needs, with ownership enforced. READ-ONLY.
 *
 * Ownership is checked here against the EVENT's `uid`, not inferred from anything the
 * caller sent — the route's workspace permission says the caller may manage events, this
 * says they may manage THIS one.
 */
export async function loadCapacityChangeContext(
  eventId: string,
  organizerUid: string,
): Promise<{ ok: true; ctx: CapacityChangeContext } | { ok: false; code: CapacityChangeFailure; message: string }> {
  const [evSnap, licSnap, globalTerms] = await Promise.all([
    eventRef(eventId).get(),
    licenceRef(eventId).get(),
    getGlobalCommercialTerms(),
  ])
  if (!evSnap.exists) return { ok: false, code: 'EVENT_NOT_FOUND', message: 'Event not found.' }

  const ev = evSnap.data() as Record<string, unknown>
  if (ev.uid !== organizerUid) return { ok: false, code: 'FORBIDDEN', message: 'You do not manage this event.' }

  const currentCapacity = currentCapacityFromEvent(ev)
  if (currentCapacity === null) {
    return {
      ok: false, code: 'UNLIMITED_CAPACITY',
      message: 'This event has unlimited registration capacity, so there is no capacity to change.',
    }
  }

  const lic = licSnap.exists ? licSnap.data() as { capacityOpSeq?: unknown } : null
  const seq = typeof lic?.capacityOpSeq === 'number' && Number.isInteger(lic.capacityOpSeq) ? lic.capacityOpSeq : 0

  return {
    ok: true,
    ctx: {
      eventId, organizerUid, currentCapacity,
      // The EVENT's own terms win, so an event activated under an older rate keeps being
      // measured against that rate when it changes capacity.
      terms:   resolveEventCommercialTerms(ev.commercial, globalTerms),
      nextSeq: seq + 1,
    },
  }
}

// ─── Creating the priced order ─────────────────────────────────────────────────

export interface CreateCapacityChangeOrderResult {
  orderId:             string
  quote:               CapacityQuote
  snapshot:            CapacityChargeSnapshot
  /** The amount the Razorpay order must be created for — always the WHOLE total. */
  razorpayAmountPaise: number
  /** RD-L6 D1 — `reuse` mode only: an identical pending order was returned instead of a new one. */
  reused?:             boolean
  /** RD-L6 D1 — set when `reused`: that order's existing Razorpay order (never a second one). */
  razorpayOrderId?:    string
}

/**
 * RD-L6 D1 — a `created` capacity order with no Razorpay order id is "starting" (its creator is still
 * between the order transaction and the Razorpay call) for this long. Younger ⇒ a request is told to
 * retry, never given a competing order. Older ⇒ the Razorpay step failed (no checkout was ever handed
 * out), so the order may be marked abandoned — inside the transaction that replaces it.
 */
export const CAPACITY_ORDER_STARTING_WINDOW_MS = 10 * 60 * 1000

/** RD-L6 D1 — why `reuse` mode refused to create: the event already has a pending capacity order. */
export interface PendingCapacityOrder {
  orderId:             string
  razorpayOrderId:     string | null
  razorpayAmountPaise: number
  /** The pending order is exactly what this request would create. */
  identical:           boolean
}

/** Same number of each service kind (the pricing itself is compared through the whole amount). */
export function sameServiceSelection(items: ServiceChargeItem[] | undefined, wanted: ServiceChargeItem[]): boolean {
  return SERVICE_KINDS.every(k => (items ?? []).filter(i => i.service === k).reduce((n, i) => n + i.quantity, 0)
    === wanted.filter(i => i.service === k).reduce((n, i) => n + i.quantity, 0))
}

const millisOf = (t: unknown): number | null =>
  t && typeof (t as { toMillis?: unknown }).toMillis === 'function' ? (t as { toMillis(): number }).toMillis() : null

/**
 * Create the order for a capacity change, re-quoting INSIDE the transaction.
 *
 * The quote the organizer was shown is not passed in and is not trusted: `newCapacity` is
 * the only input, and the amount is derived here from the capacity read in this very
 * transaction. Two concurrent changes therefore cannot both price against the same stale
 * capacity — the second one re-runs and sees the first one's sequence number.
 *
 * Creates no Razorpay order; the caller does that for `razorpayAmountPaise` (the whole
 * total) and stamps the id.
 */
export async function createCapacityChangeOrder(input: {
  eventId:      string
  organizerUid: string
  newCapacity:  unknown
  /**
   * RD-EVENT-COMMERCE-03 — prepaid service lines bought in the SAME payment as this capacity
   * change (priced and validated by the caller from the Business Configuration catalog). They
   * are settled — applied to the event's allowance ledger — by applyCapacityChange, atomically
   * with the capacity move. Absent ⇒ a plain capacity change, exactly as before.
   */
  serviceItems?: ServiceChargeItem[]
  /** The event's draft id — the allowance ledger key. Required when serviceItems are present. */
  draftId?:      string
  /**
   * RD-L6 D1 — enforce "at most one payable capacity order per event" INSIDE this transaction (the
   * one that claims the sequence number): the latest order (`cap_{event}_{capacityOpSeq}`) is read
   * here and, while it is a pending `created` order without a hold, no second order is minted —
   * an identical one is REUSED, a different one is reported as ORDER_PENDING (the caller runs the
   * M3 capture lookup + M4 supersede, then asks again), and one still "starting" (no Razorpay id,
   * younger than CAPACITY_ORDER_STARTING_WINDOW_MS) is ORDER_STARTING. Off ⇒ unchanged behaviour.
   */
  reuse?:        boolean
}): Promise<
  | { ok: true;  result: CreateCapacityChangeOrderResult }
  | { ok: false; code: CapacityChangeFailure | 'QUOTE_REJECTED'; message: string }
  | { ok: false; code: 'ORDER_STARTING' | 'ORDER_PENDING'; message: string; pending: PendingCapacityOrder }
> {
  const { eventId, organizerUid } = input

  const globalTerms = await getGlobalCommercialTerms()

  type Outcome =
    | { kind: 'ok'; result: CreateCapacityChangeOrderResult }
    | { kind: 'fail'; code: CapacityChangeFailure | 'QUOTE_REJECTED'; message: string }
    | { kind: 'pending'; code: 'ORDER_STARTING' | 'ORDER_PENDING'; message: string; pending: PendingCapacityOrder }

  const outcome = await adminDb.runTransaction<Outcome>(async (txn) => {
    const evSnap  = await txn.get(eventRef(eventId))
    const licSnap = await txn.get(licenceRef(eventId))
    const ctrSnap = await txn.get(counterRef(eventId))
    // RD-L6 D1 — the latest capacity order, read in THIS transaction (reads before any write).
    const curSeq = (() => { const v = licSnap.exists ? (licSnap.data() as { capacityOpSeq?: unknown }).capacityOpSeq : undefined
      return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : 0 })()
    const latestRef  = curSeq > 0 ? adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(capacityOrderDocId(eventId, curSeq)) : null
    const latestSnap = input.reuse && latestRef ? await txn.get(latestRef) : null
    if (!evSnap.exists) return { kind: 'fail', code: 'EVENT_NOT_FOUND', message: 'Event not found.' }

    const ev = evSnap.data() as Record<string, unknown>
    if (ev.uid !== organizerUid) return { kind: 'fail', code: 'FORBIDDEN', message: 'You do not manage this event.' }
    if (!isPurchaseEligibleLifecycle(ev)) {
      return { kind: 'fail', code: 'LIFECYCLE_INELIGIBLE', message: 'This event is no longer live, so its capacity cannot be changed.' }
    }

    const currentCapacity = currentCapacityFromEvent(ev)
    if (currentCapacity === null) {
      return { kind: 'fail', code: 'UNLIMITED_CAPACITY', message: 'This event has unlimited registration capacity.' }
    }

    const terms  = resolveEventCommercialTerms(ev.commercial, globalTerms)
    const quoted = quoteCapacityChange({ currentCapacity, newCapacity: input.newCapacity, terms })
    if (!quoted.ok) return { kind: 'fail', code: 'QUOTE_REJECTED', message: quoted.message }

    const quote = quoted.quote
    const snapshot = capacityChargeSnapshot(quote)

    // RD-EVENT-COMMERCE-03 — never below the registrations already taken. Read in THIS
    // transaction, so a registration landing concurrently makes the loser re-run.
    const sold = soldFromCounter(ctrSnap.exists ? ctrSnap.data() as Record<string, unknown> : undefined)
    if (quote.capacity < sold) {
      return { kind: 'fail', code: 'BELOW_SOLD', message: `${sold.toLocaleString('en-IN')} registrations are already taken, so capacity cannot go below ${sold.toLocaleString('en-IN')}.` }
    }

    const serviceItems = (input.serviceItems ?? []).filter(i => i.quantity > 0)
    const servicesTotal = sumServiceItems(serviceItems)
    if (serviceItems.length > 0 && !input.draftId) {
      return { kind: 'fail', code: 'QUOTE_REJECTED', message: 'Service lines need the event’s draft id.' }
    }

    // ── RD-L6 D1 · at most ONE payable capacity order per event ─────────────────
    const latest = latestSnap?.exists ? latestSnap.data() as Partial<LicenseOrderDoc> & { manualRefundHoldId?: unknown } : null
    const nothingToBuy = quote.kind === 'unchanged' && serviceItems.length === 0
    if (latestRef && latest && !nothingToBuy && latest.status === 'created' && latest.manualRefundHoldId == null
        && isCapacityChangePurpose(latest.purpose)) {
      const pendingRzp = typeof latest.razorpayOrderId === 'string' && latest.razorpayOrderId ? latest.razorpayOrderId : null
      const pendingAmount = Math.max(0, latest.razorpayAmountPaise ?? 0)
      const pc = latest.capacityChange
      const identical = latest.organizerUid === organizerUid && latest.eventId === eventId && !!pc
        && pc.capacity === quote.capacity && pc.previousCapacity === currentCapacity && pc.totalPaise === quote.totalPaise
        && sameServiceSelection(latest.serviceItems, serviceItems) && pendingAmount === quote.totalPaise + servicesTotal
        && (serviceItems.length === 0 || latest.allowanceDraftId === input.draftId)
      const pending: PendingCapacityOrder = { orderId: latestRef.id, razorpayOrderId: pendingRzp, razorpayAmountPaise: pendingAmount, identical }
      if (!pendingRzp) {
        const created = millisOf(latest.createdAt)
        if (created !== null && Date.now() - created < CAPACITY_ORDER_STARTING_WINDOW_MS) {
          return { kind: 'pending', code: 'ORDER_STARTING', message: 'A checkout for this event is still being prepared. Please try again in a moment.', pending }
        }
        // Old enough: its Razorpay step failed and no checkout was ever handed out. Abandoned HERE,
        // in the transaction that re-read it (still created, unheld, no Razorpay id) — then replaced.
        txn.set(latestRef, { status: 'failed', failReason: 'abandoned', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      } else if (identical) {
        return { kind: 'ok', result: { orderId: latestRef.id, quote, snapshot: pc!, razorpayAmountPaise: pendingAmount, reused: true, razorpayOrderId: pendingRzp } }
      } else {
        return { kind: 'pending', code: 'ORDER_PENDING', message: 'A payment for this event is already being processed. Refresh the status in a moment.', pending }
      }
    }

    // An unchanged capacity, or a change that costs nothing, needs no order at all — the
    // caller applies it directly. Creating a ₹0 order would leave an unpayable document.
    // (A change WITH paid service lines always needs an order.)
    if (quote.kind === 'unchanged' || (!quote.paymentRequired && servicesTotal === 0)) {
      return {
        kind: 'ok',
        result: { orderId: '', quote, snapshot, razorpayAmountPaise: 0 },
      }
    }

    const lic = licSnap.exists ? licSnap.data() as { capacityOpSeq?: unknown } : null
    const seq = (typeof lic?.capacityOpSeq === 'number' && Number.isInteger(lic.capacityOpSeq) ? lic.capacityOpSeq : 0) + 1
    const orderId = capacityOrderDocId(eventId, seq)

    // Razorpay collects the WHOLE amount — never a share (RD-LICENSE-PAYMENT-01) — for the
    // capacity change AND any service lines bought with it.
    const razorpayAmountPaise = quote.totalPaise + servicesTotal

    const order: LicenseOrderDoc = {
      orderId,
      eventId,
      organizerUid,
      // No tier is involved. The version's free tier is stamped so every historical reader
      // and the schema validator keep working; `commercialModel` is what says how this
      // order was actually priced, and tier-based reporting excludes it.
      tier:                defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION),
      fromTier:            null,
      purpose:             quote.kind === 'increase' ? 'capacity_increase' : 'capacity_decrease',
      amountPaise:         razorpayAmountPaise,
      currency:            'INR',
      status:              'created',
      razorpayOrderId:     null,
      razorpayPaymentId:   null,
      razorpayAmountPaise,
      eventSlug:           eventId,
      commercialModel:     'capacity',
      capacityChange:      snapshot,
      capacityOpSeq:       seq,
      ...(serviceItems.length > 0 ? {
        serviceItems, servicesTotalPaise: servicesTotal, allowanceDraftId: input.draftId,
      } : {}),
      createdAt:           now(),
      updatedAt:           now(),
      paidAt:              null,
    }
    txn.set(adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId), order)

    // Claiming the sequence number in THIS transaction is what serialises concurrent
    // changes: the second racer contends on this licence document and re-runs.
    txn.set(licenceRef(eventId), { capacityOpSeq: seq, updatedAt: now() }, { merge: true })

    return { kind: 'ok', result: { orderId, quote, snapshot, razorpayAmountPaise } }
  })

  if (outcome.kind === 'ok') return { ok: true, result: outcome.result }
  if (outcome.kind === 'pending') return { ok: false, code: outcome.code, message: outcome.message, pending: outcome.pending }
  return { ok: false, code: outcome.code, message: outcome.message }
}

/**
 * RD-L6 D1 — stamp the Razorpay order id onto a NEW capacity order, only while it is still exactly
 * what was created: `created`, unheld, with no Razorpay id yet. If it was abandoned or replaced in
 * the meantime, nothing is written and `false` comes back — the caller must NOT hand out a checkout.
 */
export async function attachCapacityRazorpayOrder(orderId: string, razorpayOrderId: string): Promise<boolean> {
  const ref = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId)
  return adminDb.runTransaction(async txn => {
    const cur = await txn.get(ref)
    const c = cur.exists ? cur.data() as Record<string, unknown> : undefined
    if (!c || c.status !== 'created' || c.manualRefundHoldId != null || (c.razorpayOrderId != null && c.razorpayOrderId !== '')) return false
    txn.set(ref, { razorpayOrderId, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return true
  })
}

/**
 * RD-M4 D2 (moved here by RD-L6 so both capacity routes share it) — supersede ONLY if the order is
 * still exactly what was checked: re-read inside a transaction, and mark it superseded only while it
 * is `created`, unheld and on the same Razorpay order. A confirm / webhook that settled it meanwhile
 * (now `paid`) must never be flipped to "superseded".
 */
export async function supersedeCapacityOrder(orderId: string, razorpayOrderId: string | null): Promise<boolean> {
  const ref = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId)
  return adminDb.runTransaction(async txn => {
    const cur = await txn.get(ref)
    const c = cur.exists ? cur.data() as Record<string, unknown> : undefined
    if (!c || c.status !== 'created' || c.manualRefundHoldId != null || c.razorpayOrderId !== razorpayOrderId) return false
    txn.set(ref, { status: 'failed', failReason: 'superseded', updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    return true
  })
}

// ─── Applying the change ───────────────────────────────────────────────────────

// RD-F1 — 'ineligible': the order is not in a grantable state (failed — superseded or on a refund
// hold —, refunded, or any unknown status). Nothing is written; it can never become grantable.
// RD-L6 D3 — 'lifecycle_ineligible': the event is no longer live (cancelled / archived / completed …); the
// order is made terminal in the apply transaction and the caller holds the captured payment.
export type CapacityApplyKind = 'ok' | 'already' | 'stale' | 'underpaid' | 'not_found' | 'ineligible' | 'lifecycle_ineligible'

export interface ApplyCapacityChangeResult {
  kind:                CapacityApplyKind
  razorpayAmountPaise: number
  totalPaise:          number
  newCapacity:         number | null
}

/**
 * Apply a paid capacity change: flip the order to `paid`, move the event's enforced
 * capacity and the licence's record of it, and append history — all in ONE transaction.
 * The Razorpay payment is verified by the CALLER; no wallet of any kind is touched.
 *
 * Refuses an UNDERPAID order — one whose Razorpay amount is not its whole total (created
 * before RD-LICENSE-PAYMENT-01 with a planned communication-wallet share). The shortfall
 * is never taken from a wallet and never waived.
 *
 * Idempotent: an order already `paid` returns `already` and writes nothing, so a webhook
 * replay, a double-clicked confirm and a retried request all settle exactly once.
 *
 * Refuses a STALE order: if the event's capacity is no longer what the order was priced
 * against, the delta this order paid for is not the delta that would now be applied, so
 * applying it would either sell unpaid capacity or silently discard paid capacity. The
 * caller refunds instead.
 */
export async function applyCapacityChange(input: {
  eventId:           string
  organizerUid:      string
  orderId:           string
  razorpayOrderId:   string | null
  razorpayPaymentId: string | null
}): Promise<ApplyCapacityChangeResult> {
  const { eventId, organizerUid, orderId } = input
  const orderRef = adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId).withConverter(licenseOrderConverter)

  return adminDb.runTransaction<ApplyCapacityChangeResult>(async (txn) => {
    // READS first (Firestore requirement).
    const [orderSnap, evSnap, ctrSnap] = await Promise.all([txn.get(orderRef), txn.get(eventRef(eventId)), txn.get(counterRef(eventId))])
    if (!orderSnap.exists) return { kind: 'not_found', razorpayAmountPaise: 0, totalPaise: 0, newCapacity: null }

    const order = orderSnap.data() as LicenseOrderDoc & { allowanceDraftId?: string }
    const snap  = order.capacityChange
    // RD-EVENT-COMMERCE-03 — the whole order: the capacity change plus any service lines.
    const serviceItems = order.serviceItems ?? []
    const total = (snap?.totalPaise ?? order.amountPaise) + (snap ? sumServiceItems(serviceItems) : 0)
    const ledgerSnap = serviceItems.length > 0 && order.allowanceDraftId ? await txn.get(ledgerRef(order.allowanceDraftId)) : null
    const razorpayAmountPaise = Math.max(0, order.razorpayAmountPaise ?? 0)

    if (order.status === 'paid') {
      return { kind: 'already', razorpayAmountPaise, totalPaise: total, newCapacity: snap?.capacity ?? null }
    }
    // RD-F1 — ONLY a `created` order with no refund hold may grant capacity. A failed (superseded /
    // stale / held), refunded or unknown-status order is refused HERE, inside the transaction, so no
    // retry, webhook or later capacity change can revive it — even if the event's capacity comes back
    // to the value the order was priced against.
    if (order.status !== 'created' || (order as { manualRefundHoldId?: unknown }).manualRefundHoldId != null) {
      return { kind: 'ineligible', razorpayAmountPaise, totalPaise: total, newCapacity: snap?.capacity ?? null }
    }
    if (!snap || !evSnap.exists) {
      return { kind: 'not_found', razorpayAmountPaise, totalPaise: total, newCapacity: null }
    }
    // Razorpay must have been asked for the WHOLE total (RD-LICENSE-PAYMENT-01).
    if (razorpayAmountPaise !== total) {
      return { kind: 'underpaid', razorpayAmountPaise, totalPaise: total, newCapacity: snap.capacity }
    }
    if (!serviceItems.every(isConsistentServiceItem) || (serviceItems.length > 0 && !ledgerSnap)) {
      return { kind: 'underpaid', razorpayAmountPaise, totalPaise: total, newCapacity: snap.capacity }
    }

    // ── The concurrency guard ──────────────────────────────────────────────────
    // Re-read the capacity the order was priced against, in this transaction, and insist
    // it is unchanged. Two increases that both quoted from 500 cannot both apply: the
    // second finds 1,000 and is rejected.
    const ev = evSnap.data() as Record<string, unknown>
    // RD-F1 — a stale order is TERMINAL: it is marked failed in THIS transaction (the caller then
    // records the manual-refund hold, which also marks it). So even if that hold write fails, the
    // order can never be applied later.
    const markStale = (failReason: 'capacity_stale' | 'lifecycle_ineligible' = 'capacity_stale') =>
      txn.set(adminDb.collection(LICENSE_ORDERS_COLLECTION).doc(orderId), {
        status: 'failed', failReason, updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true })
    // RD-L6 D3 — the event must STILL be live when the payment settles (orders are only created for a
    // live event, but it can be cancelled / archived / completed before the capture lands). Terminal,
    // atomically with every other check; nothing else is written. The caller holds the payment.
    if (!isPurchaseEligibleLifecycle(ev)) {
      markStale('lifecycle_ineligible')
      return { kind: 'lifecycle_ineligible', razorpayAmountPaise, totalPaise: total, newCapacity: snap.capacity }
    }
    if (currentCapacityFromEvent(ev) !== snap.previousCapacity) {
      markStale()
      return { kind: 'stale', razorpayAmountPaise, totalPaise: total, newCapacity: snap.capacity }
    }
    // RD-EVENT-COMMERCE-03 — registrations taken since the order was priced may now exceed a
    // reduced capacity. Applying it would leave the event over capacity: refuse as stale.
    if (snap.capacity < soldFromCounter(ctrSnap.exists ? ctrSnap.data() as Record<string, unknown> : undefined)) {
      markStale()
      return { kind: 'stale', razorpayAmountPaise, totalPaise: total, newCapacity: snap.capacity }
    }
    // RD-PHOTO-01 — photo units on this order may never take the event above 3,000 photos (a
    // concurrent photo purchase settled first). Refused as stale: nothing is applied and the caller
    // holds the payment for a manual refund decision, exactly as for a capacity that moved.
    const mediaAdding = mediaUnitsIn(serviceItems)
    if (mediaAdding > 0 && ledgerSnap) {
      const l = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
      if (!checkPhotoPurchase(paidPhotoCapacity(l?.media), mediaAdding).ok) {
        markStale()
        return { kind: 'stale', razorpayAmountPaise, totalPaise: total, newCapacity: snap.capacity }
      }
    }

    // ── WRITES ────────────────────────────────────────────────────────────────

    txn.set(orderRef, {
      status:            'paid',
      razorpayOrderId:   input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      paidAt:            now(),
      updatedAt:         now(),
    } as Partial<LicenseOrderDoc>, { merge: true })

    // `totalCapacity` is the SINGLE enforced value — the registration gate and the counter
    // transaction both read it — so it moves here, atomically with the payment. The legacy
    // `capacityPlan` is deliberately NOT rewritten: it exists only as a fallback for
    // documents that have no `totalCapacity`, and this document plainly has one.
    // The alert high-water mark is cleared in the SAME write as the capacity. The sweep
    // would re-arm anyway (its stored state is capacity-stamped, so a mismatch resets it),
    // but clearing here means an organizer who buys more capacity is eligible for warnings
    // immediately rather than after the next sweep notices the stamp is stale.
    txn.set(eventRef(eventId), {
      totalCapacity:          snap.capacity,
      [CAPACITY_ALERT_FIELD]: FieldValue.delete(),
      updatedAt:              FieldValue.serverTimestamp(),
    }, { merge: true })

    txn.set(licenceRef(eventId), {
      commercialModel: 'capacity',
      capacity:        snap.capacity,
      updatedAt:       now(),
    }, { merge: true })

    const historyRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc()
    const history: LicenseHistoryDoc = {
      id:           historyRef.id,
      eventId,
      organizerUid,
      action:       snap.operation === 'increase' ? 'capacity_increased' : 'capacity_decreased',
      fromTier:     null,
      toTier:       order.tier,
      source:       'self_serve',
      orderId,
      actorUid:     organizerUid,
      note:         `Capacity ${snap.previousCapacity} → ${snap.capacity} · charged ${snap.totalPaise} paise (base ${snap.basePaise} + GST ${snap.gstPaise})`,
      // The pricing record itself, so the trail explains the amount without a join.
      before:       { capacity: snap.previousCapacity },
      after:        snap,
      createdAt:    now(),
    }
    txn.set(historyRef, history)

    // RD-EVENT-COMMERCE-03 — service lines bought with this change, applied exactly once, in
    // the same transaction as the payment is recorded.
    if (ledgerSnap && order.allowanceDraftId) {
      txnApplyServiceItems(txn, ledgerSnap, { draftId: order.allowanceDraftId, organizerUid, orderId, items: serviceItems })
    }

    return { kind: 'ok', razorpayAmountPaise, totalPaise: total, newCapacity: snap.capacity }
  })
}

/**
 * A capacity order that could not be applied (its capacity moved underneath it, or the sold
 * floor / lifecycle refused it) holds a captured amount for a change RegisterDesk refused.
 *
 * RD-EVENT-COMMERCE-04B — NO AUTOMATIC REFUND (confirmed business rule). This used to call the
 * gateway from the webhook and the capacity confirm route; it now records a MANUAL-REFUND HOLD
 * through the same `recordManualRefundHold` as the coupon path — one deterministic
 * `failedRefunds/license_hold_{orderId}` record (`status: 'open'`) plus the order marked
 * failed, in one transaction. A Super Admin refunds or resolves it explicitly from the
 * Failed Refunds queue. An order already refunded under the old behaviour (`staleRefundId`)
 * gets no hold. Moves no money. Never throws.
 */
export async function holdStaleCapacityRemainder(input: {
  orderId:        string
  eventId:        string
  paymentId:      string | null
  remainderPaise: number
  priorRefundId?: string | null
  /** RD-L6 D3 — why the order was refused (default: stale capacity). */
  reason?:        'capacity_stale' | 'lifecycle_ineligible'
}, opts: { rethrow?: boolean } = {}): Promise<void> {
  // RD-F3 — `rethrow`: the webhook needs a failed hold write to surface (non-2xx ⇒ Razorpay retries);
  // every other caller keeps the previous never-throws behaviour.
  const { orderId, eventId, paymentId, remainderPaise } = input
  const reason = input.reason ?? 'capacity_stale'
  if (remainderPaise <= 0 || !paymentId || input.priorRefundId != null) return
  try {
    await recordManualRefundHold({
      orderDocId: orderId, razorpayOrderId: null, paymentId, amountPaise: remainderPaise, eventId,
      reason, source: 'license_capacity', failReason: reason,
    })
  } catch (err) {
    captureFinancialError(err, { scope: `license.${reason}_hold`, eventId, orderId, paymentId, amount: remainderPaise })
    if (opts.rethrow) throw err
  }
}

/**
 * Apply a capacity change that costs nothing (an unchanged capacity, or a change that
 * prices to ₹0 because it stays inside the free allowance). No order and no payment are
 * involved, but the capacity write and the audit entry still happen together, and the
 * same staleness guard applies.
 */
export async function applyFreeCapacityChange(input: {
  eventId:      string
  organizerUid: string
  snapshot:     CapacityChargeSnapshot
}): Promise<CapacityApplyKind> {
  const { eventId, organizerUid, snapshot } = input
  if (snapshot.totalPaise !== 0) return 'stale'   // never a free path for a real charge

  return adminDb.runTransaction<CapacityApplyKind>(async (txn) => {
    const [evSnap, ctrSnap] = await Promise.all([txn.get(eventRef(eventId)), txn.get(counterRef(eventId))])
    if (!evSnap.exists) return 'not_found'
    const ev = evSnap.data() as Record<string, unknown>
    if (ev.uid !== organizerUid) return 'not_found'
    if (currentCapacityFromEvent(ev) !== snapshot.previousCapacity) return 'stale'
    // RD-EVENT-COMMERCE-03 — never below registrations already taken.
    if (snapshot.capacity < soldFromCounter(ctrSnap.exists ? ctrSnap.data() as Record<string, unknown> : undefined)) return 'stale'
    if (snapshot.operation === 'unchanged') return 'already'

    txn.set(eventRef(eventId), {
      totalCapacity:          snapshot.capacity,
      [CAPACITY_ALERT_FIELD]: FieldValue.delete(),
      updatedAt:              FieldValue.serverTimestamp(),
    }, { merge: true })
    txn.set(licenceRef(eventId), { commercialModel: 'capacity', capacity: snapshot.capacity, updatedAt: now() }, { merge: true })

    const historyRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc()
    txn.set(historyRef, {
      id:           historyRef.id,
      eventId,
      organizerUid,
      action:       snapshot.operation === 'increase' ? 'capacity_increased' : 'capacity_decreased',
      fromTier:     null,
      toTier:       defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION),
      source:       'self_serve',
      orderId:      null,
      actorUid:     organizerUid,
      note:         `Capacity ${snapshot.previousCapacity} → ${snapshot.capacity} · no charge`,
      before:       { capacity: snapshot.previousCapacity },
      after:        snapshot,
      createdAt:    now(),
    } as LicenseHistoryDoc)

    return 'ok'
  })
}

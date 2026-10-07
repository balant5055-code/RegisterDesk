// lib/wallet/serviceRequests.ts
// RD-WALLET-REQ — the event-wise Wallet's server side: each service's state for one event, organizer
// refund / carry-forward requests for unused units, and the Super Admin decisions on them.
// Server-only. The rules and the valuation are documented in lib/wallet/serviceRequestRules.ts.
//
// RECORDS (all pre-existing — nothing here is a parallel ledger or balance)
//   walletServiceRequests/{id}   the request: kind, status, server-derived quantity, cap + the lines
//                                it was valued from, history, decision, external reference.
//   eventServiceAllowances/{id}  the canonical allowance ledger (WhatsApp, certificates, photos). An
//                                approval changes it in the same transaction as the request + audit:
//                                  refund        source.refunded   += quantity
//                                  carry-forward source.carriedOut += quantity, destination.carriedIn += quantity
//   events/{slug}.totalCapacity  the enforced registration capacity (+ its eventLicenses mirror): an
//                                approved CAPACITY refund lowers it by the refunded units, in the same
//                                transaction, never below registrations taken or the free allowance.
//   `purchased` / `consumed` and every order are never touched, and no money moves.
//
// SAFETY
//   • Everything is derived from the workspace's own records; the organizer submits only the event,
//     the service(s), the kind, the destination (its own event) and a note.
//   • One undecided request per (event, service): a lock document, created in the submit transaction.
//   • Submission and approval both rebuild the service state from the records INSIDE their
//     transaction and refuse (409) if the units or the cap changed.
//   • A repeated decision on a request already in that state changes nothing (`already: true`).

import { AggregateField, FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { stageAdminAudit } from '@/lib/admin/audit'
import type { AdminAuditAction } from '@/lib/admin/auditConstants'
import { LICENSE_ORDERS_COLLECTION, EVENT_LICENSES_COLLECTION } from '@/lib/licensing/schema'
import {
  ledgerRef, ledgerLine, availableUnits, ALLOWANCE_USAGE_SUBCOLLECTION, type ServiceLedgerDoc,
} from '@/lib/licensing/serviceAllowanceLedger'
import type { ServiceChargeItem } from '@/lib/licensing/serviceAllowances'
import { retainedServiceLines } from '@/lib/licensing/allowanceReconciliation'
import type { CapacityChargeSnapshot } from '@/lib/licensing/schema'
import { currentCapacityFromEvent, soldFromCounter } from '@/lib/licensing/capacityChange'
import { photoCapacityUsageQuery } from '@/features/media-studio/repositories/assetRepo'
import { txnReadPhotoCapacity, txnTouchPhotoLock } from '@/features/media-studio/services/photoCapacityGate'
import { checkPhotoPurchase, paidPhotoCapacity } from '@/lib/licensing/photoCapacity'
import { draftFacts, type DraftFacts } from './eventWalletService'
import { effectiveLifecycleStatus } from '@/lib/events/listingTabs'
import { liveEventBelongsTo } from '@/lib/events/liveEventRef'
import {
  SERVICE_REQUESTS_COLLECTION, REQUESTABLE_SERVICES, isLedgerService,
  requestEligibility, valueUnits, destinationProblem, decisionTransition, targetStatus,
  isClosedLifecycle, eventClosedAtMs, refundDeadlineMs, withinRefundWindow, refundWindowSnapshot, refundedAmountProblem,
  type RefundWindowSnapshot, type CapacityRefundRecord,
  type RequestableService, type LedgerService, type ServiceRequestKind, type ServiceRequestStatus, type ServiceRequestAction,
  type ServiceRequestView, type ServiceRequestHistoryEntry, type EventRequestsView, type EventServiceView,
  type ServiceState, type PurchaseLot, type ValuationPart, type Eligibility,
} from './serviceRequestRules'

type Rec = Record<string, unknown>
const col = () => adminDb.collection(SERVICE_REQUESTS_COLLECTION)
/**
 * One lock document per (event, service) names its undecided request. Two concurrent submits both
 * read it inside their transactions, so one of them retries, sees the lock and is refused — a query
 * alone could not guarantee that. Cleared when the request is decided.
 */
const lockRef = (draftId: string, service: RequestableService) =>
  adminDb.collection(`${SERVICE_REQUESTS_COLLECTION}Locks`).doc(`${draftId}__${service}`)
const draftRef = (uid: string, draftId: string) => adminDb.doc(`users/${uid}/eventDrafts/${draftId}`)
const ID = /^[A-Za-z0-9_-]{1,128}$/
export const isRequestId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const isoOf = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null
const tsMs = (v: unknown): number | null =>
  v && typeof (v as { toMillis?: () => number }).toMillis === 'function' ? (v as { toMillis: () => number }).toMillis() : null
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const int = (v: unknown) => Math.max(0, Math.trunc(num(v)))

export class ServiceRequestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message) }
}

/** The request document as stored. */
interface RequestDoc {
  kind: ServiceRequestKind; status: ServiceRequestStatus
  organizerUid: string; submittedBy: string
  service: RequestableService; quantity: number
  sourceDraftId: string; sourceName: string; sourceSlug?: string | null
  destinationDraftId: string | null; destinationName: string | null
  groupId?: string | null
  refundUpperBoundPaise: number | null; valuation?: ValuationPart[]
  approvedAmountPaise: number | null; externalReference: string | null
  organizerNote: string
  history: ServiceRequestHistoryEntry[]
  decision?: { action: 'approved' | 'rejected'; by: string; reason: string; at: unknown }
  processed?: { by: string; reason: string; externalReference: string; at: unknown; refundedAmountPaise?: number }
  /** S1 — refunds only, written once at submission. Absent on older requests. */
  window?: RefundWindowSnapshot
  /** S2 — written once when the refund is recorded. Absent until then (and on older processed requests). */
  refundedAmountPaise?: number | null
  /** S4 — registration-capacity refunds, written once in the approval transaction. */
  capacity?: CapacityRefundRecord
  createdAt?: unknown; updatedAt?: unknown
}

/**
 * The organizer's copy of a request: the facts about THEIR request (status, amounts, reference,
 * historical window) without Super Admin identities — who decided is shown as "RegisterDesk".
 */
export function toOrganizerView(v: ServiceRequestView): ServiceRequestView {
  return {
    ...v,
    decision: v.decision ? { ...v.decision, by: '' } : v.decision,
    processed: v.processed ? { ...v.processed, by: '' } : v.processed,
    history: v.history.map(h => (h.role === 'super_admin' ? { ...h, by: '' } : h)),
  }
}

export function toView(id: string, d: RequestDoc): ServiceRequestView {
  return {
    id, kind: d.kind, status: d.status, organizerUid: d.organizerUid, service: d.service, quantity: d.quantity,
    source: { draftId: d.sourceDraftId, name: d.sourceName, slug: d.sourceSlug ?? null },
    destination: d.destinationDraftId ? { draftId: d.destinationDraftId, name: d.destinationName ?? 'Event' } : null,
    groupId: d.groupId ?? null,
    refundUpperBoundPaise: d.kind === 'refund' ? d.refundUpperBoundPaise ?? null : null,
    valuation: Array.isArray(d.valuation) ? d.valuation : [],
    approvedAmountPaise: d.approvedAmountPaise ?? null,
    externalReference: d.externalReference ?? null,
    organizerNote: d.organizerNote ?? '',
    createdAt: isoOf(d.createdAt), updatedAt: isoOf(d.updatedAt),
    history: Array.isArray(d.history) ? d.history : [],
    // RD-INTEG — who decided and who recorded the money movement, as structured fields (the
    // history carries the same facts as prose). Approval is NOT money moved: only `processed` is.
    decision: d.decision ? { action: d.decision.action, by: d.decision.by, reason: d.decision.reason, at: isoOf(d.decision.at) } : null,
    processed: d.processed ? { by: d.processed.by, reason: d.processed.reason, externalReference: d.processed.externalReference, at: isoOf(d.processed.at), refundedAmountPaise: typeof d.processed.refundedAmountPaise === 'number' ? d.processed.refundedAmountPaise : null } : null,
    window: d.window && typeof d.window.submittedAt === 'string' ? d.window : null,
    refundedAmountPaise: typeof d.refundedAmountPaise === 'number' ? d.refundedAmountPaise : null,
    capacity: d.capacity && typeof d.capacity.before === 'number' ? d.capacity : null,
  }
}

// ═══ Reading one event's records (plain reads, or inside a transaction) ═══════════════════════════
type Reader = {
  doc: (ref: FirebaseFirestore.DocumentReference) => Promise<FirebaseFirestore.DocumentSnapshot>
  query: (q: FirebaseFirestore.Query) => Promise<FirebaseFirestore.QuerySnapshot>
}
const plain: Reader = { doc: r => r.get(), query: q => q.get() }
const inTxn = (txn: Transaction): Reader => ({ doc: r => txn.get(r), query: q => txn.get(q) })

const requestsForEventQuery = (draftId: string) => col().where('sourceDraftId', '==', draftId).limit(200)

/** Aggregates are read once before the transaction (the transaction re-checks the rest; a photo
 *  refund also re-counts stored photos inside it — see approve). */
interface Aggregates { usage: Record<'whatsapp' | 'certificates', number | null>; storedPhotos: number | null }

async function usageConsumed(draftId: string, service: 'whatsapp' | 'certificates'): Promise<number | null> {
  try {
    const snap = await ledgerRef(draftId).collection(ALLOWANCE_USAGE_SUBCOLLECTION)
      .where('service', '==', service).aggregate({ q: AggregateField.sum('quantity') }).get()
    return Math.trunc(Number(snap.data().q ?? 0))
  } catch { return null }
}
// RD-PHOTO-01 — the upload gate's own count: photos occupying this event's paid capacity (stored +
// in-flight uploads). The same query the gate re-counts inside its transaction.
const storedPhotosQuery = (uid: string, draftId: string) => photoCapacityUsageQuery(uid, draftId).count()
async function readAggregates(uid: string, draftId: string): Promise<Aggregates> {
  const [wa, cert, stored] = await Promise.all([
    usageConsumed(draftId, 'whatsapp'), usageConsumed(draftId, 'certificates'),
    storedPhotosQuery(uid, draftId).get().then(s => s.data().count).catch(() => null),
  ])
  return { usage: { whatsapp: wa, certificates: cert }, storedPhotos: stored }
}

interface EventRecords {
  uid: string
  draft: DraftFacts & { closedAtMs: number | null }
  /** The live event's slug, only once events/{slug} confirms this organizer AND this draft. */
  slug: string | null
  eventDoc: Rec | null
  licence: Rec | null
  sold: number | null
  ledger: ServiceLedgerDoc | undefined
  ledgerOwnerProblem: boolean
  orders: (Rec & { orderId: string })[]
  requests: (RequestDoc & { id: string })[]
  agg: Aggregates
}

const closedAtOf = (d: Rec) => eventClosedAtMs({
  completedAt: tsMs(d.completedAt), cancelledAt: tsMs(d.cancelledAt), archivedAt: tsMs(d.archivedAt), restoredAt: tsMs(d.restoredAt),
})

async function readRecords(rd: Reader, uid: string, draftId: string, agg: Aggregates): Promise<EventRecords | null> {
  if (!ID.test(draftId)) return null
  const dSnap = await rd.doc(draftRef(uid, draftId))
  if (!dSnap.exists) return null
  const d = dSnap.data() as Rec
  const facts = draftFacts(dSnap.id, d)
  const claimed = facts.claimedSlug && ID.test(facts.claimedSlug) ? facts.claimedSlug : null
  const [evSnap, licSnap, counterSnap, ledgerSnap, reqSnap] = await Promise.all([
    claimed ? rd.doc(adminDb.doc(`events/${claimed}`)) : Promise.resolve(null),
    claimed ? rd.doc(adminDb.collection(EVENT_LICENSES_COLLECTION).doc(claimed)) : Promise.resolve(null),
    claimed ? rd.doc(adminDb.doc(`registrationCounters/${claimed}`)) : Promise.resolve(null),
    rd.doc(ledgerRef(draftId)),
    rd.query(requestsForEventQuery(draftId)),
  ])
  const ev = evSnap?.exists ? evSnap.data() as Rec : null
  const slug = claimed && ev && ev.uid === uid && (ev.draftId === undefined || ev.draftId === draftId) ? claimed : null
  // RD-CE-FIX M2 · lifecycle and closure stamps decide refund eligibility and the 24-hour window, so
  // they come from the SERVER-written live document (publish + lifecycle transitions mirror them
  // there), never from the draft a client may have written. A draft with no live event of its own
  // was never published and can never read as closed, whatever it claims.
  const draft = slug && ev
    ? { ...facts, lifecycle: effectiveLifecycleStatus(ev), closedAtMs: closedAtOf(ev) }
    : { ...facts, lifecycle: isClosedLifecycle(facts.lifecycle) ? 'draft' as const : facts.lifecycle, closedAtMs: null }
  const lic = slug && licSnap?.exists && (licSnap.data() as Rec).organizerUid === uid ? licSnap.data() as Rec : null
  // Activation / add-on orders key the draft id; capacity orders key the slug.
  const ordersSnap = await rd.query(adminDb.collection(LICENSE_ORDERS_COLLECTION)
    .where('organizerUid', '==', uid).where('eventId', 'in', slug ? [draftId, slug] : [draftId]).limit(300))
  let ledger: ServiceLedgerDoc | undefined
  let ledgerOwnerProblem = false
  if (ledgerSnap.exists) {
    const l = ledgerSnap.data() as ServiceLedgerDoc
    if (l.organizerUid === uid) ledger = l; else ledgerOwnerProblem = true
  }
  return {
    uid, draft, slug, eventDoc: slug ? ev : null, licence: lic,
    sold: slug && counterSnap ? soldFromCounter(counterSnap.exists ? counterSnap.data() as Rec : undefined) : null,
    ledger, ledgerOwnerProblem,
    orders: ordersSnap.docs.map(o => ({ ...(o.data() as Rec), orderId: o.id }) as Rec & { orderId: string }).filter(o => o.organizerUid === uid),
    requests: reqSnap.docs.map(r => ({ ...(r.data() as RequestDoc), id: r.id })).filter(r => r.organizerUid === uid),
    agg,
  }
}

// ═══ RD-CLOSE · carry-forward destinations use the LIVE event's lifecycle ══════════════════════════
// The destination draft is client-writable, so its lifecycle fields cannot decide anything. A
// destination with a live event of its own (events/{slug} owned by this organizer AND pointing back
// at this draft) takes the live lifecycle; one without (never published, or a forged slug) is an
// unpublished draft — open, whatever it claims.
// The live document is looked for at the draft's own slug, else at the draft id (events published
// before urlSlug existed); destinationFacts then checks it belongs to THIS organizer and draft.
const destSlugOf = (draft: Rec, draftId: string): string | null => {
  const slug = draftFacts('x', draft).claimedSlug ?? draftId
  return slug && ID.test(slug) ? slug : null
}
function destinationFacts(uid: string, draftId: string, draft: Rec, live: Rec | null): DraftFacts {
  const f = draftFacts(draftId, draft)
  if (live && liveEventBelongsTo(live, uid, draftId)) return { ...f, lifecycle: effectiveLifecycleStatus(live) }
  return { ...f, lifecycle: 'draft' }
}

// ═══ Service states ═══════════════════════════════════════════════════════════════════════════════
const paidOrders = (rec: EventRecords) => rec.orders.filter(o => o.status === 'paid')
const orderAt = (o: Rec) => tsMs(o.paidAt) ?? tsMs(o.createdAt) ?? 0
// RD-INTEG · D1 — paid orders, plus refunded orders whose units the admin licence refund retired
// (their consumed units stay as zero-value lots, so FIFO and `purchased` still line up).
const lineLots = (rec: EventRecords, service: LedgerService): (PurchaseLot & { item: ServiceChargeItem })[] =>
  rec.orders.filter(o => o.status === 'paid' || (o.status === 'refunded' && !!o.servicesRetiredOnRefund)).flatMap(o => retainedServiceLines(o)
    .filter(i => i && i.service === service && int(i.quantity) > 0)
    .map((i, n) => ({ orderId: n === 0 ? o.orderId : `${o.orderId}#${n}`, at: orderAt(o), quantity: int(i.quantity), totalPaise: int(i.totalPaise), item: i })))

const approvedRequests = (rec: EventRecords, service: RequestableService, exceptId?: string) => rec.requests
  .filter(r => r.id !== exceptId && r.kind === 'refund' && r.service === service && (r.status === 'approved' || r.status === 'processed'))
const approvedPaiseOf = (rec: EventRecords, service: RequestableService, exceptId?: string) =>
  approvedRequests(rec, service, exceptId).reduce((n, r) => n + num(r.approvedAmountPaise), 0)
const hasOpen = (rec: EventRecords, service: RequestableService, exceptId?: string) =>
  rec.requests.some(r => r.id !== exceptId && r.service === service && r.status === 'submitted')

const base = (service: RequestableService): ServiceState => ({
  service, applicable: false, notApplicableReason: null, purchased: 0, used: null, carriedIn: 0, carriedOut: 0, refunded: 0,
  remaining: 0, ownUnused: 0, paidPaise: 0, lots: [], usedFront: 0, removedBack: 0, problem: null, facts: {},
})
const strip = (lots: (PurchaseLot & { item?: unknown })[]): PurchaseLot[] => lots.map(({ orderId, at, quantity, totalPaise }) => ({ orderId, at, quantity, totalPaise }))
const OWNER_PROBLEM = { code: 'LEDGER_UNRECONCILED' as const, reason: 'This event’s allowance does not match its owner — requires Super Admin review.' }

function messagingState(rec: EventRecords, service: 'whatsapp' | 'certificates'): ServiceState {
  const l = ledgerLine(rec.ledger, service)
  const lots = lineLots(rec, service)
  const s = base(service)
  s.lots = strip(lots); s.paidPaise = lots.reduce((n, x) => n + x.totalPaise, 0)
  s.purchased = l.purchased; s.carriedIn = l.carriedIn; s.carriedOut = l.carriedOut; s.refunded = l.refunded
  s.used = l.consumed; s.remaining = availableUnits(l)
  s.applicable = l.purchased > 0 || l.carriedIn > 0 || lots.length > 0
  if (!s.applicable) { s.notApplicableReason = 'No prepaid units were bought for this event — usage is charged pay-as-you-go.'; return s }
  s.ownUnused = Math.max(0, Math.trunc(l.purchased - l.consumed - l.carriedOut - l.refunded))
  s.usedFront = Math.min(l.consumed, l.purchased); s.removedBack = l.carriedOut + l.refunded
  const usage = rec.agg.usage[service]
  if (rec.ledgerOwnerProblem) s.problem = OWNER_PROBLEM
  else if (lots.reduce((n, x) => n + x.quantity, 0) !== l.purchased) s.problem = { code: 'LEDGER_UNRECONCILED', reason: 'The purchased units do not match the paid orders — requires Super Admin review.' }
  else if (usage === null) s.problem = { code: 'USAGE_UNVERIFIABLE', reason: 'Usage could not be verified right now. Try again later.' }
  else if (usage !== l.consumed) s.problem = { code: 'LEDGER_UNRECONCILED', reason: 'The used units do not match the usage records — requires Super Admin review.' }
  return s
}

function photoState(rec: EventRecords): ServiceState {
  const l = ledgerLine(rec.ledger, 'media')
  const lots = lineLots(rec, 'media')
  const s = base('media')
  s.lots = strip(lots); s.paidPaise = lots.reduce((n, x) => n + x.totalPaise, 0)
  s.purchased = l.purchased; s.carriedIn = l.carriedIn; s.carriedOut = l.carriedOut; s.refunded = l.refunded
  s.applicable = l.purchased > 0 || l.carriedIn > 0 || lots.length > 0
  const used = rec.agg.storedPhotos
  s.facts = { storedPhotos: used, baseCapAtPurchase: null }
  const net = paidPhotoCapacity(l)
  if (!s.applicable) { s.notApplicableReason = 'No photo capacity was bought for this event.'; return s }
  // RD-PHOTO-01 — there is NO free photo base: every photo the event holds (stored or uploading)
  // uses a PAID unit. This event's own purchased units are counted as used first, so only unused
  // units it paid for are ever refundable or carryable — never a used photo.
  if (used !== null) {
    s.used = Math.min(l.purchased + l.carriedIn, used)
    const ownUsed = Math.min(l.purchased, used)
    s.usedFront = ownUsed; s.removedBack = l.carriedOut + l.refunded
    s.ownUnused = Math.max(0, l.purchased - ownUsed - l.carriedOut - l.refunded)
    s.remaining = Math.max(0, net - used)
  } else {
    // The photo count is unreadable: what remains is unknown — showing the full net would silently
    // claim nothing was used.
    s.remaining = null
  }
  if (rec.ledgerOwnerProblem) s.problem = OWNER_PROBLEM
  else if (lots.reduce((n, x) => n + x.quantity, 0) !== l.purchased) s.problem = { code: 'LEDGER_UNRECONCILED', reason: 'The purchased photo units do not match the paid orders — requires Super Admin review.' }
  else if (used === null) s.problem = { code: 'USAGE_UNVERIFIABLE', reason: 'The photo count could not be read right now. Try again later.' }
  return s
}

/** A capacity order's PAID capacity units, valued at what was actually collected for them. */
function capacityLots(rec: EventRecords): { lots: PurchaseLot[]; free: Set<number> } {
  const lots: PurchaseLot[] = [], free = new Set<number>()
  for (const o of paidOrders(rec)) {
    const c = o.capacityChange as CapacityChargeSnapshot | undefined
    if (!c || (c.operation !== 'activation' && c.operation !== 'increase')) continue
    const f = int(c.freeCapacity); free.add(f)
    const units = Math.max(0, int(c.capacity) - f) - Math.max(0, int(c.previousCapacity ?? 0) - f)
    if (units <= 0) continue
    // What was collected for the capacity: the order total minus its (never-discounted) service
    // lines, never more than the snapshot's own capacity total (Option A: an activation coupon
    // reduced exactly this part).
    const collected = Math.max(0, Math.min(int(c.totalPaise), int(o.amountPaise) - int(o.servicesTotalPaise)))
    lots.push({ orderId: o.orderId, at: orderAt(o), quantity: units, totalPaise: collected })
  }
  return { lots, free }
}

function capacityState(rec: EventRecords): ServiceState {
  const s = base('registrations')
  const refundedUnits = approvedRequests(rec, 'registrations').reduce((n, r) => n + int(r.quantity), 0)
  s.refunded = refundedUnits
  if (rec.draft.campaignType === 'donation_only') { s.notApplicableReason = 'Donation campaigns have no registration capacity.'; return s }
  if (!rec.slug || !rec.eventDoc) { s.notApplicableReason = 'Capacity applies once the event is live.'; return s }
  if (rec.licence?.commercialModel !== 'capacity') { s.notApplicableReason = 'This event uses a licence tier, not per-registration capacity.'; return s }
  const cap = currentCapacityFromEvent(rec.eventDoc)
  if (cap === null) { s.notApplicableReason = 'This event has unlimited capacity.'; return s }
  const sold = rec.sold ?? 0
  const { lots, free } = capacityLots(rec)
  const freeCap = free.size === 1 ? [...free][0] : free.size === 0 ? null : -1
  s.facts = { capacity: cap, registrations: sold, freeCapacity: freeCap !== null && freeCap >= 0 ? freeCap : null }
  s.used = sold
  s.remaining = Math.max(0, cap - sold)
  s.lots = lots; s.paidPaise = lots.reduce((n, l) => n + l.totalPaise, 0)
  const bought = lots.reduce((n, l) => n + l.quantity, 0)
  s.purchased = bought
  s.applicable = bought > 0
  if (!s.applicable) { s.notApplicableReason = 'No paid capacity on record — only the free allowance applies.'; return s }
  if (freeCap === -1) {
    s.problem = { code: 'CAPACITY_TERMS_CHANGED', reason: 'The capacity was bought under different free allowances — requires Super Admin review.' }
    return s
  }
  const f = freeCap as number
  const chargeableNow = Math.max(0, cap - f)
  const removed = bought - chargeableNow
  if (removed < 0) {
    s.problem = { code: 'LEDGER_UNRECONCILED', reason: 'The event’s capacity is higher than the paid capacity orders — requires Super Admin review.' }
    return s
  }
  s.usedFront = Math.min(chargeableNow, Math.max(0, sold - f))
  s.removedBack = removed
  s.ownUnused = Math.max(0, chargeableNow - s.usedFront)
  // The capacity invariant, in PAID units: purchased = paidUsed + ownUnused + refunded + reduced
  // (reduced = removed by a charged capacity decrease rather than by an approved refund).
  s.facts.paidUsed = s.usedFront
  s.facts.reducedCapacity = Math.max(0, removed - refundedUnits)
  return s
}

function stateOf(rec: EventRecords, service: RequestableService): ServiceState {
  if (service === 'registrations') return capacityState(rec)
  if (service === 'media') return photoState(rec)
  return messagingState(rec, service)
}

function eligibilityOf(rec: EventRecords, kind: ServiceRequestKind, s: ServiceState, opts: { windowAt?: number; exceptId?: string }): Eligibility {
  return requestEligibility(kind, s, {
    lifecycle: rec.draft.lifecycle, campaignType: rec.draft.campaignType,
    openRequest: hasOpen(rec, s.service, opts.exceptId), closedAtMs: rec.draft.closedAtMs,
    windowAt: opts.windowAt, approvedPaise: approvedPaiseOf(rec, s.service, opts.exceptId),
  })
}

// ═══ Organizer: one event's services, eligibility and requests ════════════════════════════════════
export async function getEventRequests(uid: string, draftId: string, nowMs: number = Date.now()): Promise<EventRequestsView | null> {
  if (!ID.test(draftId)) return null
  const rec = await readRecords(plain, uid, draftId, await readAggregates(uid, draftId))
  if (!rec) return null
  const closed = isClosedLifecycle(rec.draft.lifecycle)
  const services: EventServiceView[] = REQUESTABLE_SERVICES.map(service => {
    const state = stateOf(rec, service)
    return {
      state,
      refund: eligibilityOf(rec, 'refund', state, { windowAt: nowMs }),
      carryForward: eligibilityOf(rec, 'carry_forward', state, {}),
    }
  })
  // Destinations: the workspace's own events that can still use units (bounded: newest 200 drafts).
  let destinations: { draftId: string; name: string }[] = []
  if (closed) {
    const ds = await adminDb.collection(`users/${uid}/eventDrafts`).orderBy('updatedAt', 'desc').limit(200).get()
    const slugs = ds.docs.map(d => destSlugOf(d.data() as Rec, d.id))
    const lives = slugs.some(Boolean)
      ? await adminDb.getAll(...slugs.map(s => adminDb.collection('events').doc(s ?? '__none__')))
      : []
    destinations = ds.docs.map((d, i) => destinationFacts(uid, d.id, d.data() as Rec, slugs[i] && lives[i]?.exists ? lives[i].data() as Rec : null))
      .filter(x => destinationProblem(x, draftId) === null)
      .slice(0, 50)
      .map(x => ({ draftId: x.draftId, name: x.name }))
  }
  const closedAtMs = rec.draft.closedAtMs
  return {
    draftId, name: rec.draft.name, closed, services,
    closedAt: closed && closedAtMs !== null ? new Date(closedAtMs).toISOString() : null,
    refundDeadline: closed && closedAtMs !== null ? new Date(refundDeadlineMs(closedAtMs)!).toISOString() : null,
    refundWindowOpen: closed ? withinRefundWindow(nowMs, closedAtMs) : null,
    destinations,
    requests: rec.requests.map(r => toOrganizerView(toView(r.id, r))).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')),
  }
}

// ═══ Organizer: submit (one service, or "refund all eligible") ════════════════════════════════════
export async function submitServiceRequests(args: {
  uid: string; callerUid: string; kind: ServiceRequestKind; draftId: string
  /** One service, or `'all'` — every service whose refund is eligible now (refunds only). */
  services: RequestableService[] | 'all'
  destinationDraftId?: string | null; note: string; nowMs?: number
}): Promise<ServiceRequestView[]> {
  const { uid, draftId, kind } = args
  const nowMs = args.nowMs ?? Date.now()
  if (args.services === 'all' && kind !== 'refund') throw new ServiceRequestError(400, 'ALL_REFUND_ONLY', '"All services" is available for refunds only.')
  const agg = await readAggregates(uid, draftId)
  const pre = await readRecords(plain, uid, draftId, agg)
  if (!pre) throw new ServiceRequestError(404, 'EVENT_NOT_FOUND', 'Event not found.')

  const wanted: RequestableService[] = args.services === 'all'
    ? REQUESTABLE_SERVICES.filter(s => eligibilityOf(pre, 'refund', stateOf(pre, s), { windowAt: nowMs }).eligible)
    : [...new Set(args.services)]
  if (wanted.length === 0) throw new ServiceRequestError(409, 'NOTHING_ELIGIBLE', 'No service of this event has unused units that can be refunded now.')
  // Every service must be eligible on its own; one refusal refuses the whole submission.
  const preElig = new Map<RequestableService, Extract<Eligibility, { eligible: true }>>()
  for (const s of wanted) {
    const e = eligibilityOf(pre, kind, stateOf(pre, s), kind === 'refund' ? { windowAt: nowMs } : {})
    if (!e.eligible) throw new ServiceRequestError(409, e.code, wanted.length > 1 ? `${s}: ${e.reason}` : e.reason)
    preElig.set(s, e)
  }

  let dest: (DraftFacts & { closedAtMs: number | null }) | null = null
  if (kind === 'carry_forward') {
    if (wanted.length !== 1) throw new ServiceRequestError(400, 'ONE_SERVICE', 'Carry forward one service at a time.')
    const dSnap = args.destinationDraftId && ID.test(args.destinationDraftId) ? await draftRef(uid, args.destinationDraftId).get() : null
    const dSlug = dSnap?.exists ? destSlugOf(dSnap.data() as Rec, dSnap.id) : null
    const dLive = dSlug ? await adminDb.collection('events').doc(dSlug).get() : null
    dest = dSnap?.exists ? { ...destinationFacts(uid, dSnap.id, dSnap.data() as Rec, dLive?.exists ? dLive.data() as Rec : null), closedAtMs: null } : null
    if (!dest) throw new ServiceRequestError(400, 'DESTINATION_REQUIRED', 'Choose one of your events to carry the units into.')
    const p = destinationProblem(dest, draftId)
    if (p) throw new ServiceRequestError(409, 'DESTINATION_INVALID', p)
  }

  const refs = wanted.map(() => col().doc())
  const groupId = wanted.length > 1 ? refs[0].id : null
  const at = new Date(nowMs).toISOString()
  await adminDb.runTransaction(async txn => {
    // Re-read the records and the locks INSIDE the transaction; anything changed → refuse.
    const rec = await readRecords(inTxn(txn), uid, draftId, agg)
    if (!rec) throw new ServiceRequestError(404, 'EVENT_NOT_FOUND', 'Event not found.')
    const locks = await Promise.all(wanted.map(s => txn.get(lockRef(draftId, s))))
    wanted.forEach((service, n) => {
      if (locks[n].exists) throw new ServiceRequestError(409, 'REQUEST_OPEN', 'A request for this service is already awaiting a decision.')
      const e = eligibilityOf(rec, kind, stateOf(rec, service), kind === 'refund' ? { windowAt: nowMs } : {})
      const before = preElig.get(service)!
      if (!e.eligible) throw new ServiceRequestError(409, e.code, e.reason)
      if (e.quantity !== before.quantity || e.upperBoundPaise !== before.upperBoundPaise) {
        throw new ServiceRequestError(409, 'UNITS_CHANGED', 'The unused units changed while you were submitting. Reload and try again.')
      }
    })
    wanted.forEach((service, n) => {
      const e = preElig.get(service)!
      const doc: RequestDoc = {
        kind, status: 'submitted', organizerUid: uid, submittedBy: args.callerUid, service, quantity: e.quantity,
        sourceDraftId: draftId, sourceName: rec.draft.name, sourceSlug: rec.slug,
        destinationDraftId: dest?.draftId ?? null, destinationName: dest?.name ?? null,
        groupId,
        refundUpperBoundPaise: kind === 'refund' ? e.upperBoundPaise ?? null : null,
        valuation: kind === 'refund' ? e.valuation ?? [] : [],
        approvedAmountPaise: null, externalReference: null,
        // S1 — the window evidence as accepted, from the SAME closure instant the eligibility check
        // just used inside this transaction. Refunds only (carry-forward has no window).
        ...(kind === 'refund' ? { window: refundWindowSnapshot(rec.draft.closedAtMs, nowMs) } : {}),
        organizerNote: args.note,
        history: [{ at, by: args.callerUid, role: 'organizer', action: 'submitted', note: args.note }],
        createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      }
      txn.create(refs[n], doc as unknown as FirebaseFirestore.DocumentData)
      txn.create(lockRef(draftId, service), { requestId: refs[n].id, organizerUid: uid, createdAt: FieldValue.serverTimestamp() })
    })
  })
  const saved = await Promise.all(refs.map(r => r.get()))
  return saved.map(s => toView(s.id, s.data() as RequestDoc))
}

/** Back-compatible single-service submit. */
export async function submitServiceRequest(args: {
  uid: string; callerUid: string; kind: ServiceRequestKind; draftId: string; service: RequestableService
  destinationDraftId?: string | null; note: string
}): Promise<ServiceRequestView> {
  const [r] = await submitServiceRequests({ ...args, services: [args.service] })
  return r
}

// ═══ Listing ═════════════════════════════════════════════════════════════════════════════════════
export const REQUESTS_PAGE = 20

export async function listOrganizerRequests(uid: string, opts: { cursor?: string | null } = {}) {
  let q = col().where('organizerUid', '==', uid).orderBy('createdAt', 'desc').limit(REQUESTS_PAGE + 1)
  if (opts.cursor && isRequestId(opts.cursor)) {
    const c = await col().doc(opts.cursor).get()
    if (c.exists && (c.data() as RequestDoc).organizerUid === uid) q = q.startAfter(c)
  }
  const snap = await q.get()
  const docs = snap.docs.slice(0, REQUESTS_PAGE)
  return {
    requests: docs.map(d => toOrganizerView(toView(d.id, d.data() as RequestDoc))),
    nextCursor: snap.docs.length > REQUESTS_PAGE ? docs[docs.length - 1].id : null,
  }
}

export interface AdminRequestFilters {
  kind: ServiceRequestKind
  status: ServiceRequestStatus | 'all'
  /** Exact organizer uid. */
  organizer?: string | null
  service?: RequestableService | null
  /** Case-insensitive text in the source / destination event name or draft id. */
  event?: string | null
  from?: Date | null
  to?: Date | null
  cursor?: string | null
}
const ADMIN_SCAN_BATCH = 100
const ADMIN_SCAN_LIMIT = 500

/**
 * One indexed query — kind (+ status), createdAt range, newest first — with the organizer / service /
 * event filters applied in memory over a BOUNDED scan (≤ ADMIN_SCAN_LIMIT documents per request), so
 * no index per filter combination is needed. The cursor is the last document EXAMINED; `scanLimited`
 * says older requests were not searched yet.
 */
export async function listAdminRequests(opts: AdminRequestFilters) {
  let q0: FirebaseFirestore.Query = col().where('kind', '==', opts.kind)
  if (opts.status !== 'all') q0 = q0.where('status', '==', opts.status)
  if (opts.from) q0 = q0.where('createdAt', '>=', Timestamp.fromDate(opts.from))
  if (opts.to)   q0 = q0.where('createdAt', '<=', Timestamp.fromDate(opts.to))
  q0 = q0.orderBy('createdAt', 'desc')
  let after: FirebaseFirestore.DocumentSnapshot | null = null
  if (opts.cursor && isRequestId(opts.cursor)) {
    const c = await col().doc(opts.cursor).get()
    if (c.exists) after = c
  }
  const term = (opts.event ?? '').trim().toLowerCase().slice(0, 100)
  const keep = (r: RequestDoc) =>
    (!opts.organizer || r.organizerUid === opts.organizer)
    && (!opts.service || r.service === opts.service)
    && (!term || [r.sourceName, r.sourceDraftId, r.destinationName, r.destinationDraftId].some(v => typeof v === 'string' && v.toLowerCase().includes(term)))
  const rows: ServiceRequestView[] = []
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
  let examined = 0, exhausted = false, more = false
  while (examined < ADMIN_SCAN_LIMIT) {
    const want = Math.min(ADMIN_SCAN_BATCH, ADMIN_SCAN_LIMIT - examined)
    const from: FirebaseFirestore.DocumentSnapshot | null = last ?? after
    const batch: FirebaseFirestore.QuerySnapshot = await (from ? q0.startAfter(from) : q0).limit(want).get()
    for (const doc of batch.docs) {
      const r = doc.data() as RequestDoc
      if (!keep(r)) { examined++; last = doc; continue }
      if (rows.length === REQUESTS_PAGE) { more = true; break }
      examined++; last = doc
      rows.push(toView(doc.id, r))
    }
    if (more) break
    if (batch.size < want) { exhausted = true; break }
  }
  const scanLimited = !more && !exhausted
  return { requests: rows, nextCursor: (more || scanLimited) && last ? last.id : null, scanLimited }
}

/** The cap for exactly `quantity` units of a request, from the CURRENT records. */
function capFor(rec: EventRecords, s: ServiceState, quantity: number, exceptId: string): { capPaise: number; parts: ValuationPart[] } | null {
  const v = valueUnits(s.lots, s.usedFront, s.removedBack, quantity)
  if (!v) return null
  return { capPaise: Math.max(0, Math.min(v.valuePaise, s.paidPaise - approvedPaiseOf(rec, s.service, exceptId))), parts: v.parts }
}

/** A Super Admin's view of one request: the request plus the CURRENT evidence for the decision. */
export async function getAdminRequest(id: string) {
  if (!isRequestId(id)) return null
  const snap = await col().doc(id).get()
  if (!snap.exists) return null
  const r = snap.data() as RequestDoc
  const rec = await readRecords(plain, r.organizerUid, r.sourceDraftId, await readAggregates(r.organizerUid, r.sourceDraftId)).catch(() => null)
  if (!rec) return { request: toView(snap.id, r), current: null }
  const state = stateOf(rec, r.service)
  const eligibility = eligibilityOf(rec, r.kind, state, { exceptId: id })
  const cap = r.kind === 'refund' && eligibility.eligible ? capFor(rec, state, Math.min(r.quantity, state.ownUnused), id) : null
  return {
    request: toView(snap.id, r),
    current: {
      state, eligibility,
      currentUnusedUnits: state.ownUnused,
      currentUpperBoundPaise: cap?.capPaise ?? null,
      valuation: cap?.parts ?? [],
      approvedPaiseOtherRequests: approvedPaiseOf(rec, r.service, id),
      // Closure / refund-window evidence: when the event closed, when the 24-hour refund window closed,
      // and whether THIS request was submitted inside that window (strictly before the deadline).
      event: (() => {
        const closedAtMs = rec.draft.closedAtMs
        const deadline = refundDeadlineMs(closedAtMs)
        // The instant the server JUDGED the submission (its nowMs, recorded on the 'submitted' history
        // entry) — not the commit timestamp, which can land a moment later and would misreport a request
        // accepted just before the deadline as "outside".
        const judged = (r.history ?? []).find(h => h.action === 'submitted')?.at
        const submittedMs = (judged ? Date.parse(judged) : NaN) || tsMs(r.createdAt)
        return {
          lifecycle: rec.draft.lifecycle,
          closedAt: closedAtMs === null ? null : new Date(closedAtMs).toISOString(),
          refundDeadline: deadline === null ? null : new Date(deadline).toISOString(),
          submittedWithinWindow: r.kind !== 'refund' || submittedMs === null ? null : withinRefundWindow(submittedMs, closedAtMs),
        }
      })(),
      orders: rec.orders.filter(o => o.status === 'paid').map(o => ({
        orderId: o.orderId, purpose: typeof o.purpose === 'string' ? o.purpose : null, amountPaise: int(o.amountPaise),
        paidAt: isoOf(o.paidAt), couponCode: typeof o.couponCode === 'string' ? o.couponCode : null, discountPaise: int(o.discountPaise),
        paymentId: typeof o.razorpayPaymentId === 'string' ? o.razorpayPaymentId : null,
      })),
    },
  }
}

// ═══ Super Admin decisions ═══════════════════════════════════════════════════════════════════════
export interface DecisionOutcome { request: ServiceRequestView; already: boolean }

function stageDecisionAudit(txn: Transaction, adminUid: string, id: string, r: RequestDoc, action: AdminAuditAction, reason: string, extra: Rec) {
  stageAdminAudit(txn, {
    adminUid, actorRole: 'super_admin',
    action, entityType: 'wallet_service_request', entityId: id, reason,
    metadata: {
      kind: r.kind, service: r.service, quantity: r.quantity, organizerUid: r.organizerUid,
      sourceDraftId: r.sourceDraftId, destinationDraftId: r.destinationDraftId, groupId: r.groupId ?? null, ...extra,
    },
    before: { status: r.status },
  })
}

export async function decideServiceRequest(args: {
  adminUid: string; id: string; action: ServiceRequestAction; reason: string
  approvedAmountPaise?: number | null; externalReference?: string | null
  /** S2 — mark_processed only: the money actually refunded outside RegisterDesk (≤ approved). */
  refundedAmountPaise?: number | null
}): Promise<DecisionOutcome> {
  const { adminUid, id, action, reason } = args
  if (!isRequestId(id)) throw new ServiceRequestError(404, 'REQUEST_NOT_FOUND', 'Request not found.')
  const reqRef = col().doc(id)

  // Aggregates (usage, stored photos) are read before the transaction; the transaction re-reads every
  // document, so units consumed in between still refuse the approval.
  const pre = await reqRef.get()
  if (!pre.exists) throw new ServiceRequestError(404, 'REQUEST_NOT_FOUND', 'Request not found.')
  const preDoc = pre.data() as RequestDoc
  const agg = action === 'approve' ? await readAggregates(preDoc.organizerUid, preDoc.sourceDraftId) : null

  const already = await adminDb.runTransaction(async txn => {
    const snap = await txn.get(reqRef)
    if (!snap.exists) throw new ServiceRequestError(404, 'REQUEST_NOT_FOUND', 'Request not found.')
    const r = snap.data() as RequestDoc
    const t = decisionTransition(r.kind, r.status, action)
    if (t === 'already') {
      if (action === 'mark_processed' && args.externalReference && r.externalReference !== args.externalReference) {
        throw new ServiceRequestError(409, 'ALREADY_PROCESSED', `Already processed with reference ${r.externalReference}.`)
      }
      // S2 — a replay with the same reference but a DIFFERENT refunded amount is a conflict, not a no-op.
      if (action === 'mark_processed' && typeof args.refundedAmountPaise === 'number' && typeof r.refundedAmountPaise === 'number' && r.refundedAmountPaise !== args.refundedAmountPaise) {
        throw new ServiceRequestError(409, 'ALREADY_PROCESSED', `Already recorded as ₹${(r.refundedAmountPaise / 100).toFixed(2)} refunded with reference ${r.externalReference}.`)
      }
      return true
    }
    // Reads before any write (a Firestore transaction rule): the lock this request holds, if any.
    const lock = r.status === 'submitted' ? lockRef(r.sourceDraftId, r.service) : null
    const lockSnap = lock ? await txn.get(lock) : null
    const releaseLock = () => { if (lock && lockSnap?.exists && lockSnap.get('requestId') === id) txn.delete(lock) }
    if (t === 'refuse') throw new ServiceRequestError(409, 'INVALID_STATE', `A ${r.kind === 'refund' ? 'refund' : 'carry-forward'} request that is ${r.status} cannot be ${action === 'mark_processed' ? 'marked processed' : `${targetStatus(action)}`}.`)

    const now = new Date().toISOString()
    const entry = (a: ServiceRequestHistoryEntry['action'], note: string): ServiceRequestHistoryEntry => ({ at: now, by: adminUid, role: 'super_admin', action: a, note })

    if (action === 'reject') {
      releaseLock()
      stageDecisionAudit(txn, adminUid, id, r, 'wallet_service_request.rejected', reason, {})
      txn.update(reqRef, {
        status: 'rejected', decision: { action: 'rejected', by: adminUid, reason, at: FieldValue.serverTimestamp() },
        history: FieldValue.arrayUnion(entry('rejected', reason)), updatedAt: FieldValue.serverTimestamp(),
      })
      return false
    }

    if (action === 'mark_processed') {
      const ref = args.externalReference
      if (!ref) throw new ServiceRequestError(400, 'EXTERNAL_REFERENCE_REQUIRED', 'Enter the external refund reference.')
      // S2 — the amount actually refunded is recorded with the reference; the approved amount is never touched.
      const refundedProblem = refundedAmountProblem(args.refundedAmountPaise, r.approvedAmountPaise)
      if (refundedProblem) throw new ServiceRequestError(400, 'REFUNDED_AMOUNT_INVALID', refundedProblem)
      const refunded = args.refundedAmountPaise as number
      stageDecisionAudit(txn, adminUid, id, r, 'wallet_service_request.processed', reason, { approvedAmountPaise: r.approvedAmountPaise, refundedAmountPaise: refunded, externalReference: ref })
      txn.update(reqRef, {
        status: 'processed', externalReference: ref, refundedAmountPaise: refunded,
        processed: { by: adminUid, reason, externalReference: ref, refundedAmountPaise: refunded, at: FieldValue.serverTimestamp() },
        history: FieldValue.arrayUnion(entry('processed', `${reason} (₹${(refunded / 100).toFixed(2)} refunded of ₹${((r.approvedAmountPaise ?? 0) / 100).toFixed(2)} approved · reference ${ref})`)), updatedAt: FieldValue.serverTimestamp(),
      })
      return false
    }

    // ── approve: rebuild the service state from the records, inside the transaction ──
    // RD-INTEG · D2 / RD-PHOTO-01 — a photo refund or carry-forward LOWERS the source event's paid
    // photo capacity, and uploads stay open after closure. The photo count is re-read INSIDE the
    // transaction and the event's photo lock document is read here and written below — the same
    // document every upload reservation writes — so an upload and this approval serialise: photos
    // reserved since the evidence was shown are counted as used and the approval refuses ("units
    // changed"), and no upload can take a unit this approval removes.
    const photoMove = r.service === 'media'
    // The gate's own counter (and the lock it serialises on), plus a re-count of the assets: the
    // larger is used, so a refund can never treat a photo that holds capacity as unused.
    const photoHeld = photoMove ? (await txnReadPhotoCapacity(txn, r.organizerUid, r.sourceDraftId)).used : 0
    const aggNow: Aggregates = photoMove
      ? { ...agg!, storedPhotos: Math.max(photoHeld, (await txn.get(storedPhotosQuery(r.organizerUid, r.sourceDraftId))).data().count) }
      : agg!
    const rec = await readRecords(inTxn(txn), r.organizerUid, r.sourceDraftId, aggNow)
    if (!rec) throw new ServiceRequestError(409, 'EVENT_NOT_FOUND', 'The source event no longer exists.')
    const destRef = r.destinationDraftId ? draftRef(r.organizerUid, r.destinationDraftId) : null
    const destLedgerRef = r.destinationDraftId ? ledgerRef(r.destinationDraftId) : null
    const [destDraftSnap, destLedgerSnap] = await Promise.all([
      destRef ? txn.get(destRef) : Promise.resolve(null),
      destLedgerRef ? txn.get(destLedgerRef) : Promise.resolve(null),
    ])
    // RD-CLOSE — the destination's live event, read in THIS transaction (a concurrent close or
    // unpublish re-runs the approval against the new state).
    const destSlug = destDraftSnap?.exists ? destSlugOf(destDraftSnap.data() as Rec, destDraftSnap.id) : null
    const destLiveSnap = destSlug ? await txn.get(adminDb.collection('events').doc(destSlug)) : null
    const state = stateOf(rec, r.service)
    const e = eligibilityOf(rec, r.kind, state, { exceptId: id })        // no windowAt: a submission rule
    if (!e.eligible) throw new ServiceRequestError(409, e.code, `Cannot approve: ${e.reason}`)
    if (e.quantity < r.quantity) {
      throw new ServiceRequestError(409, 'UNITS_CHANGED', `Only ${e.quantity} unused unit(s) remain (the request was for ${r.quantity}). Reject it so the organizer can submit again.`)
    }

    if (r.kind === 'refund') {
      const cap = capFor(rec, state, r.quantity, id)
      if (!cap) throw new ServiceRequestError(409, 'LEDGER_UNRECONCILED', 'Cannot approve: the unused units do not match the paid purchase lines.')
      const amt = args.approvedAmountPaise
      if (typeof amt !== 'number' || !Number.isInteger(amt) || amt < 1) {
        throw new ServiceRequestError(400, 'AMOUNT_REQUIRED', 'Enter the amount to refund (in rupees, more than zero).')
      }
      if (amt > cap.capPaise) throw new ServiceRequestError(400, 'AMOUNT_ABOVE_LIMIT', `The amount cannot exceed the verified refundable amount for these units (₹${(cap.capPaise / 100).toFixed(2)}).`)
      releaseLock()
      if (photoMove) txnTouchPhotoLock(txn, r.organizerUid, r.sourceDraftId, 'refund', aggNow.storedPhotos ?? photoHeld)
      // S4 — a capacity refund records the event's enforced capacity before / refunded / after, from the
      // values read in THIS transaction, on the request and in the audit row.
      let capacity: CapacityRefundRecord | null = null
      if (r.service === 'registrations') {
        // Capacity refund: the event's enforced capacity drops by the refunded units — never below
        // registrations taken or the free allowance (the eligibility above guarantees both).
        const capNow = currentCapacityFromEvent(rec.eventDoc ?? undefined)
        if (!rec.slug || capNow === null) throw new ServiceRequestError(409, 'NOT_APPLICABLE', 'Cannot approve: the event has no enforced capacity.')
        const next = capNow - r.quantity
        if (next < (rec.sold ?? 0)) throw new ServiceRequestError(409, 'UNITS_CHANGED', 'Cannot approve: capacity would fall below registrations taken.')
        capacity = { before: capNow, refunded: r.quantity, after: next }
        txn.set(adminDb.doc(`events/${rec.slug}`), { totalCapacity: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        if (rec.licence) txn.set(adminDb.collection(EVENT_LICENSES_COLLECTION).doc(rec.slug), { capacity: next, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      } else {
        txn.set(ledgerRef(r.sourceDraftId), { [r.service]: { refunded: FieldValue.increment(r.quantity) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      }
      stageDecisionAudit(txn, adminUid, id, r, 'wallet_service_request.approved', reason, { approvedAmountPaise: amt, upperBoundPaise: cap.capPaise, valuation: cap.parts, ...(capacity ? { capacityBefore: capacity.before, capacityRefunded: capacity.refunded, capacityAfter: capacity.after } : {}) })
      txn.update(reqRef, {
        status: 'approved', approvedAmountPaise: amt,
        ...(capacity ? { capacity } : {}),
        decision: { action: 'approved', by: adminUid, reason, at: FieldValue.serverTimestamp() },
        history: FieldValue.arrayUnion(entry('approved', `${reason} (₹${(amt / 100).toFixed(2)} approved; not yet refunded${capacity ? ` · capacity ${capacity.before} → ${capacity.after}` : ''})`)),
        updatedAt: FieldValue.serverTimestamp(),
      })
      return false
    }

    // carry-forward (ledger services only — requestEligibility refuses capacity)
    if (!isLedgerService(r.service) || !destDraftSnap || !destDraftSnap.exists || !destLedgerRef || !destLedgerSnap) {
      throw new ServiceRequestError(409, 'DESTINATION_INVALID', 'The destination event no longer exists.')
    }
    const dest = destinationFacts(r.organizerUid, destDraftSnap.id, destDraftSnap.data() as Rec, destLiveSnap?.exists ? destLiveSnap.data() as Rec : null)
    const p = destinationProblem(dest, r.sourceDraftId)
    if (p) throw new ServiceRequestError(409, 'DESTINATION_INVALID', p)
    if (destLedgerSnap.exists && (destLedgerSnap.data() as ServiceLedgerDoc).organizerUid !== r.organizerUid) {
      throw new ServiceRequestError(409, 'LEDGER_OWNER_MISMATCH', 'The destination event’s allowance belongs to another account.')
    }
    // RD-PHOTO-01 — photo units carried INTO an event count toward its 3,000 maximum too.
    if (photoMove) {
      const destNet = paidPhotoCapacity(destLedgerSnap.exists ? (destLedgerSnap.data() as ServiceLedgerDoc).media : undefined)
      const fits = checkPhotoPurchase(destNet, r.quantity)
      if (!fits.ok) throw new ServiceRequestError(409, 'PHOTO_CAPACITY_EXCEEDED', `Cannot approve: ${fits.message}`)
    }
    releaseLock()
    if (photoMove) txnTouchPhotoLock(txn, r.organizerUid, r.sourceDraftId, 'carry_forward', aggNow.storedPhotos ?? photoHeld)
    stageDecisionAudit(txn, adminUid, id, r, 'wallet_service_request.approved', reason, {})
    txn.set(ledgerRef(r.sourceDraftId), { [r.service]: { carriedOut: FieldValue.increment(r.quantity) }, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
    txn.set(destLedgerRef, {
      draftId: dest.draftId, organizerUid: r.organizerUid,
      [r.service]: { carriedIn: FieldValue.increment(r.quantity) }, updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true })
    txn.update(reqRef, {
      status: 'approved',
      decision: { action: 'approved', by: adminUid, reason, at: FieldValue.serverTimestamp() },
      history: FieldValue.arrayUnion(entry('approved', `${reason} (${r.quantity} unit(s) moved to ${dest.name})`)),
      updatedAt: FieldValue.serverTimestamp(),
    })
    return false
  })
  const after = await reqRef.get()
  return { request: toView(id, after.data() as RequestDoc), already }
}

// ═══ Refund-history S3 · refund reconciliation (READ-ONLY) ═══════════════════════════════════════
// Compares, per event + service: the approved / recorded refund REQUESTS, the money recorded as
// actually refunded, and the canonical ledger `refunded` counter (WhatsApp, certificates, photos).
// Registration-capacity refunds are checked against their own before / refunded / after record (S4).
// It never writes: no ledger, request or money is touched, and approval is never treated as settlement.

export type RefundReconCode =
  | 'LEDGER_REFUNDED_MISMATCH'   // Σ approved refund quantities ≠ ledger.refunded
  | 'CAPACITY_ARITHMETIC'        // before − refunded ≠ after, or refunded ≠ the request's quantity
  | 'CAPACITY_NOT_RECORDED'      // a capacity refund approved before S4 (no before/after on record)
  | 'REFUNDED_EXCEEDS_APPROVED'  // a recorded refund above the approved amount (must never happen)
  | 'REFUNDED_AMOUNT_NOT_RECORDED' // processed before S2: the actual amount was never recorded
  | 'PARTIALLY_REFUNDED'         // recorded refund below the approved amount

export interface RefundReconFinding {
  code: RefundReconCode
  confidence: 'confirmed' | 'probable' | 'inconclusive'
  organizerUid: string; sourceDraftId: string; service: RequestableService; requestId: string | null
  detail: Record<string, string | number | boolean | null>
}

export interface RefundReconRow {
  requestId: string; organizerUid: string; sourceDraftId: string; eventName: string; service: RequestableService
  status: 'approved' | 'processed'
  approvedQuantity: number; approvedAmountPaise: number | null
  /** Quantity refunded: the units leave the event at approval, so it equals the approved quantity once processed. */
  refundedQuantity: number | null; refundedAmountPaise: number | null
  /** Approved but not (fully) refunded yet; null when the actual amount was never recorded (pre-S2). */
  outstandingPaise: number | null
  submittedAt: string | null; approvedAt: string | null; processedAt: string | null
  capacity: CapacityRefundRecord | null
}

const RECON_PAGE = 50
export async function reconcileServiceRefunds(opts: { cursor?: string | null; limit?: number | null } = {}) {
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || RECON_PAGE), 1), 100)
  let q = col().where('kind', '==', 'refund').where('status', 'in', ['approved', 'processed']).orderBy('createdAt', 'desc').limit(limit + 1)
  if (opts.cursor && isRequestId(opts.cursor)) {
    const c = await col().doc(opts.cursor).get()
    if (c.exists) q = q.startAfter(c)
  }
  const snap = await q.get()
  const docs = snap.docs.slice(0, limit)
  const rows: RefundReconRow[] = []
  const findings: RefundReconFinding[] = []
  const groups = new Map<string, { organizerUid: string; draftId: string; service: RequestableService }>()
  for (const d of docs) {
    const r = d.data() as RequestDoc
    const approved = typeof r.approvedAmountPaise === 'number' ? r.approvedAmountPaise : null
    const refunded = typeof r.refundedAmountPaise === 'number' ? r.refundedAmountPaise : null
    const processed = r.status === 'processed'
    const outstanding = approved === null ? null : !processed ? approved : refunded === null ? null : Math.max(0, approved - refunded)
    rows.push({
      requestId: d.id, organizerUid: r.organizerUid, sourceDraftId: r.sourceDraftId, eventName: r.sourceName, service: r.service,
      status: processed ? 'processed' : 'approved',
      approvedQuantity: r.quantity, approvedAmountPaise: approved,
      refundedQuantity: processed ? r.quantity : null, refundedAmountPaise: refunded, outstandingPaise: outstanding,
      submittedAt: isoOf(r.createdAt), approvedAt: isoOf(r.decision?.at), processedAt: isoOf(r.processed?.at),
      capacity: r.capacity && typeof r.capacity.before === 'number' ? r.capacity : null,
    })
    const base = { organizerUid: r.organizerUid, sourceDraftId: r.sourceDraftId, service: r.service, requestId: d.id }
    if (processed && refunded === null) findings.push({ ...base, code: 'REFUNDED_AMOUNT_NOT_RECORDED', confidence: 'inconclusive', detail: { approvedPaise: approved, note: 'Processed before the actual amount was recorded — not assumed to equal the approval.' } })
    if (processed && refunded !== null && approved !== null && refunded > approved) findings.push({ ...base, code: 'REFUNDED_EXCEEDS_APPROVED', confidence: 'confirmed', detail: { approvedPaise: approved, refundedPaise: refunded } })
    if (processed && refunded !== null && approved !== null && refunded < approved) findings.push({ ...base, code: 'PARTIALLY_REFUNDED', confidence: 'probable', detail: { approvedPaise: approved, refundedPaise: refunded, outstandingPaise: approved - refunded } })
    if (r.service === 'registrations') {
      const c = r.capacity
      if (!c || typeof c.before !== 'number') findings.push({ ...base, code: 'CAPACITY_NOT_RECORDED', confidence: 'inconclusive', detail: { quantity: r.quantity, note: 'Approved before capacity before/after was recorded.' } })
      else if (c.before - c.refunded !== c.after || c.refunded !== r.quantity) findings.push({ ...base, code: 'CAPACITY_ARITHMETIC', confidence: 'confirmed', detail: { capacityBefore: c.before, capacityRefunded: c.refunded, capacityAfter: c.after, requestQuantity: r.quantity } })
    } else {
      groups.set(`${r.sourceDraftId}__${r.service}`, { organizerUid: r.organizerUid, draftId: r.sourceDraftId, service: r.service })
    }
  }
  // Ledger services: Σ quantity of EVERY approved/processed refund for the event + service (not just this
  // page) against the ledger's own refunded counter — the only writer of which is the approval.
  for (const g of groups.values()) {
    const [ledgerSnap, reqs] = await Promise.all([
      ledgerRef(g.draftId).get(),
      col().where('sourceDraftId', '==', g.draftId).limit(500).get(),
    ])
    const sum = reqs.docs.map(x => x.data() as RequestDoc)
      .filter(x => x.kind === 'refund' && x.service === g.service && (x.status === 'approved' || x.status === 'processed'))
      .reduce((n, x) => n + x.quantity, 0)
    const ledger = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : undefined
    const ledgerRefunded = ledgerLine(ledger, g.service as 'whatsapp' | 'certificates' | 'media').refunded
    if (ledger && ledger.organizerUid !== g.organizerUid) {
      findings.push({ organizerUid: g.organizerUid, sourceDraftId: g.draftId, service: g.service, requestId: null, code: 'LEDGER_REFUNDED_MISMATCH', confidence: 'confirmed', detail: { note: 'The ledger belongs to another organizer.' } })
    } else if (sum !== ledgerRefunded) {
      findings.push({ organizerUid: g.organizerUid, sourceDraftId: g.draftId, service: g.service, requestId: null, code: 'LEDGER_REFUNDED_MISMATCH', confidence: 'confirmed', detail: { approvedRefundUnits: sum, ledgerRefunded, requestsTruncated: reqs.size >= 500 } })
    }
  }
  return {
    rows, findings, scanned: docs.length, groupsChecked: groups.size,
    nextCursor: snap.docs.length > limit ? docs[docs.length - 1].id : null,
    complete: snap.docs.length <= limit,
  }
}

// ═══ Super Admin: the SAME per-service figures the organizer's event Wallet shows ═════════════════
/** RD-INTEG — one figure set per service, derived by stateOf (the organizer Wallet's own SSOT). */
export interface AdminServiceFigures {
  purchased: number; used: number | null; remaining: number | null
  carriedIn: number; carriedOut: number; refunded: number
  /** Unused units of this event's own purchase — the only refundable / carryable units. */
  refundableUnits: number
  paidPaise: number
  problem: string | null
}
export async function getAdminServiceFigures(uid: string, draftId: string): Promise<Record<RequestableService, AdminServiceFigures> | null> {
  if (!ID.test(draftId) || !ID.test(uid)) return null
  const rec = await readRecords(plain, uid, draftId, await readAggregates(uid, draftId)).catch(() => null)
  if (!rec) return null
  return Object.fromEntries(REQUESTABLE_SERVICES.map(service => {
    const s = stateOf(rec, service)
    return [service, {
      purchased: s.purchased, used: s.used, remaining: s.remaining,
      carriedIn: s.carriedIn, carriedOut: s.carriedOut, refunded: s.refunded,
      refundableUnits: s.ownUnused, paidPaise: s.paidPaise, problem: s.problem?.reason ?? null,
    }]
  })) as Record<RequestableService, AdminServiceFigures>
}

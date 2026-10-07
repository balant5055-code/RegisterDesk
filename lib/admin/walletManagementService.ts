// RD-WALLET-W2.e · Super Admin Wallet Management — READ-ONLY data service. Server-only.
//
// Every function here READS. Nothing is written: no balance, ledger, status, cursor, report or
// audit document. Nothing calls a payment provider. Every query is bounded (a limit, a cursor,
// or a bounded fan-out), and when a bound is hit the result says so (`truncated`).
//
// Sources — the EXISTING models only, joined exactly as existing code joins them:
//   • communication wallet  organizerWallets/{uid} · walletTransactions · walletTopups ·
//                           walletTopupReconciliation (W1–W2.c)
//   • media credits         mediaCreditWallets · mediaCreditLedger · mediaCreditRefunds, through the
//                           feature's own repositories
//   • event services        eventServiceAllowances/{draftId} (RD-EVENT-COMMERCE-02), events/{slug}
//                           (uid, draftId), eventLicenses/{slug} and registrationCounters/{slug} —
//                           the join lib/admin/organizer360Service.ts uses
//   • reconciliation        lib/reconciliation/walletTopups.ts (W2.d S1–S2, report-only)
//
// What does NOT exist is reported as unavailable, never invented (see UNAVAILABLE_SOURCES).

import { AggregateField, FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { captureError } from '@/lib/monitoring/sentry'
import * as mediaWalletRepo from '@/features/media-credits/repositories/walletRepo'
import * as mediaLedgerRepo from '@/features/media-credits/repositories/ledgerRepo'
import * as mediaRefundRepo from '@/features/media-credits/repositories/refundRepo'
import { CREDIT_REFUND_STATUSES, type CreditRefundStatus } from '@/features/media-credits/types'
import { EVENT_SERVICE_ALLOWANCES, viewOf, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { getAdminServiceFigures, reconcileServiceRefunds, type AdminServiceFigures } from '@/lib/wallet/serviceRequests'
import { eventClosedAtMs, type RequestableService } from '@/lib/wallet/serviceRequestRules'
import { SERVICE_KINDS, type ServiceKind } from '@/lib/licensing/serviceAllowances'
import {
  ledgerSign, reconcileCommunicationWallet, reconcileTopupsPage, reconcileTopupRecordsPage,
  reconcileCommunicationWalletsPage, type LedgerSign, type WalletReconFinding,
} from '@/lib/reconciliation/walletTopups'
import {
  DISABLED_GATEWAY, GATEWAY_REPORT_LIMITS, collectGatewayEvidence, unverifiableOrderIdFinding,
  type GatewayEvidenceProvider, type GatewayReport, type GatewayTopupInput,
} from '@/lib/reconciliation/walletTopupsGateway'

// ── shared helpers ─────────────────────────────────────────────────────────────────────────────
type Rec = Record<string, unknown>
const str  = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const int  = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null)
const rec  = (v: unknown): Rec => (v && typeof v === 'object' ? v as Rec : {})
const iso  = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null
const clampLimit = (v: unknown, dflt: number, max: number) => {
  // A missing / empty value is the default — Number(null) is 0, which would clamp to a page of 1.
  if (v === null || v === undefined || v === '') return dflt
  const n = typeof v === 'number' ? v : Number(v)
  return Math.max(1, Math.min(max, Number.isFinite(n) ? Math.trunc(n) : dflt))
}
const chunk = <T,>(a: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o }
const ID = /^[A-Za-z0-9_.:@-]{1,128}$/
export const isSafeId = (v: unknown): v is string => typeof v === 'string' && ID.test(v)

const eventNameOf = (ev: Rec): string => str(rec(rec(ev.eventDetails).info).name) ?? '(untitled event)'

/** Data the product does not record — shown as unavailable, never approximated. */
export const UNAVAILABLE_SOURCES = {
  // RD-WALLET-REQ — carry-forward / refund requests now exist for unused EVENT SERVICE units only.
  carryForward: 'There is no carry-forward for communication-wallet balances or media credits — only for unused prepaid event service units (above).',
  communicationRefunds: 'The communication wallet has no refund-request record (top-ups are never refunded automatically). Refund requests exist for unused prepaid event service units; media-credit refunds are historical only (Media Credits are retired).',
  smsAllowance: 'SMS is not available: there is no SMS provider, so nothing is sent or charged for SMS.',
  mediaUsage: 'Photo usage is the event\'s photos in Media Studio (stored + uploading), not a ledger counter — counted against its PAID photo capacity; there are no free photos and at most 3,000 per event.',
} as const

// ═══ Overview ════════════════════════════════════════════════════════════════════════════════
const TOPUP_STATUSES = ['pending', 'credited', 'needs_review', 'abandoned'] as const
const OPEN_RECON_STATUSES = ['pending', 'needs_review', 'exhausted', 'duplicate_payment'] as const
const OPEN_REFUND_STATUSES: CreditRefundStatus[] = ['requested', 'approved', 'settling']

/**
 * Every figure is `null` when ITS query failed — never a misleading 0. `failed` names the sources that
 * could not be read, so the page can say which part is unavailable while the rest still loads.
 */
export interface WalletOverview {
  communication: {
    wallets: number | null
    /** Sum of the stored balancePaise fields (non-numeric values are not counted by Firestore). */
    storedBalancePaise: number | null
    topupsByStatus: Record<typeof TOPUP_STATUSES[number], number | null>
    openReconciliation: Record<typeof OPEN_RECON_STATUSES[number], number | null>
  }
  media: {
    wallets: number | null
    balanceCredits: number | null
    heldCredits: number | null
    openRefunds: Record<string, number | null>
  }
  allowances: { eventLedgers: number | null }
  failed: string[]
  unavailable: typeof UNAVAILABLE_SOURCES
  generatedAt: string
}

const countWhere = async (collection: string, field: string, value: string) =>
  (await adminDb.collection(collection).where(field, '==', value).count().get()).data().count

/**
 * Aggregation queries only — no documents are read.
 *
 * Each figure is its OWN aggregation with at most ONE sum. Firestore serves a single count or a
 * single sum from the automatic single-field indexes, but an aggregation that sums TWO fields needs a
 * composite index: the former `mediaCreditWallets` count+sum(balance)+sum(heldCredits) query failed
 * with FAILED_PRECONDITION in production (no such index is deployed), which failed the whole Overview
 * and so the default view of the page ("Could not load wallet data"). Each source also fails on its
 * own: a failed figure is null and named in `failed`, it never takes the other figures down with it.
 */
export async function getWalletOverview(): Promise<WalletOverview> {
  const failed: string[] = []
  const safe = async <T>(source: string, run: () => Promise<T>): Promise<T | null> => {
    try { return await run() } catch (err) {
      failed.push(source)
      captureError(err, { scope: 'admin.wallet_management.overview', source })
      return null
    }
  }
  const count = (q: FirebaseFirestore.Query) => q.count().get().then(s => s.data().count)
  const sum = (q: FirebaseFirestore.Query, field: string) => q.aggregate({ s: AggregateField.sum(field) }).get().then(s => Number(s.data().s ?? 0))
  const [commWallets, commBalance, mediaWallets, mediaBalance, mediaHeld, ledgers, topups, recon, refunds] = await Promise.all([
    safe('communication wallets', () => count(adminDb.collection('organizerWallets'))),
    safe('communication balances', () => sum(adminDb.collection('organizerWallets'), 'balancePaise')),
    safe('media-credit wallets', () => count(adminDb.collection('mediaCreditWallets'))),
    safe('media-credit balances', () => sum(adminDb.collection('mediaCreditWallets'), 'balance')),
    safe('media-credit holds', () => sum(adminDb.collection('mediaCreditWallets'), 'heldCredits')),
    safe('event service ledgers', () => count(adminDb.collection(EVENT_SERVICE_ALLOWANCES))),
    Promise.all(TOPUP_STATUSES.map(s => safe(`top-ups (${s})`, () => countWhere('walletTopups', 'status', s)))),
    Promise.all(OPEN_RECON_STATUSES.map(s => safe(`reconciliation (${s})`, () => countWhere('walletTopupReconciliation', 'status', s)))),
    Promise.all(OPEN_REFUND_STATUSES.map(s => safe(`media-credit refunds (${s})`, () => countWhere('mediaCreditRefunds', 'status', s)))),
  ])
  return {
    communication: {
      wallets: commWallets, storedBalancePaise: commBalance,
      topupsByStatus: Object.fromEntries(TOPUP_STATUSES.map((s, i) => [s, topups[i]])) as WalletOverview['communication']['topupsByStatus'],
      openReconciliation: Object.fromEntries(OPEN_RECON_STATUSES.map((s, i) => [s, recon[i]])) as WalletOverview['communication']['openReconciliation'],
    },
    media: {
      wallets: mediaWallets, balanceCredits: mediaBalance, heldCredits: mediaHeld,
      openRefunds: Object.fromEntries(OPEN_REFUND_STATUSES.map((s, i) => [s, refunds[i]])),
    },
    allowances: { eventLedgers: ledgers },
    failed,
    unavailable: UNAVAILABLE_SOURCES,
    generatedAt: new Date().toISOString(),
  }
}

// ═══ Organizer wallets ═══════════════════════════════════════════════════════════════════════
export interface OrganizerWalletRow {
  uid:  string
  name: string | null
  communication: { exists: boolean; balancePaise: number | null; balanceValid: boolean; updatedAt: string | null }
  media: { exists: boolean; balance: number | null; heldCredits: number | null; refundHeldCredits: number | null }
}

async function organizerRows(uids: string[]): Promise<OrganizerWalletRow[]> {
  if (uids.length === 0) return []
  const [comm, users, media] = await Promise.all([
    adminDb.getAll(...uids.map(u => adminDb.doc(`organizerWallets/${u}`))),
    adminDb.getAll(...uids.map(u => adminDb.doc(`users/${u}`))),
    adminDb.getAll(...uids.map(u => adminDb.doc(`mediaCreditWallets/${u}`))),
  ])
  return uids.map((uid, i) => {
    const w = comm[i].exists ? comm[i].data() as Rec : null
    const mw = media[i].exists ? media[i].data() as Rec : null
    return {
      uid,
      name: users[i].exists ? str((users[i].data() as Rec).name) : null,
      communication: {
        exists: !!w, balancePaise: w ? int(w.balancePaise) : null,
        balanceValid: !w || int(w.balancePaise) !== null, updatedAt: w ? iso(w.updatedAt) : null,
      },
      media: {
        exists: !!mw, balance: mw ? int(mw.balance) : null, heldCredits: mw ? int(mw.heldCredits) : null,
        refundHeldCredits: mw ? (int(mw.refundHeldCredits) ?? 0) : null,
      },
    }
  })
}

/**
 * Communication wallets by document id (stable cursor), or one search: an exact organizer uid,
 * or an exact email (users.email ==, at most 5 matches).
 */
export async function listOrganizerWallets(opts: { cursor?: string | null; limit?: unknown; search?: string | null }) {
  const limit = clampLimit(opts.limit, 25, 50)
  const search = (opts.search ?? '').trim()
  if (search) {
    let uids: string[] = []
    if (search.includes('@')) {
      const snap = await adminDb.collection('users').where('email', '==', search.toLowerCase()).limit(5).get()
      const exact = snap.empty ? await adminDb.collection('users').where('email', '==', search).limit(5).get() : snap
      uids = exact.docs.map(d => d.id)
    } else if (isSafeId(search)) {
      uids = [search]
    }
    return { rows: await organizerRows(uids), nextCursor: null as string | null, search: true }
  }
  // W2.e.1 — BOTH wallet collections are keyed by the organizer uid, so one uid cursor pages their
  // UNION: one bounded query each (document-id order, from the same cursor, limit + 1), merged in
  // the same order Firestore uses (UTF-8 byte order of the id). An organizer with only a
  // media-credit wallet is reached by normal paging. The next page restarts both queries after
  // the last uid SHOWN, so nothing beyond the page is skipped.
  const after = opts.cursor && isSafeId(opts.cursor) ? opts.cursor : null
  const pageOf = (collection: string) => {
    let q = adminDb.collection(collection).orderBy(FieldPath.documentId()).limit(limit + 1) as FirebaseFirestore.Query
    if (after) q = q.startAfter(after)
    return q.get()
  }
  const [comm, media] = await Promise.all([pageOf('organizerWallets'), pageOf('mediaCreditWallets')])
  const merged = [...new Set([...comm.docs.map(d => d.id), ...media.docs.map(d => d.id)])]
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
  const uids = merged.slice(0, limit)
  return {
    rows: await organizerRows(uids),
    nextCursor: merged.length > limit ? uids[uids.length - 1] : null,
    search: false,
  }
}

// ═══ Event-wise services ═════════════════════════════════════════════════════════════════════
export interface EventServiceRow {
  draftId:      string
  slug:         string | null
  name:         string | null
  organizerUid: string | null
  license: { exists: boolean; tier: string | null; status: string | null; commercialModel: string | null
    /** null = uncapped (admin grant); undefined-by-absence → reported as `capacityRecorded: false` (historical tier licence). */
    capacity: number | null; capacityRecorded: boolean }
  registrations: number | null
  /** carriedIn / carriedOut / refunded (RD-WALLET-REQ): without them purchased − used ≠ left after a refund or carry. */
  services: Record<ServiceKind, { purchased: number; consumed: number | null; remaining: number | null; carriedIn: number; carriedOut: number; refunded: number; onExhausted: string | null }>
  ledgerExists: boolean
  /**
   * RD-INTEG — the SAME per-service figures the organizer's event Wallet shows (stateOf: paid lines,
   * FIFO, measured media use, refundable units, data problems). null when the event's draft could
   * not be read for its organizer; the ledger counters above are then the only evidence.
   */
  figures: Record<RequestableService, AdminServiceFigures> | null
  /** RD-CLOSE — the live event's lifecycle (server-written), when the event is published. */
  lifecycle: string | null
}

type EventRowInput = { draftId: string; ledger: ServiceLedgerDoc | null; /** RD-CLOSE — the live event, when already known. */ live?: { slug: string; data: Rec } }

async function eventRows(input: EventRowInput[]): Promise<EventServiceRow[]> {
  if (input.length === 0) return []
  // draftId → the live event (events/{slug}.draftId), bounded `in` chunks.
  const bySlug = new Map<string, Rec & { __slug: string }>()
  const byDraft = new Map<string, string>()
  for (const i of input) if (i.live) { byDraft.set(i.draftId, i.live.slug); bySlug.set(i.live.slug, { ...i.live.data, __slug: i.live.slug }) }
  for (const ids of chunk(input.filter(i => !i.live).map(i => i.draftId), 30)) {
    const snap = await adminDb.collection('events').where('draftId', 'in', ids).limit(60).get()
    // RD-INTEG — draft ids are unique per organizer only: the live event must belong to the
    // ledger's organizer, or another organizer's event would be reported against this ledger.
    const ownerOf = new Map(input.map(i => [i.draftId, str(i.ledger?.organizerUid)]))
    for (const d of snap.docs) {
      const ev = d.data() as Rec
      const did = str(ev.draftId)
      const owner = did ? ownerOf.get(did) ?? null : null
      if (owner && str(ev.uid) !== owner) continue
      if (did && !byDraft.has(did)) { byDraft.set(did, d.id); bySlug.set(d.id, { ...ev, __slug: d.id }) }
    }
  }
  const slugs = [...bySlug.keys()]
  const [lics, counters] = slugs.length
    ? await Promise.all([
        adminDb.getAll(...slugs.map(s => adminDb.doc(`eventLicenses/${s}`))),
        adminDb.getAll(...slugs.map(s => adminDb.doc(`registrationCounters/${s}`))),
      ])
    : [[], []]
  const licBy = new Map<string, Rec | null>(), cntBy = new Map<string, Rec | null>()
  slugs.forEach((s, i) => { licBy.set(s, lics[i].exists ? lics[i].data() as Rec : null); cntBy.set(s, counters[i].exists ? counters[i].data() as Rec : null) })

  const figuresBy = new Map<string, Record<RequestableService, AdminServiceFigures> | null>()
  await Promise.all(input.map(async ({ draftId, ledger }) => {
    const owner = str(ledger?.organizerUid) ?? (byDraft.get(draftId) ? str(bySlug.get(byDraft.get(draftId)!)!.uid) : null)
    figuresBy.set(draftId, owner ? await getAdminServiceFigures(owner, draftId).catch(() => null) : null)
  }))

  return input.map(({ draftId, ledger }) => {
    const slug = byDraft.get(draftId) ?? null
    const ev = slug ? bySlug.get(slug)! : null
    const lic = slug ? licBy.get(slug) ?? null : null
    const cnt = slug ? cntBy.get(slug) ?? null : null
    const view = viewOf(ledger ?? undefined)
    const services = Object.fromEntries(SERVICE_KINDS.map(k => {
      const line = rec(ledger?.[k])
      return [k, {
        purchased: view.purchased[k],
        // Media usage is NOT a ledger counter (UNAVAILABLE_SOURCES.mediaUsage).
        consumed:  k === 'media' ? null : view.consumed[k],
        remaining: k === 'media' ? null : view.remaining[k],
        carriedIn: view.carriedIn[k], carriedOut: view.carriedOut[k], refunded: view.refunded[k],
        onExhausted: str(line.onExhausted),
      }]
    })) as EventServiceRow['services']
    return {
      draftId, slug, name: ev ? eventNameOf(ev) : null,
      organizerUid: str(ledger?.organizerUid) ?? (ev ? str(ev.uid) : null),
      license: {
        exists: !!lic, tier: lic ? str(lic.tier) : null, status: lic ? str(lic.status) : null,
        commercialModel: lic ? str(lic.commercialModel) : null,
        capacity: lic && 'capacity' in lic ? int(lic.capacity) : null,
        capacityRecorded: !!lic && 'capacity' in lic,
      },
      registrations: cnt ? int(cnt.totalCount) : null,
      services, ledgerExists: !!ledger,
      figures: figuresBy.get(draftId) ?? null,
      lifecycle: ev ? (str(ev.lifecycleStatus) ?? str(ev.status)) : null,
    }
  })
}

/**
 * RD-CLOSE — EVERY live event (events/{slug}, by slug), optionally for one organizer, with its
 * licence/capacity and — when it has one — its prepaid service ledger. It used to list ledgers, so
 * an event that bought only registration capacity (no prepaid services) never appeared at all.
 * A ledger is never invented: `ledgerExists: false` says "not applicable".
 * `source: 'ledgers'` keeps the ledger listing (it also covers drafts that paid before publishing).
 */
export async function listEventServices(opts: { cursor?: string | null; limit?: unknown; organizerUid?: string | null; source?: string | null }) {
  const limit = clampLimit(opts.limit, 25, 50)
  const byOrganizer = opts.organizerUid && isSafeId(opts.organizerUid) ? opts.organizerUid : null
  if (opts.source === 'ledgers') {
    let q: FirebaseFirestore.Query = adminDb.collection(EVENT_SERVICE_ALLOWANCES)
    if (byOrganizer) q = q.where('organizerUid', '==', byOrganizer)
    q = q.orderBy(FieldPath.documentId()).limit(limit + 1)
    if (opts.cursor && isSafeId(opts.cursor)) q = q.startAfter(opts.cursor)
    const snap = await q.get()
    const docs = snap.docs.slice(0, limit)
    return {
      rows: await eventRows(docs.map(d => ({ draftId: d.id, ledger: d.data() as ServiceLedgerDoc }))),
      nextCursor: snap.size > limit ? docs[docs.length - 1].id : null,
    }
  }
  let q: FirebaseFirestore.Query = adminDb.collection('events')
  if (byOrganizer) q = q.where('uid', '==', byOrganizer)
  q = q.orderBy(FieldPath.documentId()).limit(limit + 1)
  if (opts.cursor && isSafeId(opts.cursor)) q = q.startAfter(opts.cursor)
  const snap = await q.get()
  const docs = snap.docs.slice(0, limit)
  const draftIdOf = (d: FirebaseFirestore.QueryDocumentSnapshot) => str((d.data() as Rec).draftId) ?? d.id
  const ledgers = docs.length ? await adminDb.getAll(...docs.map(d => adminDb.collection(EVENT_SERVICE_ALLOWANCES).doc(draftIdOf(d)))) : []
  return {
    rows: await eventRows(docs.map((d, i) => {
      const ev = d.data() as Rec
      const l = ledgers[i]?.exists ? ledgers[i].data() as ServiceLedgerDoc : null
      // A ledger keyed by the same draft id but owned by another organizer is not this event's.
      return { draftId: draftIdOf(d), ledger: l && l.organizerUid === str(ev.uid) ? l : null, live: { slug: d.id, data: ev } }
    })),
    nextCursor: snap.size > limit ? docs[docs.length - 1].id : null,
  }
}

// ═══ RD-CLOSE · one event, end to end (per-event reconciliation) ═════════════════════════════════
export async function getEventWalletDetail(input: { draftId?: string | null; slug?: string | null }) {
  // Resolve the live event (authoritative owner + lifecycle) by slug, else by draft id.
  let liveSnap: FirebaseFirestore.DocumentSnapshot | null = null
  if (input.slug && isSafeId(input.slug)) {
    const s = await adminDb.collection('events').doc(input.slug).get()
    if (s.exists) liveSnap = s
  }
  if (!liveSnap && input.draftId && isSafeId(input.draftId)) {
    const q = await adminDb.collection('events').where('draftId', '==', input.draftId).limit(2).get()
    if (q.size === 1) liveSnap = q.docs[0]
  }
  const ev = liveSnap?.exists ? liveSnap.data() as Rec : null
  const slug = liveSnap?.exists ? liveSnap.id : null
  const draftId = (ev ? str(ev.draftId) : null) ?? (input.draftId && isSafeId(input.draftId) ? input.draftId : null)
  if (!draftId) return null
  const ledgerSnap = await adminDb.collection(EVENT_SERVICE_ALLOWANCES).doc(draftId).get()
  const ledger = ledgerSnap.exists ? ledgerSnap.data() as ServiceLedgerDoc : null
  const owner = (ev ? str(ev.uid) : null) ?? str(ledger?.organizerUid)
  if (!owner) return null
  const [row] = await eventRows([{ draftId, ledger: ledger && ledger.organizerUid === owner ? ledger : null, ...(slug && ev ? { live: { slug, data: ev } } : {}) }])

  const keys = slug && slug !== draftId ? [draftId, slug] : [draftId]
  const ordersQ = adminDb.collection('licenseOrders').where('eventId', 'in', keys).limit(100)
  const requestsQ = adminDb.collection('walletServiceRequests').where('sourceDraftId', '==', draftId).limit(100)
  const incomingQ = adminDb.collection('walletServiceRequests').where('destinationDraftId', '==', draftId).limit(100)
  const chargesQ = slug ? adminDb.collection('walletTransactions').where('organizerUid', '==', owner).where('metadata.eventSlug', '==', slug).limit(100) : null
  const logs = slug ? adminDb.collection('emailLogs').where('organizerUid', '==', owner).where('eventSlug', '==', slug) : null
  const cnt = (q: FirebaseFirestore.Query | null) => q ? q.count().get().then(r => r.data().count).catch(() => null) : Promise.resolve(null)
  const usage = slug ? adminDb.collection('communicationUsage').where('organizerUid', '==', owner).where('eventSlug', '==', slug) : null
  const sum = (q: FirebaseFirestore.Query | null, field: string) => q ? q.aggregate({ s: AggregateField.sum(field) }).get().then(r => Math.trunc(Number(r.data().s ?? 0))).catch(() => null) : Promise.resolve(null)
  const [ordersSnap, reqSnap, inSnap, chargesSnap, queued, sent, delivered, failedAll, unknown, waQty, waCost, emailQty] = await Promise.all([
    ordersQ.get(), requestsQ.get(), incomingQ.get(), chargesQ ? chargesQ.get() : Promise.resolve(null),
    cnt(logs && logs.where('status', '==', 'queued')), cnt(logs && logs.where('status', '==', 'sent')), cnt(logs && logs.where('status', '==', 'delivered')),
    cnt(logs && logs.where('status', '==', 'failed')), cnt(logs && logs.where('status', '==', 'failed').where('deliveryUnknown', '==', true)),
    sum(usage && usage.where('channel', '==', 'whatsapp'), 'quantity'), sum(usage && usage.where('channel', '==', 'whatsapp'), 'costPaise'),
    sum(usage && usage.where('channel', '==', 'email'), 'quantity'),
  ])
  const orders = ordersSnap.docs.map(d => {
    const o = d.data() as Rec
    const items = Array.isArray(o.serviceItems) ? o.serviceItems as Rec[] : []
    return {
      orderId: d.id, purpose: str(o.purpose) ?? (d.id.startsWith('lic_') ? 'activation' : d.id.startsWith('cap_') ? 'capacity' : d.id.startsWith('add_') ? 'addon' : null),
      status: str(o.status), amountPaise: int(o.amountPaise), paidAt: iso(o.paidAt) ?? iso(o.updatedAt),
      capacity: int(rec(o.capacityChange).capacity) ?? int(o.capacity),
      services: items.map(i => `${int(i.quantity) ?? 0} ${str(i.service) ?? ''}`).join(', ') || null,
      organizerUid: str(o.organizerUid), servicesRetiredOnRefund: o.servicesRetiredOnRefund ?? null,
    }
  }).filter(o => !o.organizerUid || o.organizerUid === owner)
  const reqView = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
    const r = d.data() as Rec
    return { id: d.id, kind: str(r.kind), service: str(r.service), quantity: int(r.quantity), status: str(r.status),
      approvedAmountPaise: int(r.approvedAmountPaise), externalReference: str(r.externalReference),
      sourceDraftId: str(r.sourceDraftId), destinationDraftId: str(r.destinationDraftId), createdAt: iso(r.createdAt) }
  }
  const failed = failedAll === null || unknown === null ? null : Math.max(0, failedAll - unknown)
  return {
    event: row, draftId, slug, organizerUid: owner,
    // The SAME closure instant the refund window runs from (first closure after the last restore).
    closedAt: ev ? (() => {
      const ms = (v: unknown) => { const s = iso(v); return s ? Date.parse(s) : null }
      const c = eventClosedAtMs({ completedAt: ms(ev.completedAt), cancelledAt: ms(ev.cancelledAt), archivedAt: ms(ev.archivedAt), restoredAt: ms(ev.restoredAt) })
      return c === null ? null : new Date(c).toISOString()
    })() : null,
    serviceLedger: ledger ? 'present' : 'not_applicable',
    orders,
    requests: [...reqSnap.docs.map(reqView), ...inSnap.docs.map(reqView)].filter(r => r && true),
    charges: chargesSnap ? chargesSnap.docs.map(txnRow).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')) : [],
    chargesTruncated: !!chargesSnap && chargesSnap.size >= 100,
    communication: {
      pending: queued, sent: sent === null || delivered === null ? null : sent + delivered, delivered, failed, unknown,
      whatsappMessages: waQty, whatsappCostPaise: waCost, emailMessages: emailQty,
    },
  }
}

// ═══ Transactions (communication wallet ledger) ══════════════════════════════════════════════
export interface WalletTxnRow {
  id: string; organizerUid: string | null; type: string | null; sign: LedgerSign
  amountPaise: number | null; balanceAfterPaise: number | null; status: string | null
  referenceType: string | null; referenceId: string | null; orderId: string | null; paymentId: string | null
  description: string | null; createdAt: string | null
}
const txnRow = (d: FirebaseFirestore.DocumentSnapshot): WalletTxnRow => {
  const x = d.data() as Rec
  return {
    id: d.id, organizerUid: str(x.organizerUid), type: str(x.type), sign: ledgerSign(x.type),
    amountPaise: int(x.amountPaise), balanceAfterPaise: int(x.balancePaise), status: str(x.status),
    referenceType: str(x.referenceType), referenceId: str(x.referenceId), orderId: str(x.orderId),
    paymentId: str(x.paymentId), description: str(x.description), createdAt: iso(x.createdAt),
  }
}
const TXN_SCAN_LIMIT = 500

/**
 * walletTransactions newest first (createdAt; per organizer via the existing
 * (organizerUid, createdAt DESC) index). A `sign` filter keeps the SAME query and order and scans
 * at most TXN_SCAN_LIMIT rows per request; the cursor is the last row EXAMINED, so nothing is skipped.
 */
export async function listWalletTransactions(opts: { cursor?: string | null; limit?: unknown; organizerUid?: string | null; sign?: string | null }) {
  const limit = clampLimit(opts.limit, 25, 50)
  const sign = opts.sign === 'credit' || opts.sign === 'debit' || opts.sign === 'ambiguous' || opts.sign === 'unknown' ? opts.sign : null
  let base: FirebaseFirestore.Query = adminDb.collection('walletTransactions')
  if (opts.organizerUid && isSafeId(opts.organizerUid)) base = base.where('organizerUid', '==', opts.organizerUid)
  base = base.orderBy('createdAt', 'desc')
  let from: FirebaseFirestore.DocumentSnapshot | null = null
  if (opts.cursor && isSafeId(opts.cursor)) {
    const c = await adminDb.doc(`walletTransactions/${opts.cursor}`).get()
    // Tenant-check the cursor (the media ledger's rule): it must belong to the filtered organizer.
    if (c.exists && (!opts.organizerUid || (c.data() as Rec).organizerUid === opts.organizerUid)) from = c
  }
  const rows: WalletTxnRow[] = []
  let last: FirebaseFirestore.DocumentSnapshot | null = from
  let examined = 0, exhausted = false
  while (rows.length < limit && examined < TXN_SCAN_LIMIT) {
    const n = sign ? Math.min(100, TXN_SCAN_LIMIT - examined) : limit + 1 - rows.length
    let q = base.limit(n)
    if (last) q = q.startAfter(last)
    const snap = await q.get()
    for (const d of snap.docs) {
      if (!sign && rows.length === limit) break                              // the +1 look-ahead row
      examined++; last = d
      const r = txnRow(d)
      if (!sign || r.sign === sign) rows.push(r)
      if (rows.length === limit) break
    }
    if (snap.size < n) { exhausted = true; break }
    if (!sign) break
  }
  return { rows, nextCursor: exhausted || !last || (!sign && rows.length < limit) ? null : last.id, scanLimited: !!sign && examined >= TXN_SCAN_LIMIT }
}

// ═══ Organizer detail ════════════════════════════════════════════════════════════════════════
const DETAIL_TOPUPS = 50
const DETAIL_RECORDS = 50
const DETAIL_EVENTS = 60

export async function getOrganizerWalletDetail(uid: string) {
  if (!isSafeId(uid)) return null
  const [rows, topupSnap, reconSnap, eventsSnap, allowanceSnap, mediaWallet, mediaLedger, mediaRefunds] = await Promise.all([
    organizerRows([uid]),
    adminDb.collection('walletTopups').where('uid', '==', uid).limit(DETAIL_TOPUPS + 1).get(),
    adminDb.collection('walletTopupReconciliation').where('uid', '==', uid).limit(DETAIL_RECORDS + 1).get(),
    adminDb.collection('events').where('uid', '==', uid).limit(DETAIL_EVENTS + 1).get(),
    adminDb.collection(EVENT_SERVICE_ALLOWANCES).where('organizerUid', '==', uid).limit(DETAIL_EVENTS + 1).get(),
    mediaWalletRepo.read(uid),
    mediaLedgerRepo.listByOrganizer(uid, 10),
    mediaRefundRepo.listByOrganizer(uid, 10),
  ])
  const row = rows[0]
  const walletSnap = await adminDb.doc(`organizerWallets/${uid}`).get()
  // W2.d — this wallet's own ledger-chain verdict (read-only; never a guess on legacy history).
  const chain = await reconcileCommunicationWallet(uid, walletSnap.exists ? walletSnap.data() as Rec : null, { deadlineAtMs: Date.now() + 10_000 })

  const topups = topupSnap.docs.slice(0, DETAIL_TOPUPS).map(d => {
    const x = d.data() as Rec
    return { orderId: d.id, amountPaise: int(x.amountPaise), status: str(x.status), paymentId: str(x.paymentId), createdAt: iso(x.createdAt), _ms: (x.createdAt as { toMillis?: () => number })?.toMillis?.() ?? 0 }
  }).sort((a, b) => b._ms - a._ms).map(({ _ms, ...t }) => { void _ms; return t })

  const records = reconSnap.docs.slice(0, DETAIL_RECORDS).map(d => {
    const x = d.data() as Rec
    return {
      id: d.id, orderId: str(x.orderId), status: str(x.status), reason: str(x.reason),
      paymentIds: Array.isArray(x.paymentIds) ? x.paymentIds.filter((v): v is string => typeof v === 'string') : (str(x.paymentId) ? [str(x.paymentId)!] : []),
      attempts: int(x.attempts), lastError: str(x.lastError)?.slice(0, 200) ?? null, firstSeenAt: iso(x.firstSeenAt),
    }
  })

  // Events: the organizer's events (bounded) + any allowance ledgers not tied to a live event.
  const allowanceByDraft = new Map<string, ServiceLedgerDoc>()
  allowanceSnap.docs.slice(0, DETAIL_EVENTS).forEach(d => allowanceByDraft.set(d.id, d.data() as ServiceLedgerDoc))
  const draftIds = new Set<string>(allowanceByDraft.keys())
  eventsSnap.docs.slice(0, DETAIL_EVENTS).forEach(d => { const did = str((d.data() as Rec).draftId); if (did) draftIds.add(did) })
  const events = await eventRows([...draftIds].slice(0, DETAIL_EVENTS).map(did => ({ draftId: did, ledger: allowanceByDraft.get(did) ?? null })))

  return {
    organizer: row,
    walletCheck: { verdict: chain.verdict, finding: chain.finding as WalletReconFinding | null },
    topups, topupsTruncated: topupSnap.size > DETAIL_TOPUPS,
    reconciliationRecords: records, reconciliationTruncated: reconSnap.size > DETAIL_RECORDS,
    events, eventsTruncated: eventsSnap.size > DETAIL_EVENTS || allowanceSnap.size > DETAIL_EVENTS,
    media: {
      wallet: mediaWallet ? { balance: int(mediaWallet.balance), heldCredits: int(mediaWallet.heldCredits), refundHeldCredits: int(mediaWallet.refundHeldCredits) ?? 0, lifetimeGranted: int(mediaWallet.lifetimeGranted), lifetimeConsumed: int(mediaWallet.lifetimeConsumed) } : null,
      ledger: mediaLedger.map(e => ({ entryId: e.entryId, delta: e.delta, reason: e.reason, balanceAfter: e.balanceAfter, eventSlug: e.eventSlug, createdAt: iso((e as unknown as Rec).createdAt) })),
      refunds: mediaRefunds.map(refundRow),
    },
  }
}

// ═══ Refund requests (media credits — the only refund-request record) ═════════════════════════
const refundRow = (r: unknown) => {
  const x = rec(r)
  return {
    refundId: str(x.refundId), organizerUid: str(x.organizerUid), purchaseId: str(x.purchaseId),
    credits: int(x.credits), purchaseAmountPaise: int(x.purchaseAmountPaise), status: str(x.status),
    reason: str(x.reason)?.slice(0, 200) ?? null, decidedBy: str(x.decidedBy), createdAt: iso(x.createdAt),
  }
}

export async function listRefundRequests(opts: { status?: string | null; cursor?: string | null; limit?: unknown }) {
  const limit = clampLimit(opts.limit, 25, 50)
  const status = (CREDIT_REFUND_STATUSES as readonly string[]).includes(opts.status ?? '') ? opts.status as CreditRefundStatus : 'requested'
  const cursor = opts.cursor && isSafeId(opts.cursor) ? opts.cursor : null
  const docs = await mediaRefundRepo.listByStatus(status, limit + 1, cursor)
  const page = docs.slice(0, limit)
  return {
    status, rows: page.map(refundRow),
    nextCursor: docs.length > limit ? page[page.length - 1].refundId : null,
  }
}

// ═══ Reconciliation (W2.d S1–S2, report-only) ════════════════════════════════════════════════
/**
 * `gateway: true` (on demand, top-ups only) adds W2.d S3 gateway evidence for the top-ups this
 * page flagged. The provider is NOT an HTTP parameter: the route never passes one, so production
 * always uses DISABLED_GATEWAY — no call, no extra read — and the report says gateway verification
 * is not enabled. Only a direct caller (tests) can inject the fixture provider.
 */
export async function getReconciliationPage(
  opts: { kind?: string | null; cursor?: string | null; limit?: unknown; gateway?: boolean; gatewayAfter?: string | null },
  deps: { gatewayProvider?: GatewayEvidenceProvider } = {},
) {
  const cursor = opts.cursor && isSafeId(opts.cursor) ? opts.cursor : null
  const deadlineAtMs = Date.now() + 20_000
  if (opts.kind === 'wallets') {
    return { kind: 'wallets' as const, ...(await reconcileCommunicationWalletsPage({ cursor, limit: clampLimit(opts.limit, 10, 25), deadlineAtMs })) }
  }
  // Refund-history S3 — event-service refund reconciliation (read-only; separate shape).
  if (opts.kind === 'service_refunds') {
    return { kind: 'service_refunds' as const, ...(await reconcileServiceRefunds({ cursor, limit: clampLimit(opts.limit, 50, 100) })) }
  }
  if (opts.kind === 'records') {
    return { kind: 'records' as const, ...(await reconcileTopupRecordsPage({ cursor, limit: clampLimit(opts.limit, 100, 200), deadlineAtMs })) }
  }
  const page = await reconcileTopupsPage({ cursor, limit: clampLimit(opts.limit, 100, 200), deadlineAtMs })
  if (!opts.gateway) return { kind: 'topups' as const, ...page }
  const orderIds = [...new Set(page.findings.map(f => f.orderId))]
  const gatewayAfter = opts.gatewayAfter && isSafeId(opts.gatewayAfter) ? opts.gatewayAfter : null   // invalid → ignored
  return { kind: 'topups' as const, ...page, gateway: await gatewayEvidenceFor(orderIds, gatewayAfter, deps.gatewayProvider ?? DISABLED_GATEWAY, deadlineAtMs) }
}

/**
 * G1 — gateway evidence for ONE bounded batch of a reconciliation page's flagged orders, plus where
 * to continue. Counts describe this request only: `checked + missing + deferred === pageCandidates`.
 */
export interface GatewayPageReport extends GatewayReport {
  /** Flagged orders on this page after `gatewayAfter` — the candidates this request could check. */
  pageCandidates: number
  /** Candidates whose top-up document no longer exists: nothing to check (neither checked nor pending). */
  missing:        number
  /** Every candidate on this page after `gatewayAfter` has been handled. */
  pageComplete:   boolean
  /**
   * Resume point (pass back as `gatewayAfter`): the last order handled — or the incoming `gatewayAfter`
   * when nothing was. null once `pageComplete`. Read `pageComplete`, not null, to know the page is done.
   */
  nextAfter:      string | null
  /**
   * F3 — flagged orders on this page whose id is not usable (fails isSafeId). PAGE-level and the same
   * on every request for the page (not additive): never sent to the gateway, never read, never part
   * of `pageCandidates` / the continuation, so `pageComplete` means "every CHECKABLE order handled".
   * Each one is reported as an inconclusive `gateway_order_id_unverifiable` finding on the request
   * that STARTS the page (no `gatewayAfter`).
   */
  pageUnverifiable: number
}

/** RegisterDesk's own view of the flagged top-ups (bounded getAll reads), then the gateway report. */
async function gatewayEvidenceFor(
  orderIds: string[], after: string | null, provider: GatewayEvidenceProvider, deadlineAtMs: number,
): Promise<GatewayPageReport> {
  // Candidates in scan order. Order ids ARE walletTopups document ids (ASCII — isSafeId), so
  // string order is the document-id order the S2 page was read in, and "after" is unambiguous.
  const candidates = orderIds.filter(isSafeId).filter(id => after === null || id > after).sort()
  // F3 — an id that fails validation is never looked up, never sent and never a continuation point
  // (it could not be passed back as `gatewayAfter`); it is COUNTED and reported as unverifiable.
  const unsafe = orderIds.filter(id => !isSafeId(id))
  const withPosition = (report: GatewayReport, handled: number): GatewayPageReport => {
    const pageComplete = handled === candidates.length
    return {
      ...report, deferred: candidates.length - handled,
      pageCandidates: candidates.length, missing: handled - report.checked, pageComplete,
      nextAfter: pageComplete ? null : handled > 0 ? candidates[handled - 1] : after,
      pageUnverifiable: unsafe.length,
    }
  }
  // Disabled (production): nothing is read and nothing is called — and no finding is produced (this
  // report carries no evidence of any kind); the unusable ids are still counted.
  if (provider.source === 'disabled') return withPosition(await collectGatewayEvidence(candidates.map(orderId => emptyInput(orderId)), provider), 0)
  const withUnverifiable = (r: GatewayPageReport): GatewayPageReport =>
    after === null && unsafe.length > 0 ? { ...r, findings: [...unsafe.map(unverifiableOrderIdFinding), ...r.findings] } : r
  const ids = candidates.slice(0, GATEWAY_REPORT_LIMITS.maxOrders)
  if (ids.length === 0) return withUnverifiable(withPosition(await collectGatewayEvidence([], provider, { deadlineAtMs }), 0))
  const [topups, records] = await Promise.all([
    adminDb.getAll(...ids.map(id => adminDb.doc(`walletTopups/${id}`))),
    adminDb.getAll(...ids.map(id => adminDb.doc(`walletTopupReconciliation/${id}`))),
  ])
  const inputs: GatewayTopupInput[] = []
  ids.forEach((orderId, i) => {
    if (!topups[i].exists) return
    const t = topups[i].data() as Rec
    const r = records[i].exists ? records[i].data() as Rec : null
    const known = r ? [...(Array.isArray(r.paymentIds) ? r.paymentIds.filter((v): v is string => typeof v === 'string') : []), ...(str(r.paymentId) ? [str(r.paymentId)!] : [])] : []
    inputs.push({
      orderId, uid: str(t.uid), amountPaise: int(t.amountPaise), currency: str(t.currency),
      status: str(t.status), paymentId: str(t.paymentId), knownPaymentIds: [...new Set(known)],
    })
  })
  const report = await collectGatewayEvidence(inputs, provider, { deadlineAtMs })
  // Handled = the batch prefix before the first UNCHECKED input (a missing top-up inside it had
  // nothing to check). An early stop — deadline, budget or circuit — therefore resumes at the first
  // unchecked order, and a missing document never moves the position past a pending one.
  const firstPending = inputs[report.checked]?.orderId
  return withUnverifiable(withPosition(report, firstPending === undefined ? ids.length : ids.indexOf(firstPending)))
}
const emptyInput = (orderId: string): GatewayTopupInput =>
  ({ orderId, uid: null, amountPaise: null, currency: null, status: null, paymentId: null, knownPaymentIds: [] })

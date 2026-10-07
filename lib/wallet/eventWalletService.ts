// lib/wallet/eventWalletService.ts
// RD-WALLET-EVT-01 — the organizer's event-wise Wallet READ MODEL. Server-only. READ-ONLY.
//
// It owns no data and computes no money of its own: every figure is read from the record that
// already owns it, through the function that already derives it —
//   registrations  eventLicenses + registrationCounters + events, derived exactly as the License
//                  Center does (app/api/organizer/licenses/[eventId]): a capacity licence uses
//                  deriveStoredEventCapacity, a tier licence resolveEffectiveEventLicense;
//   services       eventServiceAllowances/{draftId} through viewOf — the activation-status view —
//                  with the same owner check readDraftCoverage applies; prepaid capacity of an
//                  event that is not live yet comes from readDraftCoverage itself;
//   photos         the upload gate's rule (RD-PHOTO-01, media-studio/uploads/prepare): capacity =
//                  the event's PAID photo units only (no free base); used = pending + ready photos;
//   paid           licenseOrders with status 'paid' for the event (its slug or its draft id);
//   communication  usage COUNTS from communicationUsage by `eventSlug` (the one key every writer
//                  sets consistently — `eventId` is not), wallet MONEY from the walletTransactions
//                  ledger (a usage record can exist for a charge the wallet never took).
//
// Ownership: events are the workspace's own drafts (users/{uid}/eventDrafts); a draft's slug is
// trusted only once events/{slug} or eventLicenses/{slug} confirms the same owner; every query is
// filtered by organizerUid. Bounded: a page is at most WALLET_EVENTS_PAGE_MAX events, the draft
// scan stops at SCAN_LIMIT, and per-event reads happen only for the events on the page. Nothing is
// written — no balance, allowance, order or cursor.

import { AggregateField } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { effectiveLifecycleStatus } from '@/lib/events/listingTabs'
import { EVENT_LICENSES_COLLECTION, LICENSE_ORDERS_COLLECTION, type EventLicenseDoc } from '@/lib/licensing/schema'
import { isValidTierForVersion, isUnlimited } from '@/lib/licensing/eventLicense'
import { getLicenseCatalog, getLicenseCatalogV2 } from '@/lib/licensing/resolveCatalog'
import { pickVersionedDefinition } from '@/lib/licensing/licenseCatalogShared'
import { resolveEffectiveEventLicense } from '@/lib/licensing/adminLicense'
import { deriveStoredEventCapacity } from '@/lib/registrations/capacity'
import { readDraftCoverage } from '@/lib/licensing/draftCoverage'
import { EVENT_SERVICE_ALLOWANCES, viewOf, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { SERVICE_KINDS, type ServiceKind } from '@/lib/licensing/serviceAllowances'
import { photoCapacityUsageQuery } from '@/features/media-studio/repositories/assetRepo'
import { maxAdditionalPhotos } from '@/lib/licensing/photoCapacity'
import {
  todayIn, walletEventPhase, orderPurposeLabel,
  type Measured, type PhotoLine, type RegistrationLine, type ServiceLine, type WalletEventDetail,
  type WalletEventPayment, type WalletEventPhase, type WalletEventRow, type WalletEventsPage,
} from './eventWalletView'

export const WALLET_EVENTS_PAGE_DEFAULT = 10
export const WALLET_EVENTS_PAGE_MAX     = 15        // ≤ 30 ids per licenseOrders `in` query (slug + draft id)
const SCAN_BATCH = 100
const SCAN_LIMIT = 600

type Rec = Record<string, unknown>
const obj = (v: unknown): Rec => (v && typeof v === 'object' ? v as Rec : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)
const isoOf = (v: unknown): string | null =>
  v && typeof (v as { toDate?: () => Date }).toDate === 'function' ? (v as { toDate: () => Date }).toDate().toISOString() : null
const ok = <T,>(value: T): Measured<T> => ({ ok: true, value })
const UNAVAILABLE = { ok: false as const, reason: 'unavailable' as const }

// ── drafts ──────────────────────────────────────────────────────────────────────────────────────
export interface DraftFacts {
  draftId: string; claimedSlug: string | null; name: string; eventType: string | null; campaignType: string | null
  lifecycle: ReturnType<typeof effectiveLifecycleStatus>; startDate: string | null; endDate: string | null; timezone: string | null
  searchText: string
}

export function draftFacts(draftId: string, d: Rec): DraftFacts {
  const details = obj(d.eventDetails), info = obj(details.info), seo = obj(details.seo), sched = obj(details.schedule)
  const org = obj(details.organizer), phys = obj(obj(details.venue).physical)
  return {
    draftId,
    claimedSlug:  str(seo.urlSlug),
    name:         str(info.name) ?? 'Untitled event',
    eventType:    str(d.eventType),
    campaignType: str(d.campaignType),
    lifecycle:    effectiveLifecycleStatus(d),
    startDate:    str(sched.startDate),
    endDate:      str(sched.endDate),
    timezone:     str(sched.timezone),
    // The same searchable fields as the Events listing (app/api/organizer/events).
    searchText:   [info.name, seo.urlSlug, org.name, phys.name, phys.city, phys.addressLine1]
      .filter((v): v is string => typeof v === 'string').join(' ').toLowerCase(),
  }
}

const phaseOf = (f: DraftFacts, now: Date): WalletEventPhase =>
  walletEventPhase(f.lifecycle, f.startDate, f.endDate, todayIn(f.timezone, now))

// ── per-page loading (batched) ──────────────────────────────────────────────────────────────────
interface PageContext {
  uid: string
  facts: DraftFacts[]
  verifiedSlug: Map<string, string>               // draftId → slug confirmed as this workspace's
  licence: Map<string, EventLicenseDoc>           // slug → licence (owner-checked)
  eventDoc: Map<string, Rec>                      // slug → events doc (owner-checked)
  used: Map<string, number>                       // slug → registrationCounters.totalCount
  ledger: Map<string, ServiceLedgerDoc>           // draftId → ledger (owner-checked)
  orders: Measured<Rec[]>                         // this page's events' licence orders
  catalogs: Promise<[Awaited<ReturnType<typeof getLicenseCatalog>>, Awaited<ReturnType<typeof getLicenseCatalogV2>>]>
}

async function loadPage(uid: string, facts: DraftFacts[]): Promise<PageContext> {
  const slugs = [...new Set(facts.map(f => f.claimedSlug).filter((s): s is string => !!s))]
  const ids   = facts.map(f => f.draftId)
  const [eventSnaps, licSnaps, counterSnaps, ledgerSnaps] = await Promise.all([
    slugs.length ? adminDb.getAll(...slugs.map(s => adminDb.doc(`events/${s}`))) : Promise.resolve([]),
    slugs.length ? adminDb.getAll(...slugs.map(s => adminDb.collection(EVENT_LICENSES_COLLECTION).doc(s))) : Promise.resolve([]),
    slugs.length ? adminDb.getAll(...slugs.map(s => adminDb.doc(`registrationCounters/${s}`))) : Promise.resolve([]),
    ids.length ? adminDb.getAll(...ids.map(id => adminDb.collection(EVENT_SERVICE_ALLOWANCES).doc(id))) : Promise.resolve([]),
  ])
  const eventDoc = new Map<string, Rec>(), licence = new Map<string, EventLicenseDoc>(), used = new Map<string, number>()
  slugs.forEach((s, i) => {
    const ev = eventSnaps[i]?.exists ? eventSnaps[i].data() as Rec : null
    const lic = licSnaps[i]?.exists ? licSnaps[i].data() as EventLicenseDoc : null
    if (ev && ev.uid === uid) eventDoc.set(s, ev)
    if (lic && lic.organizerUid === uid) licence.set(s, lic)
    if (counterSnaps[i]?.exists) used.set(s, (counterSnaps[i].data() as { totalCount?: number }).totalCount ?? 0)
  })
  const verifiedSlug = new Map<string, string>()
  for (const f of facts) if (f.claimedSlug && (eventDoc.has(f.claimedSlug) || licence.has(f.claimedSlug))) verifiedSlug.set(f.draftId, f.claimedSlug)
  const ledger = new Map<string, ServiceLedgerDoc>()
  ids.forEach((id, i) => {
    const l = ledgerSnaps[i]?.exists ? ledgerSnaps[i].data() as ServiceLedgerDoc : null
    if (l && typeof l.organizerUid === 'string' && l.organizerUid === uid) ledger.set(id, l)   // readDraftCoverage's owner rule
  })
  // Activation / add-on orders key the draft id; capacity orders key the slug. One bounded query.
  const keys = [...new Set([...ids, ...verifiedSlug.values()])].slice(0, 30)
  let orders: Measured<Rec[]> = ok([])
  if (keys.length > 0) {
    try {
      const snap = await adminDb.collection(LICENSE_ORDERS_COLLECTION)
        .where('organizerUid', '==', uid).where('eventId', 'in', keys).limit(500).get()
      orders = ok(snap.docs.map(d => ({ ...d.data(), orderId: d.id })))
    } catch { orders = UNAVAILABLE }
  }
  return {
    uid, facts, verifiedSlug, licence, eventDoc, used, ledger, orders,
    catalogs: Promise.all([getLicenseCatalog(), getLicenseCatalogV2()]),
  }
}

// ── lines ───────────────────────────────────────────────────────────────────────────────────────
async function registrationLine(ctx: PageContext, f: DraftFacts): Promise<RegistrationLine> {
  if (f.campaignType === 'donation_only') return { state: 'not_applicable', reason: 'donation_campaign' }
  const slug = ctx.verifiedSlug.get(f.draftId)
  const lic = slug ? ctx.licence.get(slug) : undefined
  if (slug && lic) {
    try {
      // EXACTLY the License Center derivation (app/api/organizer/licenses/[eventId]).
      const isCapacityModel = lic.commercialModel === 'capacity'
      const used = ctx.used.get(slug) ?? 0
      let limit: number | null
      if (isCapacityModel) {
        limit = deriveStoredEventCapacity((ctx.eventDoc.get(slug) ?? null) as Parameters<typeof deriveStoredEventCapacity>[0])
      } else {
        const [catalog, catalogV2] = await ctx.catalogs
        const version = typeof lic.version === 'number' && lic.version >= 1 ? lic.version : 1
        const tier    = isValidTierForVersion(lic.tier, version) ? lic.tier : 'starter'
        const eff     = resolveEffectiveEventLicense(pickVersionedDefinition(catalog, catalogV2, tier, version), lic.status, lic.amountPaise ?? 0, lic.admin)
        const max     = eff.definition.limits.maxRegistrations
        limit = isUnlimited(max) ? null : max
      }
      return limit == null
        ? { state: 'unlimited', used, capacityModel: isCapacityModel }
        : { state: 'limited', limit, used, remaining: Math.max(0, limit - used), capacityModel: isCapacityModel }
    } catch { return { state: 'unavailable' } }
  }
  // Not live yet: what the draft has PAID for (activation-status's own reader).
  try {
    const cov = await readDraftCoverage(f.draftId, ctx.uid)
    if (cov.paidCapacity != null) return { state: 'prepaid', paidCapacity: cov.paidCapacity }
  } catch { return { state: 'unavailable' } }
  const live = f.lifecycle === 'published' || f.lifecycle === 'registration_closed' || f.lifecycle === 'completed' || f.lifecycle === 'cancelled'
  return { state: 'not_applicable', reason: live ? 'no_licence' : 'not_published' }
}

function serviceLines(ctx: PageContext, draftId: string): Record<ServiceKind, ServiceLine> {
  const ledger = ctx.ledger.get(draftId)
  const v = viewOf(ledger)
  return Object.fromEntries(SERVICE_KINDS.map(k => [k, {
    service: k, purchased: v.purchased[k], consumed: v.consumed[k], remaining: v.remaining[k],
    onExhausted: v.purchased[k] > 0 ? (ledger?.[k]?.onExhausted ?? null) : null,
    carriedIn: v.carriedIn[k], carriedOut: v.carriedOut[k], refunded: v.refunded[k],
  } satisfies ServiceLine])) as Record<ServiceKind, ServiceLine>
}

async function countOrNull(q: FirebaseFirestore.Query): Promise<Measured<number>> {
  try { return ok((await q.count().get()).data().count) } catch { return UNAVAILABLE }
}
async function sumOrNull(q: FirebaseFirestore.Query, field: string): Promise<Measured<number>> {
  try { return ok(Number((await q.aggregate({ s: AggregateField.sum(field) }).get()).data().s ?? 0)) } catch { return UNAVAILABLE }
}

async function photoLine(ctx: PageContext, f: DraftFacts, purchasedMedia: number): Promise<PhotoLine> {
  // RD-PHOTO-01 — the upload gate's own rule: capacity is the PAID photo units only (no free base,
  // no licence-tier limit); used is every photo occupying a unit (stored + in-flight uploads).
  const stored = await countOrNull(photoCapacityUsageQuery(ctx.uid, f.draftId))
  const purchased = Math.max(0, Math.trunc(purchasedMedia))
  return { state: 'limited', baseCap: 0, purchased, cap: purchased, stored, maxAdditional: maxAdditionalPhotos(purchased) }
}

function eventOrders(ctx: PageContext, f: DraftFacts): Measured<Rec[]> {
  if (!ctx.orders.ok) return UNAVAILABLE
  const slug = ctx.verifiedSlug.get(f.draftId)
  return ok(ctx.orders.value.filter(o => o.organizerUid === ctx.uid && (o.eventId === f.draftId || (slug !== undefined && o.eventId === slug))))
}

async function buildRow(ctx: PageContext, f: DraftFacts, now: Date): Promise<WalletEventRow> {
  const slug = ctx.verifiedSlug.get(f.draftId) ?? null
  const services = serviceLines(ctx, f.draftId)
  const [registrations, photos, whatsappBilledMessages] = await Promise.all([
    registrationLine(ctx, f),
    // The upload gate's own figure: purchased + carried in − carried out − refunded (prepare route).
    photoLine(ctx, f, Math.max(0, services.media.purchased + services.media.carriedIn - services.media.carriedOut - services.media.refunded)),
    slug ? sumOrNull(adminDb.collection('communicationUsage')
      .where('organizerUid', '==', ctx.uid).where('eventSlug', '==', slug).where('channel', '==', 'whatsapp'), 'quantity')
      : Promise.resolve(null),
  ])
  const orders = eventOrders(ctx, f)
  return {
    draftId: f.draftId, slug, name: f.name, eventType: f.eventType, lifecycle: f.lifecycle, phase: phaseOf(f, now),
    startDate: f.startDate, endDate: f.endDate, registrations, services, photos, whatsappBilledMessages,
    paidPaise: orders.ok
      ? ok(orders.value.filter(o => o.status === 'paid').reduce((s, o) => s + (typeof o.amountPaise === 'number' ? o.amountPaise : 0), 0))
      : UNAVAILABLE,
  }
}

// ── public API ──────────────────────────────────────────────────────────────────────────────────
export async function listWalletEvents(uid: string, opts: {
  phase?: WalletEventPhase | null; search?: string | null; cursor?: string | null; limit?: number; now?: Date
} = {}): Promise<WalletEventsPage> {
  const now = opts.now ?? new Date()
  const pageSize = Math.max(1, Math.min(WALLET_EVENTS_PAGE_MAX, Math.trunc(opts.limit ?? WALLET_EVENTS_PAGE_DEFAULT)))
  const term = (opts.search ?? '').trim().toLowerCase().slice(0, 100)
  const drafts = adminDb.collection(`users/${uid}/eventDrafts`)
  let from: FirebaseFirestore.DocumentSnapshot | null = null
  if (opts.cursor && /^[A-Za-z0-9_-]{1,128}$/.test(opts.cursor)) {
    const c = await drafts.doc(opts.cursor).get()
    if (c.exists) from = c
  }
  // Bounded scan, newest first (the Events listing's order), until one match past the page.
  const matched: DraftFacts[] = []
  let examined = 0, last: FirebaseFirestore.QueryDocumentSnapshot | null = null, exhausted = false
  while (matched.length <= pageSize && examined < SCAN_LIMIT) {
    const want = Math.min(SCAN_BATCH, SCAN_LIMIT - examined)
    let q = drafts.orderBy('updatedAt', 'desc').limit(want)
    const after = last ?? from
    if (after) q = q.startAfter(after)
    const batch = await q.get()
    for (const doc of batch.docs) {
      examined++; last = doc
      const f = draftFacts(doc.id, doc.data() as Rec)
      if ((opts.phase && phaseOf(f, now) !== opts.phase) || (term && !f.searchText.includes(term))) continue
      matched.push(f)
      if (matched.length > pageSize) break
    }
    if (matched.length > pageSize) break
    if (batch.size < want) { exhausted = true; break }
  }
  const more = matched.length > pageSize
  const page = matched.slice(0, pageSize)
  // The cursor is the last draft EXAMINED for this page: nothing is skipped, nothing repeated.
  const lastOfPage = more ? page[page.length - 1].draftId : null
  const scanLimited = !more && !exhausted && examined >= SCAN_LIMIT
  const nextCursor = more ? lastOfPage : scanLimited && last ? last.id : null
  if (page.length === 0) return { events: [], nextCursor, scanLimited }
  const ctx = await loadPage(uid, page)
  const events = await Promise.all(page.map(f => buildRow(ctx, f, now)))
  return { events, nextCursor, scanLimited }
}

/** null when the draft is not this workspace's (the route answers 404 — nothing is revealed). */
export async function getWalletEventDetail(uid: string, draftId: string, now: Date = new Date()): Promise<WalletEventDetail | null> {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(draftId)) return null
  const snap = await adminDb.doc(`users/${uid}/eventDrafts/${draftId}`).get()
  if (!snap.exists) return null
  const f = draftFacts(snap.id, snap.data() as Rec)
  const ctx = await loadPage(uid, [f])
  const slug = ctx.verifiedSlug.get(f.draftId) ?? null
  const usage = (channel: 'email' | 'whatsapp') => slug
    ? sumOrNull(adminDb.collection('communicationUsage')
      .where('organizerUid', '==', uid).where('eventSlug', '==', slug).where('channel', '==', channel), 'quantity')
    : Promise.resolve(null)
  // Wallet money for this event = ledger rows that REFERENCE it (lib/wallet/eventWalletView txnEventRef):
  // metadata.eventSlug (WhatsApp) + certificate charges keyed by the draft id.
  const ledger = adminDb.collection('walletTransactions')
  const bySlug = slug ? ledger.where('organizerUid', '==', uid).where('metadata.eventSlug', '==', slug) : null
  // RD-INTEG · D3 — a broadcast's unaccepted share comes back as a CREDIT row on the same event;
  // amounts are stored unsigned, so credits are summed separately and netted out below.
  // Equality-only (index-merge, no composite index): the only CREDIT that records an event slug is
  // the broadcast settlement's 'refund' row (licence refunds reference the event by referenceId).
  const bySlugCredit = bySlug ? bySlug.where('type', '==', 'refund') : null
  const byCert = ledger.where('organizerUid', '==', uid).where('type', '==', 'certificate_charge').where('metadata.eventId', '==', f.draftId)
  const licenceOrderId = slug ? ctx.licence.get(slug)?.orderId ?? null : null
  // The License Center's key: the activation order's draft id, else the event (slug) itself.
  const licenceDraftKey = licenceOrderId?.startsWith('lic_') ? licenceOrderId.slice(4) : slug
  const [event, emailMessages, whatsappMessages, slugSum, slugCount, certSum, certCount, licenceCharge, creditSum, creditCount] = await Promise.all([
    buildRow(ctx, f, now),
    usage('email'), usage('whatsapp'),
    bySlug ? sumOrNull(bySlug, 'amountPaise') : Promise.resolve(ok(0)),
    bySlug ? countOrNull(bySlug) : Promise.resolve(ok(0)),
    sumOrNull(byCert, 'amountPaise'), countOrNull(byCert),
    // License Center's "paid from wallet" figure (legacy wallet-first activations).
    slug ? adminDb.doc(`walletTransactions/license_${licenceDraftKey}`).get().catch(() => null) : Promise.resolve(null),
    bySlugCredit ? sumOrNull(bySlugCredit, 'amountPaise') : Promise.resolve(ok(0)),
    bySlugCredit ? countOrNull(bySlugCredit) : Promise.resolve(ok(0)),
  ])
  const add = (a: Measured<number>, b: Measured<number>): Measured<number> => (a.ok && b.ok ? ok(a.value + b.value) : UNAVAILABLE)
  const neg = (a: Measured<number>): Measured<number> => (a.ok ? ok(-a.value) : UNAVAILABLE)
  const orders = eventOrders(ctx, f)
  const payments: WalletEventPayment[] = orders.ok
    ? orders.value
      .filter(o => o.status === 'paid' || o.status === 'refunded')
      .map(o => ({
        orderId: String(o.orderId), purpose: orderPurposeLabel(o.purpose), status: o.status as 'paid' | 'refunded',
        amountPaise: typeof o.amountPaise === 'number' ? o.amountPaise : 0, paidAt: isoOf(o.paidAt) ?? isoOf(o.updatedAt),
      }))
      .sort((a, b) => (b.paidAt ?? '').localeCompare(a.paidAt ?? ''))
    : []
  // Read exactly as the License Center reads it: the row keyed by the (owner-verified) licence's order.
  const licenceWalletPaid = licenceCharge && licenceCharge.exists
    ? Number((licenceCharge.data() as { amountPaise?: number }).amountPaise ?? 0) : 0
  return {
    event, payments, licenceWalletPaidPaise: licenceWalletPaid,
    communication: {
      emailMessages, whatsappMessages,
      // Net of credits: (all rows − credits) is the debits; minus credits again is the net charge.
      walletChargesPaise: add(add(slugSum, certSum), neg(add(creditSum, creditSum))),
      walletChargeCount:  add(add(slugCount, certCount), neg(creditCount)),
    },
    links: {
      licenceCenter:    slug && ctx.licence.has(slug) ? `/dashboard/settings/billing/licenses/${encodeURIComponent(slug)}` : null,
      // The existing way into an event's setup (the Events "Edit" action); License & Services is its final step.
      servicesPurchase: `/dashboard/events/new/visibility?draftId=${encodeURIComponent(f.draftId)}`,
    },
  }
}

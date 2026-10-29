// POST /api/licensing/checkout/quote — RD-EVENT-COMMERCE-02 / 03
//
// The License & Services page's LIVE quote: capacity + prepaid service quantities in, an
// itemized server-computed breakdown out. Read-only — no order, no Razorpay call, no write.
//
//   body     { eventId?: draftId, capacity: number, services?: { whatsapp?, certificates?, media? } }
//   returns  { mode, catalog, capacity, services, totals, payable, coverage, published, media }
//
// TWO MODES, decided by the SERVER-written draft status (clients cannot write it):
//
//   draft      `capacity` is the activation target and `services` the TOTAL units wanted. Payable
//              is the full selection until the activation is paid, then the DIFFERENCE.
//   published  (published or pending_review) `capacity` is the new TARGET for the live event and
//              `services` are ADDITIONAL units. The capacity line is the change quote (increase,
//              or decrease with its approved fee) measured from the ENFORCED capacity, and never
//              below the registrations already taken.
//
// `payable` is null when any requested item cannot be quoted — payment is then refused, never
// silently priced as free. Nothing here is authoritative: the purchase routes re-validate and
// re-price from scratch (and refuse a stale total); this shows the server's arithmetic.

import { NextRequest, NextResponse } from 'next/server'
import { authorizeWorkspace } from '@/lib/team/workspace'
import { adminDb }             from '@/lib/firebase/admin'
import { calculateActivationQuote, quoteCapacityChange, type CapacityQuote } from '@/lib/licensing/capacityPricing'
import { getGlobalCommercialTerms } from '@/lib/licensing/resolveCommercialTerms'
import {
  SERVICE_KINDS, parseServiceSelection, validateServiceQuantity, priceServiceItem, serviceAvailability, saleStateMessage,
  sumServiceItems, type ServiceChargeItem, type ServiceKind,
} from '@/lib/licensing/serviceAllowances'
import { getServiceCatalog } from '@/lib/licensing/serviceAllowanceConfig'
import { readDraftCoverage, quoteAddon } from '@/lib/licensing/draftCoverage'
import { communicationCapacityFigures, type CapacityActivity } from '@/lib/communications/capacityFigures'
import { readWhatsAppCapacityActivity } from '@/lib/communications/capacityActivity'
import { isSubmittedDraftStatus } from '@/lib/events/builder/stepRegistry'
import { resolveCapacityEventSlug, loadCapacityChangeContext, readSoldCount, isPurchaseEligibleLifecycle } from '@/lib/licensing/capacityChange'
import { photoCapacityUsageQuery } from '@/features/media-studio/repositories/assetRepo'
import { MAX_EVENT_PHOTO_CAPACITY, maxAdditionalPhotos } from '@/lib/licensing/photoCapacity'
import { readEventPhotoLedger, checkPhotoSelection, type EventPhotoLedger } from '@/lib/licensing/photoCapacityServer'
import { readLegacyEntitlement, type LegacyEntitlement } from '@/lib/licensing/legacyEntitlement'

export const dynamic = 'force-dynamic'
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
const noStore = { 'Cache-Control': 'no-store' }

type ServiceResult = { ok: true; item: ServiceChargeItem | null } | { ok: false; code: string; error: string }

export async function POST(req: NextRequest): Promise<NextResponse> {
  // RD-CE-FIX M5 · the same gate as the rest of licensing (capacity/*, checkout/confirm): verified
  // token, the workspace it acts for, suspension of caller OR owner, and the `events` permission —
  // a check-in-only or finance member, or a suspended workspace, cannot buy or read licences here.
  const authz = await authorizeWorkspace(req, 'events')
  if (!authz.ok) return NextResponse.json({ error: authz.error }, { status: authz.status })

  let body: { eventId?: unknown; capacity?: unknown; services?: unknown }
  try { body = await req.json() as typeof body } catch { return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 }) }

  const parsed = parseServiceSelection(body.services)
  if (!parsed.ok) return NextResponse.json({ error: parsed.message }, { status: 400, headers: noStore })
  const selection = parsed.selection

  const [globalTerms, serviceCatalog] = await Promise.all([getGlobalCommercialTerms(), getServiceCatalog()])
  const catalogCfg = serviceCatalog.config

  // ── Which event, and in which mode ────────────────────────────────────────────────
  const eventId = typeof body.eventId === 'string' ? body.eventId.trim() : ''
  let ownedDraft = false, submitted = false, uid: string | null = null
  if (eventId && EVENT_ID_RE.test(eventId)) {
    uid = authz.workspaceUid
    const draft = await adminDb.doc(`users/${uid}/eventDrafts/${eventId}`).get()
    ownedDraft = draft.exists
    submitted  = draft.exists && isSubmittedDraftStatus(draft.get('status'))
  }

  // ── Published context (enforced capacity, sold, lifecycle) ────────────────────────
  let published: { slug: string; currentCapacity: number; sold: number; eligible: boolean; terms: typeof globalTerms } | null = null
  let publishedError: string | null = null
  if (submitted && uid) {
    const r = await resolveCapacityEventSlug(eventId, uid)
    if (!r.ok) publishedError = r.message
    else {
      const [loaded, sold, evSnap] = await Promise.all([loadCapacityChangeContext(r.slug, uid), readSoldCount(r.slug), adminDb.collection('events').doc(r.slug).get()])
      if (!loaded.ok) publishedError = loaded.message
      else published = { slug: r.slug, currentCapacity: loaded.ctx.currentCapacity, sold, eligible: isPurchaseEligibleLifecycle(evSnap.data()), terms: loaded.ctx.terms }
    }
  }

  // ── RD-PHOTO-01 · the event's PAID photo capacity (no free base; max 3,000 per event) ─────
  let media: {
    baseCap: number | null; used: number | null
    capacity: number; purchased: number; maxTotal: number; maxAdditional: number
  } = { baseCap: 0, used: null, capacity: 0, purchased: 0, maxTotal: MAX_EVENT_PHOTO_CAPACITY, maxAdditional: MAX_EVENT_PHOTO_CAPACITY }
  let photoLedger: EventPhotoLedger = { capacity: 0, purchased: 0 }
  if (ownedDraft && uid) {
    const [ledger, used] = await Promise.all([
      readEventPhotoLedger(uid, eventId),
      photoCapacityUsageQuery(uid, eventId).count().get().then(s => s.data().count).catch(() => null),
    ])
    photoLedger = ledger
    media = { baseCap: 0, used, capacity: ledger.capacity, purchased: ledger.purchased, maxTotal: MAX_EVENT_PHOTO_CAPACITY, maxAdditional: maxAdditionalPhotos(ledger.capacity) }
  }

  // ── Catalog (what the page may offer, and why not) ────────────────────────────────
  const catalog = Object.fromEntries(SERVICE_KINDS.map(k => {
    const c = catalogCfg[k], a = serviceAvailability(c)
    const missing = [...a.missing]
    // RD-EVENT-COMMERCE-05 — WHY it is (not) for sale, plus the one organizer-facing sentence.
    const saleState = serviceCatalog.state[k]
    const state = saleState
    return [k, {
      purchasable: missing.length === 0 && state === 'available', missing, state,
      stateMessage: saleStateMessage(k, state, a.missing),
      minQuantity: c.minQuantity, maxQuantity: c.maxQuantity, presets: c.presets,
      unitPricePaise: c.unitPricePaise, gstRatePercent: c.gstRatePercent, onExhausted: c.onExhausted,
    }]
  })) as unknown as Record<ServiceKind, { purchasable: boolean }>

  // ── Capacity line ─────────────────────────────────────────────────────────────────
  let capacity: { ok: true; quote: CapacityQuote } | { ok: false; code: string; error: string }
  if (published) {
    const target = body.capacity === undefined || body.capacity === null ? published.currentCapacity : body.capacity
    const q = quoteCapacityChange({ currentCapacity: published.currentCapacity, newCapacity: target, terms: published.terms })
    capacity = !q.ok ? { ok: false, code: q.code, error: q.message }
      : q.quote.capacity < published.sold
        ? { ok: false, code: 'BELOW_SOLD', error: `${published.sold.toLocaleString('en-IN')} registrations are already taken, so capacity cannot go below ${published.sold.toLocaleString('en-IN')}.` }
        : { ok: true, quote: q.quote }
  } else if (submitted) {
    capacity = { ok: false, code: 'EVENT_NOT_FOUND', error: publishedError ?? 'This event could not be loaded.' }
  } else {
    const cq = calculateActivationQuote({ capacity: body.capacity, terms: globalTerms })
    capacity = cq.ok ? { ok: true, quote: cq.quote } : { ok: false, code: cq.code, error: cq.message }
  }

  // ── Service lines (draft: total units; published: ADDITIONAL units) ───────────────
  const services = {} as Record<ServiceKind, ServiceResult>
  const items: ServiceChargeItem[] = []
  for (const k of SERVICE_KINDS) {
    const check = validateServiceQuantity(k, selection[k], catalogCfg[k])
    if (!check.ok) {
      // RD-EVENT-COMMERCE-05 — a not-for-sale refusal names the ACTUAL reason.
      const error = check.code === 'NOT_PURCHASABLE' ? saleStateMessage(k, serviceCatalog.state[k], serviceAvailability(catalogCfg[k]).missing) || check.message : check.message
      services[k] = { ok: false, code: check.code, error }; continue
    }
    // RD-PHOTO-01 — never past 3,000 photos for the event (draft: total; published: additional).
    if (k === 'media' && check.quantity > 0) {
      const fits = checkPhotoSelection(published ? 'published' : 'draft', check.quantity, photoLedger)
      if (!fits.ok) { services[k] = { ok: false, code: fits.code, error: fits.message }; continue }
    }
    const item = check.quantity > 0 ? priceServiceItem(k, check.quantity, catalogCfg[k]) : null
    if (item) items.push(item)
    services[k] = { ok: true, item }
  }
  const allValid = capacity.ok && SERVICE_KINDS.every(k => services[k].ok)

  // For a published event the capacity line only counts when capacity actually changes.
  const capLine = capacity.ok && !(published && capacity.quote.kind === 'unchanged') ? capacity.quote : null
  const totals = {
    activationPaise: capLine?.totalPaise ?? 0,
    servicesPaise:   sumServiceItems(items),
    basePaise:       (capLine?.basePaise ?? 0) + items.reduce((n, i) => n + i.basePaise, 0),
    gstPaise:        (capLine?.gstPaise ?? 0) + items.reduce((n, i) => n + i.gstPaise, 0),
    totalPaise:      (capLine?.totalPaise ?? 0) + sumServiceItems(items),
  }

  // ── Coverage (paid orders + allowance ledger) ──────────────────────────────────────
  let coverage: Awaited<ReturnType<typeof readDraftCoverage>> | null = null
  if (ownedDraft && uid) {
    const c = await readDraftCoverage(eventId, uid)
    if (!c.activation || c.activation.organizerUid === uid) coverage = c
  }
  // RD-COMMS-L2 — the communication figures in the ONE organizer definition shared with
  // Communications › Usage. An event that never had WhatsApp capacity holds nothing (no read);
  // an unreadable activity leaves Used / In progress unknown ("—"), never guessed.
  let whatsappActivity: CapacityActivity | null = { inProgress: 0, returned: 0 }
  if (coverage && uid && coverage.purchased.whatsapp + coverage.carriedIn.whatsapp > 0) {
    whatsappActivity = await readWhatsAppCapacityActivity(uid, eventId).catch(() => null)
  }
  // RD-CAPACITY-DEFAULT — a draft whose capacity is still governed by a VERIFIED historical paid tier
  // (the publish route's own rule): the wizard must not persist the free default over it.
  const legacyEntitlement: LegacyEntitlement | null = ownedDraft && !submitted && !published && uid
    ? await readLegacyEntitlement(eventId, uid) : null
  const commLine = (c: NonNullable<typeof coverage>, k: 'whatsapp' | 'certificates') => ({
    purchased: c.purchased[k], consumed: c.consumed[k], carriedIn: c.carriedIn[k],
    carriedOut: c.carriedOut[k], refunded: c.refunded[k], remaining: c.remaining[k],
  })

  type Payable = { kind: 'activation' | 'addon' | 'covered' | 'capacity_change'; capacityCharge: unknown; serviceItems: ServiceChargeItem[]; totalPaise: number }
  let payable: Payable | null = null
  if (allValid && capacity.ok) {
    if (published) {
      if (!published.eligible) payable = null
      else payable = {
        kind: capLine ? 'capacity_change' : items.length > 0 ? 'addon' : 'covered',
        capacityCharge: capLine, serviceItems: items, totalPaise: totals.totalPaise,
      }
    } else if (coverage?.activationPaid && coverage.activation?.commercialModel === 'capacity') {
      const add = quoteAddon({ coverage, capacity: capacity.quote.capacity, services: selection, catalog: catalogCfg })
      payable = add.ok
        ? { kind: add.totalPaise > 0 ? 'addon' : 'covered', capacityCharge: add.capacityCharge, serviceItems: add.serviceItems, totalPaise: add.totalPaise }
        : null
    } else {
      payable = { kind: totals.totalPaise > 0 ? 'activation' : 'covered', capacityCharge: capacity.quote, serviceItems: items, totalPaise: totals.totalPaise }
    }
  }

  return NextResponse.json({
    mode: published ? 'published' : 'draft',
    terms: published?.terms ?? globalTerms, catalog, capacity, services, totals, payable,
    coverage: coverage ? {
      activationPaid: coverage.activationPaid, paidCapacity: coverage.paidCapacity,
      purchased: coverage.purchased, consumed: coverage.consumed, remaining: coverage.remaining,
      communication: {
        whatsapp:     communicationCapacityFigures(commLine(coverage, 'whatsapp'), whatsappActivity),
        certificates: communicationCapacityFigures(commLine(coverage, 'certificates'), { inProgress: 0, returned: null }),
      },
    } : null,
    published: published ? { currentCapacity: published.currentCapacity, sold: published.sold, eligible: published.eligible } : null,
    media,
    legacyEntitlement,
  }, { status: 200, headers: noStore })
}

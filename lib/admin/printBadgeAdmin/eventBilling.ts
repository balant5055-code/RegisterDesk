// RD-PRINT-BILL-P7 · Super Admin reader for ONE event's ID-badge generation billing. Server-only,
// READ-ONLY.
//
// The event is addressed by its live slug (events/{slug}); its draft id keys every billing record:
//   ledger    eventServiceAllowances/{draftId}.print_badges  (purchased, carried, refunded, consumed)
//   usage     eventServiceAllowances/{draftId}/usage  where service == 'print_badges'
//   rounds    printBadgeRounds  where eventId == draftId
//   claims    printBadgeClaims  where eventId == draftId   (registration ids ONLY — no attendee data)
//   jobs      printGenerationJobs where eventId == draftId (billing mode and round)
//   reconciliation  the Phase 5 reconcilePrintBadgeUsage(draftId) — reused, never re-derived here
// Each list is a document-id page with a cursor; each section is read independently and reported
// as unavailable (never as empty or zero) when its read fails.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { ledgerRef, ledgerLine, availableUnits, ALLOWANCE_USAGE_SUBCOLLECTION, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { PRINT_BADGE_CLAIMS, PRINT_BADGE_ROUNDS } from '@/lib/printAssets/badgeBilling/decisions'
import { reconcilePrintBadgeUsage, type BadgeUsageReconciliation } from '@/lib/printAssets/badgeBilling/reconcile'
import { section, pageByDocId, n, numOrNull, str, iso, type Section, type Page } from './common'

export const EVENT_BILLING_PAGE = 25
export const EVENT_BILLING_PAGE_MAX = 100
export const EVENT_BILLING_SECTIONS = ['usage', 'rounds', 'claims', 'jobs'] as const
export type EventBillingSection = typeof EVENT_BILLING_SECTIONS[number]

const PRINT_JOBS = 'printGenerationJobs'
const SLUG_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * A usage record's quantity means different things over its round's life: while the round is OPEN
 * it is the units RESERVED for the run; once SETTLED it was trimmed to the units KEPT (the rest
 * released). `roundStatus` says which: 'reserved' | 'settled' | another stored status; 'no_round'
 * when no billing round has this unit key (not a generation round, or the round is missing);
 * 'unknown' when the round could not be read.
 */
export interface UsageRow { unitKey: string; quantity: number; releasedUnits: number; source: string | null; createdAt: string | null; roundStatus: string }
export interface RoundRow {
  roundId: string; jobId: string | null; round: number; status: string | null
  reserved: number; claimed: number; keptUnits: number | null; releasedUnits: number | null; settledReason: string | null
  quote: { eligible: number | null; previouslyBilled: number | null; chargeable: number | null; unitPricePaise: number | null; quotedChargeable: number | null } | null
  createdAt: string | null; settledAt: string | null
}
export interface ClaimRow { claimId: string; registrationId: string | null; jobId: string | null; round: number | null; mode: string | null; assetType: string | null; claimedAt: string | null }
export interface JobRow {
  jobId: string; status: string | null; assetType: string | null
  counts: { total: number; processed: number; succeeded: number; failed: number }
  billing: { mode: string; round: number } | null; createdAt: string | null
}

export interface EventBillingView {
  event: { slug: string; draftId: string; organizerUid: string | null; name: string | null; lifecycleStatus: string | null }
  ledger?: Section<{
    exists: boolean; ownerMatches: boolean
    purchased: number; carriedIn: number; carriedOut: number; refunded: number; consumed: number; available: number
  }>
  claimCounts?: Section<{ units: number; complimentary: number }>
  usage?: Section<Page<UsageRow>>
  rounds?: Section<Page<RoundRow>>
  claims?: Section<Page<ClaimRow>>
  jobs?: Section<Page<JobRow>>
  reconciliation?: Section<BadgeUsageReconciliation>
}

const toUsage = (d: FirebaseFirestore.QueryDocumentSnapshot): UsageRow => {
  const x = d.data() as Record<string, unknown>
  return { unitKey: d.id, quantity: n(x.quantity), releasedUnits: n(x.releasedUnits), source: str(x.source), createdAt: iso(x.createdAt), roundStatus: 'unknown' }
}

/** Usage key = round doc id (roundUnitKey). One getAll for the page (≤ EVENT_BILLING_PAGE_MAX docs). */
async function withRoundStatus(page: Page<UsageRow>): Promise<Page<UsageRow>> {
  if (!page.items.length) return page
  try {
    const snaps = await adminDb.getAll(...page.items.map(u => adminDb.collection(PRINT_BADGE_ROUNDS).doc(u.unitKey)))
    return { ...page, items: page.items.map((u, i) => ({ ...u, roundStatus: snaps[i].exists ? str(snaps[i].get('status')) ?? 'unknown' : 'no_round' })) }
  } catch (e) {
    console.error('[admin/print-badges] usage round status unavailable', { type: e instanceof Error ? e.name : typeof e })
    return page   // every row stays 'unknown' — never guessed as kept
  }
}
const toRound = (d: FirebaseFirestore.QueryDocumentSnapshot): RoundRow => {
  const x = d.data() as Record<string, unknown>
  const q = x.quote && typeof x.quote === 'object' ? x.quote as Record<string, unknown> : null
  return {
    roundId: d.id, jobId: str(x.jobId), round: n(x.round), status: str(x.status),
    reserved: n(x.reserved), claimed: n(x.claimed), keptUnits: numOrNull(x.keptUnits), releasedUnits: numOrNull(x.releasedUnits),
    settledReason: str(x.settledReason),
    quote: q ? { eligible: numOrNull(q.eligible), previouslyBilled: numOrNull(q.previouslyBilled), chargeable: numOrNull(q.chargeable), unitPricePaise: numOrNull(q.unitPricePaise), quotedChargeable: numOrNull(q.quotedChargeable) } : null,
    createdAt: iso(x.createdAt), settledAt: iso(x.settledAt),
  }
}
/** A claim row carries the registration ID only — never a name, email or phone. */
const toClaim = (d: FirebaseFirestore.QueryDocumentSnapshot): ClaimRow => {
  const x = d.data() as Record<string, unknown>
  return { claimId: d.id, registrationId: str(x.registrationId), jobId: str(x.jobId), round: numOrNull(x.round), mode: str(x.mode), assetType: str(x.assetType), claimedAt: iso(x.claimedAt) }
}
const toJob = (d: FirebaseFirestore.QueryDocumentSnapshot): JobRow => {
  const x = d.data() as Record<string, unknown>
  const c = (x.counts ?? {}) as Record<string, unknown>
  const b = x.billing && typeof x.billing === 'object' ? x.billing as Record<string, unknown> : null
  return {
    jobId: d.id, status: str(x.status), assetType: str(x.assetType),
    counts: { total: n(c.total), processed: n(c.processed), succeeded: n(c.succeeded), failed: n(c.failed) },
    billing: b && (b.mode === 'paid' || b.mode === 'complimentary') ? { mode: b.mode, round: n(b.round) } : null,
    createdAt: iso(x.createdAt),
  }
}

const ID = () => FieldPath.documentId()
const LIST = {
  usage:  (draftId: string, cursor: string | null, limit: number) =>
    pageByDocId(ledgerRef(draftId).collection(ALLOWANCE_USAGE_SUBCOLLECTION).where('service', '==', 'print_badges'), cursor, limit, toUsage, ID()).then(withRoundStatus),
  rounds: (draftId: string, cursor: string | null, limit: number) =>
    pageByDocId(adminDb.collection(PRINT_BADGE_ROUNDS).where('eventId', '==', draftId), cursor, limit, toRound, ID()),
  claims: (draftId: string, cursor: string | null, limit: number) =>
    pageByDocId(adminDb.collection(PRINT_BADGE_CLAIMS).where('eventId', '==', draftId), cursor, limit, toClaim, ID()),
  jobs:   (draftId: string, cursor: string | null, limit: number) =>
    pageByDocId(adminDb.collection(PRINT_JOBS).where('eventId', '==', draftId), cursor, limit, toJob, ID()),
}

export interface EventBillingRequest {
  slug: string
  /** One section's next page only (with `cursor`) — or, when absent, the whole first view. */
  only?: EventBillingSection | null
  cursor?: string | null
  limit?: number
}

/** null when no live event with a draft exists at this slug (the route answers 404). */
export async function getEventBadgeBilling(r: EventBillingRequest): Promise<EventBillingView | null> {
  if (!SLUG_RE.test(r.slug)) return null
  const ev = await adminDb.collection('events').doc(r.slug).get()
  const e = ev.exists ? ev.data() as Record<string, unknown> : null
  const draftId = str(e?.draftId)
  if (!e || !draftId) return null
  const organizerUid = str(e.uid)
  const view: EventBillingView = {
    event: { slug: r.slug, draftId, organizerUid, name: str(e.eventName) ?? str(e.name), lifecycleStatus: str(e.lifecycleStatus) },
  }
  const limit = Math.max(1, Math.min(r.limit ?? EVENT_BILLING_PAGE, EVENT_BILLING_PAGE_MAX))

  if (r.only) {
    const only = r.only, cursor = r.cursor ?? null
    if (only === 'usage') view.usage = await section(only, () => LIST.usage(draftId, cursor, limit))
    if (only === 'rounds') view.rounds = await section(only, () => LIST.rounds(draftId, cursor, limit))
    if (only === 'claims') view.claims = await section(only, () => LIST.claims(draftId, cursor, limit))
    if (only === 'jobs') view.jobs = await section(only, () => LIST.jobs(draftId, cursor, limit))
    return view
  }

  const [ledger, claimCounts, usage, rounds, claims, jobs, reconciliation] = await Promise.all([
    section('ledger', async () => {
      const s = await ledgerRef(draftId).get()
      const doc = s.exists ? s.data() as ServiceLedgerDoc : undefined
      const ownerMatches = !doc || !organizerUid || doc.organizerUid === organizerUid
      const l = ledgerLine(doc, 'print_badges')
      return {
        exists: s.exists, ownerMatches,
        purchased: l.purchased, carriedIn: l.carriedIn, carriedOut: l.carriedOut, refunded: l.refunded, consumed: l.consumed,
        available: availableUnits(l),
      }
    }),
    section('claim counts', async () => {
      const base = adminDb.collection(PRINT_BADGE_CLAIMS).where('eventId', '==', draftId)
      const [u, c] = await Promise.all([base.where('mode', '==', 'units').count().get(), base.where('mode', '==', 'complimentary').count().get()])
      return { units: u.data().count, complimentary: c.data().count }
    }),
    section('usage', () => LIST.usage(draftId, null, limit)),
    section('rounds', () => LIST.rounds(draftId, null, limit)),
    section('claims', () => LIST.claims(draftId, null, limit)),
    section('jobs', () => LIST.jobs(draftId, null, limit)),
    section('reconciliation', () => reconcilePrintBadgeUsage(draftId)),
  ])
  return { ...view, ledger, claimCounts, usage, rounds, claims, jobs, reconciliation }
}

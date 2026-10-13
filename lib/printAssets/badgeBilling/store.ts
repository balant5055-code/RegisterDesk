// RD-PRINT-BILL-P5 · ID-badge GENERATION billing — Firestore. Server-only.
//
// ═══ THE RECORDS ═════════════════════════════════════════════════════════════════
//   printBadgeClaims/{draftId}__{registrationId}         ← create-only; ONE per attendee per event (D1)
//     { claimId, organizerUid, eventId, eventSlug, registrationId, jobId, round, roundId,
//       mode: 'units' | 'complimentary', assetType, claimedAt }
//   printBadgeRounds/{jobId}_r{n}                         ← one reservation of units for one job
//     { roundId, jobId, round, organizerUid, eventId, eventSlug, assetType, unitKey,
//       status: 'reserved' | 'settled', reserved, claimed, quote, createdBy, createdAt,
//       settledAt?, keptUnits?, releasedUnits?, settledReason? }
//   eventServiceAllowances/{draftId}                      ← print_badges.consumed (the existing ledger)
//   eventServiceAllowances/{draftId}/usage/{jobId}_r{n}   ← { service: 'print_badges', quantity, … }
//   licenseHistory  'print_badges_consumed'               ← one row per settled round that reserved units
//
// ═══ THE MONEY RULES ═════════════════════════════════════════════════════════════
//   • Units are taken UP FRONT for the round (reserved = attendees not yet billed), so the ledger can
//     never be overdrawn: concurrent jobs each reserve inside a transaction on the ledger.
//   • An attendee is billed by CREATING its claim, in the same transaction that marks the card
//     rendered and counts the claim against the round. A claim that already exists (any job, either
//     asset type) makes the card free (D2). Two workers racing on one attendee: one creates, the
//     other's transaction retries and sees the claim ⇒ free. One charge, always.
//   • A round SETTLES once its job is terminal: keep = claims made in it, the rest go back to the
//     ledger (D4 — fewer than quoted ⇒ the unused reservation is trimmed). Settling and claiming both
//     go through the round document, so a late worker after settlement is refused, never charged.
//   • Nothing is ever charged for a card that did not render: rendering happens BEFORE the claim.
//
// Both collections are server-only (no client rules) and retained on event deletion.

import crypto from 'crypto'
import { FieldPath, FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { txnCreateJob } from '@/lib/jobs/kernel'
import {
  ledgerRef, ledgerLine, availableUnits, txnTakeUnits, txnTrimUnits, txnReadUsage, type ServiceLedgerDoc,
} from '@/lib/licensing/serviceAllowanceLedger'
import {
  isChargeableBadgeAssetType, resolveEffectivePrintBadgeTerms, EVENT_PRINT_BADGE_FIELD, type EffectivePrintBadgeTerms,
} from '@/lib/licensing/printBadgeCommercial'
import { getGlobalPrintBadgeTerms } from '@/lib/licensing/printBadgeTermsServer'
import { readPrintBadgePilot } from '@/lib/licensing/printBadgePilotServer'
import { isPilotOrganizer } from '@/lib/licensing/printBadgePilot'
import { LICENSE_HISTORY_COLLECTION, type LicenseHistoryDoc } from '@/lib/licensing/schema'
import { defaultLicenseTierForVersion, CURRENT_LICENSE_VERSION } from '@/lib/licensing/eventLicense'
import {
  PRINT_BADGE_CLAIMS, PRINT_BADGE_ROUNDS, claimDocId, roundDocId, roundUnitKey, decideBadgeReserve, decideClaim,
  settleableJobStatus, billingOf, BILLING_CLOSED_MESSAGE, UNITS_EXHAUSTED_MESSAGE,
  type PrintJobBillingMode, type RoundState,
} from './decisions'

/** Same collection as generationJob's PRINT_GENERATION_JOBS (kept literal here to avoid an import cycle; test-pinned). */
export const BILLED_JOBS_COLLECTION = 'printGenerationJobs'

const now = () => FieldValue.serverTimestamp()
const claimsCol = () => adminDb.collection(PRINT_BADGE_CLAIMS)
const roundsCol = () => adminDb.collection(PRINT_BADGE_ROUNDS)
const jobRef  = (jobId: string) => adminDb.collection(BILLED_JOBS_COLLECTION).doc(jobId)
const itemRef = (jobId: string, registrationId: string) => jobRef(jobId).collection('items').doc(registrationId)
export const claimRef = (draftId: string, registrationId: string) => claimsCol().doc(claimDocId(draftId, registrationId))
export const roundRef = (jobId: string, round: number) => roundsCol().doc(roundDocId(jobId, round))

const GETALL_CHUNK = 300
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : 0)

// ─── Mode ─────────────────────────────────────────────────────────────────────────

export type ModeResolution =
  /** `notInPilot` (RD-PRINT-P8): free because the organizer is outside the paid ID-badge pilot. */
  | { ok: true; mode: PrintJobBillingMode; terms: EffectivePrintBadgeTerms | null; notInPilot?: true }
  | { ok: false; reason: 'unavailable' | 'ownership' }

/**
 * The billing mode a NEW job for `assetType` on `eventSlug` runs in.
 * Non-chargeable asset types are free without a read. While the code gate is closed
 * (PAID_BADGE_GENERATION_RELEASED = false) every event is free — decided by the resolver itself,
 * BEFORE any read, so the free path does exactly the work it did before Phase 5.
 * Once released, terms that cannot be read refuse the job rather than guess (never a free pass,
 * never an unagreed charge).
 *
 * Fix 1 — the event's terms decide how attendees are billed, and the units / claims are keyed by
 * the DRAFT id, so the live event must be PROVABLY this draft's: `events/{slug}.uid` is the
 * workspace AND `events/{slug}.draftId` is present and equal. Anything else ⇒ 'ownership' (refused).
 *
 * RD-PRINT-P8 (W5) — paid generation is a PILOT. Once the gate is open, the pilot setting is read
 * first (stored config, cached): unreadable or malformed ⇒ 'unavailable' (503 — never a silent free
 * pass). An organizer OUTSIDE the pilot is free right there, with no event or terms read — the free
 * path is unchanged for them. Only a pilot organizer goes on to the ownership, terms and precedence
 * checks below. The gate-closed path above reads nothing, exactly as before.
 *
 * RD-PRINT-P8.2 — `freshPilot`: read the pilot bypassing the 60-second configuration cache. Passed
 * ONLY by the job-create route, so removing an organizer from the pilot stops new paid jobs at once.
 * Quote previews and summaries keep the cached read (they authorize nothing).
 */
export async function resolvePrintJobBillingMode(
  assetType: unknown, eventSlug: string, owner: { organizerUid: string; draftId: string },
  opts: { freshPilot?: boolean } = {},
): Promise<ModeResolution> {
  if (!isChargeableBadgeAssetType(assetType)) return { ok: true, mode: 'free', terms: null }
  const gate = resolveEffectivePrintBadgeTerms({ paidGenerationEnabled: true, unitPricePaise: null, gstRatePercent: null }, null)
  if (gate.mode === 'free') return { ok: true, mode: 'free', terms: null }
  try {
    const pilot = await readPrintBadgePilot({ fresh: opts.freshPilot === true })
    if (!pilot.ok) return { ok: false, reason: 'unavailable' }
    if (!isPilotOrganizer(pilot, owner.organizerUid)) return { ok: true, mode: 'free', terms: null, notInPilot: true }
    const [g, ev] = await Promise.all([getGlobalPrintBadgeTerms(), adminDb.collection('events').doc(eventSlug).get()])
    if (!ev.exists || ev.get('uid') !== owner.organizerUid || ev.get('draftId') !== owner.draftId) return { ok: false, reason: 'ownership' }
    if (!g.ok) return { ok: false, reason: 'unavailable' }
    const terms = resolveEffectivePrintBadgeTerms(g.terms, ev.get(EVENT_PRINT_BADGE_FIELD))
    return { ok: true, mode: terms.mode, terms }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}

// ─── Reads ────────────────────────────────────────────────────────────────────────

/** The registration ids (of `ids`) that already hold a claim on this event. Batched document reads. */
export async function claimedRegistrationIds(draftId: string, ids: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>()
  for (let i = 0; i < ids.length; i += GETALL_CHUNK) {
    const slice = ids.slice(i, i + GETALL_CHUNK)
    if (!slice.length) continue
    const snaps = await adminDb.getAll(...slice.map(id => claimRef(draftId, id)))
    snaps.forEach((s, k) => { if (s.exists) out.add(slice[k]) })
  }
  return out
}

export interface BadgeAvailability { available: number; ownerMismatch: boolean }

/** Units this organizer can still use on this event. A ledger owned by somebody else counts as none. */
export async function readBadgeAvailability(draftId: string, organizerUid: string): Promise<BadgeAvailability> {
  const snap = await ledgerRef(draftId).get()
  const ledger = snap.exists ? snap.data() as ServiceLedgerDoc : undefined
  if (ledger && ledger.organizerUid !== organizerUid) return { available: 0, ownerMismatch: true }
  return { available: availableUnits(ledgerLine(ledger, 'print_badges')), ownerMismatch: false }
}

// ─── Reservation: create a paid / complimentary job ─────────────────────────────

export interface RoundQuoteSnapshot {
  eligible:         number
  previouslyBilled: number
  chargeable:       number
  unitPricePaise:   number | null
  priceSource:      string | null
  quoteHash:        string | null
  quotedChargeable: number | null
  quotedAt:         number | null
}

export type CreateBilledJobOutcome =
  | { kind: 'created' }
  | { kind: 'exists' }
  | { kind: 'insufficient'; available: number; shortfall: number }

/**
 * ONE transaction: the job does not exist yet ⇒ (paid) reserve `chargeable` units and open round 1,
 * then create the job document. Insufficient units ⇒ nothing is written (the seeded item docs stay
 * unreachable — no job references them — exactly as an interrupted seed always left them).
 */
export async function createBilledJob(args: {
  jobId: string; seed: Record<string, unknown>; total: number
  mode: 'paid' | 'complimentary'; draftId: string; organizerUid: string; eventSlug: string; assetType: string
  createdBy: string; chargeable: number; quote: RoundQuoteSnapshot
  /** The request marker this caller owns (requestId jobs): the job is created only while it still does. */
  request?: { key: string; token: string } | null
}): Promise<CreateBilledJobOutcome | { kind: 'lost' }> {
  const jRef = jobRef(args.jobId)
  const rRef = roundRef(args.jobId, 1)
  const unitKey = roundUnitKey(args.jobId, 1)
  const mRef = args.request ? requestRef(args.request.key) : null
  return adminDb.runTransaction(async tx => {
    const [jSnap, mSnap] = await Promise.all([tx.get(jRef), mRef ? tx.get(mRef) : Promise.resolve(null)])
    // Fencing: a seeder whose marker was taken over (its lease expired) never creates a job.
    if (mSnap && !ownsMarker(mSnap, args.request!.token, args.jobId)) return { kind: 'lost' as const }
    if (jSnap.exists) return { kind: 'exists' as const }
    const created = () => { if (mRef) tx.update(mRef, { status: 'created', updatedAt: now() }) }
    if (args.mode === 'complimentary') {
      txnCreateJob(tx, BILLED_JOBS_COLLECTION, args.jobId, args.seed, args.total)
      created()
      return { kind: 'created' as const }
    }
    const [lSnap, rSnap, usage] = await Promise.all([tx.get(ledgerRef(args.draftId)), tx.get(rRef), txnReadUsage(tx, args.draftId, unitKey)])
    const ledger = lSnap.exists ? lSnap.data() as ServiceLedgerDoc : undefined
    const available = ledger && ledger.organizerUid !== args.organizerUid ? 0 : availableUnits(ledgerLine(ledger, 'print_badges'))
    const d = decideBadgeReserve(available, args.chargeable)
    if (!d.ok) {
      // Refused: the request is RELEASED (not deleted) so the same requestId can try again at once.
      if (mRef) tx.update(mRef, { status: 'released', updatedAt: now() })
      return { kind: 'insufficient' as const, available: d.available, shortfall: d.shortfall }
    }
    // A round or usage record for a job id that does not exist is impossible by construction
    // (both are written in this transaction); if one ever appears, refuse rather than double-take.
    if (rSnap.exists || usage.exists) throw new Error('print badge round already exists for an uncreated job')
    if (args.chargeable > 0) txnTakeUnits(tx, args.draftId, 'print_badges', unitKey, args.chargeable, `print_generation:${args.jobId}`)
    tx.create(rRef, roundDoc(args, 1, unitKey))
    txnCreateJob(tx, BILLED_JOBS_COLLECTION, args.jobId, args.seed, args.total)
    created()
    return { kind: 'created' as const }
  })
}

// ─── Request markers: ONE seeder per requestId ─────────────────────────────────────
//
// printJobRequests/{requestKey}   requestKey = billedPrintJobId(workspace, requestId)
//   { requestKey, organizerUid, requestHash, status: 'seeding' | 'released' | 'created',
//     attempt, jobId, token, leaseUntil, createdAt, updatedAt }
//
// Only the caller that CREATES (or legitimately takes over) the marker may seed items, and it
// seeds into the marker's `jobId`. Every other request with that requestId is answered from the
// marker: the created job unchanged, 409 REQUEST_ID_REUSED (different request), or 409
// REQUEST_IN_PROGRESS (still seeding). Markers are never deleted.
//
// RECOVERY: a seeder renews its lease after every seeded page. A seeder that dies leaves a lease
// that expires; a refused one RELEASES the marker. Either way the next matching request takes over
// with attempt n+1 and a NEW job id (`<key>_a<n>`), so items a dead or slow seeder wrote can never
// mix into the new job — they sit, unreachable, under the old id (as an interrupted seed always
// did). A slow old seeder is fenced: createBilledJob refuses it ('lost') once the token moved on.

export const PRINT_JOB_REQUESTS = 'printJobRequests'
/** How long a seeder may go without renewing (it renews after every page of ≤ 400 registrations). */
export const REQUEST_SEED_LEASE_MS = 5 * 60_000
const requestRef = (key: string) => adminDb.collection(PRINT_JOB_REQUESTS).doc(key)

function ownsMarker(snap: FirebaseFirestore.DocumentSnapshot, token: string, jobId?: string): boolean {
  return snap.exists && snap.get('status') === 'seeding' && snap.get('token') === token && (jobId === undefined || snap.get('jobId') === jobId)
}

export interface PrintJobRequestMarker {
  requestKey: string; organizerUid: string; requestHash: string
  status: 'seeding' | 'released' | 'created'; attempt: number; jobId: string; token: string; leaseUntil: number
}

/** Read-only look at a request's marker (null when the requestId was never used). */
export async function readPrintJobRequest(key: string): Promise<PrintJobRequestMarker | null> {
  const s = await requestRef(key).get()
  return s.exists ? s.data() as PrintJobRequestMarker : null
}

export type RequestClaim =
  | { kind: 'owner'; jobId: string; token: string; attempt: number }
  | { kind: 'created'; jobId: string }
  | { kind: 'reused' }
  | { kind: 'in_progress' }

/**
 * Create-only ownership of a requestId. The marker is CREATED (tx.create) by the first caller;
 * a later caller may take it over only when it was released or its seeding lease expired.
 */
export async function claimPrintJobRequest(args: {
  key: string; organizerUid: string; requestHash: string; nowMs?: number
}): Promise<RequestClaim> {
  const ref = requestRef(args.key)
  const nowMs = args.nowMs ?? Date.now()
  const token = crypto.randomUUID()
  return adminDb.runTransaction(async tx => {
    const s = await tx.get(ref)
    if (!s.exists) {
      tx.create(ref, {
        requestKey: args.key, organizerUid: args.organizerUid, requestHash: args.requestHash,
        status: 'seeding', attempt: 1, jobId: args.key, token, leaseUntil: nowMs + REQUEST_SEED_LEASE_MS,
        createdAt: now(), updatedAt: now(),
      })
      return { kind: 'owner' as const, jobId: args.key, token, attempt: 1 }
    }
    const m = s.data() as PrintJobRequestMarker
    if (m.organizerUid !== args.organizerUid || m.requestHash !== args.requestHash) return { kind: 'reused' as const }
    if (m.status === 'created') return { kind: 'created' as const, jobId: m.jobId }
    if (m.status === 'released' || (m.status === 'seeding' && int(m.leaseUntil) < nowMs)) {
      const attempt = int(m.attempt) + 1
      const jobId = `${args.key}_a${attempt}`
      tx.update(ref, { status: 'seeding', attempt, jobId, token, leaseUntil: nowMs + REQUEST_SEED_LEASE_MS, updatedAt: now() })
      return { kind: 'owner' as const, jobId, token, attempt }
    }
    return { kind: 'in_progress' as const }
  })
}

/** Renews the seeding lease; false once this caller no longer owns the marker (stop seeding). */
export async function renewPrintJobRequest(key: string, token: string, nowMs = Date.now()): Promise<boolean> {
  const ref = requestRef(key)
  return adminDb.runTransaction(async tx => {
    const s = await tx.get(ref)
    if (!ownsMarker(s, token)) return false
    tx.update(ref, { leaseUntil: nowMs + REQUEST_SEED_LEASE_MS, updatedAt: now() })
    return true
  })
}

/** Gives the requestId back after a refusal or failure — only by its current owner, never deleted. */
export async function releasePrintJobRequest(key: string, token: string): Promise<boolean> {
  const ref = requestRef(key)
  return adminDb.runTransaction(async tx => {
    const s = await tx.get(ref)
    if (!ownsMarker(s, token)) return false
    tx.update(ref, { status: 'released', updatedAt: now() })
    return true
  })
}

function roundDoc(
  a: { jobId: string; organizerUid: string; draftId: string; eventSlug: string; assetType: string; createdBy: string; chargeable: number; quote: RoundQuoteSnapshot },
  round: number, unitKey: string,
): Record<string, unknown> {
  return {
    roundId: roundDocId(a.jobId, round), jobId: a.jobId, round,
    organizerUid: a.organizerUid, eventId: a.draftId, eventSlug: a.eventSlug, assetType: a.assetType,
    unitKey, status: 'reserved', reserved: a.chargeable, claimed: 0, quote: a.quote,
    createdBy: a.createdBy, createdAt: now(), updatedAt: now(),
  }
}

// ─── Reservation: reopen a settled job into a new round ───────────────────────────

export type ReopenRoundOutcome =
  | { kind: 'reopened'; round: number; holdTag: number | null }
  | { kind: 'busy' }
  | { kind: 'insufficient'; available: number; shortfall: number }
  | { kind: 'changed' }

/**
 * Resets a job to pending for another run (the same control-field reset the free path does),
 * INSIDE a transaction that reads the job's round, so it serialises with settlement:
 *   • the round is still OPEN (not yet settled) ⇒ the run continues in it — nothing new reserved;
 *   • the round is SETTLED and `chargeable` > 0 ⇒ reserve `chargeable` units into round n+1;
 *   • the round is SETTLED and nothing is chargeable ⇒ a free run (claims make every card free).
 * `expectSettled` is what the caller quoted against: if the round's state moved, `changed`.
 *
 * Fix 3 — `holdMs` > 0 (a regenerate that must reset cards) leaves the job LEASED to the caller
 * (`processing`, lockedUntil = now + holdMs) instead of `pending`: no worker can start before the
 * caller has reset the accepted targets, and nothing at all is reset when this transaction refuses.
 * The caller then hands the job over with releaseReopenHold(jobId, holdTag). A caller that dies in
 * between leaves a lease that simply expires; the cron then resumes the job.
 * Fix 4 — `runScope` (a partial regenerate) limits the run to those registrations; null clears it.
 */
export async function reopenBilledJob(args: {
  jobId: string; expectedRound: number; expectSettled: boolean; chargeable: number
  createdBy: string; quote: RoundQuoteSnapshot | null
  holdMs?: number; runScope?: string[] | null
}): Promise<ReopenRoundOutcome> {
  const jRef = jobRef(args.jobId)
  return adminDb.runTransaction(async tx => {
    const jSnap = await tx.get(jRef)
    if (!jSnap.exists) return { kind: 'changed' as const }
    const job = jSnap.data() as Record<string, unknown>
    const billing = billingOf(job)
    if (!billing || billing.mode !== 'paid' || billing.round !== args.expectedRound) return { kind: 'changed' as const }
    const locked = job.lockedUntil instanceof Timestamp ? job.lockedUntil.toMillis() : 0
    if (job.status === 'processing' && locked > Date.now()) return { kind: 'busy' as const }

    const draftId = String(job.eventId), organizerUid = String(job.organizerUid)
    const cur = await tx.get(roundRef(args.jobId, billing.round))
    const settled = !cur.exists || cur.get('status') === 'settled'
    if (settled !== args.expectSettled) return { kind: 'changed' as const }

    let round = billing.round
    if (settled && args.chargeable > 0) {
      round = billing.round + 1
      const unitKey = roundUnitKey(args.jobId, round)
      const [lSnap, nSnap, usage] = await Promise.all([tx.get(ledgerRef(draftId)), tx.get(roundRef(args.jobId, round)), txnReadUsage(tx, draftId, unitKey)])
      if (nSnap.exists || usage.exists) return { kind: 'changed' as const }
      const ledger = lSnap.exists ? lSnap.data() as ServiceLedgerDoc : undefined
      const available = ledger && ledger.organizerUid !== organizerUid ? 0 : availableUnits(ledgerLine(ledger, 'print_badges'))
      const d = decideBadgeReserve(available, args.chargeable)
      if (!d.ok) return { kind: 'insufficient' as const, available: d.available, shortfall: d.shortfall }
      txnTakeUnits(tx, draftId, 'print_badges', unitKey, args.chargeable, `print_generation:${args.jobId}`)
      tx.create(roundRef(args.jobId, round), roundDoc({
        jobId: args.jobId, organizerUid, draftId, eventSlug: String(job.eventSlug), assetType: String(job.assetType),
        createdBy: args.createdBy, chargeable: args.chargeable,
        quote: args.quote ?? { eligible: args.chargeable, previouslyBilled: 0, chargeable: args.chargeable, unitPricePaise: billing.unitPricePaise, priceSource: null, quoteHash: null, quotedChargeable: null, quotedAt: null },
      }, round, unitKey))
    }
    // An OPEN round simply continues: its reservation already covers every unbilled item of the job.
    const holdTag = args.holdMs && args.holdMs > 0 ? Date.now() + args.holdMs : null
    tx.update(jRef, {
      ...(round !== billing.round ? { 'billing.round': round } : {}),
      // An EMPTY scope is kept (a partial regenerate whose ids matched nothing runs nothing); null clears it.
      runScope: args.runScope ? args.runScope : FieldValue.delete(),
      status: holdTag ? 'processing' : 'pending',
      lockedUntil: holdTag ? Timestamp.fromMillis(holdTag) : null,
      cursor: null, error: null, completedAt: null,
      'counts.processed': 0, 'counts.succeeded': 0, 'counts.failed': 0, 'counts.skipped': 0,
      updatedAt: now(),
    })
    return { kind: 'reopened' as const, round, holdTag }
  })
}

/**
 * Hands a held job (reopenBilledJob with holdMs) to the workers: `pending`, no lease — but ONLY if
 * the hold is still ours (status `processing` with our exact lease). A job cancelled, or re-leased
 * after our hold expired, in the meantime is left exactly as it is.
 */
export async function releaseReopenHold(jobId: string, holdTag: number): Promise<boolean> {
  const jRef = jobRef(jobId)
  return adminDb.runTransaction(async tx => {
    const s = await tx.get(jRef)
    if (!s.exists) return false
    const locked = s.get('lockedUntil')
    if (s.get('status') !== 'processing' || !(locked instanceof Timestamp) || locked.toMillis() !== holdTag) return false
    tx.update(jRef, { status: 'pending', lockedUntil: null, updatedAt: now() })
    return true
  })
}

// ─── Per attendee: the claim ─────────────────────────────────────────────────────

export type ClaimOutcome =
  | { ok: true; billed: 'new' | 'prior' | 'complimentary' | 'already_rendered' }
  | { ok: false; error: string }

/**
 * Called AFTER the card rendered. One transaction reads the item, the attendee's claim and the
 * job's round, then marks the card rendered and — only for an attendee not yet billed on this
 * event — creates the claim and counts it against the round. Refusals mark the item failed in the
 * same transaction (never overwriting a card another worker already finished).
 */
export async function claimBadgeForItem(
  job: { jobId: string; eventId: string; eventSlug: string; organizerUid: string; assetType: string; billing?: unknown },
  registrationId: string,
): Promise<ClaimOutcome> {
  const billing = billingOf(job)
  if (!billing) throw new Error('claimBadgeForItem on a job without billing')
  const iRef = itemRef(job.jobId, registrationId)
  const cRef = claimRef(job.eventId, registrationId)
  const rRef = billing.mode === 'paid' ? roundRef(job.jobId, billing.round) : null
  return adminDb.runTransaction(async tx => {
    const [iSnap, cSnap, rSnap] = await Promise.all([tx.get(iRef), tx.get(cRef), rRef ? tx.get(rRef) : Promise.resolve(null)])
    if (!iSnap.exists) return { ok: false as const, error: 'Registration no longer exists' }
    if (iSnap.get('rendered') === true) return { ok: true as const, billed: 'already_rendered' as const }
    const round: RoundState | null = rSnap?.exists
      ? { status: rSnap.get('status') === 'settled' ? 'settled' : 'reserved', reserved: int(rSnap.get('reserved')), claimed: int(rSnap.get('claimed')) }
      : null
    const decision = decideClaim(billing.mode, cSnap.exists, round)
    if (decision === 'closed' || decision === 'exhausted') {
      const error = decision === 'closed' ? BILLING_CLOSED_MESSAGE : UNITS_EXHAUSTED_MESSAGE
      tx.update(iRef, { rendered: false, error })
      return { ok: false as const, error }
    }
    if (decision === 'new' || decision === 'complimentary') {
      tx.create(cRef, {
        claimId: cRef.id, organizerUid: job.organizerUid, eventId: job.eventId, eventSlug: job.eventSlug,
        registrationId, jobId: job.jobId,
        round:   decision === 'new' ? billing.round : null,
        roundId: decision === 'new' ? roundDocId(job.jobId, billing.round) : null,
        mode:    decision === 'new' ? 'units' : 'complimentary',
        assetType: job.assetType, claimedAt: now(),
      })
      if (decision === 'new') tx.update(rRef!, { claimed: FieldValue.increment(1), updatedAt: now() })
    }
    tx.update(iRef, {
      rendered: true, renderedAt: now(), error: null,
      billed: decision, ...(decision === 'new' ? { billedRound: billing.round } : {}),
    })
    return { ok: true as const, billed: decision }
  })
}

/** A billed job's render failure: recorded unless another worker already finished this card. */
export async function markBilledItemFailed(jobId: string, registrationId: string, error: string): Promise<void> {
  const iRef = itemRef(jobId, registrationId)
  await adminDb.runTransaction(async tx => {
    const s = await tx.get(iRef)
    if (!s.exists || s.get('rendered') === true) return
    tx.update(iRef, { rendered: false, error })
  })
}

// ─── Settlement ─────────────────────────────────────────────────────────────────────

export type SettleOutcome =
  | { kind: 'settled'; kept: number; released: number }
  | { kind: 'already' }
  | { kind: 'not_billed' }
  | { kind: 'active' }
  | { kind: 'no_round' }

/**
 * Settles the job's CURRENT round once the job is terminal (completed / failed / cancelled):
 * keeps one unit per claim made in the round and releases the rest to the ledger, exactly once.
 * Safe to call from every terminal path and the cron sweep — a second call is `already`.
 */
export async function settlePrintBadgeRound(jobId: string, reason: string, orphanRound?: number): Promise<SettleOutcome> {
  const jRef = jobRef(jobId)
  const historyRef = adminDb.collection(LICENSE_HISTORY_COLLECTION).doc()
  return adminDb.runTransaction(async (tx: Transaction) => {
    const jSnap = await tx.get(jRef)
    let job: Record<string, unknown>
    let roundNo: number
    if (jSnap.exists) {
      job = jSnap.data() as Record<string, unknown>
      const billing = billingOf(job)
      if (!billing || billing.mode !== 'paid') return { kind: 'not_billed' as const }
      if (!settleableJobStatus(job.status)) return { kind: 'active' as const }
      roundNo = billing.round
    } else {
      // The job document is gone (its event was deleted): nobody can claim against the round any
      // more, so the sweep (which names the round) settles it — otherwise its units stay held forever.
      if (orphanRound === undefined) return { kind: 'not_billed' as const }
      const o = await tx.get(roundRef(jobId, orphanRound))
      if (!o.exists) return { kind: 'no_round' as const }
      job = { eventId: o.get('eventId'), organizerUid: o.get('organizerUid'), status: 'deleted' }
      roundNo = orphanRound
    }
    const billing = { round: roundNo }
    const rRef = roundRef(jobId, billing.round)
    const draftId = String(job.eventId)
    const [rSnap, usage] = await Promise.all([tx.get(rRef), txnReadUsage(tx, draftId, roundUnitKey(jobId, billing.round))])
    if (!rSnap.exists) return { kind: 'no_round' as const }
    if (rSnap.get('status') === 'settled') return { kind: 'already' as const }
    const reserved = int(rSnap.get('reserved')), claimed = int(rSnap.get('claimed'))
    const kept = Math.min(claimed, usage.quantity)
    const released = txnTrimUnits(tx, draftId, 'print_badges', roundUnitKey(jobId, billing.round), usage, kept)
    tx.update(rRef, {
      status: 'settled', settledAt: now(), updatedAt: now(),
      keptUnits: kept, releasedUnits: released, settledReason: reason, jobStatusAtSettle: String(job.status),
    })
    if (reserved > 0) {
      const history: Omit<LicenseHistoryDoc, 'createdAt'> & { createdAt: unknown } = {
        id: historyRef.id, eventId: draftId, organizerUid: String(job.organizerUid), action: 'print_badges_consumed',
        fromTier: null, toTier: defaultLicenseTierForVersion(CURRENT_LICENSE_VERSION),   // compatibility stamp only
        source: 'system', orderId: null, actorUid: null,
        note: `ID badges used — ${kept} of ${reserved} reserved (job ${jobId}, run ${billing.round}); ${released} returned`,
        after: { jobId, round: billing.round, reserved, kept, released, reason },
        createdAt: now(),
      }
      tx.create(historyRef, history)
    }
    return { kind: 'settled' as const, kept, released }
  })
}

/**
 * Cron backstop: settles open rounds whose job has ended (crash, cancel, failure). Paged by document
 * id (equality + __name__ — served by the automatic single-field index), so rounds of jobs that are
 * still running never hide the ones behind them. Bounded by `maxScan`.
 */
export async function sweepPrintBadgeRounds(maxScan = 500, page = 100): Promise<{ scanned: number; settled: number }> {
  let scanned = 0, settled = 0
  let cursor: string | null = null
  while (scanned < maxScan) {
    let q = roundsCol().where('status', '==', 'reserved').orderBy(FieldPath.documentId())
    if (cursor) q = q.startAfter(cursor)
    const size = Math.min(page, maxScan - scanned)
    const snap = await q.limit(size).get()
    if (snap.empty) break
    for (const d of snap.docs) {
      try {
        const r = await settlePrintBadgeRound(String(d.get('jobId')), 'sweep', Number(d.get('round')))
        if (r.kind === 'settled') settled++
      } catch { /* left for the next tick */ }
    }
    scanned += snap.size
    cursor = snap.docs[snap.docs.length - 1].id
    if (snap.size < size) break
  }
  return { scanned, settled }
}

// Phase 3.8 · B — STUCK settlement-release reporting, READ-ONLY (never retries a release, never changes a
// releaseStatus, never writes a ledger or wallet).
//
// The release job (lib/settlements/releaseFunds.ts, daily at 02:00 UTC — cron-maintenance) takes ledger rows
// with status 'completed' + releaseStatus 'pending' + paidAt ≤ now − holdHours, OLDEST FIRST, up to
// min(limit, maximumSettlementsPerRun) per run, one transaction each, and refuses a row whose net exceeds the
// organizer's pendingPaise (INSUFFICIENT). A refused row stays 'pending' and is retried every run — and,
// being oldest, keeps taking a slot of every batch. The job PERSISTS NO FAILURE EVIDENCE (the reason goes to
// Sentry only), so "attempted and refused" cannot be told from "never attempted".
//
// This report therefore lists rows OVERDUE for release (eligible for longer than STUCK_RELEASE_GRACE_MS —
// two daily runs) and classifies each from CURRENT state by replaying the job's own rule in its own order:
//   stuck        — the replay shows pendingPaise cannot cover it when its turn comes (the next run will
//                  refuse it exactly as the last ones did): a confirmed, deterministic blocker
//   unverifiable — releases are paused (disabled / frozen); the row is beyond what one run may take
//                  (backlog); the wallet or the row is unreadable; or the replay WOULD release it, so why it
//                  is overdue cannot be established without persisted attempt evidence
// Bounded: at most STUCK_RELEASE_SCAN_CAP eligible rows per report; a capped scan is itself unverifiable.
// Query: the release job's own query (index status ASC, releaseStatus ASC, paidAt ASC — declared).

import { adminDb } from '@/lib/firebase/admin'
import { Timestamp } from 'firebase-admin/firestore'
import { getSettlementConfig } from '@/lib/settlements/resolveSettlementConfig'
import { RELEASE_ATTEMPTS_COLLECTION } from '@/lib/settlements/releaseAttempts'
import { releasableNetAfterManualRefunds } from '@/lib/refunds/manualRefundRules'
import {
  mismatch, unverifiable,
  type CounterMismatch, type ReconcileResult, type ReconcileUnverifiable,
} from '@/lib/reconciliation/types'

/** Two daily release runs after a row became eligible. */
export const STUCK_RELEASE_GRACE_MS = 48 * 60 * 60 * 1000
export const STUCK_RELEASE_SCAN_CAP = 2_000
const PAGE = 500
/** The release cron's own per-run limit (app/api/cron/release-funds: releaseEligibleFunds({ limit: 500 })). */
export const RELEASE_CRON_LIMIT = 500

export interface EligibleRow { id: string; organizerUid: unknown; netSettlementPaise: unknown; paidAtMs: number | null }
/** Phase 3.10A — the persisted evidence of earlier attempts for a row (settlementReleaseAttempts), if any. */
export interface AttemptEvidence { status: unknown; attempts: unknown; lastCode: unknown; firstAttemptAtMs: number | null; lastAttemptAtMs: number | null }
export interface StuckReleaseEntry {
  ptxId: string
  organizerUid: string | null
  amountPaise: number | null
  eligibleAtMs: number | null
  overdueMs: number | null
  verdict: 'stuck' | 'unverifiable'
  reason: string
  evidence: {
    pendingBeforeTurnPaise: number | null; runPosition: number; runLimit: number
    /** Phase 3.10A — whether an OPEN attempt record exists for this row (rows refused before the record existed have none). */
    failureEvidencePersisted: boolean
    attempt: { attempts: number; lastCode: string; firstAttemptAtMs: number | null; lastAttemptAtMs: number | null } | null
  }
}

/** PURE — replay the release job over the eligible rows (oldest first) and classify the overdue ones. */
export function classifyOverdueReleases(input: {
  rows: EligibleRow[]                        // ALL eligible rows read, in the job's order (paidAt asc)
  pendingByOrganizer: Map<string, unknown>   // pendingPaise as stored (absent / non-number ⇒ unreadable)
  config: { enabled: boolean; frozen: boolean; holdHours: number; maximumSettlementsPerRun: number }
  nowMs: number
  scanCapped: boolean
  /** Phase 3.10A — persisted attempt evidence by ledger row id (absent ⇒ none recorded). */
  attemptsById?: Map<string, AttemptEvidence | null>
}): StuckReleaseEntry[] {
  const runLimit = Math.max(1, Math.min(RELEASE_CRON_LIMIT, input.config.maximumSettlementsPerRun))
  const holdMs = input.config.holdHours * 60 * 60 * 1000
  const pending = new Map<string, number | null>()
  for (const [uid, v] of input.pendingByOrganizer) pending.set(uid, typeof v === 'number' && Number.isSafeInteger(v) ? v : null)
  const out: StuckReleaseEntry[] = []
  input.rows.forEach((r, i) => {
    const uid = typeof r.organizerUid === 'string' && r.organizerUid ? r.organizerUid : null
    const amt = typeof r.netSettlementPaise === 'number' && Number.isSafeInteger(r.netSettlementPaise) ? r.netSettlementPaise : null
    const eligibleAt = r.paidAtMs === null ? null : r.paidAtMs + holdMs
    const overdue = eligibleAt === null ? null : input.nowMs - eligibleAt - STUCK_RELEASE_GRACE_MS
    // the replay: what pending holds for this organizer when this row's turn comes
    const before = uid ? pending.get(uid) ?? null : null
    let wouldRelease: boolean | null = null
    if (uid && amt !== null && before !== null && before !== undefined) {
      wouldRelease = before >= amt
      if (wouldRelease) pending.set(uid, before - amt)
    }
    if (overdue === null || overdue <= 0) return
    const a = input.attemptsById?.get(r.id) ?? null
    const open = a && a.status === 'open' && typeof a.attempts === 'number' && a.attempts > 0 && typeof a.lastCode === 'string' ? a : null
    const attempt = open ? { attempts: open.attempts as number, lastCode: open.lastCode as string, firstAttemptAtMs: open.firstAttemptAtMs, lastAttemptAtMs: open.lastAttemptAtMs } : null
    const entry = (verdict: StuckReleaseEntry['verdict'], reason: string): StuckReleaseEntry => ({
      ptxId: r.id, organizerUid: uid, amountPaise: amt, eligibleAtMs: eligibleAt, overdueMs: overdue, verdict, reason,
      evidence: { pendingBeforeTurnPaise: before ?? null, runPosition: i, runLimit, failureEvidencePersisted: !!attempt, attempt },
    })
    if (!input.config.enabled || input.config.frozen) out.push(entry('unverifiable', 'release_paused'))
    else if (!uid || amt === null) out.push(entry('unverifiable', 'row_unreadable'))
    else if (before === null || before === undefined) out.push(entry('unverifiable', 'wallet_unreadable'))
    // CONFIRMED: the job recorded INSUFFICIENT refusals AND the replay shows it would refuse again
    else if (wouldRelease === false && attempt?.lastCode === 'INSUFFICIENT') out.push(entry('stuck', 'repeated_refusal'))
    // predicted only: no recorded refusal (never attempted since the evidence exists, or refused before it existed)
    else if (wouldRelease === false) out.push(entry('stuck', 'pending_below_release'))
    // recorded evidence that does not prove a deterministic refusal — never a confirmed discrepancy
    else if (attempt?.lastCode === 'INSUFFICIENT') out.push(entry('unverifiable', 'refused_before_now_coverable'))
    else if (attempt) out.push(entry('unverifiable', `release_error:${attempt.lastCode}`))
    else if (i >= runLimit) out.push(entry('unverifiable', 'beyond_run_limit'))
    else out.push(entry('unverifiable', 'no_failure_evidence'))
  })
  if (input.scanCapped) {
    out.push({ ptxId: '*', organizerUid: null, amountPaise: null, eligibleAtMs: null, overdueMs: null, verdict: 'unverifiable', reason: `scan_capped_at_${STUCK_RELEASE_SCAN_CAP}`,
      evidence: { pendingBeforeTurnPaise: null, runPosition: input.rows.length, runLimit, failureEvidencePersisted: false, attempt: null } })
  }
  return out
}

/** The full report (read-only). */
export async function reportStuckReleases(nowMs = Date.now()): Promise<{ entries: StuckReleaseEntry[]; scanned: number; scanCapped: boolean }> {
  const config = await getSettlementConfig()
  const cutoff = Timestamp.fromMillis(nowMs - config.holdHours * 60 * 60 * 1000)
  const rows: EligibleRow[] = []
  let last: FirebaseFirestore.QueryDocumentSnapshot | null = null
  let scanCapped = false
  for (;;) {
    let q = adminDb.collection('platformTransactions')
      .where('status', '==', 'completed').where('releaseStatus', '==', 'pending').where('paidAt', '<=', cutoff)
      .orderBy('paidAt', 'asc').limit(PAGE)
    if (last) q = q.startAfter(last)
    const page = await q.get()
    for (const d of page.docs) {
      const paid = d.get('paidAt') as { toMillis?: () => number } | undefined
      // RD-REFUND-MANUAL-01 — the release moves the net LESS a manual refund already reversed from it (releaseFunds).
      const net = d.get('netSettlementPaise')
      const releasable = typeof net === 'number' ? releasableNetAfterManualRefunds(net, d.get('manualRefund')?.reversedNetPaise) : net
      rows.push({ id: d.id, organizerUid: d.get('organizerUid'), netSettlementPaise: releasable, paidAtMs: typeof paid?.toMillis === 'function' ? paid.toMillis() : null })
    }
    if (page.size < PAGE) break
    last = page.docs[page.docs.length - 1]
    if (rows.length >= STUCK_RELEASE_SCAN_CAP) { scanCapped = true; break }
  }
  const uids = [...new Set(rows.map(r => r.organizerUid).filter((u): u is string => typeof u === 'string' && !!u))]
  const pendingByOrganizer = new Map<string, unknown>()
  for (let i = 0; i < uids.length; i += 100) {
    const snaps = await adminDb.getAll(...uids.slice(i, i + 100).map(u => adminDb.doc(`organizerRevenueWallets/${u}`)))
    for (const s of snaps) pendingByOrganizer.set(s.id, s.exists ? s.get('pendingPaise') : undefined)
  }
  // Phase 3.10A — the persisted attempt evidence of the OVERDUE rows only (by id; no query, no index)
  const holdMs = config.holdHours * 60 * 60 * 1000
  const overdueIds = rows.filter(r => r.paidAtMs !== null && nowMs - (r.paidAtMs + holdMs) - STUCK_RELEASE_GRACE_MS > 0).map(r => r.id)
  const attemptsById = new Map<string, AttemptEvidence | null>()
  const ms = (v: unknown) => { const t = (v as { toMillis?: () => number } | null | undefined)?.toMillis?.(); return typeof t === 'number' ? t : null }
  for (let i = 0; i < overdueIds.length; i += 100) {
    const snaps = await adminDb.getAll(...overdueIds.slice(i, i + 100).map(id => adminDb.doc(`${RELEASE_ATTEMPTS_COLLECTION}/${id}`)))
    for (const s of snaps) attemptsById.set(s.id, s.exists ? { status: s.get('status'), attempts: s.get('attempts'), lastCode: s.get('lastCode'), firstAttemptAtMs: ms(s.get('firstAttemptAt')), lastAttemptAtMs: ms(s.get('lastAttemptAt')) } : null)
  }
  return { entries: classifyOverdueReleases({ rows, pendingByOrganizer, config, nowMs, scanCapped, attemptsById }), scanned: rows.length, scanCapped }
}

// ─── Phase 3.10B · lifecycle of OPEN release-attempt records — READ-ONLY (nothing is closed or deleted) ───
//
// An open record stays open until its row releases. A row can also leave eligibility WITHOUT releasing; what
// that means for its record is not always final, so this only CLASSIFIES (owner decides any closure):
//   active              — row completed + pending: still eligible; the record is legitimately open
//   row_held            — row on a refund hold: TEMPORARY (a lift returns it to pending) — must stay open
//   row_reversed        — row refunded / disputed: not releasable today, but reopening a refunded donation is an
//                         open owner decision (Phase 3.4 case 1) — left open
//   row_deleted         — the ledger row no longer exists: abnormal; evidence kept, left open
//   released_unresolved — row released but the record still open (a release whose resolve did not complete,
//                         e.g. a run killed between commit and resolve): the record is stale; resolving it would be
//                         safe (a released row never becomes eligible again) — proposed, not done here
//   unreadable          — the record or the row cannot be read reliably
export type OpenEvidenceState = 'active' | 'row_held' | 'row_reversed' | 'row_deleted' | 'released_unresolved' | 'unreadable'
export const OPEN_EVIDENCE_SCAN_CAP = 1_000

/** PURE — the lifecycle state of one OPEN record from its ledger row (null = the row does not exist). */
export function classifyOpenEvidence(row: { status?: unknown; releaseStatus?: unknown; releaseHold?: unknown } | null): OpenEvidenceState {
  if (!row) return 'row_deleted'
  if (row.status === 'refunded' || row.status === 'disputed') return 'row_reversed'
  if (row.status !== 'completed') return 'unreadable'
  if (row.releaseStatus === 'released') return 'released_unresolved'
  if (row.releaseStatus === 'held' || row.releaseHold) return 'row_held'
  if (row.releaseStatus === 'pending') return 'active'
  return 'unreadable'
}

/** READ-ONLY — every OPEN record (bounded) with its lifecycle state. Equality query on one field (single-field index). */
export async function reportOpenReleaseEvidence(): Promise<{ entries: Array<{ ptxId: string; state: OpenEvidenceState; attempts: unknown; lastCode: unknown }>; scanCapped: boolean }> {
  const snap = await adminDb.collection(RELEASE_ATTEMPTS_COLLECTION).where('status', '==', 'open').limit(OPEN_EVIDENCE_SCAN_CAP + 1).get()
  const docs = snap.docs.slice(0, OPEN_EVIDENCE_SCAN_CAP)
  const rows = new Map<string, FirebaseFirestore.DocumentSnapshot>()
  for (let i = 0; i < docs.length; i += 100) {
    const s = await adminDb.getAll(...docs.slice(i, i + 100).map(d => adminDb.doc(`platformTransactions/${d.id}`)))
    for (const x of s) rows.set(x.id, x)
  }
  return {
    entries: docs.map(d => {
      const r = rows.get(d.id)
      return { ptxId: d.id, state: classifyOpenEvidence(r?.exists ? r.data() as Record<string, unknown> : null), attempts: d.get('attempts'), lastCode: d.get('lastCode') }
    }),
    scanCapped: snap.size > OPEN_EVIDENCE_SCAN_CAP,
  }
}

/** The global reconciliation's release pass (report-only). */
// The release pass takes no paging options: it replays the release job over the eligible rows, oldest first.
export async function reconcileStuckReleases(): Promise<ReconcileResult> {
  const { entries, scanned } = await reportStuckReleases()
  const mismatches: CounterMismatch[] = []
  const unv: ReconcileUnverifiable[] = []
  for (const e of entries) {
    if (e.verdict === 'stuck') mismatches.push(mismatch('release', e.ptxId, `stuckRelease:${e.reason}`, e.amountPaise ?? 0, e.evidence.pendingBeforeTurnPaise ?? 0, false))
    else unv.push(unverifiable('release', e.ptxId, 'release', e.reason))
  }
  return { entityType: 'release', scanned, mismatches, unverifiable: unv, repaired: 0 }
}

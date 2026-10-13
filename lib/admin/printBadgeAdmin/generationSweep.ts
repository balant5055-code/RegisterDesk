// RD-PRINT-BILL-P7 · Super Admin, platform-wide view of ID-badge GENERATION billing. Server-only,
// READ-ONLY, bounded.
//
// Two sources, both paged in DOCUMENT-ID order with a cursor (no composite index, never a full scan):
//   source=rounds   printBadgeRounds (optionally only OPEN ones). Each open round is flagged STALE
//                   (open > 24 h) and/or JOB_ENDED (its job is completed / failed / cancelled / gone —
//                   the cron sweep should have settled it).
//   source=ledgers  eventServiceAllowances pages, keeping the events that show badge activity
//                   (badges bought, carried in or consumed).
// The distinct events of the page are then reconciled with the Phase 5 reconcilePrintBadgeUsage —
// at most MAX_EVENTS per request; the rest are reported as not checked (eventsTruncated), never as clean.

import { FieldPath } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import { EVENT_SERVICE_ALLOWANCES, ledgerLine, type ServiceLedgerDoc } from '@/lib/licensing/serviceAllowanceLedger'
import { PRINT_BADGE_ROUNDS, STALE_ROUND_MS, settleableJobStatus } from '@/lib/printAssets/badgeBilling/decisions'
import { reconcilePrintBadgeUsage, type BadgeUsageReconciliation } from '@/lib/printAssets/badgeBilling/reconcile'
import { section, pageByDocId, n, numOrNull, str, iso, tsMs, type Section, type Page } from './common'

export const SWEEP_ROUND_PAGE_MAX = 50
export const SWEEP_LEDGER_PAGE_MAX = 100
export const SWEEP_MAX_EVENTS = 5
const PRINT_JOBS = 'printGenerationJobs'

export interface SweepRoundRow {
  roundId: string; jobId: string | null; eventId: string | null; organizerUid: string | null; round: number; status: string | null
  reserved: number; claimed: number; keptUnits: number | null; releasedUnits: number | null
  createdAt: string | null; settledAt: string | null
  /** Open rounds only. */
  flags: Array<'STALE' | 'JOB_ENDED' | 'JOB_MISSING'>
  jobStatus: string | null
}
export interface SweepLedgerRow { draftId: string; organizerUid: string | null; purchased: number; carriedIn: number; consumed: number }

export interface SweepEventResult { draftId: string; result: Section<Pick<BadgeUsageReconciliation, 'ok' | 'problems' | 'truncated' | 'ledgerConsumed' | 'usageTotal'>> }

export interface GenerationSweepView {
  source: 'rounds' | 'ledgers'
  rounds?: Section<Page<SweepRoundRow>>
  ledgers?: Section<Page<SweepLedgerRow> & { scanned: number }>
  events: SweepEventResult[]
  /** Events in this page that were NOT reconciled because of the per-request cap. */
  eventsNotChecked: string[]
}

export interface GenerationSweepRequest { source: 'rounds' | 'ledgers'; openOnly?: boolean; cursor?: string | null; limit?: number; nowMs?: number; reconcile?: boolean }

async function reconcileEvents(draftIds: string[]): Promise<{ events: SweepEventResult[]; eventsNotChecked: string[] }> {
  const unique = [...new Set(draftIds)]
  const take = unique.slice(0, SWEEP_MAX_EVENTS)
  const events = await Promise.all(take.map(async draftId => ({
    draftId,
    result: await section('reconcile', async () => {
      const r = await reconcilePrintBadgeUsage(draftId)
      return { ok: r.ok, problems: r.problems, truncated: r.truncated, ledgerConsumed: r.ledgerConsumed, usageTotal: r.usageTotal }
    }),
  })))
  return { events, eventsNotChecked: unique.slice(SWEEP_MAX_EVENTS) }
}

export async function getGenerationSweep(r: GenerationSweepRequest): Promise<GenerationSweepView> {
  const nowMs = r.nowMs ?? Date.now()
  const cursor = r.cursor ?? null
  const doReconcile = r.reconcile !== false

  if (r.source === 'ledgers') {
    const limit = Math.max(1, Math.min(r.limit ?? SWEEP_LEDGER_PAGE_MAX, SWEEP_LEDGER_PAGE_MAX))
    const ledgers = await section('ledgers', async () => {
      const page = await pageByDocId(adminDb.collection(EVENT_SERVICE_ALLOWANCES), cursor, limit, d => ({ id: d.id, data: d.data() as ServiceLedgerDoc }), FieldPath.documentId())
      const items: SweepLedgerRow[] = []
      for (const { id, data } of page.items) {
        const l = ledgerLine(data, 'print_badges')
        if (l.purchased + l.carriedIn + l.consumed <= 0) continue
        items.push({ draftId: id, organizerUid: str(data.organizerUid), purchased: l.purchased, carriedIn: l.carriedIn, consumed: l.consumed })
      }
      return { items, hasMore: page.hasMore, nextCursor: page.nextCursor, scanned: page.items.length }
    })
    const { events, eventsNotChecked } = ledgers.ok && doReconcile ? await reconcileEvents(ledgers.data.items.map(x => x.draftId)) : { events: [], eventsNotChecked: [] }
    return { source: 'ledgers', ledgers, events, eventsNotChecked }
  }

  const limit = Math.max(1, Math.min(r.limit ?? SWEEP_ROUND_PAGE_MAX, SWEEP_ROUND_PAGE_MAX))
  const rounds = await section('rounds', async () => {
    const base = r.openOnly ? adminDb.collection(PRINT_BADGE_ROUNDS).where('status', '==', 'reserved') : adminDb.collection(PRINT_BADGE_ROUNDS)
    const page = await pageByDocId(base, cursor, limit, d => ({ id: d.id, x: d.data() as Record<string, unknown> }), FieldPath.documentId())
    const openJobIds = [...new Set(page.items.filter(i => i.x.status === 'reserved').map(i => str(i.x.jobId)).filter((v): v is string => !!v))]
    const jobs = new Map<string, string | null>()
    if (openJobIds.length) {
      const snaps = await adminDb.getAll(...openJobIds.map(id => adminDb.collection(PRINT_JOBS).doc(id)))
      snaps.forEach((s, i) => jobs.set(openJobIds[i], s.exists ? str(s.get('status')) ?? 'unknown' : null))
    }
    const items: SweepRoundRow[] = page.items.map(({ id, x }) => {
      const jobId = str(x.jobId)
      const open = x.status === 'reserved'
      const jobStatus = jobId && jobs.has(jobId) ? jobs.get(jobId) ?? null : null
      const flags: SweepRoundRow['flags'] = []
      if (open) {
        const created = tsMs(x.createdAt)
        if (created !== null && nowMs - created > STALE_ROUND_MS) flags.push('STALE')
        if (jobId && jobs.has(jobId) && jobs.get(jobId) === null) flags.push('JOB_MISSING')
        else if (jobStatus && settleableJobStatus(jobStatus)) flags.push('JOB_ENDED')
      }
      return {
        roundId: id, jobId, eventId: str(x.eventId), organizerUid: str(x.organizerUid), round: n(x.round), status: str(x.status),
        reserved: n(x.reserved), claimed: n(x.claimed), keptUnits: numOrNull(x.keptUnits), releasedUnits: numOrNull(x.releasedUnits),
        createdAt: iso(x.createdAt), settledAt: iso(x.settledAt), flags, jobStatus: open ? jobStatus : null,
      }
    })
    return { items, hasMore: page.hasMore, nextCursor: page.nextCursor }
  })
  const { events, eventsNotChecked } = rounds.ok && doReconcile
    ? await reconcileEvents(rounds.data.items.map(x => x.eventId).filter((v): v is string => !!v))
    : { events: [], eventsNotChecked: [] }
  return { source: 'rounds', rounds, events, eventsNotChecked }
}

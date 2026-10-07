// ─── Reports History — a bounded READ MODEL over reportExportJobs ─────────────
//
// RD-ANALYTICS-12-11. Server-only. This module reads the export jobs that already exist; it
// creates nothing, writes nothing, and knows nothing about generation.
//
// ═══ WHY A SERVER READER AT ALL ══════════════════════════════════════════════
// `reportExportJobs` has no `match` block in firestore.rules, so the client SDK is denied by
// default — deliberately, because a job document carries the workspace uid, the storage path
// and (historically) a capability URL. History therefore cannot be a Firestore listener; it
// has to be a server projection, which is also the only place the report-permission gate can
// be applied honestly.
//
// ═══ THE ONE HARD PROBLEM: PAGINATION UNDER A NON-QUERYABLE PREDICATE ════════
// Visibility is per report KIND — `permissionForExportJob` resolves the kind through the same
// registry the download route uses. Firestore cannot evaluate that predicate, so a naive
// implementation reads 25 documents, drops the ones the caller may not see, and returns 7.
// The page is sparse, and worse, the next cursor is taken from the last VISIBLE row — so the
// hidden rows between it and the true page end are scanned again on every subsequent request,
// or skipped, depending on which end you take it from.
//
// The fix is to separate the two page sizes:
//
//   SOURCE page  — what Firestore returns per read          (50)
//   VISIBLE page — what the caller receives                 (25)
//   SCAN BOUND   — the most documents one request may read  (250)
//
// The reader pulls source pages until the visible page is full, the source is exhausted, or
// the scan bound is reached — and the cursor always advances to the last document CONSUMED,
// visible or not. That is what makes progress guaranteed: a request that reads 250 invisible
// jobs still returns a cursor 250 documents further on, so "Load more" cannot loop.
//
// Every read is bounded. There is no unbounded loop and no full-collection read: the scan
// bound alone caps a request at five Firestore reads regardless of workspace size, which is
// also the property the emulator scale test asserts.
//
// ═══ WHY THE PERMISSION IS NOT PUSHED INTO THE QUERY ═════════════════════════
// `where('kind','in',allowedKinds)` would make every page dense and remove the scan loop. It
// was rejected: it needs a THIRD index column (organizerUid, kind, createdAt) where the
// approved audit specifies exactly `organizerUid ASC, createdAt DESC`, and it would make a
// locally-derived kind list — not `permissionForExportJob` — the thing that decides access.
// One gate, applied to every row, is worth a scan bound.

import { Timestamp }   from 'firebase-admin/firestore'
import { adminDb }     from '@/lib/firebase/admin'
import { toISO, toMillis } from '@/lib/reports/format'
import { ORGANIZER_REPORTS } from '@/lib/reports/registry'
import {
  REPORT_EXPORT_JOBS, permissionForExportJob, type ReportExportJob,
} from '@/lib/reports/exportJob'
import type { JobStatus } from '@/lib/jobs/types'
import type { TeamPermission } from '@/lib/team/types'

/** What the caller receives per request. Also the maximum — §7 of the phase brief. */
export const HISTORY_PAGE_SIZE = 25
/** What Firestore returns per read. Larger than the visible page so a partly-hidden
 *  page usually still fills in one round trip. */
export const HISTORY_SOURCE_PAGE = 50
/** The most documents ONE request may read, however many of them are invisible. */
export const HISTORY_MAX_SCAN = 250

/**
 * Whether the artifact behind a job can be fetched right now.
 *
 * These three values mirror the download route's own decisions exactly — 410 for cancelled,
 * 409 for no output, 410 for expired — so History never advertises a download the route will
 * refuse, and never hides one it would serve. It is a projection of that route's rules, not a
 * second copy of them: the route remains the only thing that decides.
 */
export type HistoryDownloadState = 'available' | 'expired' | 'unavailable'

/**
 * One History row, as it reaches the browser.
 *
 * Deliberately ABSENT, and each for a reason:
 *   organizerUid   — tenancy, resolved server-side; the client never needs to name it
 *   output.path    — the storage location of a financial artifact
 *   url            — no signed URL is ever minted during a list read (see the module note)
 *   contentType    — nothing in the UI branches on it
 *   lockedUntil    — the worker lease
 *   cursor         — the job runner's resume checkpoint
 *   counts         — chunk bookkeeping for a job that has exactly one item
 *   error          — the raw stored message; `failure` carries a sanitized state instead
 *   createdBy      — a raw uid; `createdByYou` answers the only question the UI asks
 */
export interface ReportHistoryEntry {
  jobId:     string
  /** The stored kind. The CLIENT resolves its label from lib/reports/catalog.ts and falls
   *  back to this string, so a retired kind renders instead of breaking the list. */
  kind:      string
  status:    JobStatus
  format:    string
  createdAt:   string | null
  completedAt: string | null
  expiresAt:   string | null
  /** The report's own date filters, echoed back so a row is identifiable. */
  range:     { from: string | null; to: string | null }
  rowCount:  number | null
  truncated: boolean
  download:  HistoryDownloadState
  /** A sanitized failure state — never the stored message. Null unless the job failed. */
  failure:   string | null
  /** Attribution without an identifier: `createdBy === the caller`. */
  createdByYou: boolean
}

export interface ReportHistoryPage {
  entries:    ReportHistoryEntry[]
  nextCursor: string | null
  hasMore:    boolean
}

// ─── Cursor ───────────────────────────────────────────────────────────────────
//
// The cursor is a position in the `createdAt DESC` ordering and NOTHING else.
//
// The obvious encoding — the last scanned document's id, as `/api/organizer/notifications`
// uses — cannot be used here, because the last scanned document is frequently one the caller
// may NOT see. Handing back its `rex_<uuid>` would disclose the existence of a hidden export
// on every page turn, which is the precise thing §5 forbids. Base64 would not help: encoding
// is not concealment.
//
// So the cursor carries the timestamp only, at full Firestore precision (seconds +
// nanoseconds). It names no job, no workspace and no caller, it is meaningless in another
// workspace because the query's `organizerUid` filter comes from the session rather than the
// cursor, and `startAfter` on the ordered field is exact.

interface HistoryCursor { s: number; n: number }

export function encodeHistoryCursor(ts: Timestamp): string {
  return Buffer.from(JSON.stringify({ s: ts.seconds, n: ts.nanoseconds }), 'utf8').toString('base64url')
}

/** `null` for a malformed cursor — the route answers 400 rather than silently restarting
 *  the feed from the top, which would look like an infinite History. */
export function decodeHistoryCursor(raw: string): HistoryCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as unknown
    const c = parsed as { s?: unknown; n?: unknown }
    if (typeof c.s !== 'number' || typeof c.n !== 'number') return null
    if (!Number.isFinite(c.s) || !Number.isFinite(c.n) || c.s < 0 || c.n < 0) return null
    return { s: Math.floor(c.s), n: Math.floor(c.n) }
  } catch { return null }
}

// ─── Projection ───────────────────────────────────────────────────────────────

/**
 * Every failed export answers the same way.
 *
 * `job.error` is whatever the strategy caught — `Unknown report: x`, a Firestore message, a
 * storage error, an arbitrary exception string. The active-export panel shows it while the
 * job is on screen and in memory, which is a different exposure from writing it into a
 * durable, workspace-wide, shareable list; the audit called that out as P3. The stored value
 * is untouched and still reaches server logs.
 */
const FAILURE_MESSAGE = 'Report generation failed. Generate it again.'

export function historyDownloadState(job: Pick<ReportExportJob, 'status' | 'output'>, nowMs: number): HistoryDownloadState {
  // A cancelled job may still carry an `output` — cancelJob does not clear it — and the
  // download route refuses it with 410. History must say the same.
  if (job.status === 'cancelled') return 'unavailable'
  if (!job.output) return 'unavailable'
  const expiresMs = toMillis(job.output.expiresAt)
  // Three clocks exist and only one of them is this: the job document is never deleted, the
  // stored object is reclaimed at ~7 days, and the application's own link expires at 24h.
  // An expired artifact is not a deleted job — the row stays, honestly marked.
  if (expiresMs > 0 && expiresMs <= nowMs) return 'expired'
  return 'available'
}

export function toHistoryEntry(job: ReportExportJob, callerUid: string, nowMs = Date.now()): ReportHistoryEntry {
  const filters = (job.filters ?? {}) as { from?: unknown; to?: unknown }
  return {
    jobId:  job.jobId,
    kind:   typeof job.kind === 'string' ? job.kind : '',
    status: job.status,
    format: typeof job.format === 'string' ? job.format : '',
    createdAt:   toISO(job.createdAt),
    completedAt: toISO(job.completedAt),
    expiresAt:   job.output ? toISO(job.output.expiresAt) : null,
    range: {
      from: typeof filters.from === 'string' ? filters.from : null,
      to:   typeof filters.to   === 'string' ? filters.to   : null,
    },
    rowCount:  job.output ? job.output.rowCount : null,
    truncated: job.output ? !!job.output.truncated : false,
    download:  historyDownloadState(job, nowMs),
    failure:   job.status === 'failed' ? FAILURE_MESSAGE : null,
    createdByYou: job.createdBy === callerUid,
  }
}

// ─── Reader ───────────────────────────────────────────────────────────────────

/** True when at least one registered report is readable by these permissions. Lets a caller
 *  who can see nothing skip the query entirely rather than scan 250 documents to prove it. */
export function hasAnyReportPermission(permissions: TeamPermission[]): boolean {
  return Object.values(ORGANIZER_REPORTS).some(m => permissions.includes(m.permission))
}

export async function readReportHistory(opts: {
  workspaceUid: string
  callerUid:    string
  permissions:  TeamPermission[]
  cursor:       string | null
  pageSize?:    number
  nowMs?:       number
}): Promise<ReportHistoryPage> {
  const pageSize = Math.min(Math.max(1, opts.pageSize ?? HISTORY_PAGE_SIZE), HISTORY_PAGE_SIZE)
  const nowMs    = opts.nowMs ?? Date.now()
  const empty: ReportHistoryPage = { entries: [], nextCursor: null, hasMore: false }

  if (!hasAnyReportPermission(opts.permissions)) return empty

  /**
   * Tenancy is a QUERY filter, never a post-filter.
   *
   * `workspaceUid` comes from the authenticated session — it is not a parameter the caller
   * can set. Reading the collection and comparing `organizerUid` afterwards would mean every
   * workspace's exports pass through this process, which is both a scale defect and a
   * disclosure waiting for one missing `continue`.
   *
   * Requires the composite index (organizerUid ASC, createdAt DESC) added in this phase.
   */
  const base = adminDb.collection(REPORT_EXPORT_JOBS)
    .where('organizerUid', '==', opts.workspaceUid)
    .orderBy('createdAt', 'desc')

  let after: HistoryCursor | null = opts.cursor ? decodeHistoryCursor(opts.cursor) : null
  // A cursor that fails to decode never reaches here — the route rejects it first.
  const entries: ReportHistoryEntry[] = []
  let scanned = 0
  let sourceExhausted = false

  while (entries.length < pageSize && scanned < HISTORY_MAX_SCAN) {
    const want = Math.min(HISTORY_SOURCE_PAGE, HISTORY_MAX_SCAN - scanned)
    let q = base.limit(want)
    if (after) q = base.startAfter(new Timestamp(after.s, after.n)).limit(want)

    const snap = await q.get()
    if (snap.empty) { sourceExhausted = true; break }

    let consumed = 0
    for (const doc of snap.docs) {
      // Stop BEFORE consuming a document the page has no room for, so the cursor names the
      // last row actually accounted for and the next request resumes exactly here.
      if (entries.length >= pageSize) break
      consumed++
      scanned++
      const job = { ...(doc.data() as ReportExportJob), jobId: doc.id }
      const createdAt = job.createdAt
      if (createdAt instanceof Timestamp) after = { s: createdAt.seconds, n: createdAt.nanoseconds }

      /**
       * The gate. Same predicate as the poll, process, cancel and download routes.
       *
       * `null` means the kind is not a registered report — which the create route makes
       * unreachable — and is treated as a REFUSAL, exactly as the download route treats it.
       * A row that fails this is not rendered, not counted, and not described: no kind, no
       * date range, no status, no creator, no acknowledgement that it exists.
       */
      const need = permissionForExportJob(job)
      if (!need || !opts.permissions.includes(need)) continue

      entries.push(toHistoryEntry(job, opts.callerUid, nowMs))
    }

    /**
     * A short read means the ordering is exhausted — but ONLY if this page was read to the
     * end. Filling the visible page mid-snapshot leaves documents behind, and calling that
     * "exhausted" ends the feed early: 40 jobs would return 25 with `hasMore: false` and the
     * remaining 15 would be unreachable. Both conditions, or neither.
     */
    if (consumed === snap.docs.length && snap.docs.length < want) { sourceExhausted = true; break }
  }

  const hasMore = !sourceExhausted
  return {
    entries,
    nextCursor: hasMore && after ? encodeHistoryCursor(new Timestamp(after.s, after.n)) : null,
    hasMore:    hasMore && !!after,
  }
}

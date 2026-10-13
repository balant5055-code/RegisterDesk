// RD-PRINT-P3 · Combined on-demand print runs. Server-only.
//
// A print run turns a generation job's selected cards into ONE PDF without storing it:
//   1. PLAN   (POST /print-jobs/[jobId]/runs) — freezes, as METADATA, the ordered ids of
//      the cards that can be printed now, the job's PINNED template version, the sheet
//      settings and the batch boundaries; reports cards that cannot be printed and text
//      that would overflow its box (warnings only — the design is never changed).
//   2. BATCHES (POST /print-runs/[runId]/batches/[i]) — each renders exactly its slice of
//      the frozen ids, STRICTLY: a registration that changed since planning fails the
//      batch (and the run) instead of silently dropping a card.
//   3. The BROWSER merges the batches into one PDF and downloads it — only when every batch
//      succeeded — then (4) COMPLETE records it, which the server accepts only when every
//      batch was rendered and the page count matches the plan.
//
// Stored per run: ids, counts, settings, status, timestamps. Never PDF/image bytes, never
// URLs, never names, contacts, ticket/QR values or form answers.
//
// Duplicate submissions: the run id is derived from (workspace, job, client requestId), and
// the plan is written with `create()` — a double click returns the SAME run, never two.

import crypto from 'crypto'
import { FieldValue, Timestamp } from 'firebase-admin/firestore'
import { adminDb } from '@/lib/firebase/admin'
import {
  analyzePrintRunCards, listPrintJobItems, isPrintItemReady, renderPrintRunBatch,
  type PrintGenerationJob, type PrintSheetsResult,
} from '@/lib/printAssets/generationJob'
import type { SheetSpec } from '@/lib/printAssets/sheet/layout'
import { planBatches, batchSlice, batchSheets, RUN_MAX_CARDS } from './plan'

export const PRINT_RUNS = 'printRuns'
const SKIPPED_KEPT  = 500
const OVERFLOW_KEPT = 50

/**
 * planned   — plan frozen; batches may be rendered; not yet confirmed complete.
 * completed — every batch rendered and the merged page count confirmed (terminal).
 * failed    — a batch failed in a way a retry cannot fix, or the browser gave up (terminal).
 * expired   — RD-PRINT-P4: planned but untouched for RUN_STALE_MS — the browser abandoned it
 *             (closed tab, lost connection). Set lazily on next access and by the daily
 *             reconciliation; only this run's status fields change (terminal).
 */
export type PrintRunStatus = 'planned' | 'completed' | 'failed' | 'expired'

/** A planned run with no activity for this long is treated as abandoned. */
export const RUN_STALE_MS = 24 * 60 * 60 * 1000

/** Plain-language explanation for every run error code (history and UI). */
export const PRINT_RUN_ERROR_MESSAGES: Record<string, string> = {
  REGISTRATION_CHANGED: 'A registration was cancelled, refunded or removed after the run was planned. Start a new download.',
  TOO_LARGE:            'A part of this run was larger than one download allows. Select fewer cards or use plainer cards.',
  RENDER_FAILED:        'A card could not be drawn. Check the template, then start a new download.',
  TEMPLATE_UNAVAILABLE: 'The template version this job uses could not be loaded.',
  NO_CARDS:             'None of the planned cards can be printed any more.',
  SHEET_MISMATCH:       'A part of the PDF did not have the planned number of sheets.',
  CLIENT_ABORTED:       'The download did not finish in the browser, so nothing was saved.',
  ABANDONED:            'The download was started but never finished, so the run expired.',
  RUN_COMPLETED:        'This print run is already complete. Start a new download to print again.',
}

export interface PrintRun {
  runId:        string
  organizerUid: string
  createdBy:    string
  jobId:        string
  eventId:      string
  eventSlug:    string
  templateId:   string
  templateVersion:     number
  templateVersionHash: string | null
  sheet:        SheetSpec
  /** The frozen print order: every card that will be printed, exactly once. Ids only. */
  registrationIds: string[]
  cardCount:    number
  perSheet:     number
  batchSize:    number
  batchCount:   number
  sheets:       number
  skipped:      { registrationId: string; reason: string }[]   // first SKIPPED_KEPT
  skippedCount: number
  overflowCount: number                                         // cards with at least one warning
  overflow:     { registrationId: string; elementId: string; kind: 'width' | 'height' }[]   // first OVERFLOW_KEPT
  renderedBatches: number[]
  status:       PrintRunStatus
  error:        string | null
  errorCode:    string | null
  createdAt?:   unknown
  updatedAt?:   unknown
  completedAt?: unknown
}

export type RunResult<T> = { ok: true; value: T } | { ok: false; status: number; code: string; error: string; registrationIds?: string[] }

const runsCol = () => adminDb.collection(PRINT_RUNS)
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/

export function printRunId(organizerUid: string, jobId: string, requestId: string): string {
  return `run_${crypto.createHash('sha256').update(`${organizerUid}|${jobId}|${requestId}`).digest('hex').slice(0, 32)}`
}

export async function getPrintRun(runId: string): Promise<PrintRun | null> {
  const s = await runsCol().doc(runId).get()
  return s.exists ? await expireIfStale(s.data() as PrintRun) : null
}

const millis = (v: unknown) => (v instanceof Timestamp ? v.toMillis() : 0)

/** True when a PLANNED run has had no activity for RUN_STALE_MS. */
export function isStalePrintRun(run: Pick<PrintRun, 'status' | 'updatedAt' | 'createdAt'>, now = Date.now()): boolean {
  if (run.status !== 'planned') return false
  const last = millis(run.updatedAt) || millis(run.createdAt)
  return last > 0 && now - last > RUN_STALE_MS
}

/**
 * RD-PRINT-P4 — lazily expire an abandoned run. Transactional: only a run that is STILL
 * planned and stale is changed, and only its status/error fields. Never touches
 * registrations, jobs, templates or Storage.
 */
async function expireIfStale(run: PrintRun, now = Date.now()): Promise<PrintRun> {
  if (!isStalePrintRun(run, now)) return run
  const ref = runsCol().doc(run.runId)
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref)
    const fresh = snap.data() as PrintRun | undefined
    if (!fresh || !isStalePrintRun(fresh, now)) return fresh ?? run
    const error = PRINT_RUN_ERROR_MESSAGES.ABANDONED
    tx.update(ref, { status: 'expired', error, errorCode: 'ABANDONED', updatedAt: FieldValue.serverTimestamp() })
    return { ...fresh, status: 'expired' as const, error, errorCode: 'ABANDONED' }
  })
}

/**
 * RD-PRINT-P4 — the daily reconciliation: expire abandoned planned runs. Bounded per call;
 * reads only `printRuns` (single-field `status` query, no new index) and writes only the
 * status/error fields of stale planned runs. Anything it misses is still expired lazily on
 * its next access. Returns counts only.
 */
export async function reconcileStalePrintRuns(opts: { now?: number; limit?: number } = {}): Promise<{ scanned: number; expired: number }> {
  const now = opts.now ?? Date.now()
  const snap = await runsCol().where('status', '==', 'planned').limit(opts.limit ?? 500).get()
  let expired = 0
  for (const d of snap.docs) {
    const run = d.data() as PrintRun
    if (!isStalePrintRun(run, now)) continue
    if ((await expireIfStale(run, now)).status === 'expired') expired++
  }
  return { scanned: snap.size, expired }
}

/** RD-PRINT-P4 — a job's most recent runs (history). Single-field query; sorted in memory. */
export async function listPrintRunsForJob(jobId: string, organizerUid: string, n = 20): Promise<PrintRun[]> {
  const snap = await runsCol().where('jobId', '==', jobId).limit(200).get()
  const runs = snap.docs.map(d => d.data() as PrintRun).filter(r => r.organizerUid === organizerUid)
  runs.sort((a, b) => millis(b.createdAt) - millis(a.createdAt))
  return Promise.all(runs.slice(0, n).map(r => expireIfStale(r)))
}

// ─── Plan ────────────────────────────────────────────────────────────────────────

export async function createPrintRun(input: {
  job: PrintGenerationJob; actorUid: string; requestId: unknown
  spec: SheetSpec; registrationIds?: string[]; batchCards?: number
}): Promise<RunResult<{ run: PrintRun; created: boolean }>> {
  const { job } = input
  if (typeof input.requestId !== 'string' || !REQUEST_ID.test(input.requestId)) {
    return { ok: false, status: 400, code: 'INVALID_REQUEST_ID', error: 'requestId must be 8–64 letters, digits, - or _.' }
  }
  if (!job.templateVersion) {
    return { ok: false, status: 409, code: 'JOB_NOT_PINNED', error: 'This print job predates template versioning. Generate the cards again to print them as one PDF.' }
  }
  const runId = printRunId(job.organizerUid, job.jobId, input.requestId)
  const existing = await getPrintRun(runId)
  if (existing) return { ok: true, value: { run: existing, created: false } }     // duplicate submission → same run

  // RD-PRINT-P4 — a job still generating would silently yield only the cards ready SO FAR.
  if (job.status === 'pending' || job.status === 'processing') {
    return { ok: false, status: 409, code: 'JOB_IN_PROGRESS', error: 'This print job is still generating cards. Wait until it finishes, then download.' }
  }
  // Selection, in the job's deterministic order. EVERY selected card that will not be printed
  // is reported with its reason — not-generated and failed cards included (RD-PRINT-P4).
  const items = await listPrintJobItems(job.jobId)
  const wanted = input.registrationIds && input.registrationIds.length ? new Set(input.registrationIds) : null
  const ids: string[] = []
  const skipped: { registrationId: string; reason: string }[] = []
  for (const it of items) {
    if (wanted && !wanted.has(it.registrationId)) continue
    if (isPrintItemReady(it)) ids.push(it.registrationId)
    // RD-PRINT-AUDIT · fixed text only — never the item's stored error (a legacy item's error
    // could be a raw exception string; nothing derived from it is copied into run history).
    else skipped.push({ registrationId: it.registrationId, reason: it.error ? 'Card could not be generated' : 'Card has not been generated' })
  }
  if (wanted) {
    const inJob = new Set(items.map(i => i.registrationId))
    for (const id of wanted) if (!inJob.has(id)) skipped.push({ registrationId: id, reason: 'Not part of this print job' })
  }
  if (ids.length > RUN_MAX_CARDS) {
    return { ok: false, status: 413, code: 'TOO_MANY_CARDS', error: `A print run holds at most ${RUN_MAX_CARDS.toLocaleString('en-IN')} cards — this selection has ${ids.length.toLocaleString('en-IN')}.` }
  }
  if (ids.length === 0) return { ok: false, status: 409, code: 'NO_CARDS', error: 'No generated cards match this selection.' }

  const analysis = await analyzePrintRunCards(job, ids, input.spec)
  if (!analysis.ok) return analysis
  skipped.push(...analysis.skipped)
  const planned = planBatches(analysis.eligible.length, analysis.perSheet, input.batchCards)
  if (!planned.ok) return { ok: false, status: planned.code === 'TOO_MANY_CARDS' ? 413 : 422, code: planned.code, error: planned.error }

  const run: PrintRun = {
    runId, organizerUid: job.organizerUid, createdBy: input.actorUid, jobId: job.jobId,
    eventId: job.eventId, eventSlug: job.eventSlug, templateId: job.templateId,
    templateVersion: job.templateVersion, templateVersionHash: job.templateVersionHash ?? null,
    sheet: input.spec, registrationIds: analysis.eligible, cardCount: analysis.eligible.length,
    perSheet: analysis.perSheet, ...planned.plan,
    skipped: skipped.slice(0, SKIPPED_KEPT), skippedCount: skipped.length,
    overflowCount: new Set(analysis.overflow.map(o => o.registrationId)).size,
    overflow: analysis.overflow.slice(0, OVERFLOW_KEPT),
    renderedBatches: [], status: 'planned', error: null, errorCode: null,
  }
  try {
    await runsCol().doc(runId).create({ ...run, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
  } catch {
    // A concurrent duplicate submission created it first — return that one.
    const raced = await getPrintRun(runId)
    if (raced) return { ok: true, value: { run: raced, created: false } }
    return { ok: false, status: 500, code: 'RUN_CREATE_FAILED', error: 'Could not create the print run.' }
  }
  return { ok: true, value: { run, created: true } }
}

// ─── Batches ─────────────────────────────────────────────────────────────────────

/** Errors that make the PLAN itself unusable — retrying the same batch cannot succeed. */
const TERMINAL_BATCH_CODES = new Set(['REGISTRATION_CHANGED', 'TOO_LARGE', 'RENDER_FAILED', 'TEMPLATE_UNAVAILABLE', 'NO_CARDS', 'SHEET_MISMATCH'])

export async function renderRunBatch(
  run: PrintRun, job: PrintGenerationJob, index: number,
  limits?: { maxBytes?: number; timeBudgetMs?: number },
): Promise<PrintSheetsResult> {
  if (run.status === 'failed') return { ok: false, status: 409, code: 'RUN_FAILED', error: run.error ?? 'This print run failed. Plan it again.' }
  if (run.status === 'expired') return { ok: false, status: 409, code: 'RUN_EXPIRED', error: run.error ?? PRINT_RUN_ERROR_MESSAGES.ABANDONED }
  // RD-PRINT-AUDIT · a completed run is final: a stale tab or replayed request can neither
  // re-render it nor turn it into "failed" after its PDF was downloaded.
  if (run.status === 'completed') return { ok: false, status: 409, code: 'RUN_COMPLETED', error: PRINT_RUN_ERROR_MESSAGES.RUN_COMPLETED }
  if (!Number.isInteger(index) || index < 0 || index >= run.batchCount) {
    return { ok: false, status: 404, code: 'NO_SUCH_BATCH', error: `This print run has ${run.batchCount} batches.` }
  }
  if (job.templateVersion !== run.templateVersion) {
    return { ok: false, status: 409, code: 'VERSION_MISMATCH', error: 'The print job no longer matches this run’s template version.' }
  }
  const ids = batchSlice(run.registrationIds, run.batchSize, index)
  let out = await renderPrintRunBatch(job, ids, run.sheet, index, limits)
  if (out.ok && out.sheets !== batchSheets(run.cardCount, run.batchSize, run.perSheet, index)) {
    out = { ok: false, status: 500, code: 'SHEET_MISMATCH', error: 'A batch did not produce the planned number of sheets.' }
  }
  const ref = runsCol().doc(run.runId)
  if (out.ok) {
    await ref.update({ renderedBatches: FieldValue.arrayUnion(index), updatedAt: FieldValue.serverTimestamp() })
  } else if (TERMINAL_BATCH_CODES.has(out.code)) {
    // RD-PRINT-AUDIT · fail the run ONLY while it is still planned (transactional): a run that
    // completed — or failed/expired — meanwhile keeps its state. The stored text is the fixed
    // message for the code, never an exception string.
    const error = PRINT_RUN_ERROR_MESSAGES[out.code] ?? 'A part of this print run could not be rendered.'
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref)
      if ((snap.data() as PrintRun | undefined)?.status !== 'planned') return
      tx.update(ref, { status: 'failed', error, errorCode: out.code, updatedAt: FieldValue.serverTimestamp() })
    })
  }
  return out
}

// ─── Completion ──────────────────────────────────────────────────────────────────

export async function completePrintRun(runId: string, organizerUid: string, pageCount: unknown): Promise<RunResult<PrintRun>> {
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(runsCol().doc(runId))
    const run = snap.exists ? (snap.data() as PrintRun) : null
    if (!run || run.organizerUid !== organizerUid) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Print run not found' }
    if (run.status === 'completed') return { ok: true, value: run }                 // idempotent
    if (run.status === 'failed') return { ok: false, status: 409, code: 'RUN_FAILED', error: run.error ?? 'This print run failed.' }
    if (run.status === 'expired' || isStalePrintRun(run)) {
      return { ok: false, status: 409, code: 'RUN_EXPIRED', error: PRINT_RUN_ERROR_MESSAGES.ABANDONED }
    }
    const done = new Set(run.renderedBatches)
    const missing = Array.from({ length: run.batchCount }, (_, i) => i).filter(i => !done.has(i))
    if (missing.length) {
      return { ok: false, status: 409, code: 'INCOMPLETE', error: `${missing.length} batch${missing.length === 1 ? ' has' : 'es have'} not been rendered — the PDF would be incomplete.` }
    }
    if (pageCount !== run.sheets) {
      return { ok: false, status: 409, code: 'PAGE_COUNT_MISMATCH', error: `The merged PDF must have ${run.sheets} sheets.` }
    }
    tx.update(snap.ref, { status: 'completed', completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() })
    return { ok: true, value: { ...run, status: 'completed' as const } }
  })
}

/**
 * The browser reports it could not finish (e.g. a batch failed after retries). Metadata only.
 * RD-PRINT-AUDIT · the stored message is FIXED — no client free text is accepted, so nothing a
 * client sends (or an exception it relays) ends up in run history.
 */
export async function failPrintRun(runId: string, organizerUid: string): Promise<RunResult<PrintRun>> {
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(runsCol().doc(runId))
    const run = snap.exists ? (snap.data() as PrintRun) : null
    if (!run || run.organizerUid !== organizerUid) return { ok: false, status: 404, code: 'NOT_FOUND', error: 'Print run not found' }
    if (run.status !== 'planned') return { ok: true, value: run }
    const error = PRINT_RUN_ERROR_MESSAGES.CLIENT_ABORTED
    tx.update(snap.ref, { status: 'failed', error, errorCode: 'CLIENT_ABORTED', updatedAt: FieldValue.serverTimestamp() })
    return { ok: true, value: { ...run, status: 'failed' as const, error, errorCode: 'CLIENT_ABORTED' } }
  })
}

// ─── View ────────────────────────────────────────────────────────────────────────

export interface PrintRunView {
  runId: string; jobId: string; status: PrintRunStatus
  templateVersion: number
  sheet: SheetSpec
  cardCount: number; perSheet: number; batchSize: number; batchCount: number; sheets: number
  skippedCount: number; skipped: { registrationId: string; reason: string }[]
  overflowCount: number; overflow: { registrationId: string; elementId: string; kind: 'width' | 'height' }[]
  renderedBatches: number[]
  error: string | null; errorCode: string | null
  /** RD-PRINT-P4 — what to show in history: a short status and a plain-language message. */
  statusLabel: string
  message: string | null
  createdAt: string | null; updatedAt: string | null; completedAt: string | null
}

const STATUS_LABELS: Record<PrintRunStatus, string> = {
  planned: 'In progress', completed: 'Downloaded', failed: 'Failed — nothing downloaded', expired: 'Abandoned — nothing downloaded',
}

const iso = (v: unknown) => (v instanceof Timestamp ? v.toDate().toISOString() : null)

/** Everything the browser needs to fetch, check and merge — but not the id list itself. */
export function toPrintRunView(run: PrintRun): PrintRunView {
  return {
    runId: run.runId, jobId: run.jobId, status: run.status, templateVersion: run.templateVersion, sheet: run.sheet,
    cardCount: run.cardCount, perSheet: run.perSheet, batchSize: run.batchSize, batchCount: run.batchCount, sheets: run.sheets,
    skippedCount: run.skippedCount, skipped: run.skipped, overflowCount: run.overflowCount, overflow: run.overflow,
    renderedBatches: [...run.renderedBatches].sort((a, b) => a - b),
    error: run.error, errorCode: run.errorCode,
    statusLabel: STATUS_LABELS[run.status] ?? run.status,
    message: run.errorCode ? (PRINT_RUN_ERROR_MESSAGES[run.errorCode] ?? run.error) : run.error,
    createdAt: iso(run.createdAt), updatedAt: iso(run.updatedAt), completedAt: iso(run.completedAt),
  }
}
